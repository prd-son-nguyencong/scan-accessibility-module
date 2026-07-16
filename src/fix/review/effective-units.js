import { mergeEvidenceIntoUnit } from '../canonical/fix-unit.js';
import { buildEditorDeepLink } from '../trace/inbox.js';
import { normalizeSourcePath } from '../../reporter/fingerprint.js';
import { TRACE_SHA256_PATTERN } from './trace-audit.js';

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function applyMappingToFinding(finding, mapping) {
  if (!mapping?.file) return finding;
  const next = clone(finding);
  next.source = {
    ...(next.source || {}),
    file: normalizeSourcePath(mapping.file),
    line: mapping.line,
    confidence: 'high',
    method: 'manual-mapping',
    preimageSha256: mapping.computedPreimageSha256 || mapping.expectedPreimageSha256 || null,
  };
  return next;
}

function deriveSourceOwner(findings = []) {
  const ranked = [...findings].sort((a, b) => {
    const rank = { high: 1, medium: 2, low: 3, none: 4 };
    return (rank[a.source?.confidence] || 99) - (rank[b.source?.confidence] || 99);
  });
  const owner = ranked.find((finding) => finding.source?.file) || findings[0];
  const source = owner?.source || {};
  return {
    file: source.file ? normalizeSourcePath(source.file) : null,
    line: Number.isInteger(source.line) && source.line > 0 ? source.line : null,
    preimageSha256: source.preimageSha256 || null,
    preimageRange: source.preimageRange || null,
    confidence: source.confidence || 'none',
    method: source.method || 'unresolved',
  };
}

function deriveUnitStatus(findings = []) {
  if (findings.length === 0) return 'trace-required';
  const mapped = findings.filter((finding) => finding.source?.file && finding.source?.line && finding.source?.preimageSha256);
  if (mapped.length !== findings.length) return 'trace-required';
  const preimages = [...new Set(mapped.map((finding) => finding.source.preimageSha256))];
  if (preimages.length !== 1) return 'trace-required';
  return 'ready';
}

function materializeMappedBaseUnits(state) {
  const mappingByFinding = state.manualMappings || {};
  return (state.baseFixUnits || []).map((unit) => {
    const findings = (unit.findings || []).map((finding) => {
      const mapping = mappingByFinding[finding.findingId];
      return mapping ? applyMappingToFinding(finding, mapping) : clone(finding);
    });
    const sourceOwner = deriveSourceOwner(findings);
    return {
      ...clone(unit),
      findings,
      findingIds: findings.map((finding) => finding.findingId),
      sourceOwner,
      status: deriveUnitStatus(findings),
      affectedRoutes: [...new Set(findings.map((finding) => finding.route || '/'))].sort(),
    };
  });
}

function applyMergeOverlays(units, mergeOverlays = []) {
  const byId = new Map(units.map((unit) => [unit.fixUnitId, unit]));
  const hidden = new Set();
  for (const overlay of mergeOverlays) {
    const source = byId.get(overlay.sourceFixUnitId);
    const target = byId.get(overlay.targetFixUnitId);
    if (!source || !target || hidden.has(overlay.sourceFixUnitId)) continue;
    const mergedFindings = [...(target.findings || [])];
    for (const finding of source.findings || []) {
      if (!mergedFindings.some((item) => item.findingId === finding.findingId)) {
        mergedFindings.push(clone(finding));
      }
    }
    mergedFindings.sort((a, b) => String(a.findingId).localeCompare(String(b.findingId)));
    let merged = {
      ...target,
      findings: mergedFindings,
      findingIds: mergedFindings.map((finding) => finding.findingId),
      affectedRoutes: [...new Set([
        ...(target.affectedRoutes || []),
        ...(source.affectedRoutes || []),
      ])].sort(),
    };
    for (const evidenceItem of source.evidence || []) {
      merged = mergeEvidenceIntoUnit(merged, evidenceItem);
    }
    merged.sourceOwner = deriveSourceOwner(merged.findings);
    merged.status = deriveUnitStatus(merged.findings);
    byId.set(target.fixUnitId, merged);
    hidden.add(source.fixUnitId);
  }
  return [...byId.values()].filter((unit) => !hidden.has(unit.fixUnitId));
}

export function materializeEffectiveUnits(state) {
  const mapped = materializeMappedBaseUnits(state);
  return applyMergeOverlays(mapped, state.mergeOverlays || []);
}

export function effectiveUnitById(state, fixUnitId) {
  return materializeEffectiveUnits(state).find((unit) => unit.fixUnitId === fixUnitId) || null;
}

export function mergedAwayUnitIds(state) {
  return new Set((state.mergeOverlays || []).map((overlay) => overlay.sourceFixUnitId));
}

export function isDecisionPending(decision = {}) {
  return decision.decision === 'pending' && !decision.revisionNote && !decision.rejectReason;
}

export function hasRegisteredCandidate(state, fixUnitId) {
  const candidate = state.candidates?.[fixUnitId];
  return Boolean(candidate?.candidateHash);
}

export function rootCauseMatches(source, target) {
  if (!source || !target) return false;
  if (source.kind !== 'accessibility' || target.kind !== 'accessibility') return false;
  if (source.status !== 'ready' || target.status !== 'ready') return false;
  if (source.canonicalRuleId !== target.canonicalRuleId) return false;
  if ((source.pageState || 'initial') !== (target.pageState || 'initial')) return false;
  const sourcePreimage = source.sourceOwner?.preimageSha256;
  const targetPreimage = target.sourceOwner?.preimageSha256;
  return Boolean(sourcePreimage && targetPreimage && sourcePreimage === targetPreimage);
}

export function eligibleMergeTargets(state, sourceFixUnitId) {
  const effective = materializeEffectiveUnits(state);
  const source = effective.find((unit) => unit.fixUnitId === sourceFixUnitId);
  if (!source || !rootCauseMatches(source, source)) return [];
  const sourceDecision = state.decisions?.[sourceFixUnitId];
  if (!isDecisionPending(sourceDecision || {})) return [];
  if (hasRegisteredCandidate(state, sourceFixUnitId)) return [];

  return effective
    .filter((target) => {
      if (target.fixUnitId === sourceFixUnitId) return false;
      if (!rootCauseMatches(source, target)) return false;
      const decision = state.decisions?.[target.fixUnitId];
      if (!isDecisionPending(decision || {})) return false;
      if (hasRegisteredCandidate(state, target.fixUnitId)) return false;
      if ((decision || {}).revisionNote) return false;
      return true;
    })
    .map((target) => ({
      fixUnitId: target.fixUnitId,
      title: target.title,
      sourceFile: target.sourceOwner?.file || null,
      canonicalRuleId: target.canonicalRuleId,
    }));
}

export function buildMergeOverlay(source, target) {
  return {
    sourceFixUnitId: source.fixUnitId,
    targetFixUnitId: target.fixUnitId,
    sharedPreimageSha256: source.sourceOwner.preimageSha256,
    canonicalRuleId: source.canonicalRuleId,
    pageState: source.pageState || 'initial',
    kind: 'accessibility',
    sourceFindingIds: [...(source.findingIds || [])].sort(),
    targetFindingIds: [...(target.findingIds || [])].sort(),
    at: new Date().toISOString(),
  };
}

export function validateMergeOverlayRecord(overlay, source, target) {
  if (!overlay || typeof overlay !== 'object') {
    throw new Error('Invalid merge overlay.');
  }
  if (!TRACE_SHA256_PATTERN.test(overlay.sharedPreimageSha256 || '')) {
    throw new Error('Merge overlay shared preimage is invalid.');
  }
  if (overlay.sourceFixUnitId !== source.fixUnitId || overlay.targetFixUnitId !== target.fixUnitId) {
    throw new Error('Merge overlay unit IDs mismatch.');
  }
  if (overlay.canonicalRuleId !== source.canonicalRuleId || overlay.canonicalRuleId !== target.canonicalRuleId) {
    throw new Error('Merge overlay canonicalRuleId mismatch.');
  }
  if ((overlay.pageState || 'initial') !== (source.pageState || 'initial')) {
    throw new Error('Merge overlay pageState mismatch.');
  }
  if (overlay.kind !== 'accessibility') {
    throw new Error('Merge overlay kind mismatch.');
  }
  const sourceIds = [...(overlay.sourceFindingIds || [])].sort().join('|');
  const targetIds = [...(overlay.targetFindingIds || [])].sort().join('|');
  const expectedSourceIds = [...(source.findingIds || [])].sort().join('|');
  const expectedTargetIds = [...(target.findingIds || [])].sort().join('|');
  if (sourceIds !== expectedSourceIds || targetIds !== expectedTargetIds) {
    throw new Error('Merge overlay finding IDs mismatch.');
  }
  if (source.sourceOwner?.preimageSha256 !== overlay.sharedPreimageSha256) {
    throw new Error('Merge overlay source preimage mismatch.');
  }
  if (target.sourceOwner?.preimageSha256 !== overlay.sharedPreimageSha256) {
    throw new Error('Merge overlay target preimage mismatch.');
  }
  if (!rootCauseMatches(source, target)) {
    throw new Error('Merge overlay root-cause identity mismatch.');
  }
}

export function validateMergeOverlaySequence(baseFixUnits, manualMappings, mergeOverlays = []) {
  const replayState = {
    baseFixUnits,
    manualMappings: manualMappings || {},
    mergeOverlays: [],
  };
  const sourcesUsed = new Set();
  const priorTargets = new Set();
  const mergedAway = new Set();

  for (const overlay of mergeOverlays) {
    if (sourcesUsed.has(overlay.sourceFixUnitId)) {
      throw new Error('Duplicate merge source overlay.');
    }
    if (mergedAway.has(overlay.sourceFixUnitId) || mergedAway.has(overlay.targetFixUnitId)) {
      throw new Error('Merge overlay references hidden unit.');
    }
    if (priorTargets.has(overlay.sourceFixUnitId)) {
      throw new Error('Merge overlay chain is not allowed.');
    }
    const effective = materializeEffectiveUnits(replayState);
    const source = effective.find((unit) => unit.fixUnitId === overlay.sourceFixUnitId);
    const target = effective.find((unit) => unit.fixUnitId === overlay.targetFixUnitId);
    if (!source || !target) {
      throw new Error('Merge overlay references unknown unit.');
    }
    validateMergeOverlayRecord(overlay, source, target);
    replayState.mergeOverlays.push(overlay);
    sourcesUsed.add(overlay.sourceFixUnitId);
    priorTargets.add(overlay.targetFixUnitId);
    mergedAway.add(overlay.sourceFixUnitId);
  }
}

export function editorLinkForUnit(state, unit) {
  return buildEditorDeepLink({
    localRoot: state.localRoot,
    file: unit.sourceOwner?.file,
    line: unit.sourceOwner?.line,
  });
}

export {
  clone,
  deriveSourceOwner,
  deriveUnitStatus,
  applyMappingToFinding,
};
