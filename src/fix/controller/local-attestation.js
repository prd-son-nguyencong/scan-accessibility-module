import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { getLocalBuildRevision, resolveScanAttestation } from '../../tracer/build-instrumented.js';
import { readBoundedFile } from '../review/secure-io.js';
import {
  isBuildRevisionDirty,
  validateInstrumentationDigest,
} from '../../tracer/page-attestation.js';
import { resolveTrustedDeploymentUrl } from '../../tracer/trusted-deployment-url.js';
import { canonicalizeDeploymentUrl } from '../../tracer/deployment-url.js';

const MAX_JSON_BYTES = 1024 * 1024;

function resolveOutDir(localRoot, config = {}) {
  const outDir = config?.outDir || 'dist';
  if (typeof outDir !== 'string' || outDir.includes('..') || isAbsolute(outDir)) {
    return 'dist';
  }
  return outDir;
}

function readTrustedScanConfig(root) {
  const configPath = join(root, '.scan-config.json');
  const contained = assertPathContainedInRoot(root, configPath);
  if (!contained.ok) return { ok: false, reason: 'LOCAL_ATTESTATION_MISSING' };

  let raw;
  try {
    raw = readBoundedFile(contained.resolvedPath, MAX_JSON_BYTES);
  } catch {
    return { ok: false, reason: 'MALFORMED_CONFIG' };
  }
  if (raw == null) return { ok: true, value: {} };

  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false, reason: 'MALFORMED_CONFIG' };
  }
}

export function resolveTrustedRoot(localRoot) {
  if (!localRoot || typeof localRoot !== 'string') {
    return { ok: false, reason: 'LOCAL_ROOT_MISSING' };
  }
  if (!existsSync(localRoot)) {
    return { ok: false, reason: 'LOCAL_ROOT_MISSING' };
  }
  try {
    const resolvedRoot = realpathSync(localRoot);
    return { ok: true, localRoot: resolvedRoot };
  } catch {
    return { ok: false, reason: 'LOCAL_ROOT_MISSING' };
  }
}

export function assertPathContainedInRoot(root, candidatePath) {
  const rootCheck = resolveTrustedRoot(root);
  if (!rootCheck.ok) return rootCheck;

  const resolvedRoot = rootCheck.localRoot;
  if (!existsSync(candidatePath)) {
    return { ok: false, reason: 'LOCAL_ATTESTATION_MISSING' };
  }

  let resolvedCandidate;
  try {
    resolvedCandidate = realpathSync(candidatePath);
  } catch {
    return { ok: false, reason: 'PATH_TRAVERSAL' };
  }

  const rel = relative(resolvedRoot, resolvedCandidate);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    return { ok: false, reason: 'PATH_TRAVERSAL' };
  }

  return { ok: true, localRoot: resolvedRoot, resolvedPath: resolvedCandidate };
}

function isRegularReadableFile(filePath) {
  try {
    return lstatSync(filePath).isFile();
  } catch {
    return false;
  }
}

function readRegularJsonFile(root, filePath, missingReason, malformedReason) {
  const contained = assertPathContainedInRoot(root, filePath);
  if (!contained.ok) return contained;
  if (!isRegularReadableFile(contained.resolvedPath)) {
    return { ok: false, reason: missingReason };
  }

  let raw;
  try {
    raw = readBoundedFile(contained.resolvedPath, MAX_JSON_BYTES);
  } catch {
    return { ok: false, reason: malformedReason };
  }
  if (raw == null) {
    return { ok: false, reason: missingReason };
  }

  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false, reason: malformedReason };
  }
}

/**
 * Load and validate local build/instrumentation attestation from the filesystem.
 * Recomputes instrumentation digest from scan-manifest; never trusts persisted digest alone.
 */
export function loadTrustedLocalAttestation(localRoot) {
  const rootCheck = resolveTrustedRoot(localRoot);
  if (!rootCheck.ok) return rootCheck;

  const root = rootCheck.localRoot;
  const configRead = readTrustedScanConfig(root);
  if (!configRead.ok) return configRead;

  const outDir = resolveOutDir(root, configRead.value);
  const outPath = resolve(root, outDir);
  const outContained = assertPathContainedInRoot(root, outPath);
  if (!outContained.ok) return outContained;

  const manifestRead = readRegularJsonFile(
    root,
    join(outPath, 'scan-manifest.json'),
    'LOCAL_ATTESTATION_MISSING',
    'MALFORMED_MANIFEST',
  );
  if (!manifestRead.ok) return manifestRead;

  const attestationRead = readRegularJsonFile(
    root,
    join(outPath, 'scan-attestation.json'),
    'LOCAL_ATTESTATION_MISSING',
    'MALFORMED_ATTESTATION',
  );
  if (!attestationRead.ok) return attestationRead;

  const currentRevision = getLocalBuildRevision(root);
  if (!currentRevision) {
    return { ok: false, reason: 'BUILD_REVISION_MISSING' };
  }
  if (isBuildRevisionDirty(currentRevision)) {
    return { ok: false, reason: 'BUILD_REVISION_DIRTY' };
  }

  const persisted = attestationRead.value || {};
  if (persisted.buildRevision !== currentRevision) {
    return { ok: false, reason: 'BUILD_REVISION_MISMATCH' };
  }

  if (
    persisted.instrumentationDigest != null
    && !validateInstrumentationDigest(persisted.instrumentationDigest).ok
  ) {
    return { ok: false, reason: 'MALFORMED_ATTESTATION' };
  }

  const deploymentResolved = resolveTrustedDeploymentUrl(root);
  const deploymentUrl = deploymentResolved.ok ? deploymentResolved.deploymentUrl : null;
  const persistedDeploymentUrl = persisted.deploymentUrl
    ? canonicalizeDeploymentUrl(String(persisted.deploymentUrl))
    : null;
  if (deploymentUrl && persistedDeploymentUrl && deploymentUrl !== persistedDeploymentUrl) {
    return { ok: false, reason: 'ATTESTATION_SIDECAR_STALE' };
  }

  const manifest = manifestRead.value || {};
  const resolved = resolveScanAttestation(manifest, persisted, currentRevision, deploymentUrl);

  if (resolved.entryCount === 0 || resolved.status === 'missing-instrumentation') {
    return { ok: false, reason: 'LOCAL_ATTESTATION_MISSING' };
  }

  return {
    ok: true,
    attestation: {
      buildRevision: currentRevision,
      instrumentationDigest: resolved.instrumentationDigest,
      deploymentUrl,
      status: resolved.status,
      entryCount: resolved.entryCount,
      buildRevisionDirty: isBuildRevisionDirty(currentRevision),
    },
  };
}
