export {
  CORPUS_ACCEPTANCE_RULE_ID_CONVENTION,
  CORPUS_COMPARATOR_VERSION,
  CORPUS_SCHEMA_VERSION,
} from './constants.js';
export {
  validateCorpusCase,
  validateCorpusManifest,
} from './schema.js';
export {
  buildCorpusFindingEntry,
  buildCorpusMultiset,
  compareCorpusFindings,
  corpusFindingsEquivalent,
  CorpusPoolInconsistencyError,
} from './diff.js';
export {
  DELTA_CATEGORIES,
  classifyCorpusDeltaEntry,
  classifyCorpusDiff,
  hasOracleLimitationForRule,
  parseOracleLimitationRules,
  serializeClassifiedCorpusDiff,
} from './delta-classification.js';
export {
  pairingAffinity,
  pairingTiebreak,
  scopePathsDifferForEntries,
  semanticScopeFingerprintForEntry,
  evidenceMappingDiffersForEntries,
} from './pairing.js';
export {
  computeCommercialParityMetrics,
  meetsCommercialParityThreshold,
  serializeCommercialParityMetrics,
} from './parity-metrics.js';
export {
  containsHostLeakage,
  hostLeakageError,
} from './sanitization.js';
export {
  AmbiguousSemanticFindingError,
  assertComparableSemanticFinding,
  extractSemanticDescriptor,
  findSemanticHostLeakage,
  hasSemanticDisambiguator,
  isAmbiguousSemanticFinding,
  isGeneratedIdRef,
  normalizeSemanticAttributes,
  semanticElementFingerprint,
  semanticFindingsEquivalent,
} from './semantic-fingerprint.js';
