import { join } from 'node:path';
import { normalizeSourcePath } from '../../reporter/fingerprint.js';
import { readBoundedJsonLines, SecureIoError } from './secure-io.js';

export const MAX_TRACE_AUDIT_BYTES = 512 * 1024;
export const MAX_TRACE_AUDIT_LINES = 10_000;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;

export class TraceAuditError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'TraceAuditError';
    this.code = code;
  }
}

function validateRelativeMappingPath(file) {
  const normalized = normalizeSourcePath(file);
  if (!normalized || normalized.includes('..') || normalized.startsWith('/')) {
    throw new TraceAuditError('CORRUPT_TRACE_AUDIT', 'Manual mapping path must be relative and contained.');
  }
  return normalized;
}

function manualMappingRecord(event) {
  return {
    findingId: event.findingId,
    file: normalizeSourcePath(event.file),
    line: event.line,
    expectedPreimageSha256: event.expectedPreimageSha256,
    computedPreimageSha256: event.computedPreimageSha256,
  };
}

function sameManualMapping(left, right) {
  return left.findingId === right.findingId
    && left.file === right.file
    && left.line === right.line
    && left.expectedPreimageSha256 === right.expectedPreimageSha256
    && left.computedPreimageSha256 === right.computedPreimageSha256;
}

function validateAuditMappingEvent(event, findingId, knownFindingIds) {
  if (!event || typeof event !== 'object') {
    throw new TraceAuditError('CORRUPT_TRACE_AUDIT', 'Audit event must be an object.');
  }
  if (event.type !== 'manual_source_mapping') {
    throw new TraceAuditError('CORRUPT_TRACE_AUDIT', 'Unexpected audit event type.');
  }
  if (typeof event.reportId !== 'string' || !SHA256_PATTERN.test(event.reportId)) {
    throw new TraceAuditError('CORRUPT_TRACE_AUDIT', 'Audit event reportId is invalid.');
  }
  if (typeof event.findingId !== 'string' || event.findingId !== findingId) {
    throw new TraceAuditError('CORRUPT_TRACE_AUDIT', 'Audit event findingId is invalid.');
  }
  if (!knownFindingIds.has(findingId)) {
    throw new TraceAuditError('CORRUPT_TRACE_AUDIT', 'Audit event references unknown finding.');
  }
  validateRelativeMappingPath(event.file);
  if (!Number.isInteger(event.line) || event.line <= 0) {
    throw new TraceAuditError('CORRUPT_TRACE_AUDIT', 'Audit event line must be positive.');
  }
  if (!SHA256_PATTERN.test(event.expectedPreimageSha256 || '')) {
    throw new TraceAuditError('CORRUPT_TRACE_AUDIT', 'Audit event expected preimage is invalid.');
  }
  if (!SHA256_PATTERN.test(event.computedPreimageSha256 || '')) {
    throw new TraceAuditError('CORRUPT_TRACE_AUDIT', 'Audit event computed preimage is invalid.');
  }
  if (event.computedPreimageSha256 !== event.expectedPreimageSha256) {
    throw new TraceAuditError('CORRUPT_TRACE_AUDIT', 'Audit event preimage mismatch.');
  }
}

export function validateManualMappingRecord(mapping, findingId, knownFindingIds, { requireComputed = true } = {}) {
  if (!mapping || typeof mapping !== 'object') {
    throw new TraceAuditError('CORRUPT_TRACE_AUDIT', `Invalid manual mapping for ${findingId}.`);
  }
  if (mapping.findingId !== findingId || !knownFindingIds.has(findingId)) {
    throw new TraceAuditError('CORRUPT_TRACE_AUDIT', `Unknown manual mapping finding ${findingId}.`);
  }
  validateRelativeMappingPath(mapping.file);
  if (!Number.isInteger(mapping.line) || mapping.line <= 0) {
    throw new TraceAuditError('CORRUPT_TRACE_AUDIT', `Manual mapping line must be positive for ${findingId}.`);
  }
  if (!SHA256_PATTERN.test(mapping.expectedPreimageSha256 || '')) {
    throw new TraceAuditError('CORRUPT_TRACE_AUDIT', `Manual mapping expected preimage invalid for ${findingId}.`);
  }
  if (requireComputed && !SHA256_PATTERN.test(mapping.computedPreimageSha256 || '')) {
    throw new TraceAuditError('CORRUPT_TRACE_AUDIT', `Manual mapping computed preimage invalid for ${findingId}.`);
  }
  if (
    mapping.computedPreimageSha256 != null
    && mapping.computedPreimageSha256 !== mapping.expectedPreimageSha256
  ) {
    throw new TraceAuditError('CORRUPT_TRACE_AUDIT', `Manual mapping preimage mismatch for ${findingId}.`);
  }
}

export function loadManualMappingsFromTraceAudit(sessionDir, { reportId, knownFindingIds } = {}) {
  if (!sessionDir) return {};
  if (!reportId || !knownFindingIds) {
    throw new TraceAuditError('CORRUPT_TRACE_AUDIT', 'Audit replay requires reportId and known finding IDs.');
  }

  const auditPath = join(sessionDir, 'trace-audit.jsonl');
  let lines;
  try {
    lines = readBoundedJsonLines(auditPath, MAX_TRACE_AUDIT_BYTES, MAX_TRACE_AUDIT_LINES);
  } catch (error) {
    if (error instanceof SecureIoError) {
      throw new TraceAuditError(error.code === 'SYMLINK_FILE' ? 'SYMLINK_TRACE_AUDIT' : 'CORRUPT_TRACE_AUDIT', 'Trace audit file is not accessible.');
    }
    throw error;
  }
  if (lines.length === 0 && !readBoundedJsonLines(auditPath, 1, 1).length) {
    return {};
  }

  const mappings = {};
  for (const line of lines) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      throw new TraceAuditError('CORRUPT_TRACE_AUDIT', 'Trace audit contains invalid JSON.');
    }
    if (event.type !== 'manual_source_mapping') {
      continue;
    }
    if (event.reportId !== reportId) {
      throw new TraceAuditError('CORRUPT_TRACE_AUDIT', 'Trace audit reportId mismatch.');
    }
    validateAuditMappingEvent(event, event.findingId, knownFindingIds);
    const record = manualMappingRecord(event);
    const existing = mappings[event.findingId];
    if (existing) {
      if (!sameManualMapping(existing, record)) {
        throw new TraceAuditError('CORRUPT_TRACE_AUDIT', 'Conflicting duplicate manual mapping in trace audit.');
      }
      continue;
    }
    mappings[event.findingId] = record;
  }
  return mappings;
}

export { SHA256_PATTERN as TRACE_SHA256_PATTERN };
