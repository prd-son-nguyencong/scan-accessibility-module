import { execFileSync } from 'child_process';
import { existsSync, readFileSync, statSync } from 'fs';
import path from 'path';
import { getProjectRoot } from '../utils/paths.js';
import { loadConfig } from '../utils/config.js';
import { spawnGroup, terminateGroup } from '../utils/process-group.js';
import { resolveProject } from '../utils/project.js';
import { instrumentationManifestDigest } from '../reporter/fingerprint.js';
import { resolveDeploymentUrlForBuild } from './trusted-deployment-url.js';
import { findChangedSources } from './preimage.js';
import { planTracingBuild, writeWrapperConfig } from './vite-wrapper.js';

const ROOT = getProjectRoot();
const MANIFEST_MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes
const IS_WINDOWS = process.platform === 'win32';
const DEFAULT_BUILD_TIMEOUT_MS = 10 * 60 * 1000;

export function computeInstrumentationDigest(manifest = {}, sourceHashes = null) {
  return instrumentationManifestDigest(manifest, sourceHashes);
}

/**
 * status: `verified` (persisted digest matches the manifest + recorded source hashes), `recomputed`
 * (no persisted digest, or it does not match), `missing-instrumentation` (empty manifest).
 * `sourceHashes` are the build-time hashes; `changedSources` lists those whose local file differs now
 * (checked against `root` when given).
 */
export function resolveScanAttestation(manifest = {}, persisted = {}, buildRevision = null, deploymentUrl = null, root = null) {
  const entryCount = Object.keys(manifest).length;
  if (entryCount === 0) {
    return {
      buildRevision,
      instrumentationDigest: null,
      deploymentUrl: deploymentUrl || null,
      entryCount,
      status: 'missing-instrumentation',
    };
  }
  const sourceHashes = persisted.sourceHashes && typeof persisted.sourceHashes === 'object' ? persisted.sourceHashes : null;
  const instrumentationDigest = computeInstrumentationDigest(manifest, sourceHashes);
  return {
    sourceHashes,
    changedSources: root ? findChangedSources(root, sourceHashes) : [],
    buildRevision: persisted.buildRevision || buildRevision,
    instrumentationDigest,
    deploymentUrl: deploymentUrl || persisted.deploymentUrl || null,
    entryCount,
    status: persisted.instrumentationDigest === instrumentationDigest
      ? 'verified'
      : 'recomputed',
  };
}

function manifestPath(config) {
  return resolveProject(config || {}, ROOT).manifestPath;
}

function attestationPath(config) {
  return resolveProject(config || {}, ROOT).attestationPath;
}

export function getLocalBuildRevision(root = ROOT) {
  if (process.env.ADA_SCAN_BUILD_REVISION) return process.env.ADA_SCAN_BUILD_REVISION;
  try {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const dirty = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=no'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return `git:${head}${dirty ? ':dirty' : ''}`;
  } catch {
    return null;
  }
}

function isManifestFresh(config) {
  const p = manifestPath(config);
  if (!existsSync(p)) return false;
  const { mtimeMs } = statSync(p);
  if (Date.now() - mtimeMs >= MANIFEST_MAX_AGE_MS) return false;
  const currentRevision = getLocalBuildRevision(ROOT);
  if (!currentRevision || currentRevision.endsWith(':dirty')) return false;
  const attestation = loadScanAttestation(config);
  return attestation.status === 'verified'
    && attestation.buildRevision === currentRevision;
}

/**
 * Command, env and timeout for the instrumented build. pnpm 11 runs an implicit
 * `pnpm install` before every script when the lockfile is stale; the host's
 * postinstall then re-enters pnpm and the scan appears to hang. Skip that check
 * (config.buildEnv or the caller's environment can still override it).
 */
export function resolveBuildSpawn(config = {}, baseEnv = process.env) {
  const buildCommand = config.buildCommand || 'pnpm build:vite';
  const [cmd, ...args] = buildCommand.split(/\s+/);
  const buildEnv = config.buildEnv || { SCAN_MODE: 'true', MINIFY: 'true' };
  const deploymentResolved = resolveDeploymentUrlForBuild(ROOT);
  return {
    buildCommand,
    cmd,
    args,
    timeoutMs: config.buildTimeoutMs ?? DEFAULT_BUILD_TIMEOUT_MS,
    env: {
      pnpm_config_verify_deps_before_run: 'false',
      ...baseEnv,
      ...buildEnv,
      PARADOX_ENV: baseEnv.PARADOX_ENV || 'STG',
      ADA_SCAN_BUILD_REVISION: getLocalBuildRevision(ROOT) || '',
      ADA_SCAN_DEPLOYMENT_URL: deploymentResolved.ok
        ? deploymentResolved.deploymentUrl
        : (baseEnv.ADA_SCAN_DEPLOYMENT_URL || ''),
    },
  };
}

/**
 * Runs the host's build with the instrumentation env so the Vite plugin emits
 * `<outDir>/scan-manifest.json`. Build command + env + outDir are config-driven
 * (buildCommand / buildEnv / outDir) so npm/yarn/pnpm and custom scripts work.
 */
export async function buildInstrumented(force = false, config = loadConfig()) {
  if (!force && isManifestFresh(config)) {
    console.log('Scan manifest is fresh — skipping build.\n');
    return loadScanAttestation(config);
  }

  const spawnPlan = resolveBuildSpawn(config);
  const { buildCommand, timeoutMs, env } = spawnPlan;
  let { cmd, args } = spawnPlan;
  // Zero-config tracing: a project config without the plugin gets a temporary wrapper config.
  const plan = planTracingBuild(ROOT, config);
  let wrapper = null;
  if (plan.mode === 'wrapped') {
    try {
      wrapper = writeWrapperConfig(ROOT, plan.configFile);
      cmd = plan.cmd;
      args = [...plan.args, '--config', wrapper.file];
    } catch (err) {
      plan.mode = 'unavailable';
      plan.reason = `could not write the temporary wrapper config: ${err.message}`;
      plan.remedy = 'Make <project>/.ada-scan writable or register scanInstrumentationPlugin() from "ada-scan/vite"';
    }
  }

  console.log(`\nBuilding (${wrapper ? `vite build, instrumentation added via a temporary config` : buildCommand}) with instrumentation env...`);
  const result = await new Promise((resolve) => {
    const child = spawnGroup(cmd, args, {
      cwd: ROOT,
      stdio: 'inherit',
      // Windows package-manager binaries are .cmd shims — require a shell.
      shell: IS_WINDOWS,
      env,
    });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; terminateGroup(child, 2000); }, timeoutMs);
    child.once('error', (error) => { clearTimeout(timer); resolve({ error }); });
    child.once('close', (status) => { clearTimeout(timer); resolve({ status, timedOut }); });
  }).finally(() => wrapper?.cleanup());

  if (result.timedOut) {
    throw new Error(
      `Instrumented build timed out after ${timeoutMs}ms via "${buildCommand}" (set buildTimeoutMs to change)`
    );
  }
  if (result.error) {
    throw new Error(`Instrumented build could not start via "${buildCommand}": ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`Instrumented build failed (exit ${result.status}) via "${buildCommand}"`);
  }
  console.log('Build complete.\n');
  const attestation = loadScanAttestation(config);
  if (attestation.status === 'missing-instrumentation') {
    console.warn(
      'Warning: instrumented build produced no scan manifest; source attribution is unattested.'
      + (plan.mode === 'unavailable' ? ` Why: ${plan.reason}. Fix: ${plan.remedy}.` : '')
    );
  }
  return attestation;
}

/**
 * Local-URL scans trace findings to source via the instrumented build, but the
 * scan itself does not need it. Returns {attestation, unavailable}: `unavailable`
 * is the reason string when tracing could not be set up (no build attempted when
 * the project has no build script; a failing build is reported, not thrown).
 */
export async function tryBuildInstrumented(force = false, config = loadConfig()) {
  const defaultCommand = !config.buildCommand || config.buildCommand === 'pnpm build:vite';
  if (defaultCommand) {
    let scripts = null;
    try { scripts = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts; } catch { /* no package.json */ }
    if (!scripts || !Object.keys(scripts).some((k) => k.startsWith('build'))) {
      return { attestation: null, unavailable: 'no package.json with a build script in the project root' };
    }
  }
  try {
    return { attestation: await buildInstrumented(force, config), unavailable: null };
  } catch (err) {
    return { attestation: null, unavailable: err.message };
  }
}

export function loadScanManifest(config = loadConfig()) {
  const p = manifestPath(config);
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return {};
  }
}

export function loadScanAttestation(config = loadConfig()) {
  const manifest = loadScanManifest(config);
  let persisted = {};
  const p = attestationPath(config);
  if (existsSync(p)) {
    try {
      persisted = JSON.parse(readFileSync(p, 'utf8'));
    } catch {
      persisted = {};
    }
  }
  const deploymentResolved = resolveDeploymentUrlForBuild(ROOT);
  const deploymentUrl = deploymentResolved.ok ? deploymentResolved.deploymentUrl : null;
  return resolveScanAttestation(
    manifest,
    persisted,
    getLocalBuildRevision(ROOT),
    deploymentUrl,
    ROOT,
  );
}
