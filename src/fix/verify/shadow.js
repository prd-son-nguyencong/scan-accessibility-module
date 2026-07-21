import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import { basename, join, relative, resolve } from 'node:path';
import { parseTrustedCommand } from './command.js';
import { tmpdir } from 'node:os';
import { resolveTrustedRoot } from '../controller/local-attestation.js';
import { applyEditsToBytes } from '../candidate/bytes.js';
import { assertDestinationContained } from '../candidate/path.js';
import { attachDiffToCandidate } from '../candidate/diff.js';
import { readSecureFileBytes, touchedFilesForCandidate } from '../candidate/intent.js';
import { persistVerificationArtifact } from './artifact.js';
import { buildCommandEnvironment } from './process-env.js';
import { compareVerificationFindings } from './verification-key.js';

export class ShadowVerificationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ShadowVerificationError';
    this.code = code;
  }
}

const DEFAULT_EXCLUDED_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'scan-reports',
]);
const SECRET_NAME_PATTERN = /^\.env|credentials|secrets/i;
const MAX_TREE_FILES = 5000;
const MAX_TREE_BYTES = 64 * 1024 * 1024;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_SHADOW_COPY_FILE_BYTES = 8 * 1024 * 1024;
const MAX_CAPTURED_OUTPUT = 32 * 1024;
const DEFAULT_BUILD_TIMEOUT_MS = 120_000;
const KILL_ESCALATION_MS = 5000;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

export function assertLoopbackSiteUrl(url) {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    throw new ShadowVerificationError('SITE_URL_INVALID', 'Site URL is invalid.');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new ShadowVerificationError('SITE_URL_INVALID', 'Site URL must use HTTP or HTTPS.');
  }
  const host = parsed.hostname.toLowerCase();
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new ShadowVerificationError('SITE_URL_NOT_LOOPBACK', 'Site URL must bind to loopback only.');
  }
  return parsed.href;
}

export function scannerOwnsSiteLifecycle(scanner) {
  return Boolean(scanner && scanner.ownsSiteLifecycle === true);
}

export async function startCandidateSite(site, shadowRoot, { signal, buildResult } = {}) {
  if (!site || typeof site.start !== 'function') {
    throw new ShadowVerificationError('SITE_ADAPTER_INVALID', 'Site adapter must expose start().');
  }
  const handle = await site.start(shadowRoot, { signal, buildResult });
  if (!handle || typeof handle.url !== 'string') {
    throw new ShadowVerificationError('SITE_ADAPTER_INVALID', 'Site adapter start() must return { url, stop? }.');
  }
  const url = assertLoopbackSiteUrl(handle.url);
  const stop = typeof handle.stop === 'function'
    ? handle.stop.bind(handle)
    : (typeof site.stop === 'function' ? () => site.stop() : null);
  return { url, context: handle.context || null, stop };
}

export async function stopCandidateSite(siteHandle) {
  if (!siteHandle?.stop) return;
  try {
    await siteHandle.stop();
  } catch {
    // ignore cleanup failures
  }
}

function shouldExcludeEntry(name, relPath) {
  if (DEFAULT_EXCLUDED_DIRS.has(name)) return true;
  if (relPath.startsWith('scan-reports/') || relPath.includes('/scan-reports/')) return true;
  if (SECRET_NAME_PATTERN.test(name)) return true;
  return false;
}

export function copyProjectTreeIntoShadow({
  localRoot,
  shadowRoot,
  extraExclude = [],
}) {
  const rootCheck = resolveTrustedRoot(localRoot);
  if (!rootCheck.ok) {
    throw new ShadowVerificationError(rootCheck.reason || 'LOCAL_ROOT_MISSING', 'Local root unavailable.');
  }
  mkdirSync(shadowRoot, { recursive: true, mode: 0o700 });
  chmodSync(shadowRoot, 0o700);

  const exclude = new Set([...DEFAULT_EXCLUDED_DIRS, ...extraExclude]);
  const shadowPath = resolveTrustedRoot(shadowRoot).localRoot;
  let fileCount = 0;
  let totalBytes = 0;

  function walk(currentRoot, relDir = '') {
    if (fileCount > MAX_TREE_FILES || totalBytes > MAX_TREE_BYTES) {
      throw new ShadowVerificationError('SHADOW_TREE_TOO_LARGE', 'Shadow copy exceeds allowed tree size.');
    }
    for (const entry of readdirSync(currentRoot)) {
      const relPath = relDir ? `${relDir}/${entry}` : entry;
      if (shouldExcludeEntry(entry, relPath) || exclude.has(entry)) continue;
      const srcPath = join(currentRoot, entry);
      if (resolve(srcPath) === shadowPath) continue;
      const stat = lstatSync(srcPath);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        const destDir = assertDestinationContained(shadowRoot, relPath);
        mkdirSync(destDir, { recursive: true, mode: 0o700 });
        chmodSync(destDir, 0o700);
        walk(srcPath, relPath);
        continue;
      }
      if (!stat.isFile()) continue;
      if (stat.size > MAX_SHADOW_COPY_FILE_BYTES) {
        throw new ShadowVerificationError('SHADOW_FILE_TOO_LARGE', 'Shadow copy file exceeds size limit.');
      }
      const destPath = assertDestinationContained(shadowRoot, relPath);
      mkdirSync(resolve(destPath, '..'), { recursive: true, mode: 0o700 });
      copyFileSync(srcPath, destPath);
      chmodSync(destPath, stat.mode & 0o777 || 0o600);
      fileCount += 1;
      totalBytes += stat.size;
    }
  }

  walk(rootCheck.localRoot);
  return { fileCount, totalBytes };
}

function applyCandidateInShadow(candidate, shadowRoot) {
  for (const file of touchedFilesForCandidate(candidate)) {
    const target = assertDestinationContained(shadowRoot, file);
    const original = lstatSync(target);
    if (!original.isFile()) {
      throw new ShadowVerificationError('INVALID_SHADOW_FILE', 'Shadow target is not a regular file.');
    }
    const bytes = readSecureFileBytes(target, MAX_FILE_BYTES);
    const updated = applyEditsToBytes(bytes, candidate.edits.filter((edit) => edit.file === file));
    writeFileSync(target, updated, { mode: original.mode & 0o777 || 0o600 });
  }
}

function validateScannerResult(result, { requireSourceTrace = true } = {}) {
  if (!result || typeof result !== 'object') {
    throw new ShadowVerificationError('SCANNER_RESULT_INVALID', 'Scanner result schema is invalid.');
  }
  if (!Array.isArray(result.findings)) {
    throw new ShadowVerificationError('SCANNER_RESULT_INVALID', 'Scanner findings are required.');
  }
  if (requireSourceTrace && result.sourceTraceResolved !== true) {
    throw new ShadowVerificationError('SOURCE_TRACE_UNRESOLVED', 'Scanner must report sourceTraceResolved=true.');
  }
  if (!Array.isArray(result.executedLayers) || result.executedLayers.length === 0) {
    throw new ShadowVerificationError('SCANNER_LAYERS_MISSING', 'Scanner must report executedLayers.');
  }
  return result;
}

function compareFindings(baselineFindings, afterFindings, targetFindingIds = [], compareFn = compareVerificationFindings) {
  return compareFn(baselineFindings, afterFindings, targetFindingIds);
}

export function runManagedCommand(command, args, cwd, { timeoutMs, signal, extraEnv = {} } = {}) {
  const parsed = parseTrustedCommand({ command, args: args || [] }, { field: 'command' });
  return new Promise((resolvePromise, reject) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    let killTimer = null;
    let terminationError = null;

    const finish = (handler, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (signal) signal.removeEventListener('abort', onAbort);
      child.stdout?.removeAllListeners('data');
      child.stderr?.removeAllListeners('data');
      child.removeAllListeners('close');
      child.removeAllListeners('error');
      handler(value);
    };

    const child = spawn(parsed.command, parsed.args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: buildCommandEnvironment(extraEnv),
    });

    const requestTermination = (error) => {
      if (settled || terminationError) return;
      terminationError = error;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // ignore
        }
      }, KILL_ESCALATION_MS);
    };

    const onAbort = () => requestTermination(
      Object.assign(new Error('CANCELLED'), { code: 'CANCELLED' }),
    );

    const timer = setTimeout(() => {
      requestTermination(
        Object.assign(new Error('COMMAND_TIMEOUT'), { code: 'COMMAND_TIMEOUT' }),
      );
    }, timeoutMs || DEFAULT_BUILD_TIMEOUT_MS);

    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    child.stdout.on('data', (chunk) => {
      stdout = (stdout + chunk.toString('utf8')).slice(-MAX_CAPTURED_OUTPUT);
    });
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-MAX_CAPTURED_OUTPUT);
    });
    child.on('error', (error) => finish(reject, error));
    child.on('close', (code) => {
      if (terminationError) {
        finish(reject, terminationError);
        return;
      }
      finish(resolvePromise, { code, stdout, stderr });
    });
  });
}

export async function runShadowVerification({
  localRoot,
  sessionDir,
  candidate,
  targetFindingIds = [],
  baselineFindings = [],
  manualChecks = [],
  manualChecksAcknowledged = false,
  performanceMetrics = null,
  formatter = null,
  prepare = null,
  build = null,
  scanner = null,
  site = null,
  commandEnv = {},
  keepShadow = false,
  buildTimeoutMs = DEFAULT_BUILD_TIMEOUT_MS,
  signal = null,
}) {
  if (!scanner) {
    throw new ShadowVerificationError('SCANNER_REQUIRED', 'Verification scanner adapter is required.');
  }

  const enriched = attachDiffToCandidate(candidate);
  const rootCheck = resolveTrustedRoot(localRoot);
  if (!rootCheck.ok) {
    throw new ShadowVerificationError(rootCheck.reason || 'LOCAL_ROOT_MISSING', 'Local root unavailable.');
  }

  const shadowRoot = mkdtempSync(join(tmpdir(), 'ada-shadow-'));
  chmodSync(shadowRoot, 0o700);
  let siteHandle = null;

  try {
    copyProjectTreeIntoShadow({ localRoot, shadowRoot });
    applyCandidateInShadow(enriched, shadowRoot);

    let prepareResult = null;
    if (prepare) {
      prepareResult = await runManagedCommand(prepare.command, prepare.args || [], shadowRoot, {
        timeoutMs: buildTimeoutMs,
        signal,
        extraEnv: commandEnv,
      });
      if (prepareResult.code !== 0) {
        const persisted = persistVerificationArtifact(sessionDir, {
          status: 'prepare_failed',
          candidateHash: enriched.candidateHash,
          diffHash: enriched.diffHash,
          targetFindingIds,
          removedTargets: [],
          newCriticalSerious: [],
          build: null,
          prepare: { exitCode: prepareResult.code },
          format: null,
          sourceTraceResolved: false,
          manualChecks: manualChecks.filter(Boolean),
          manualChecksAcknowledged,
          environment: {
            shadow: true,
            localLighthouse: Boolean(performanceMetrics?.localLighthouse),
            psiParity: false,
            provenance: performanceMetrics?.provenance || 'local-shadow',
          },
          performance: performanceMetrics ? {
            baseline: performanceMetrics.baseline || null,
            after: null,
          } : null,
        });
        return {
          ok: false,
          reason: 'PREPARE_FAILED',
          artifact: persisted.artifact,
          artifactId: persisted.artifactId,
          shadowRoot: keepShadow ? shadowRoot : null,
        };
      }
    }

    if (formatter) {
      const formatResult = await runManagedCommand(formatter.command, formatter.args || [], shadowRoot, {
        timeoutMs: buildTimeoutMs,
        signal,
        extraEnv: commandEnv,
      });
      if (formatResult.code !== 0) {
        throw new ShadowVerificationError('FORMAT_FAILED', 'Formatter failed in shadow workspace.');
      }
    }

    const buildSpec = build || { command: 'npm', args: ['run', 'build'] };
    const buildResult = await runManagedCommand(buildSpec.command, buildSpec.args || [], shadowRoot, {
      timeoutMs: buildTimeoutMs,
      signal,
      extraEnv: commandEnv,
    });

    if (buildResult.code !== 0) {
      const persisted = persistVerificationArtifact(sessionDir, {
        status: 'build_failed',
        candidateHash: enriched.candidateHash,
        diffHash: enriched.diffHash,
        targetFindingIds,
        removedTargets: [],
        newCriticalSerious: [],
        build: { exitCode: buildResult.code },
        format: null,
        sourceTraceResolved: false,
        manualChecks: manualChecks.filter(Boolean),
        manualChecksAcknowledged,
        environment: {
          shadow: true,
          localLighthouse: Boolean(performanceMetrics?.localLighthouse),
          psiParity: false,
          provenance: performanceMetrics?.provenance || 'local-shadow',
        },
        performance: performanceMetrics ? {
          baseline: performanceMetrics.baseline || null,
          after: null,
        } : null,
      });
      return {
        ok: false,
        reason: 'BUILD_FAILED',
        artifact: persisted.artifact,
        artifactId: persisted.artifactId,
        shadowRoot: keepShadow ? shadowRoot : null,
      };
    }

    if (!scannerOwnsSiteLifecycle(scanner)) {
      if (!site) {
        throw new ShadowVerificationError(
          'SITE_REQUIRED',
          'Site adapter is required after build unless the scanner declares ownsSiteLifecycle.',
        );
      }
      siteHandle = await startCandidateSite(site, shadowRoot, { signal, buildResult });
    }

    const scanResult = validateScannerResult(await scanner({
      workspaceRoot: shadowRoot,
      siteUrl: siteHandle?.url ?? null,
      siteContext: siteHandle?.context ?? null,
      routes: candidate.routes || ['/'],
      layers: candidate.layers || ['accessibility'],
      signal,
      candidateBindings: (enriched.edits || []).map((edit) => ({ file: edit.file })),
      targetFindingIds,
    }));
    const afterFindings = scanResult.findings;
    const compareFn = typeof scanResult.compareFindings === 'function'
      ? scanResult.compareFindings.bind(scanResult)
      : compareVerificationFindings;
    const delta = compareFindings(baselineFindings, afterFindings, targetFindingIds, compareFn);
    const unresolvedManual = manualChecks.filter(Boolean);
    const manualOk = unresolvedManual.length === 0 || manualChecksAcknowledged;
    const passed = delta.targetsResolved
      && delta.newCriticalSerious.length === 0
      && scanResult.sourceTraceResolved === true
      && manualOk;

    const artifactBody = {
      status: passed ? 'passed' : 'failed',
      candidateHash: enriched.candidateHash,
      diffHash: enriched.diffHash,
      targetFindingIds,
      removedTargets: targetFindingIds.filter((id) => {
        const detail = delta.targetDetails?.find((item) => item.findingId === id);
        return detail ? detail.resolved : !afterFindings.some((item) => (item.findingId || item.fingerprint) === id);
      }),
      newCriticalSerious: delta.newCriticalSerious.map((item) => ({
        findingId: item.findingId || item.fingerprint || null,
        impact: item.impact,
        canonicalRuleId: item.canonicalRuleId || item.ruleId || null,
        nativeRuleId: item.nativeRuleId || item.ruleId || null,
        layer: item.layer || null,
        route: item.route || item.pageRoute || null,
        selector: item.selector || item.element?.selector || null,
      })),
      build: { exitCode: buildResult.code },
      prepare: prepareResult ? { exitCode: prepareResult.code } : null,
      format: formatter ? { exitCode: 0 } : null,
      sourceTraceResolved: scanResult.sourceTraceResolved === true,
      sourceTraceByTarget: scanResult.sourceTraceByTarget || [],
      executedLayers: scanResult.executedLayers || [],
      manualChecks: unresolvedManual,
      manualChecksAcknowledged,
      environment: {
        shadow: true,
        localLighthouse: Boolean(performanceMetrics?.localLighthouse),
        psiParity: false,
        provenance: performanceMetrics?.provenance || 'local-shadow',
      },
      performance: performanceMetrics ? {
        baseline: performanceMetrics.baseline || null,
        after: performanceMetrics.after || scanResult.performance || null,
      } : null,
    };

    const persisted = persistVerificationArtifact(sessionDir, artifactBody);
    return {
      ok: passed,
      reason: passed ? 'PASSED' : 'VERIFICATION_FAILED',
      artifact: persisted.artifact,
      artifactId: persisted.artifactId,
      diff: enriched.diff,
      diffHash: enriched.diffHash,
      candidate: enriched,
      shadowRoot: keepShadow ? shadowRoot : null,
    };
  } finally {
    await stopCandidateSite(siteHandle);
    if (!keepShadow) {
      try {
        rmSync(shadowRoot, { recursive: true, force: true });
      } catch {
        // ignore cleanup failures
      }
    }
  }
}
