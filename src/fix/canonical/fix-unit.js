import { canonicalSha256, normalizeSourcePath, normalizedHtmlSha256 } from '../../reporter/fingerprint.js';
import { canonicalRuleForFixUnit } from './finding-aliases.js';

export class FixCanonicalizerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'FixCanonicalizerError';
    this.code = code;
  }
}

const ACCESSIBILITY_CATEGORIES = new Set(['accessibility', 'markup']);

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function rootCauseRegion(finding) {
  const source = finding.source || {};
  if (source.preimageSha256) {
    return {
      kind: 'source-preimage',
      preimageSha256: source.preimageSha256,
      file: normalizeSourcePath(source.file) || null,
    };
  }
  const element = finding.element || {};
  return {
    kind: 'dom',
    selector: element.selector || '',
    normalizedHtmlHash: element.normalizedHtmlHash || null,
  };
}

function unitKind(finding) {
  if (finding.kind === 'performance' || finding.category === 'performance') {
    return 'performance';
  }
  if (ACCESSIBILITY_CATEGORIES.has(finding.category)) {
    return 'accessibility';
  }
  return finding.category === 'performance' ? 'performance' : 'accessibility';
}

function performanceGroupKey(finding) {
  const metric = finding.metric
    || finding.opportunity
    || finding.nativeRuleId
    || finding.canonicalRuleId
    || 'unknown';
  const device = finding.device
    || finding.evidence?.device
    || finding.evidence?.viewport?.name
    || 'unknown';
  const resources = [
    ...(finding.affectedResources || []),
    ...(finding.evidence?.affectedResources || []),
    finding.source?.file,
  ].filter(Boolean).map(normalizeSourcePath).sort();
  return canonicalSha256({
    kind: 'performance',
    metric,
    route: finding.route || '/',
    device,
    resources,
  });
}

function accessibilityGroupKey(finding) {
  const canonicalRuleId = canonicalRuleForFixUnit(
    finding.canonicalRuleId || finding.nativeRuleId,
  );
  const region = rootCauseRegion(finding);
  return canonicalSha256({
    kind: 'accessibility',
    canonicalRuleId,
    pageState: finding.pageState || 'initial',
    region,
  });
}

function groupKey(finding) {
  return unitKind(finding) === 'performance'
    ? performanceGroupKey(finding)
    : accessibilityGroupKey(finding);
}

function sourceOwner(finding) {
  const source = finding.source || {};
  return {
    file: normalizeSourcePath(source.file) || null,
    line: Number.isInteger(source.line) && source.line > 0 ? source.line : null,
    preimageSha256: source.preimageSha256 || null,
    preimageRange: source.preimageRange || null,
    confidence: source.confidence || 'none',
    method: source.method || 'unresolved',
  };
}

function collectEvidence(finding) {
  const observations = finding.evidence?.observations || [];
  if (observations.length > 0) {
    return observations.map((observation) => ({
      layer: observation.layer || finding.layer,
      nativeRuleId: observation.nativeRuleId || finding.nativeRuleId,
      message: observation.message || finding.evidence?.message || null,
      route: finding.route || '/',
      source: clone(finding.source || null),
    }));
  }
  return [{
    layer: finding.layer,
    nativeRuleId: finding.nativeRuleId,
    message: finding.evidence?.message || null,
    route: finding.route || '/',
    source: clone(finding.source || null),
  }];
}

function buildTitle(findings) {
  const primary = findings[0];
  const rule = primary.canonicalRuleId || primary.nativeRuleId || 'issue';
  const file = primary.source?.file;
  if (file) return `${rule} in ${normalizeSourcePath(file)}`;
  return `${rule} on ${primary.route || '/'}`;
}

function finalizeUnit(findings) {
  const ordered = [...findings].sort((a, b) =>
    String(a.findingId).localeCompare(String(b.findingId))
  );
  const primary = ordered[0];
  const routes = [...new Set(ordered.map((finding) => finding.route || '/'))].sort();
  const evidence = [...new Map(
    ordered
      .flatMap(collectEvidence)
      .map((item) => [
        `${item.layer}|${item.nativeRuleId}|${item.route}|${item.message || ''}`,
        item,
      ])
  ).values()].sort((a, b) => `${a.layer}|${a.nativeRuleId}`.localeCompare(`${b.layer}|${b.nativeRuleId}`));

  const owner = [...ordered]
    .sort((a, b) => {
      const rank = { high: 1, medium: 2, low: 3, none: 4 };
      return (rank[a.source?.confidence] || 99) - (rank[b.source?.confidence] || 99);
    })[0];

  return {
    fixUnitId: groupKey(primary),
    kind: unitKind(primary),
    title: buildTitle(ordered),
    canonicalRuleId: canonicalRuleForFixUnit(primary.canonicalRuleId || primary.nativeRuleId),
    pageState: primary.pageState || 'initial',
    sourceOwner: sourceOwner(owner),
    findingIds: ordered.map((finding) => finding.findingId),
    affectedRoutes: routes,
    evidence,
    status: owner.source?.file ? 'ready' : 'trace-required',
    findings: ordered.map((finding) => clone(finding)),
  };
}

export function buildFixUnits(findings = []) {
  const seenIds = new Set();
  for (const finding of findings) {
    if (!finding?.findingId || typeof finding.findingId !== 'string') {
      throw new FixCanonicalizerError('MISSING_FINDING_ID', 'Each finding must include a findingId.');
    }
    if (seenIds.has(finding.findingId)) {
      throw new FixCanonicalizerError(
        'DUPLICATE_FINDING_ID',
        `Duplicate findingId ${finding.findingId} is not allowed.`,
      );
    }
    seenIds.add(finding.findingId);
  }

  const groups = new Map();
  for (const finding of findings) {
    const key = groupKey(finding);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(finding);
  }
  return [...groups.values()]
    .map(finalizeUnit)
    .sort((a, b) => a.fixUnitId.localeCompare(b.fixUnitId));
}

/**
 * Build fix units from projected legacy V1 violations without changing the V1 field set.
 */
export function buildFixUnitsFromProjectedViolations(violations = []) {
  return buildFixUnits(violations.map((violation) => ({
    findingId: violation.id,
    nativeRuleId: violation.ruleId,
    canonicalRuleId: violation.canonicalRuleId || violation.ruleId,
    layer: violation.layer,
    category: violation.category || 'accessibility',
    pageState: violation.pageState || 'initial',
    route: violation.route || '/',
    element: {
      selector: violation.element?.selector || '',
      normalizedHtmlHash: violation.element?.normalizedHtmlHash
        || normalizedHtmlSha256(violation.element?.outerHTML || ''),
      outerHTML: violation.element?.outerHTML || '',
      ...(Array.isArray(violation.element?.framePath) ? { framePath: [...violation.element.framePath] } : {}),
      ...(Array.isArray(violation.element?.shadowPath) ? { shadowPath: [...violation.element.shadowPath] } : {}),
    },
    source: violation.source || {},
    evidence: violation.evidence || {},
    fix: violation.fix || { deterministic: false },
  })));
}

export function mergeEvidenceIntoUnit(unit, evidenceItem) {
  const next = clone(unit);
  const key = `${evidenceItem.layer}|${evidenceItem.nativeRuleId}|${evidenceItem.route || '/'}|${evidenceItem.message || ''}`;
  const existing = new Map(
    (next.evidence || []).map((item) => [
      `${item.layer}|${item.nativeRuleId}|${item.route || '/'}|${item.message || ''}`,
      item,
    ])
  );
  existing.set(key, evidenceItem);
  next.evidence = [...existing.values()].sort((a, b) =>
    `${a.layer}|${a.nativeRuleId}`.localeCompare(`${b.layer}|${b.nativeRuleId}`)
  );
  return next;
}
