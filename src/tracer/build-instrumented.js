import { execFileSync, spawnSync } from 'child_process';
import { existsSync, readFileSync, statSync } from 'fs';
import path from 'path';
import { getProjectRoot } from '../utils/paths.js';
import { loadConfig } from '../utils/config.js';
import { instrumentationManifestDigest } from '../reporter/fingerprint.js';
import { resolveDeploymentUrlForBuild } from './trusted-deployment-url.js';

const ROOT = getProjectRoot();
const MANIFEST_MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes
const IS_WINDOWS = process.platform === 'win32';

export function computeInstrumentationDigest(manifest = {}) {
  return instrumentationManifestDigest(manifest);
}

export function resolveScanAttestation(manifest = {}, persisted = {}, buildRevision = null, deploymentUrl = null) {
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
  const instrumentationDigest = computeInstrumentationDigest(manifest);
  return {
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
  const outDir = config?.outDir || 'dist';
  return path.join(ROOT, outDir, 'scan-manifest.json');
}

function attestationPath(config) {
  const outDir = config?.outDir || 'dist';
  return path.join(ROOT, outDir, 'scan-attestation.json');
}

export function getLocalBuildRevision(root = ROOT) {
  if (process.env.ADA_SCAN_BUILD_REVISION) return process.env.ADA_SCAN_BUILD_REVISION;
  try {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const dirty = execFileSync('git', ['status', '--porcelain=v1'], {
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
 * Runs the host's build with the instrumentation env so the Vite plugin emits
 * `<outDir>/scan-manifest.json`. Build command + env + outDir are config-driven
 * (buildCommand / buildEnv / outDir) so npm/yarn/pnpm and custom scripts work.
 */
export async function buildInstrumented(force = false, config = loadConfig()) {
  if (!force && isManifestFresh(config)) {
    console.log('Scan manifest is fresh — skipping build.\n');
    return loadScanAttestation(config);
  }

  const buildCommand = config.buildCommand || 'pnpm build:vite';
  const [cmd, ...args] = buildCommand.split(/\s+/);
  const buildEnv = config.buildEnv || { SCAN_MODE: 'true', MINIFY: 'true' };
  const deploymentResolved = resolveDeploymentUrlForBuild(ROOT);

  console.log(`\nBuilding (${buildCommand}) with instrumentation env...`);
  const result = spawnSync(cmd, args, {
    cwd: ROOT,
    stdio: 'inherit',
    // Windows package-manager binaries are .cmd shims — require a shell.
    shell: IS_WINDOWS,
    env: {
      ...process.env,
      ...buildEnv,
      PARADOX_ENV: process.env.PARADOX_ENV || 'STG',
      ADA_SCAN_BUILD_REVISION: getLocalBuildRevision(ROOT) || '',
      ADA_SCAN_DEPLOYMENT_URL: deploymentResolved.ok
        ? deploymentResolved.deploymentUrl
        : (process.env.ADA_SCAN_DEPLOYMENT_URL || ''),
    },
  });

  if (result.status !== 0) {
    throw new Error(`Instrumented build failed (exit ${result.status}) via "${buildCommand}"`);
  }
  console.log('Build complete.\n');
  const attestation = loadScanAttestation(config);
  if (attestation.status === 'missing-instrumentation') {
    console.warn(
      'Warning: instrumented build produced no scan manifest; source attribution is unattested.'
    );
  }
  return attestation;
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
  );
}
