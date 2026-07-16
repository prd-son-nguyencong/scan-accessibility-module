import { canonicalizeDeploymentUrl, isUrlWithinDeploymentScope } from './deployment-url.js';
import { sanitizeAttestationReason } from './attestation-reasons.js';

export const ATTESTATION_META = Object.freeze({
  BUILD_REVISION: 'ada-scan-build-revision',
  INSTRUMENTATION_DIGEST: 'ada-scan-instrumentation-digest',
  DEPLOYMENT_URL: 'ada-scan-deployment-url',
});

export const ATTESTATION_META_NAMES = Object.freeze(Object.values(ATTESTATION_META));

const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const BUILD_REVISION_PATTERN = /^(git:[0-9a-f]{40}|release:[a-zA-Z0-9._-]{1,128})(:dirty)?$/;

export function isBuildRevisionDirty(revision) {
  return typeof revision === 'string' && revision.endsWith(':dirty');
}

export function validateBuildRevision(revision) {
  if (typeof revision !== 'string' || !revision.trim()) {
    return { ok: false, reason: 'MISSING_BUILD_REVISION' };
  }
  if (!BUILD_REVISION_PATTERN.test(revision)) {
    return { ok: false, reason: 'MALFORMED_BUILD_REVISION' };
  }
  return { ok: true, value: revision };
}

export function validateInstrumentationDigest(digest) {
  if (typeof digest !== 'string' || !digest.trim()) {
    return { ok: false, reason: 'MISSING_INSTRUMENTATION_DIGEST' };
  }
  if (!SHA256_PATTERN.test(digest)) {
    return { ok: false, reason: 'MALFORMED_INSTRUMENTATION_DIGEST' };
  }
  return { ok: true, value: digest };
}

export function validateAttestationDeploymentUrl(url) {
  if (typeof url !== 'string' || !url.trim()) {
    return { ok: false, reason: 'MISSING_DEPLOYMENT_URL' };
  }
  const canonical = canonicalizeDeploymentUrl(url);
  if (!canonical) {
    return { ok: false, reason: 'MALFORMED_DEPLOYMENT_URL' };
  }
  return { ok: true, value: canonical };
}

function extractExactlyOne(metaContents, metaName, missingReason) {
  const rawValues = Array.isArray(metaContents?.[metaName]) ? metaContents[metaName] : [];
  const values = rawValues.map((value) => String(value ?? '').trim()).filter(Boolean);
  if (values.length === 0) {
    return { ok: false, reason: missingReason };
  }
  if (values.length > 1) {
    return { ok: false, reason: 'DUPLICATE_META' };
  }
  return { ok: true, value: values[0] };
}

/**
 * Pure validation of attestation meta contents extracted from one page.
 * @param {Record<string, string[]>} metaContents
 */
export function validatePageAttestationMetaContents(metaContents = {}) {
  const revisionRaw = extractExactlyOne(
    metaContents,
    ATTESTATION_META.BUILD_REVISION,
    'MISSING_BUILD_REVISION',
  );
  if (!revisionRaw.ok) return revisionRaw;

  const digestRaw = extractExactlyOne(
    metaContents,
    ATTESTATION_META.INSTRUMENTATION_DIGEST,
    'MISSING_INSTRUMENTATION_DIGEST',
  );
  if (!digestRaw.ok) return digestRaw;

  const deploymentRaw = extractExactlyOne(
    metaContents,
    ATTESTATION_META.DEPLOYMENT_URL,
    'MISSING_DEPLOYMENT_URL',
  );
  if (!deploymentRaw.ok) return deploymentRaw;

  const revision = validateBuildRevision(revisionRaw.value);
  if (!revision.ok) return revision;

  const digest = validateInstrumentationDigest(digestRaw.value);
  if (!digest.ok) return digest;

  const deploymentUrl = validateAttestationDeploymentUrl(deploymentRaw.value);
  if (!deploymentUrl.ok) return deploymentUrl;

  return {
    ok: true,
    attestation: {
      buildRevision: revision.value,
      instrumentationDigest: digest.value,
      deploymentUrl: deploymentUrl.value,
    },
  };
}

function attestationTriple(attestation) {
  return `${attestation.buildRevision}|${attestation.instrumentationDigest}|${attestation.deploymentUrl}`;
}

/**
 * Aggregate per-page attestations; all pages must agree on the attestation triple.
 * @param {Array<{ attestationResult?: { ok: boolean, reason?: string, attestation?: object }, pageUrl?: string, scanFailed?: boolean }>} pageEntries
 */
export function aggregatePageAttestations(pageEntries = []) {
  if (!Array.isArray(pageEntries) || pageEntries.length === 0) {
    return { ok: false, reason: 'MISSING_BUILD_REVISION' };
  }

  const validated = [];
  for (const entry of pageEntries) {
    if (entry?.scanFailed) {
      return { ok: false, reason: 'PAGE_ATTESTATION_UNAVAILABLE' };
    }
    const pageResult = entry?.attestationResult ?? entry;
    if (!pageResult?.ok) {
      return {
        ok: false,
        reason: sanitizeAttestationReason(pageResult?.reason) || 'MISSING_BUILD_REVISION',
      };
    }
    validated.push({
      attestation: pageResult.attestation,
      pageUrl: entry.pageUrl || null,
    });
  }

  const first = validated[0].attestation;
  for (let index = 1; index < validated.length; index += 1) {
    const current = validated[index].attestation;
    if (current.buildRevision !== first.buildRevision) {
      return { ok: false, reason: 'BUILD_REVISION_INCONSISTENT' };
    }
    if (current.instrumentationDigest !== first.instrumentationDigest) {
      return { ok: false, reason: 'INSTRUMENTATION_DIGEST_INCONSISTENT' };
    }
    if (current.deploymentUrl !== first.deploymentUrl) {
      return { ok: false, reason: 'DEPLOYMENT_URL_INCONSISTENT' };
    }
  }

  if (attestationTriple(first) !== attestationTriple(validated[validated.length - 1].attestation)) {
    return { ok: false, reason: 'BUILD_REVISION_INCONSISTENT' };
  }

  for (const entry of validated) {
    if (entry.pageUrl && !isUrlWithinDeploymentScope(entry.pageUrl, first.deploymentUrl)) {
      return { ok: false, reason: 'DEPLOYMENT_URL_MISMATCH' };
    }
  }

  return { ok: true, attestation: first };
}

/**
 * Derive ScanReportV2 target fields from remote page attestations.
 */
export function deriveRemoteScanTarget({
  scannedUrl,
  sourceRoot = null,
  pageAttestations = [],
  pageEntries = null,
} = {}) {
  const base = {
    url: scannedUrl || null,
    buildRevision: null,
    instrumentationDigest: null,
    deploymentUrl: null,
    attestationStatus: 'missing',
    attestationReason: null,
  };

  if (!sourceRoot) {
    return {
      ...base,
      mode: 'url-only',
      attestationReason: 'LOCAL_SOURCE_REQUIRED',
    };
  }

  const entries = pageEntries ?? pageAttestations.map((attestationResult, index) => ({
    attestationResult,
    pageUrl: scannedUrl,
    scanFailed: attestationResult?.reason === 'PAGE_ATTESTATION_UNAVAILABLE',
  }));

  const aggregated = aggregatePageAttestations(entries);
  if (!aggregated.ok) {
    return {
      ...base,
      mode: 'url-only',
      attestationStatus: aggregated.reason === 'PAGE_ATTESTATION_UNAVAILABLE'
        ? 'unavailable'
        : 'malformed',
      attestationReason: sanitizeAttestationReason(aggregated.reason),
    };
  }

  const { attestation } = aggregated;
  base.buildRevision = attestation.buildRevision;
  base.instrumentationDigest = attestation.instrumentationDigest;
  base.deploymentUrl = attestation.deploymentUrl;

  if (isBuildRevisionDirty(attestation.buildRevision)) {
    return {
      ...base,
      mode: 'url-only',
      attestationStatus: 'malformed',
      attestationReason: 'BUILD_REVISION_DIRTY',
    };
  }

  if (scannedUrl && !isUrlWithinDeploymentScope(scannedUrl, attestation.deploymentUrl)) {
    return {
      ...base,
      mode: 'url-only',
      attestationStatus: 'scope-mismatch',
      attestationReason: 'DEPLOYMENT_URL_MISMATCH',
    };
  }

  return {
    ...base,
    mode: 'hybrid',
    attestationStatus: 'complete',
    attestationReason: null,
  };
}

/**
 * Extract attestation meta values from a live Playwright page without logging HTML.
 */
export async function extractPageAttestationFromPage(page, {
  evaluate = null,
} = {}) {
  const runEvaluate = evaluate || ((handler, arg) => page.evaluate(handler, arg));
  const metaContents = await runEvaluate((metaNames) => {
    const result = {};
    for (const name of metaNames) {
      result[name] = [...document.querySelectorAll(`meta[name="${name}"]`)]
        .map((element) => element.getAttribute('content') || '');
    }
    return result;
  }, ATTESTATION_META_NAMES);

  return validatePageAttestationMetaContents(metaContents);
}

export function validateAttestationForInjection(attestation = {}) {
  const revision = validateBuildRevision(attestation.buildRevision);
  if (!revision.ok) return revision;
  if (isBuildRevisionDirty(revision.value)) {
    return { ok: false, reason: 'BUILD_REVISION_DIRTY' };
  }
  const digest = validateInstrumentationDigest(attestation.instrumentationDigest);
  if (!digest.ok) return digest;
  const deploymentUrl = validateAttestationDeploymentUrl(attestation.deploymentUrl);
  if (!deploymentUrl.ok) return deploymentUrl;
  return {
    ok: true,
    attestation: {
      buildRevision: revision.value,
      instrumentationDigest: digest.value,
      deploymentUrl: deploymentUrl.value,
    },
  };
}

export function injectAttestationMetaTags(html, attestation = {}) {
  const validated = validateAttestationForInjection(attestation);
  if (!validated.ok) return String(html);

  const { buildRevision: revision, instrumentationDigest: digest, deploymentUrl } = validated.attestation;

  const escapeHtmlAttribute = (value) => String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  const tags = [
    `<meta name="${ATTESTATION_META.BUILD_REVISION}" content="${escapeHtmlAttribute(revision)}">`,
    `<meta name="${ATTESTATION_META.INSTRUMENTATION_DIGEST}" content="${escapeHtmlAttribute(digest)}">`,
    `<meta name="${ATTESTATION_META.DEPLOYMENT_URL}" content="${escapeHtmlAttribute(deploymentUrl)}">`,
  ];

  const source = String(html);
  if (!/<\/head\s*>/i.test(source)) return source;

  const metaPattern = new RegExp(
    `\\s*<meta\\s+name=["'](?:${ATTESTATION_META_NAMES.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})["'][^>]*>`,
    'gi',
  );
  const withoutExisting = source.replace(metaPattern, '');
  const markers = `\n    ${tags.join('\n    ')}`;
  return withoutExisting.replace(/<\/head\s*>/i, `${markers}\n  </head>`);
}
