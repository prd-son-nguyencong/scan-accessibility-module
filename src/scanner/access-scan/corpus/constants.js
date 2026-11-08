import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const CORPUS_SCHEMA_VERSION = '1.0.0';

/** Stable corpus differential comparator contract; not tied to package version or time. */
export const CORPUS_COMPARATOR_VERSION = '1.0.0';

export const CORPUS_PROFILES = Object.freeze(['standards', 'commercial-parity']);

export const CORPUS_REQUIRED_CASE_FILES = Object.freeze([
  'meta.json',
  'snapshot.json',
  'expected.json',
]);

/** Optional gitignored file; its `forbiddenTokens` add real customer names so none ship in src. */
const LOCAL_TOKENS_PATH = process.env.ADA_CORPUS_REDACTION_TOKENS
  || fileURLToPath(new URL('../../../../scripts/accessscan-corpus/redaction-tokens.local.json', import.meta.url));

function loadLocalForbiddenTokens() {
  if (!existsSync(LOCAL_TOKENS_PATH)) return [];
  const { forbiddenTokens } = JSON.parse(readFileSync(LOCAL_TOKENS_PATH, 'utf8'));
  return Array.isArray(forbiddenTokens) ? forbiddenTokens.filter((t) => typeof t === 'string' && t) : [];
}

export const CORPUS_FORBIDDEN_TOKENS = Object.freeze([
  'paradox',
  'data-testid',
  'referenceHtml',
  'reference-snapshot',
  'expectedFailureCount',
  ...loadLocalForbiddenTokens(),
]);

/**
 * Corpus differential gates compare findings using normalizeCorpusRuleId():
 * external commercial aliases resolve to native ids, then reporter commercial
 * canonicalization is applied. Reporter V2 projections continue to use
 * canonicalizeRuleId(nativeRuleId) without rewriting native rule ids.
 */
export const CORPUS_ACCEPTANCE_RULE_ID_CONVENTION = Object.freeze({
  acceptanceNormalizer: 'normalizeCorpusRuleId',
  reporterNormalizer: 'canonicalizeRuleId',
  flow: 'external-commercial -> native -> commercial-canonical',
});
