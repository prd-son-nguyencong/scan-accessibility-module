import { isLoopbackUrl } from '../../utils/host-classify.js';
import { isUrlWithinDeploymentScope } from '../../tracer/deployment-url.js';
import { isBuildRevisionDirty } from '../../tracer/page-attestation.js';
import { sanitizeAttestationReason } from '../../tracer/attestation-reasons.js';

function isRemoteUrl(url) {
  if (!url) return false;
  return !isLoopbackUrl(url);
}

function attestationPresent(value) {
  return typeof value === 'string' && value.length > 0;
}

function resolveEffectiveMode({ targetMode = null, url = null, localRoot = null } = {}) {
  if (!localRoot) return 'url-only';
  if (url && isRemoteUrl(url)) return 'hybrid';
  if (targetMode === 'hybrid') return 'hybrid';
  if (targetMode === 'url-only') return 'hybrid';
  return 'local-only';
}

export function requiresHybridAttestation({ targetMode = null, url = null, localRoot = null } = {}) {
  return resolveEffectiveMode({ targetMode, url, localRoot }) === 'hybrid';
}

/**
 * Resolve whether the current target may enter the trusted fix workflow.
 * URL-only is always scan-only. Hybrid requires exact revision, digest, and deployment URL match.
 */
export function resolveFixCapability({
  targetMode = null,
  url = null,
  localRoot = null,
  remoteRevision = null,
  localRevision = null,
  remoteInstrumentationDigest = null,
  localInstrumentationDigest = null,
  remoteDeploymentUrl = null,
  localDeploymentUrl = null,
  scannedUrl = null,
  attestationStatus = null,
  attestationReason = null,
} = {}) {
  if (!localRoot) {
    return {
      mode: 'url-only',
      canFix: false,
      reason: 'LOCAL_SOURCE_REQUIRED',
    };
  }

  const mode = resolveEffectiveMode({ targetMode, url, localRoot });
  if (mode === 'local-only') {
    return {
      mode: 'local-only',
      canFix: true,
      reason: null,
    };
  }

  if (attestationStatus && attestationStatus !== 'complete') {
    return {
      mode: 'hybrid',
      canFix: false,
      reason: sanitizeAttestationReason(attestationReason) || 'REMOTE_ATTESTATION_INVALID',
    };
  }

  if (isBuildRevisionDirty(remoteRevision) || isBuildRevisionDirty(localRevision)) {
    return {
      mode: 'hybrid',
      canFix: false,
      reason: 'BUILD_REVISION_DIRTY',
    };
  }

  if (!attestationPresent(remoteRevision) || !attestationPresent(localRevision)) {
    return {
      mode: 'hybrid',
      canFix: false,
      reason: 'MISSING_BUILD_REVISION',
    };
  }
  if (remoteRevision !== localRevision) {
    return {
      mode: 'hybrid',
      canFix: false,
      reason: 'BUILD_REVISION_MISMATCH',
    };
  }
  if (
    !attestationPresent(remoteInstrumentationDigest)
    || !attestationPresent(localInstrumentationDigest)
  ) {
    return {
      mode: 'hybrid',
      canFix: false,
      reason: 'MISSING_INSTRUMENTATION_DIGEST',
    };
  }
  if (remoteInstrumentationDigest !== localInstrumentationDigest) {
    return {
      mode: 'hybrid',
      canFix: false,
      reason: 'INSTRUMENTATION_DIGEST_MISMATCH',
    };
  }

  if (!attestationPresent(remoteDeploymentUrl) || !attestationPresent(localDeploymentUrl)) {
    return {
      mode: 'hybrid',
      canFix: false,
      reason: 'MISSING_DEPLOYMENT_URL',
    };
  }
  if (remoteDeploymentUrl !== localDeploymentUrl) {
    return {
      mode: 'hybrid',
      canFix: false,
      reason: 'DEPLOYMENT_URL_MISMATCH',
    };
  }

  const scopeUrl = scannedUrl || url;
  if (scopeUrl && !isUrlWithinDeploymentScope(scopeUrl, remoteDeploymentUrl)) {
    return {
      mode: 'hybrid',
      canFix: false,
      reason: 'DEPLOYMENT_URL_MISMATCH',
    };
  }

  return {
    mode: 'hybrid',
    canFix: true,
    reason: null,
  };
}
