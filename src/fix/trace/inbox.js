import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  realpathSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { buildSourcePreimage } from '../../tracer/preimage.js';
import { normalizeSourcePath } from '../../reporter/fingerprint.js';
import { mergeEvidenceIntoUnit } from '../canonical/fix-unit.js';
import { readBoundedFile } from '../review/secure-io.js';

const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function writeAuditEventToDisk(inbox, event) {
  mkdirSync(inbox.sessionDir, { recursive: true, mode: 0o700 });
  chmodSync(inbox.sessionDir, 0o700);
  const auditPath = join(inbox.sessionDir, 'trace-audit.jsonl');
  appendFileSync(
    auditPath,
    `${JSON.stringify(event)}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
  if (existsSync(auditPath)) chmodSync(auditPath, 0o600);
}

function persistAuditEvent(inbox, event) {
  if (inbox.sessionDir) writeAuditEventToDisk(inbox, event);
  inbox.auditLog.push(event);
}

function validateMappingInputs({
  findingId,
  file,
  line,
  expectedPreimageSha256,
} = {}) {
  if (!findingId || typeof findingId !== 'string') {
    return { ok: false, reason: 'INVALID_MAPPING_INPUT' };
  }
  if (!file || typeof file !== 'string') {
    return { ok: false, reason: 'INVALID_MAPPING_INPUT' };
  }
  if (!Number.isInteger(line) || line <= 0) {
    return { ok: false, reason: 'INVALID_MAPPING_INPUT' };
  }
  if (!SHA256_PATTERN.test(expectedPreimageSha256 || '')) {
    return { ok: false, reason: 'EXPECTED_PREIMAGE_REQUIRED' };
  }
  return { ok: true };
}

function validateMappingPath(localRoot, file) {
  if (!localRoot || !existsSync(localRoot)) {
    return { ok: false, reason: 'LOCAL_ROOT_MISSING' };
  }

  const normalized = normalizeSourcePath(file);
  if (!normalized || normalized.includes('..') || isAbsolute(normalized)) {
    return { ok: false, reason: 'PATH_OUTSIDE_LOCAL_ROOT' };
  }

  const absoluteRoot = realpathSync(localRoot);
  const candidatePath = resolve(absoluteRoot, normalized);
  if (!existsSync(candidatePath)) {
    return { ok: false, reason: 'FILE_NOT_FOUND' };
  }
  const resolvedPath = realpathSync(candidatePath);
  const rel = relative(absoluteRoot, resolvedPath);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    return { ok: false, reason: 'PATH_OUTSIDE_LOCAL_ROOT' };
  }
  return { ok: true, file: normalized, absoluteRoot, resolvedPath };
}

function computePreimageFromResolvedPath(resolvedPath, line) {
  try {
    const content = readBoundedFile(resolvedPath, MAX_SOURCE_BYTES);
    if (content == null) return null;
    return buildSourcePreimage(content, line);
  } catch {
    return null;
  }
}

export function verifySourceCandidate(inbox, partial) {
  if (!partial?.file || !Number.isInteger(partial.line) || partial.line <= 0) {
    return { ok: false, reason: 'SOURCE_TRACE_UNATTESTED' };
  }
  if (!SHA256_PATTERN.test(partial.preimageSha256 || '')) {
    return { ok: false, reason: 'SOURCE_TRACE_UNATTESTED' };
  }

  const pathCheck = validateMappingPath(inbox.localRoot, partial.file);
  if (!pathCheck.ok) {
    return { ok: false, reason: pathCheck.reason === 'FILE_NOT_FOUND'
      ? 'SOURCE_PREIMAGE_MISMATCH'
      : pathCheck.reason };
  }

  const computed = computePreimageFromResolvedPath(pathCheck.resolvedPath, partial.line);
  if (!computed?.preimageSha256) {
    return { ok: false, reason: 'SOURCE_PREIMAGE_MISMATCH' };
  }
  if (computed.preimageSha256 !== partial.preimageSha256) {
    return { ok: false, reason: 'SOURCE_PREIMAGE_MISMATCH' };
  }

  return {
    ok: true,
    source: {
      file: pathCheck.file,
      line: partial.line,
      preimageSha256: computed.preimageSha256,
      confidence: partial.confidence || 'high',
      method: partial.method || 'verified-source',
    },
  };
}

export function createSourceTraceInbox({
  reportId,
  localRoot,
  sessionDir = null,
  candidates = [],
} = {}) {
  return {
    reportId,
    localRoot,
    sessionDir,
    candidates: clone(candidates),
    manualMappings: new Map(),
    auditLog: [],
  };
}

function partialWithEditorLink(inbox, partial) {
  return {
    file: partial.file,
    line: partial.line ?? null,
    confidence: partial.confidence || 'low',
    method: partial.method || 'candidate',
    preimageSha256: partial.preimageSha256 || null,
    validationStatus: partial.validationStatus || null,
    validationReason: partial.validationReason || null,
    editorLink: buildEditorDeepLink({
      localRoot: inbox.localRoot,
      file: partial.file,
      line: partial.line,
    }),
  };
}

function manualMappingLookup(inbox, findingId) {
  if (!inbox?.manualMappings) return null;
  if (inbox.manualMappings instanceof Map) {
    return inbox.manualMappings.get(findingId) || null;
  }
  return inbox.manualMappings[findingId] || null;
}

export function traceAllFindings(inbox, findings = []) {
  const candidateMap = new Map(
    (inbox?.candidates || []).map((entry) => [entry.findingId, entry.partials || []]),
  );

  return findings.map((finding) => {
    const partials = new Map();
    for (const partial of candidateMap.get(finding.findingId) || []) {
      if (!partial?.file) continue;
      partials.set(partialKey(partial), partial);
    }

    const manual = manualMappingLookup(inbox, finding.findingId);
    let manualPartial = null;
    if (manual?.file) {
      manualPartial = {
        file: manual.file,
        line: manual.line,
        confidence: 'high',
        method: 'manual-mapping',
        preimageSha256: manual.computedPreimageSha256 || manual.expectedPreimageSha256 || null,
      };
    }

    const attested = attestedPartialFromFinding(finding);
    if (attested?.file && !manualPartial) {
      partials.set(partialKey(attested), attested);
    }

    if (manualPartial) {
      partials.set(partialKey(manualPartial), manualPartial);
    }

    const verifiedSources = new Map();
    const resolvedPartials = [];
    for (const partial of partials.values()) {
      const verification = verifySourceCandidate(inbox, partial);
      const enriched = partialWithEditorLink(inbox, {
        ...partial,
        validationStatus: verification.ok ? 'verified' : 'rejected',
        validationReason: verification.ok ? null : verification.reason,
      });
      resolvedPartials.push(enriched);
      if (verification.ok) {
        verifiedSources.set(
          `${verification.source.file}|${verification.source.line}|${verification.source.preimageSha256}`,
          verification.source,
        );
      }
    }

    const manualVerified = manualPartial
      ? verifySourceCandidate(inbox, manualPartial)
      : null;
    if (manualVerified?.ok) {
      return {
        findingId: finding.findingId,
        route: finding.route || '/',
        unresolved: false,
        reason: null,
        verifiedSource: manualVerified.source,
        partials: resolvedPartials,
      };
    }

    let verifiedSource = null;
    let reason = null;
    if (verifiedSources.size > 1) {
      reason = 'AMBIGUOUS_MAPPING';
    } else if (verifiedSources.size === 1) {
      verifiedSource = [...verifiedSources.values()][0];
    } else if (attested?.file || manual?.file) {
      reason = resolvedPartials.some((partial) => partial.validationReason === 'SOURCE_PREIMAGE_MISMATCH')
        ? 'SOURCE_PREIMAGE_MISMATCH'
        : 'SOURCE_TRACE_UNATTESTED';
    }

    return {
      findingId: finding.findingId,
      route: finding.route || '/',
      unresolved: !verifiedSource,
      reason,
      verifiedSource,
      partials: resolvedPartials,
    };
  });
}

export function applyTraceResultsToFindings(findings = [], traceResults = []) {
  const traceByFindingId = new Map(traceResults.map((result) => [result.findingId, result]));

  return findings.map((finding) => {
    const trace = traceByFindingId.get(finding.findingId);
    const next = clone(finding);
    if (!trace?.verifiedSource) {
      next.source = {
        ...(next.source || {}),
        file: null,
        line: null,
        confidence: 'none',
        method: trace?.reason || 'unresolved',
        preimageSha256: null,
        preimageRange: null,
      };
      return next;
    }

    next.source = {
      ...(next.source || {}),
      file: trace.verifiedSource.file,
      line: trace.verifiedSource.line,
      confidence: trace.verifiedSource.confidence || 'high',
      method: trace.verifiedSource.method || 'verified-source',
      preimageSha256: trace.verifiedSource.preimageSha256,
    };
    return next;
  });
}

function partialKey(partial) {
  return `${partial.file}|${partial.line}|${partial.preimageSha256 || ''}|${partial.method || ''}`;
}

function attestedPartialFromFinding(finding) {
  const source = finding.source || {};
  if (!source.file || !Number.isInteger(source.line) || source.line <= 0) {
    return null;
  }
  return {
    file: normalizeSourcePath(source.file),
    line: source.line,
    confidence: source.confidence || 'high',
    method: source.method || 'attested-source',
    preimageSha256: source.preimageSha256 || null,
  };
}

export function buildEditorDeepLink({
  localRoot,
  file,
  line = null,
  editor = 'vscode',
} = {}) {
  if (!file || typeof file !== 'string') return null;
  const normalized = normalizeSourcePath(file);
  if (!normalized || normalized.includes('..') || isAbsolute(normalized)) return null;
  if (!Number.isInteger(line) || line <= 0) return null;
  if (!localRoot || !existsSync(localRoot)) return null;

  const absolutePath = join(localRoot, normalized);
  const location = `${absolutePath}:${line}`;
  if (editor === 'cursor') return `cursor://file/${location}`;
  return `vscode://file/${location}`;
}

export function applyManualMapping(inbox, {
  findingId,
  file,
  line,
  reportId,
  expectedPreimageSha256 = null,
} = {}) {
  const inputCheck = validateMappingInputs({
    findingId,
    file,
    line,
    expectedPreimageSha256,
  });
  if (!inputCheck.ok) return inputCheck;

  if (reportId !== inbox.reportId) {
    return { ok: false, reason: 'REPORT_HASH_MISMATCH' };
  }

  const pathCheck = validateMappingPath(inbox.localRoot, file);
  if (!pathCheck.ok) return pathCheck;

  const computed = computePreimageFromResolvedPath(pathCheck.resolvedPath, line);
  if (!computed?.preimageSha256) {
    return { ok: false, reason: 'SOURCE_PREIMAGE_MISMATCH' };
  }
  if (computed.preimageSha256 !== expectedPreimageSha256) {
    return { ok: false, reason: 'SOURCE_PREIMAGE_MISMATCH' };
  }

  const existing = inbox.manualMappings.get(findingId);
  if (
    existing
    && (existing.file !== pathCheck.file || existing.line !== line
      || existing.expectedPreimageSha256 !== expectedPreimageSha256)
  ) {
    return { ok: false, reason: 'AMBIGUOUS_MAPPING' };
  }
  if (
    existing
    && existing.file === pathCheck.file
    && existing.line === line
    && existing.expectedPreimageSha256 === expectedPreimageSha256
  ) {
    return {
      ok: true,
      mapping: existing,
      auditEvent: null,
      idempotent: true,
    };
  }

  const mapping = {
    findingId,
    file: pathCheck.file,
    line,
    expectedPreimageSha256,
    computedPreimageSha256: computed.preimageSha256,
  };

  const auditEvent = {
    type: 'manual_source_mapping',
    reportId: inbox.reportId,
    findingId,
    file: pathCheck.file,
    line,
    expectedPreimageSha256,
    computedPreimageSha256: computed.preimageSha256,
  };

  if (inbox.sessionDir) {
    try {
      writeAuditEventToDisk(inbox, auditEvent);
    } catch {
      return { ok: false, reason: 'AUDIT_PERSIST_FAILED' };
    }
  }

  inbox.manualMappings.set(findingId, mapping);
  inbox.auditLog.push(auditEvent);

  return { ok: true, mapping, auditEvent };
}

export function mergeTraceEvidence(unit, evidenceItem, inbox) {
  if (inbox?.reportId && evidenceItem?.source?.preimageSha256) {
    persistAuditEvent(inbox, {
      type: 'trace_evidence_merged',
      reportId: inbox.reportId,
      fixUnitId: unit.fixUnitId,
      layer: evidenceItem.layer,
      nativeRuleId: evidenceItem.nativeRuleId,
      preimageSha256: evidenceItem.source.preimageSha256,
    });
  }
  return mergeEvidenceIntoUnit(unit, evidenceItem);
}
