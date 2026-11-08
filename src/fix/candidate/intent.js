import { createHash } from 'node:crypto';
import { canonicalSha256 } from '../../reporter/fingerprint.js';
import { buildSourcePreimage, buildSourcePreimageRange } from '../../tracer/preimage.js';
import { CIS_VALIDATION_LIMITS } from '../cis/limits.js';
import { resolveTrustedRoot } from '../controller/local-attestation.js';
import {
  applyEditToBytes,
  applyEditsToBytes,
  decodeUtf8Bytes,
  resolveEditByteOffsets,
} from './bytes.js';
import { readSecureFileBytes, resolveSecureSourceFile, validateRelativeCandidatePath } from './path.js';

export class CandidateIntentError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CandidateIntentError';
    this.code = code;
  }
}

export const CANDIDATE_LIMITS = Object.freeze({
  maxEditsPerCandidate: CIS_VALIDATION_LIMITS.maxEditsPerPatch,
  maxFileBytes: CIS_VALIDATION_LIMITS.maxBlockBytes,
  maxEditTextChars: CIS_VALIDATION_LIMITS.maxEditTextChars,
  maxCandidateBytes: 256 * 1024,
  allowedExtensions: CIS_VALIDATION_LIMITS.allowedTextExtensions,
});

const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const entry of Object.values(value)) deepFreeze(entry);
  return value;
}

function assertSha256(value, code, message) {
  if (!SHA256_PATTERN.test(String(value || ''))) {
    throw new CandidateIntentError(code, message);
  }
}

export function hashFileBytes(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

export function hashFileContent(content) {
  return hashFileBytes(Buffer.from(String(content), 'utf8'));
}

function validateBlockRange(range) {
  if (!range || typeof range !== 'object') {
    throw new CandidateIntentError('INVALID_RANGE', 'Block range is required.');
  }
  const startLine = range.startLine ?? range.start;
  const endLine = range.endLine ?? range.end;
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine) {
    throw new CandidateIntentError('INVALID_RANGE', 'Block range must use positive 1-based line numbers.');
  }
  return { startLine, endLine };
}

function assertAllowedExtension(file) {
  const ext = file.slice(file.lastIndexOf('.'));
  if (!CANDIDATE_LIMITS.allowedExtensions.includes(ext)) {
    throw new CandidateIntentError('UNSUPPORTED_EXTENSION', `Extension ${ext} is not allowlisted.`);
  }
}

function validateEditIntent(edit, fileMap, localRoot) {
  if (!edit || typeof edit !== 'object') {
    throw new CandidateIntentError('INVALID_EDIT', 'Edit intent must be an object.');
  }
  const file = validateRelativeCandidatePath(edit.file);
  assertAllowedExtension(file);
  const range = validateBlockRange(edit.blockRange || edit.range);
  assertSha256(edit.expectedBlockSha256, 'INVALID_HASH', 'expectedBlockSha256 is invalid.');
  assertSha256(edit.expectedFileSha256, 'INVALID_HASH', 'expectedFileSha256 is invalid.');

  const oldText = String(edit.oldText ?? '');
  const newText = String(edit.newText ?? '');
  if (!oldText) {
    throw new CandidateIntentError('EMPTY_OLD_TEXT', 'oldText must be non-empty.');
  }
  if (oldText.length > CANDIDATE_LIMITS.maxEditTextChars || newText.length > CANDIDATE_LIMITS.maxEditTextChars) {
    throw new CandidateIntentError('EDIT_TOO_LARGE', 'Edit text exceeds allowed size.');
  }
  if (oldText === newText) {
    throw new CandidateIntentError('NO_OP_EDIT', 'Edit would not change source content.');
  }
  if (oldText.includes('\0') || newText.includes('\0')) {
    throw new CandidateIntentError('NUL_BYTE', 'Edit text must not contain NUL bytes.');
  }

  let state = fileMap.get(file);
  if (!state) {
    const resolved = resolveSecureSourceFile(localRoot, file, { maxBytes: CANDIDATE_LIMITS.maxFileBytes });
    const fileSha256 = hashFileBytes(resolved.bytes);
    if (fileSha256 !== edit.expectedFileSha256) {
      throw new CandidateIntentError('STALE_PREIMAGE', 'Whole-file hash does not match current disk content.');
    }
    const content = decodeUtf8Bytes(resolved.bytes);
    const preimage = range.startLine === range.endLine
      ? buildSourcePreimage(content, range.startLine)
      : buildSourcePreimageRange(content, range.startLine, range.endLine);
    if (!preimage || preimage.preimageSha256 !== edit.expectedBlockSha256) {
      throw new CandidateIntentError('HASH_MISMATCH', 'Block preimage hash does not match bound range.');
    }
    state = { file, bytes: resolved.bytes, fileSha256, resolvedPath: resolved.resolvedPath, mode: resolved.mode };
    fileMap.set(file, state);
  } else if (state.fileSha256 !== edit.expectedFileSha256) {
    throw new CandidateIntentError('STALE_PREIMAGE', 'Conflicting expected file hash for the same path.');
  }

  const offsets = resolveEditByteOffsets(state.bytes, oldText, range.startLine, range.endLine);
  return {
    file,
    blockRange: { startLine: range.startLine, endLine: range.endLine },
    expectedBlockSha256: edit.expectedBlockSha256,
    expectedFileSha256: edit.expectedFileSha256,
    oldText,
    newText,
    startOffset: offsets.startOffset,
    endOffset: offsets.endOffset,
  };
}

function assertNoOverlap(edits) {
  const byFile = new Map();
  for (const edit of edits) {
    if (!byFile.has(edit.file)) byFile.set(edit.file, []);
    byFile.get(edit.file).push(edit);
  }
  for (const fileEdits of byFile.values()) {
    const sorted = [...fileEdits].sort((a, b) => a.startOffset - b.startOffset);
    for (let i = 1; i < sorted.length; i += 1) {
      if (sorted[i].startOffset < sorted[i - 1].endOffset) {
        throw new CandidateIntentError('OVERLAPPING_EDITS', 'Overlapping edits within a file are not allowed.');
      }
    }
  }
}

function canonicalEditForHash(edit) {
  return {
    file: edit.file,
    blockRange: edit.blockRange,
    expectedBlockSha256: edit.expectedBlockSha256,
    expectedFileSha256: edit.expectedFileSha256,
    oldText: edit.oldText,
    newText: edit.newText,
  };
}

export function computeCandidateHash({
  reportId,
  policyVersion,
  promptVersion,
  modelId,
  edits,
}) {
  const ordered = [...edits]
    .map(canonicalEditForHash)
    .sort((a, b) => `${a.file}|${a.blockRange.startLine}|${a.oldText}`.localeCompare(`${b.file}|${b.blockRange.startLine}|${b.oldText}`));
  return canonicalSha256({
    reportId,
    policyVersion,
    promptVersion,
    modelId,
    edits: ordered,
  });
}

export function validateAndBuildCandidate({
  localRoot,
  reportId,
  policyVersion,
  promptVersion = '',
  modelId = '',
  edits = [],
}) {
  const rootCheck = resolveTrustedRoot(localRoot);
  if (!rootCheck.ok) {
    throw new CandidateIntentError(rootCheck.reason || 'LOCAL_ROOT_MISSING', 'Local root is unavailable.');
  }
  if (!Array.isArray(edits) || edits.length === 0) {
    throw new CandidateIntentError('INVALID_EDIT', 'At least one edit intent is required.');
  }
  if (edits.length > CANDIDATE_LIMITS.maxEditsPerCandidate) {
    throw new CandidateIntentError('TOO_MANY_EDITS', 'Candidate exceeds allowed edit count.');
  }

  const fileMap = new Map();
  const validated = edits.map((edit) => validateEditIntent(edit, fileMap, rootCheck.localRoot));
  assertNoOverlap(validated);

  const candidateHash = computeCandidateHash({
    reportId,
    policyVersion,
    promptVersion,
    modelId,
    edits: validated,
  });

  const candidate = deepFreeze({
    reportId,
    policyVersion,
    promptVersion,
    modelId,
    localRoot: rootCheck.localRoot,
    edits: validated.map((entry) => deepFreeze({ ...entry })),
    candidateHash,
  });

  if (Buffer.byteLength(JSON.stringify(candidate), 'utf8') > CANDIDATE_LIMITS.maxCandidateBytes) {
    throw new CandidateIntentError('CANDIDATE_TOO_LARGE', 'Candidate exceeds allowed serialized size.');
  }

  return candidate;
}

export function applyEditToText(content, edit) {
  const bytes = Buffer.from(String(content), 'utf8');
  return decodeUtf8Bytes(applyEditToBytes(bytes, edit));
}

export { applyEditToBytes, applyEditsToBytes };

export function applyEditsToText(content, edits) {
  const bytes = Buffer.from(String(content), 'utf8');
  return decodeUtf8Bytes(applyEditsToBytes(bytes, edits));
}

export function touchedFilesForCandidate(candidate) {
  return [...new Set(candidate.edits.map((edit) => edit.file))].sort();
}

export function readCurrentFileHash(localRoot, file) {
  const normalized = validateRelativeCandidatePath(file);
  const resolved = resolveSecureSourceFile(localRoot, normalized, { maxBytes: CANDIDATE_LIMITS.maxFileBytes });
  return hashFileBytes(resolved.bytes);
}

export function readCurrentFileBytes(localRoot, file) {
  const resolved = resolveSecureSourceFile(localRoot, file, { maxBytes: CANDIDATE_LIMITS.maxFileBytes });
  return resolved.bytes;
}

export function assertNoCrossCandidateConflicts(candidates = []) {
  const fileEdits = new Map();
  const fileHashes = new Map();
  for (const candidate of candidates) {
    for (const edit of candidate.edits || []) {
      if (!fileEdits.has(edit.file)) fileEdits.set(edit.file, []);
      fileEdits.get(edit.file).push(edit);
      const prior = fileHashes.get(edit.file);
      if (prior && prior !== edit.expectedFileSha256) {
        throw new CandidateIntentError('CROSS_CANDIDATE_HASH_CONFLICT', 'Conflicting expected file hashes across candidates.');
      }
      fileHashes.set(edit.file, edit.expectedFileSha256);
    }
  }
  for (const edits of fileEdits.values()) {
    assertNoOverlap(edits);
  }
}

export { readSecureFileBytes, validateRelativeCandidatePath };
