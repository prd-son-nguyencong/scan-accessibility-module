import { normalizeCorpusRuleId } from '../../../reporter/rule-aliases.js';
import {
  pairingAffinity,
  pairingTiebreak,
} from './pairing.js';
import {
  assertComparableSemanticFinding,
  semanticElementFingerprint,
} from './semantic-fingerprint.js';

export class CorpusPoolInconsistencyError extends Error {
  constructor(message = 'Corpus entry pool inconsistency') {
    super(message);
    this.name = 'CorpusPoolInconsistencyError';
  }
}

/**
 * @typedef {object} CorpusFindingEntry
 * @property {string} key
 * @property {string} fingerprint
 * @property {string} ruleId
 * @property {Record<string, unknown>} finding
 */

/**
 * @typedef {object} CorpusChangedPair
 * @property {CorpusFindingEntry} expected
 * @property {CorpusFindingEntry} actual
 */

/**
 * Diff buckets are disjoint: every unmatched expected entry is in `missing`,
 * every unmatched actual entry is in `extra`, and paired replacements appear
 * only in `changed`. Consumers can sum bucket sizes without double-counting.
 *
 * @typedef {object} CorpusDiffResult
 * @property {boolean} equivalent
 * @property {CorpusFindingEntry[]} missing
 * @property {CorpusFindingEntry[]} extra
 * @property {CorpusChangedPair[]} changed
 */

/**
 * @param {Record<string, unknown>} finding
 * @returns {CorpusFindingEntry}
 */
export function buildCorpusFindingEntry(finding = {}) {
  assertComparableSemanticFinding(finding);
  const fingerprint = semanticElementFingerprint(finding);
  const ruleId = normalizeCorpusRuleId(
    finding.canonicalRuleId
    || finding.ruleId
    || finding.nativeRuleId
    || 'unknown-rule',
  );
  return {
    key: `${ruleId}|${fingerprint}`,
    fingerprint,
    ruleId,
    finding,
  };
}

/**
 * @param {Record<string, unknown>[]} findings
 * @returns {string[]}
 */
export function buildCorpusMultiset(findings = []) {
  return findings.map((finding) => buildCorpusFindingEntry(finding).key);
}

/**
 * @param {string[]} left
 * @param {string[]} right
 * @returns {{ missing: string[], extra: string[] }}
 */
function multisetDelta(left, right) {
  const leftCounts = new Map();
  const rightCounts = new Map();

  for (const key of left) leftCounts.set(key, (leftCounts.get(key) || 0) + 1);
  for (const key of right) rightCounts.set(key, (rightCounts.get(key) || 0) + 1);

  /** @type {string[]} */
  const missing = [];
  /** @type {string[]} */
  const extra = [];

  for (const [key, count] of leftCounts.entries()) {
    const delta = count - (rightCounts.get(key) || 0);
    for (let index = 0; index < delta; index += 1) missing.push(key);
  }
  for (const [key, count] of rightCounts.entries()) {
    const delta = count - (leftCounts.get(key) || 0);
    for (let index = 0; index < delta; index += 1) extra.push(key);
  }

  return { missing, extra };
}

/**
 * @param {CorpusFindingEntry[]} entries
 * @param {string[]} keys
 * @returns {CorpusFindingEntry[]}
 */
function takeEntries(entries, keys) {
  const pool = [...entries];
  return keys.map((key) => {
    const index = pool.findIndex((entry) => entry.key === key);
    if (index === -1) {
      throw new CorpusPoolInconsistencyError(`missing pool entry for key ${key}`);
    }
    const [entry] = pool.splice(index, 1);
    return entry;
  });
}

/**
 * @param {CorpusFindingEntry[]} missing
 * @param {CorpusFindingEntry[]} extra
 * @returns {{
 *   changed: CorpusChangedPair[],
 *   missingOnly: CorpusFindingEntry[],
 *   extraOnly: CorpusFindingEntry[],
 * }}
 */
function buildDisjointDiff(missing, extra) {
  /** @type {CorpusChangedPair[]} */
  const changed = [];
  const missingPool = missing.map((entry, index) => ({ entry, index }));
  const extraPool = extra.map((entry, index) => ({ entry, index }));
  const consumedMissing = new Set();
  const consumedExtra = new Set();
  const ruleIds = new Set([
    ...missing.map((entry) => entry.ruleId),
    ...extra.map((entry) => entry.ruleId),
  ]);

  for (const ruleId of [...ruleIds].sort()) {
    const ruleMissing = missingPool.filter((item) => item.entry.ruleId === ruleId);
    const ruleExtra = extraPool.filter((item) => item.entry.ruleId === ruleId);

    /** @type {Array<{
     *   missingIndex: number,
     *   extraIndex: number,
     *   score: number,
     *   tiebreak: string,
     * }>} */
    const candidates = [];
    for (const missingItem of ruleMissing) {
      for (const extraItem of ruleExtra) {
        candidates.push({
          missingIndex: missingItem.index,
          extraIndex: extraItem.index,
          score: pairingAffinity(missingItem.entry, extraItem.entry),
          tiebreak: pairingTiebreak(missingItem.entry, extraItem.entry),
        });
      }
    }
    candidates.sort((left, right) => (
      right.score - left.score
      || left.tiebreak.localeCompare(right.tiebreak)
    ));

    for (const candidate of candidates) {
      if (consumedMissing.has(candidate.missingIndex) || consumedExtra.has(candidate.extraIndex)) {
        continue;
      }
      const expected = missingPool.find((item) => item.index === candidate.missingIndex)?.entry;
      const actual = extraPool.find((item) => item.index === candidate.extraIndex)?.entry;
      if (!expected || !actual) continue;
      changed.push({ expected, actual });
      consumedMissing.add(candidate.missingIndex);
      consumedExtra.add(candidate.extraIndex);
    }
  }

  return {
    changed,
    missingOnly: missing.filter((_, index) => !consumedMissing.has(index)),
    extraOnly: extra.filter((_, index) => !consumedExtra.has(index)),
  };
}

/**
 * @param {Record<string, unknown>[]} expected
 * @param {Record<string, unknown>[]} actual
 * @returns {CorpusDiffResult}
 */
export function compareCorpusFindings(expected = [], actual = []) {
  const expectedEntries = expected.map((finding) => buildCorpusFindingEntry(finding));
  const actualEntries = actual.map((finding) => buildCorpusFindingEntry(finding));
  const { missing: missingKeys, extra: extraKeys } = multisetDelta(
    expectedEntries.map((entry) => entry.key),
    actualEntries.map((entry) => entry.key),
  );

  const missingAll = takeEntries(expectedEntries, missingKeys);
  const extraAll = takeEntries(actualEntries, extraKeys);
  const { changed, missingOnly, extraOnly } = buildDisjointDiff(missingAll, extraAll);

  return {
    equivalent: missingOnly.length === 0 && extraOnly.length === 0 && changed.length === 0,
    missing: missingOnly,
    extra: extraOnly,
    changed,
  };
}

/**
 * @param {Record<string, unknown>[]} expected
 * @param {Record<string, unknown>[]} actual
 * @returns {boolean}
 */
export function corpusFindingsEquivalent(expected = [], actual = []) {
  return compareCorpusFindings(expected, actual).equivalent;
}
