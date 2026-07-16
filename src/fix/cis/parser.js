import { CIS_POC_LIMITS, CIS_VALIDATION_LIMITS } from './limits.js';

export class CisParserError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = 'CisParserError';
    this.code = code;
  }
}

const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const BLOCK_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

const FORBIDDEN_KEYS = new Set([
  'file',
  'path',
  'filepath',
  'filename',
  'cwd',
  'command',
  'shell',
  'exec',
  'url',
  'href',
  'env',
  'token',
  'secret',
  'password',
  'credential',
]);

const FORBIDDEN_VALUE_PATTERNS = [
  { code: 'PARSER_PATH_FIELD', pattern: /(?:^|[\s"'`])(?:\.\.\/|\/etc\/|\.env|\.git\/|src\/|partials\/)/i },
  { code: 'PARSER_FORBIDDEN_CONTENT', pattern: /\b(?:rm\s+-rf|curl\s+|wget\s+|sudo\s+|chmod\s+|eval\s+|exec\s+)\b/i },
  { code: 'PARSER_FORBIDDEN_CONTENT', pattern: /https?:\/\/[^\s/]+:[^\s/@]+@/i },
  { code: 'PARSER_FORBIDDEN_URL', pattern: /https?:\/\//i },
  { code: 'PARSER_FORBIDDEN_CONTENT', pattern: /\b(?:token|secret|password|api[_-]?key)\s*[:=]/i },
];

const EDIT_TEXT_FORBIDDEN_PATTERNS = [
  { code: 'PARSER_FORBIDDEN_URL', pattern: /https?:\/\//i },
  ...FORBIDDEN_VALUE_PATTERNS.filter(({ code }) => code !== 'PARSER_FORBIDDEN_URL'),
];

/**
 * @param {unknown} raw
 */
export function normalizeModelJson(raw) {
  if (typeof raw !== 'string') {
    throw new CisParserError('PARSER_INVALID_JSON', 'Model output must be a string.');
  }
  const trimmed = raw.trim();
  if (trimmed.length > CIS_VALIDATION_LIMITS.maxOutputChars) {
    throw new CisParserError('PARSER_OUTPUT_TOO_LARGE', 'Model output exceeds maxOutputChars.');
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    if (!fenceMatch) {
      throw new CisParserError('PARSER_INVALID_JSON', 'Model output is not valid JSON.');
    }
    const inner = fenceMatch[1].trim();
    if (!inner || (inner.match(/```/g) || []).length > 0) {
      throw new CisParserError('PARSER_INVALID_JSON', 'Ambiguous code fence in model output.');
    }
    try {
      return JSON.parse(inner);
    } catch {
      throw new CisParserError('PARSER_INVALID_JSON', 'Fenced model output is not valid JSON.');
    }
  }
}

/**
 * @param {Record<string, unknown>} obj
 * @param {string[]} allowed
 * @param {string} label
 */
function assertExactKeys(obj, allowed, label) {
  const keys = Object.keys(obj);
  const allowedSet = new Set(allowed);
  for (const key of keys) {
    if (!allowedSet.has(key)) {
      throw new CisParserError('PARSER_EXTRA_PROPERTY', `Unexpected property ${label}.${key}.`);
    }
  }
  for (const key of allowed) {
    if (!Object.prototype.hasOwnProperty.call(obj, key)) {
      throw new CisParserError('PARSER_INVALID_TYPE', `Missing required property ${label}.${key}.`);
    }
  }
}

/**
 * @param {unknown} value
 * @param {string} label
 * @param {{ patterns?: typeof FORBIDDEN_VALUE_PATTERNS }} [options]
 */
function assertNonEmptyString(value, label, maxLen, options = {}) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new CisParserError('PARSER_INVALID_TYPE', `${label} must be a non-empty string.`);
  }
  if (value.length > maxLen) {
    throw new CisParserError('PARSER_OUTPUT_TOO_LARGE', `${label} exceeds allowed length.`);
  }
  scanForbiddenContent(value, label, options.patterns || FORBIDDEN_VALUE_PATTERNS);
  return value;
}

/**
 * @param {unknown} value
 * @param {string} label
 * @param {typeof FORBIDDEN_VALUE_PATTERNS} patterns
 */
function scanForbiddenContent(value, label, patterns = FORBIDDEN_VALUE_PATTERNS) {
  if (typeof value === 'string') {
    for (const { code, pattern } of patterns) {
      if (pattern.test(value)) {
        throw new CisParserError(code, `Forbidden content in ${label}.`);
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanForbiddenContent(item, `${label}[${index}]`, patterns));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(key.toLowerCase())) {
        throw new CisParserError('PARSER_PATH_FIELD', `Forbidden property ${label}.${key}.`);
      }
      scanForbiddenContent(child, `${label}.${key}`, patterns);
    }
  }
}

/**
 * @param {unknown} parsed
 * @param {{
 *   requestableBlockIds?: Set<string>,
 *   suppliedBlockIds?: Set<string>,
 *   suppliedBlockHashes?: Record<string, string>,
 *   suppliedBlockTexts?: Record<string, string>,
 *   allowedFindingIds?: Set<string>,
 * }} context
 */
export function parseCisAction(parsed, context = {}) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CisParserError('PARSER_INVALID_JSON', 'Action must be a JSON object.');
  }

  const actionType = parsed.action;
  if (typeof actionType !== 'string') {
    throw new CisParserError('PARSER_INVALID_TYPE', 'action must be a string.');
  }

  switch (actionType) {
    case 'request_context':
      return parseRequestContext(parsed, context);
    case 'propose_patch':
      return parseProposePatch(parsed, context);
    case 'cannot_fix':
      return parseCannotFix(parsed);
    default:
      assertExactKeys(parsed, ['action'], 'action');
      throw new CisParserError('PARSER_UNKNOWN_ACTION', `Unknown action ${actionType}.`);
  }
}

/**
 * @param {Record<string, unknown>} parsed
 * @param {{ requestableBlockIds?: Set<string> }} context
 */
function parseRequestContext(parsed, context) {
  assertExactKeys(parsed, ['action', 'blockIds', 'reason'], 'action');
  const blockIds = parsed.blockIds;
  if (!Array.isArray(blockIds) || blockIds.length === 0) {
    throw new CisParserError('PARSER_INVALID_TYPE', 'blockIds must be a non-empty array.');
  }
  if (blockIds.length > CIS_VALIDATION_LIMITS.maxContextBlockIds) {
    throw new CisParserError('PARSER_OUTPUT_TOO_LARGE', 'Too many blockIds requested.');
  }
  const seen = new Set();
  for (const blockId of blockIds) {
    if (typeof blockId !== 'string' || !BLOCK_ID_PATTERN.test(blockId)) {
      throw new CisParserError('PARSER_INVALID_TYPE', 'Each blockId must be an opaque identifier.');
    }
    if (seen.has(blockId)) {
      throw new CisParserError('PARSER_DUPLICATE_BLOCK_ID', `Duplicate blockId ${blockId}.`);
    }
    seen.add(blockId);
    if (!context.requestableBlockIds?.has(blockId)) {
      throw new CisParserError('PARSER_UNKNOWN_BLOCK_ID', `Unknown or non-requestable blockId ${blockId}.`);
    }
  }
  const reason = assertNonEmptyString(parsed.reason, 'reason', CIS_VALIDATION_LIMITS.maxReasonChars);
  return { action: 'request_context', blockIds: [...blockIds], reason };
}

/**
 * @param {Record<string, unknown>} parsed
 * @param {{
 *   suppliedBlockIds?: Set<string>,
 *   suppliedBlockHashes?: Record<string, string>,
 *   suppliedBlockTexts?: Record<string, string>,
 *   allowedFindingIds?: Set<string>,
 * }} context
 */
function parseProposePatch(parsed, context) {
  assertExactKeys(
    parsed,
    ['action', 'edits', 'resolvesFindingIds', 'rationale', 'manualChecks'],
    'action',
  );

  if (!context.suppliedBlockIds || !context.suppliedBlockHashes || !context.suppliedBlockTexts) {
    throw new CisParserError('PARSER_INVALID_TYPE', 'propose_patch requires supplied block context.');
  }

  const edits = parsed.edits;
  if (!Array.isArray(edits) || edits.length === 0) {
    throw new CisParserError('PARSER_INVALID_TYPE', 'edits must be a non-empty array.');
  }
  if (edits.length > CIS_VALIDATION_LIMITS.maxEditsPerPatch) {
    throw new CisParserError('PARSER_TOO_MANY_EDITS', 'Too many edits in propose_patch.');
  }

  /** @type {Array<{ blockId: string, expectedSha256: string, oldText: string, newText: string }>} */
  const normalizedEdits = [];
  const seenEditKeys = new Set();

  for (const [index, edit] of edits.entries()) {
    if (!edit || typeof edit !== 'object' || Array.isArray(edit)) {
      throw new CisParserError('PARSER_INVALID_TYPE', `edits[${index}] must be an object.`);
    }
    assertExactKeys(edit, ['blockId', 'expectedSha256', 'oldText', 'newText'], `edits[${index}]`);

    const blockId = edit.blockId;
    if (typeof blockId !== 'string' || !BLOCK_ID_PATTERN.test(blockId)) {
      throw new CisParserError('PARSER_INVALID_TYPE', `edits[${index}].blockId must be an opaque identifier.`);
    }
    if (!context.suppliedBlockIds.has(blockId)) {
      throw new CisParserError('PARSER_BLOCK_NOT_SUPPLIED', `Block ${blockId} has not been supplied to the model.`);
    }

    const expectedSha256 = edit.expectedSha256;
    if (typeof expectedSha256 !== 'string' || !SHA256_PATTERN.test(expectedSha256)) {
      throw new CisParserError('PARSER_INVALID_TYPE', `edits[${index}].expectedSha256 must be sha256:<hex>.`);
    }
    if (context.suppliedBlockHashes[blockId] !== expectedSha256) {
      throw new CisParserError('PARSER_HASH_MISMATCH', `Hash mismatch for blockId ${blockId}.`);
    }

    const oldText = edit.oldText;
    const newText = edit.newText;
    if (typeof oldText !== 'string' || typeof newText !== 'string') {
      throw new CisParserError('PARSER_INVALID_TYPE', `edits[${index}] oldText/newText must be strings.`);
    }
    if (oldText.length === 0) {
      throw new CisParserError('PARSER_INVALID_TYPE', `edits[${index}].oldText must be non-empty.`);
    }
    if (oldText === newText) {
      throw new CisParserError('PARSER_NOOP_EDIT', `edits[${index}] oldText and newText must differ.`);
    }
    if (oldText.length > CIS_VALIDATION_LIMITS.maxEditTextChars
      || newText.length > CIS_VALIDATION_LIMITS.maxEditTextChars) {
      throw new CisParserError('PARSER_OUTPUT_TOO_LARGE', `edits[${index}] text exceeds maxEditTextChars.`);
    }
    scanForbiddenContent(oldText, `edits[${index}].oldText`, EDIT_TEXT_FORBIDDEN_PATTERNS);
    scanForbiddenContent(newText, `edits[${index}].newText`, EDIT_TEXT_FORBIDDEN_PATTERNS);

    const blockText = context.suppliedBlockTexts[blockId];
    if (!blockText) {
      throw new CisParserError('PARSER_BLOCK_NOT_SUPPLIED', `Missing supplied text for block ${blockId}.`);
    }
    if (!blockText.includes(oldText)) {
      throw new CisParserError('PARSER_INVALID_TYPE', `oldText not found in block ${blockId}.`);
    }
    if (blockText.indexOf(oldText) !== blockText.lastIndexOf(oldText)) {
      throw new CisParserError('PARSER_OVERLAPPING_EDITS', `oldText is not unique in block ${blockId}.`);
    }

    const editKey = `${blockId}\0${oldText}`;
    if (seenEditKeys.has(editKey)) {
      throw new CisParserError('PARSER_DUPLICATE_EDIT', `Duplicate edit for blockId ${blockId}.`);
    }
    seenEditKeys.add(editKey);

    normalizedEdits.push({ blockId, expectedSha256, oldText, newText });
  }

  assertNoOverlappingEdits(normalizedEdits, context.suppliedBlockTexts);

  const resolvesFindingIds = parsed.resolvesFindingIds;
  if (!Array.isArray(resolvesFindingIds) || resolvesFindingIds.length === 0) {
    throw new CisParserError('PARSER_INVALID_TYPE', 'resolvesFindingIds must be a non-empty array.');
  }
  const findingSeen = new Set();
  for (const findingId of resolvesFindingIds) {
    if (typeof findingId !== 'string' || !SHA256_PATTERN.test(findingId)) {
      throw new CisParserError('PARSER_INVALID_TYPE', 'Each resolvesFindingIds entry must be sha256:<hex>.');
    }
    if (findingSeen.has(findingId)) {
      throw new CisParserError('PARSER_INVALID_TYPE', `Duplicate findingId ${findingId}.`);
    }
    findingSeen.add(findingId);
    if (context.allowedFindingIds && !context.allowedFindingIds.has(findingId)) {
      throw new CisParserError('PARSER_UNKNOWN_FINDING_ID', `Unknown findingId ${findingId}.`);
    }
  }

  const rationale = assertNonEmptyString(parsed.rationale, 'rationale', CIS_VALIDATION_LIMITS.maxRationaleChars);
  const manualChecks = parsed.manualChecks;
  if (!Array.isArray(manualChecks)) {
    throw new CisParserError('PARSER_INVALID_TYPE', 'manualChecks must be an array.');
  }
  if (manualChecks.length > CIS_VALIDATION_LIMITS.maxManualChecks) {
    throw new CisParserError('PARSER_OUTPUT_TOO_LARGE', 'Too many manualChecks entries.');
  }
  const normalizedManualChecks = manualChecks.map((entry, index) =>
    assertNonEmptyString(entry, `manualChecks[${index}]`, CIS_VALIDATION_LIMITS.maxManualCheckChars)
  );

  return {
    action: 'propose_patch',
    edits: normalizedEdits,
    resolvesFindingIds: [...resolvesFindingIds],
    rationale,
    manualChecks: normalizedManualChecks,
  };
}

/**
 * @param {Array<{ blockId: string, oldText: string }>} edits
 * @param {Record<string, string>} blockTexts
 */
function assertNoOverlappingEdits(edits, blockTexts) {
  const byBlock = new Map();
  for (const edit of edits) {
    if (!byBlock.has(edit.blockId)) byBlock.set(edit.blockId, []);
    byBlock.get(edit.blockId).push(edit);
  }

  for (const [blockId, blockEdits] of byBlock.entries()) {
    if (blockEdits.length < 2) continue;
    const blockText = blockTexts[blockId];

    /** @type {Array<{ start: number, end: number }>} */
    const ranges = blockEdits.map((edit) => {
      const start = blockText.indexOf(edit.oldText);
      return { start, end: start + edit.oldText.length };
    }).sort((a, b) => a.start - b.start);

    for (let i = 1; i < ranges.length; i += 1) {
      if (ranges[i].start < ranges[i - 1].end) {
        throw new CisParserError('PARSER_OVERLAPPING_EDITS', `Overlapping edits in block ${blockId}.`);
      }
    }
  }
}

/** @param {Record<string, unknown>} parsed */
function parseCannotFix(parsed) {
  assertExactKeys(parsed, ['action', 'reasonCode', 'explanation'], 'action');
  const reasonCode = assertNonEmptyString(parsed.reasonCode, 'reasonCode', 128);
  const explanation = assertNonEmptyString(parsed.explanation, 'explanation', CIS_VALIDATION_LIMITS.maxRationaleChars);
  return { action: 'cannot_fix', reasonCode, explanation };
}

/**
 * @param {string} raw
 * @param {Parameters<typeof parseCisAction>[1]} context
 */
export function parseCisActionFromModelOutput(raw, context = {}) {
  const parsed = normalizeModelJson(raw);
  return parseCisAction(parsed, context);
}

/**
 * Rough token estimate for prompt budgeting (chars / 4).
 * @param {string} text
 */
export function estimateTokenCount(text) {
  return Math.ceil(String(text).length / 4);
}

/**
 * @param {string} prompt
 */
export function assertPromptWithinInputBudget(prompt) {
  if (estimateTokenCount(prompt) > CIS_POC_LIMITS.maxInputTokens) {
    throw new CisParserError('PARSER_OUTPUT_TOO_LARGE', 'Prompt exceeds maxInputTokens.');
  }
}

/**
 * @param {Array<{ role: string, content: string }>} messages
 */
export function assertMessagesWithinInputBudget(messages) {
  if (estimateMessagesTokenCount(messages) > CIS_POC_LIMITS.maxInputTokens) {
    throw new CisParserError('PARSER_OUTPUT_TOO_LARGE', 'Prompt exceeds maxInputTokens.');
  }
}

/**
 * @param {Array<{ role: string, content: string }>} messages
 */
export function estimateMessagesTokenCount(messages) {
  return estimateTokenCount(messages.map((entry) => `${entry.role}:${entry.content}`).join('\n'));
}
