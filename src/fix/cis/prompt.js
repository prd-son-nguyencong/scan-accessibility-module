export const CIS_PROMPT_VERSION = '1';

const PATH_BEARING_PATTERN = /(?:^|[\s"'`])(?:\.\.\/|src\/|partials\/|\.liquid\b|\.html\b|\.js\b|\.css\b)/i;
const BARE_FILENAME_PATTERN = /\b[\w.-]+\.(?:liquid|html|js|css)\b/i;

/**
 * @param {string | undefined | null} value
 */
export function isPathBearingString(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  return PATH_BEARING_PATTERN.test(value)
    || BARE_FILENAME_PATTERN.test(value)
    || /https?:\/\//i.test(value);
}

/**
 * @param {Record<string, unknown>} fixUnit
 */
export function buildSanitizedFixUnitSnapshot(fixUnit) {
  const snapshot = {
    fixUnitId: fixUnit.fixUnitId,
    kind: fixUnit.kind,
    canonicalRuleId: fixUnit.canonicalRuleId,
    findingIds: fixUnit.findingIds,
    evidence: sanitizeEvidence(fixUnit.evidence),
  };
  if (fixUnit.title && !isPathBearingString(fixUnit.title)) {
    snapshot.title = fixUnit.title;
  }
  return snapshot;
}

/**
 * @param {Array<Record<string, unknown>> | undefined} evidence
 */
export function sanitizeEvidence(evidence) {
  return (evidence || []).map((item) => {
    /** @type {Record<string, unknown>} */
    const sanitized = {
      layer: item.layer,
      nativeRuleId: item.nativeRuleId,
    };
    if (item.canonicalRuleId && typeof item.canonicalRuleId === 'string') {
      sanitized.canonicalRuleId = item.canonicalRuleId;
    }
    if (item.message && typeof item.message === 'string' && !isPathBearingString(item.message)) {
      sanitized.message = item.message;
    }
    if (item.route && typeof item.route === 'string' && !isPathBearingString(item.route)) {
      sanitized.route = item.route;
    }
    return sanitized;
  });
}

/**
 * @param {Record<string, unknown>} fixUnit
 * @param {string[]} availableBlockIds
 * @param {Array<{ blockId: string, sha256: string, bytes: number, text: string }>} suppliedBlocks
 */
export function buildInitialUserPrompt(fixUnit, availableBlockIds, suppliedBlocks) {
  return JSON.stringify({
    promptVersion: CIS_PROMPT_VERSION,
    fixUnit: buildSanitizedFixUnitSnapshot(fixUnit),
    availableBlockIds,
    blocks: suppliedBlocks.map(({ blockId, sha256, bytes, text }) => ({
      blockId,
      sha256,
      bytes,
      text,
    })),
  });
}

/**
 * @param {Array<{ blockId: string, sha256: string, bytes: number, text: string }>} blocks
 * @param {string} reason
 */
export function buildContextSupplementPrompt(blocks, reason) {
  return JSON.stringify({
    kind: 'context_supplement',
    reason,
    blocks: blocks.map(({ blockId, sha256, bytes, text }) => ({
      blockId,
      sha256,
      bytes,
      text,
    })),
  });
}
