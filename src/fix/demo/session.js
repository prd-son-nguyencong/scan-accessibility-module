import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { createHash } from 'node:crypto';
import { getDirname } from '../../utils/paths.js';
import { resolveTrustedRoot } from '../controller/local-attestation.js';
import { copyProjectTreeIntoShadow, runManagedCommand } from '../verify/shadow.js';
import { validateRelativeCandidatePath, resolveSecureSourceFile } from '../candidate/path.js';
import { CANDIDATE_LIMITS } from '../candidate/intent.js';
import { readBoundedFile } from '../review/secure-io.js';
import { validateScanReportV2 } from '../../reporter/report-v2.js';
import { normalizeSourcePath } from '../../reporter/fingerprint.js';
import { DemoPackageManagerError, resolvePackageManager } from './package-manager.js';
import {
  ensureDemoSandboxScanConfig,
  readBoundedHostScanConfig,
} from './sandbox-config.js';
import { resolveTrustedVerificationConfig } from '../verify/config.js';

export class DemoSandboxError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DemoSandboxError';
    this.code = code;
  }
}

const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const MAX_SCAN_REPORT_BYTES = 16 * 1024 * 1024;
const CONTROL_CHAR_PATTERN = /[\x00-\x1f\x7f]/;
const DEMO_ROUTE_PATTERN = /^\/(?:[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*)?$/;

function assertSessionId(sessionId) {
  const value = String(sessionId ?? '');
  if (!SESSION_ID_PATTERN.test(value)) {
    throw new DemoSandboxError(
      'INVALID_SESSION_ID',
      'Session ID must contain only letters, numbers, underscores, and hyphens.',
    );
  }
  return value;
}

function validateTargetFile(originalRoot, targetFile) {
  let normalized;
  try {
    normalized = validateRelativeCandidatePath(targetFile);
  } catch (error) {
    let code = error.code || 'INVALID_TARGET_FILE';
    if (code === 'PATH_TRAVERSAL' || code === 'ABSOLUTE_PATH') code = 'INVALID_TARGET_FILE';
    throw new DemoSandboxError(code, error.message || 'Target file path is invalid.');
  }

  try {
    resolveSecureSourceFile(originalRoot, normalized, { maxBytes: CANDIDATE_LIMITS.maxFileBytes });
  } catch (error) {
    let code = error.code || 'INVALID_TARGET_FILE';
    if (code === 'FILE_NOT_FOUND') code = 'TARGET_FILE_MISSING';
    if (code === 'INVALID_FILE') code = 'TARGET_NOT_REGULAR_FILE';
    if (code === 'PATH_TRAVERSAL' || code === 'ABSOLUTE_PATH') code = 'INVALID_TARGET_FILE';
    throw new DemoSandboxError(code, error.message || 'Target file is unavailable.');
  }

  return normalized;
}

function captureTargetCheckpoint(root, targetFile) {
  const resolved = resolveSecureSourceFile(root, targetFile, { maxBytes: CANDIDATE_LIMITS.maxFileBytes });
  const fileSha256 = `sha256:${createHash('sha256').update(resolved.bytes).digest('hex')}`;
  return {
    targetFile,
    fileSha256,
    byteLength: resolved.bytes.length,
  };
}

export function validateDemoRoute(route) {
  const value = String(route ?? '');
  if (
    CONTROL_CHAR_PATTERN.test(value)
    || value.includes('\\')
    || value.includes('?')
    || value.includes('#')
    || value.includes('%')
    || /^[a-z][a-z0-9+.-]*:/i.test(value)
    || value.includes('//')
    || !DEMO_ROUTE_PATTERN.test(value)
  ) {
    throw new DemoSandboxError(
      'INVALID_ROUTE',
      'Route must be a local path beginning with / and use simple ASCII path segments only.',
    );
  }
  if (value !== '/') {
    for (const segment of value.slice(1).split('/')) {
      if (segment === '.' || segment === '..') {
        throw new DemoSandboxError(
          'INVALID_ROUTE',
          'Route must be a local path beginning with / and use simple ASCII path segments only.',
        );
      }
    }
  }
  return value;
}

function assertRegularNonSymlinkFile(filePath, code, message) {
  let stat;
  try {
    stat = lstatSync(filePath);
  } catch {
    throw new DemoSandboxError(code, message);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new DemoSandboxError(code, message);
  }
}

export function resolveTrustedPackageScannerExecutable() {
  const packageRoot = realpathSync(join(getDirname(import.meta.url), '..', '..', '..'));
  const candidate = join(packageRoot, 'bin', 'ada-scan.js');
  if (!existsSync(candidate)) {
    throw new DemoSandboxError('TRUSTED_SCANNER_MISSING', 'Trusted scanner executable is unavailable.');
  }
  assertRegularNonSymlinkFile(
    candidate,
    'TRUSTED_SCANNER_INVALID',
    'Trusted scanner executable must be a regular non-symlink file.',
  );
  const resolved = realpathSync(candidate);
  assertRegularNonSymlinkFile(
    resolved,
    'TRUSTED_SCANNER_INVALID',
    'Trusted scanner executable must be a regular non-symlink file.',
  );
  if (!isAbsolute(resolved)) {
    throw new DemoSandboxError(
      'TRUSTED_SCANNER_INVALID',
      'Trusted scanner executable must be an absolute path.',
    );
  }
  return resolved;
}

function removeOwnedSessionDir(sessionDir) {
  if (existsSync(sessionDir)) {
    rmSync(sessionDir, { recursive: true, force: true });
  }
}

function assertDirectoryComponent(dirPath, code) {
  let stat;
  try {
    stat = lstatSync(dirPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
  if (stat.isSymbolicLink()) {
    throw new DemoSandboxError('SYMLINK_SESSION_PARENT', 'Session parent path must not be a symlink.');
  }
  if (!stat.isDirectory()) {
    throw new DemoSandboxError(code, 'Session parent path must be a directory.');
  }
  return true;
}

function ensureSafeDirectoryChain(root, segments) {
  let current = root;
  for (const segment of segments) {
    current = join(current, segment);
    if (assertDirectoryComponent(current, 'INVALID_SESSION_PARENT')) {
      continue;
    }
    mkdirSync(current, { mode: 0o700 });
    chmodSync(current, 0o700);
    if (!assertDirectoryComponent(current, 'INVALID_SESSION_PARENT')) {
      throw new DemoSandboxError('INVALID_SESSION_PARENT', 'Session parent path must be a directory.');
    }
  }
  return current;
}

function createExclusiveSessionLeaf(sessionDir) {
  try {
    mkdirSync(sessionDir, { mode: 0o700 });
    chmodSync(sessionDir, 0o700);
    return true;
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw new DemoSandboxError(
        'DEMO_SESSION_EXISTS',
        'Session directory already exists for this session ID.',
      );
    }
    throw error;
  }
}

function resolveTrustedPackageManager({
  packageManagerCommand,
  resolvePackageManager: resolvePackageManagerFn = resolvePackageManager,
}) {
  try {
    if (packageManagerCommand != null && packageManagerCommand !== '') {
      const value = String(packageManagerCommand);
      if (!isAbsolute(value)) {
        throw new DemoSandboxError(
          'INVALID_PACKAGE_MANAGER',
          'Package manager command must be an absolute executable path.',
        );
      }
      return resolvePackageManagerFn(value);
    }
    return resolvePackageManagerFn('pnpm');
  } catch (error) {
    if (error instanceof DemoSandboxError) throw error;
    if (error instanceof DemoPackageManagerError) {
      throw new DemoSandboxError(
        error.code || 'PACKAGE_MANAGER_NOT_FOUND',
        'Package manager command is unavailable.',
      );
    }
    throw error;
  }
}

function assertTargetCheckpointsUnchanged({
  label,
  originalCheckpoint,
  currentOriginal,
  currentSandbox,
}) {
  if (
    currentOriginal.fileSha256 !== originalCheckpoint.fileSha256
    || currentSandbox.fileSha256 !== originalCheckpoint.fileSha256
  ) {
    throw new DemoSandboxError(
      'DEMO_SANDBOX_TARGET_MISMATCH',
      label || 'Sandbox target file does not match the original project.',
    );
  }
}

function sanitizeCommandFailureMessage() {
  return 'Demo preparation command failed.';
}

export async function prepareDemoSandbox({
  originalRoot,
  sessionId,
  targetFile,
  runCommand = runManagedCommand,
  copyProjectTree = copyProjectTreeIntoShadow,
  packageManagerCommand = null,
  resolvePackageManager: resolvePackageManagerFn = resolvePackageManager,
}) {
  const rootCheck = resolveTrustedRoot(originalRoot);
  if (!rootCheck.ok) {
    throw new DemoSandboxError(rootCheck.reason || 'LOCAL_ROOT_MISSING', 'Original project root is unavailable.');
  }
  const trustedOriginalRoot = rootCheck.localRoot;
  const resolvedSessionId = assertSessionId(sessionId);
  const normalizedTarget = validateTargetFile(trustedOriginalRoot, targetFile);

  const sessionDir = join(trustedOriginalRoot, 'scan-reports', 'fix-sessions', resolvedSessionId);
  const sandboxRoot = join(sessionDir, 'demo-workspace');
  const artifactsDir = join(sessionDir, 'artifacts');

  ensureSafeDirectoryChain(trustedOriginalRoot, ['scan-reports', 'fix-sessions']);

  let createdSessionDir = false;
  try {
    createExclusiveSessionLeaf(sessionDir);
    createdSessionDir = true;

    mkdirSync(artifactsDir, { recursive: true, mode: 0o700 });
    chmodSync(artifactsDir, 0o700);

    const originalCheckpoint = captureTargetCheckpoint(trustedOriginalRoot, normalizedTarget);
    const copy = copyProjectTree({
      localRoot: trustedOriginalRoot,
      shadowRoot: sandboxRoot,
    });

    const sandboxCheckpoint = captureTargetCheckpoint(sandboxRoot, normalizedTarget);
    assertTargetCheckpointsUnchanged({
      originalCheckpoint,
      currentOriginal: originalCheckpoint,
      currentSandbox: sandboxCheckpoint,
    });

    const hostScanConfig = readBoundedHostScanConfig(trustedOriginalRoot);
    if (!hostScanConfig.ok) {
      throw new DemoSandboxError(
        hostScanConfig.reason || 'MALFORMED_CONFIG',
        'Host scan config is invalid.',
      );
    }

    const packageManagerPath = resolveTrustedPackageManager({
      packageManagerCommand,
      resolvePackageManager: resolvePackageManagerFn,
    });

    try {
      ensureDemoSandboxScanConfig({
        sandboxRoot,
        hostRoot: trustedOriginalRoot,
        packageManagerPath,
        hostScanConfig,
      });
    } catch (error) {
      if (error?.code === 'MALFORMED_CONFIG' || error?.code === 'INVALID_PACKAGE_MANAGER') {
        throw new DemoSandboxError(error.code, 'Sandbox verification config is invalid.');
      }
      throw error;
    }

    const verificationConfig = resolveTrustedVerificationConfig(sandboxRoot);
    if (!verificationConfig.ok || !verificationConfig.prepare) {
      throw new DemoSandboxError(
        verificationConfig.reason || 'MALFORMED_CONFIG',
        'Sandbox verification config is invalid.',
      );
    }

    const installResult = await runCommand(
      verificationConfig.prepare.command,
      verificationConfig.prepare.args,
      sandboxRoot,
      { timeoutMs: 300_000 },
    );
    if (installResult.code !== 0) {
      throw new DemoSandboxError('DEMO_PREPARE_FAILED', sanitizeCommandFailureMessage());
    }

    const postInstallOriginal = captureTargetCheckpoint(trustedOriginalRoot, normalizedTarget);
    const postInstallSandbox = captureTargetCheckpoint(sandboxRoot, normalizedTarget);
    assertTargetCheckpointsUnchanged({
      label: 'Sandbox target file changed during dependency install.',
      originalCheckpoint,
      currentOriginal: postInstallOriginal,
      currentSandbox: postInstallSandbox,
    });

    return {
      originalRoot: trustedOriginalRoot,
      sessionDir,
      sandboxRoot,
      artifactsDir,
      targetFile: normalizedTarget,
      copy,
      checkpoints: {
        original: originalCheckpoint,
        sandbox: sandboxCheckpoint,
      },
    };
  } catch (error) {
    if (createdSessionDir) {
      removeOwnedSessionDir(sessionDir);
    }
    throw error;
  }
}

export async function runFreshSandboxScan({
  sandboxRoot,
  route,
  runCommand = runManagedCommand,
}) {
  const rootCheck = resolveTrustedRoot(sandboxRoot);
  if (!rootCheck.ok) {
    throw new DemoSandboxError(rootCheck.reason || 'LOCAL_ROOT_MISSING', 'Sandbox root is unavailable.');
  }
  const trustedSandboxRoot = rootCheck.localRoot;
  const validatedRoute = validateDemoRoute(route);
  const trustedScannerExecutable = resolveTrustedPackageScannerExecutable();

  const scanResult = await runCommand(process.execPath, [
    trustedScannerExecutable,
    '--page', validatedRoute,
    '--layers', 'axe,accessScan',
    '--no-psi',
    '--no-fail',
    '--force-build',
  ], trustedSandboxRoot, {
    timeoutMs: 300_000,
    extraEnv: { ADA_SCAN_ROOT: trustedSandboxRoot },
  });

  if (scanResult.code !== 0) {
    throw new DemoSandboxError('DEMO_SCAN_FAILED', 'Fresh sandbox scan failed.');
  }

  const reportPath = join(trustedSandboxRoot, 'scan-reports', 'latest.json');
  let raw;
  try {
    raw = readBoundedFile(reportPath, MAX_SCAN_REPORT_BYTES);
  } catch {
    throw new DemoSandboxError('DEMO_SCAN_REPORT_INVALID', 'Sandbox scan report is unavailable.');
  }
  if (raw == null) {
    throw new DemoSandboxError('DEMO_SCAN_REPORT_INVALID', 'Sandbox scan report is missing.');
  }

  let report;
  try {
    report = JSON.parse(raw);
    validateScanReportV2(report);
  } catch {
    throw new DemoSandboxError('DEMO_SCAN_REPORT_INVALID', 'Sandbox scan report is malformed.');
  }

  return { report, reportPath };
}

export function reportHasTargetFinding(report, targetFile) {
  const normalized = normalizeSourcePath(targetFile);
  const findings = (report.pages || []).flatMap((page) => page.findings || []);
  return findings.some((finding) => normalizeSourcePath(finding.source?.file || '') === normalized);
}
