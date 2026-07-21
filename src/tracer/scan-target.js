import { loadScanAttestation } from './build-instrumented.js';
import { loadTrustedLocalAttestation, resolveTrustedRoot } from '../fix/controller/local-attestation.js';
import { resolveFixCapability } from '../fix/controller/mode-gate.js';
import { deriveRemoteScanTarget } from './page-attestation.js';
import { applyAttestedRemoteTracing } from './remote-hint-trace.js';
import { sanitizeAttestationReason } from './attestation-reasons.js';

function normalizePageAttestationEntries(pageResults = []) {
  return pageResults.map((result) => ({
    attestationResult: result.pageAttestation ?? {
      ok: false,
      reason: result.scanFailed ? 'PAGE_ATTESTATION_UNAVAILABLE' : 'MISSING_BUILD_REVISION',
    },
    pageUrl: result.url,
    scanFailed: Boolean(result.scanFailed),
  }));
}

/**
 * Derive remote/local scan target, evaluate hybrid capability, and optionally trace remote findings.
 */
export function deriveScanTargetAndTrace({
  pageResults = [],
  pages = [],
  sourceRoot = null,
  isUrlMode = false,
  scanAttestation = null,
  manifest = null,
  config = null,
  loadLocalAttestation = loadTrustedLocalAttestation,
  resolveCapability = resolveFixCapability,
  traceRemoteViolations = applyAttestedRemoteTracing,
} = {}) {
  let resolvedSourceRoot = null;
  if (sourceRoot) {
    const rootCheck = resolveTrustedRoot(sourceRoot);
    resolvedSourceRoot = rootCheck.ok ? rootCheck.localRoot : null;
  }

  let tracedPageResults = pageResults;
  let targetFields;
  let capability = null;

  if (isUrlMode) {
    const pageEntries = normalizePageAttestationEntries(pageResults);
    const scannedUrl = pages.length === 1 ? pages[0].url : pages[0]?.url || pageResults[0]?.url || null;

    targetFields = deriveRemoteScanTarget({
      scannedUrl,
      sourceRoot: resolvedSourceRoot,
      pageEntries,
    });
    targetFields.attestationReason = sanitizeAttestationReason(targetFields.attestationReason);

    if (resolvedSourceRoot) {
      const loaded = loadLocalAttestation(resolvedSourceRoot);
      capability = resolveCapability({
        targetMode: targetFields.mode,
        url: targetFields.url,
        localRoot: resolvedSourceRoot,
        remoteRevision: targetFields.buildRevision ?? null,
        localRevision: loaded.ok ? loaded.attestation.buildRevision : null,
        remoteInstrumentationDigest: targetFields.instrumentationDigest ?? null,
        localInstrumentationDigest: loaded.ok ? loaded.attestation.instrumentationDigest : null,
        remoteDeploymentUrl: targetFields.deploymentUrl ?? null,
        localDeploymentUrl: loaded.ok ? loaded.attestation.deploymentUrl : null,
        scannedUrl: targetFields.url ?? null,
        attestationStatus: targetFields.attestationStatus ?? null,
        attestationReason: targetFields.attestationReason ?? null,
      });

      if (!loaded.ok && targetFields.mode === 'hybrid') {
        capability = {
          mode: 'hybrid',
          canFix: false,
          reason: sanitizeAttestationReason(loaded.reason) || 'LOCAL_ATTESTATION_MISSING',
        };
      }

      if (capability?.canFix) {
        tracedPageResults = traceRemoteViolations(pageResults, resolvedSourceRoot);
      }
    }
  } else {
    const instrumentationDigest = scanAttestation?.instrumentationDigest
      || (manifest && Object.keys(manifest).length > 0 && config
        ? loadScanAttestation(config).instrumentationDigest
        : null);

    targetFields = {
      mode: 'local-only',
      url: pages.length === 1 ? pages[0].url : pages[0]?.url || null,
      buildRevision: scanAttestation?.buildRevision || null,
      instrumentationDigest,
      deploymentUrl: null,
      attestationStatus: null,
      attestationReason: null,
    };
  }

  return {
    targetFields,
    pageResults: tracedPageResults,
    resolvedSourceRoot,
    capability,
  };
}
