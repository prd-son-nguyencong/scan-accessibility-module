export { CORPUS_TOOLING_ERROR_CODES, CorpusToolingError, isCorpusToolingError } from './lib/errors.js';
export { getCommittedFixtureRoot, resolveDraftDir, reassertDraftPathSafe, resetCommittedFixtureRootForTests, setCommittedFixtureRootForTests } from './lib/paths.js';
export {
  resetAllowedRuleIdsForTests,
  resetBuiltinAllowedRuleIdsCacheForTests,
  resolveAllowedRuleIds,
  setAllowedRuleIdsForTests,
  setAllowedRuleIdsResolverForTests,
} from './lib/rule-ids.js';
export { buildSnapshotIdentity, snapshotsSemanticallyEqual } from './lib/snapshot-identity.js';
export {
  assertNoRedactionLeaks,
  findRedactionLeaks,
  sanitizeAttributes,
  sanitizeOuterHtml,
  sanitizeSemanticDescriptor,
  sanitizeSnapshot,
  sanitizeSnapshotElement,
  sanitizeTextValue,
} from './lib/sanitize.js';
export {
  buildLandmarkPath,
  buildSemanticFromSnapshotElement,
  computeOrdinal,
} from './lib/landmark.js';
export {
  alignFindingToSnapshot,
  alignFindingsToSnapshot,
  alignFindingsToSnapshotPartial,
} from './lib/align.js';
export {
  canonicalizeExternalRuleAlias,
  ingestAccessScanReport,
  normalizeReportFinding,
  normalizeReportFindings,
} from './lib/ingest.js';
export {
  captureLiveSnapshot,
  captureLiveStableSnapshot,
  captureStableSnapshot,
  DEFAULT_PAGE_STATE,
  normalizeCapturedSnapshot,
  validateCapturePageState,
} from './lib/capture.js';
export {
  generateDraftCase,
  resetDraftPathGuardForTests,
  setDraftPathGuardForTests,
  validateDraftSerialized,
} from './lib/draft.js';
export {
  defaultReplayScanCase,
  ensurePlaywrightTempDir,
  filterViolationsForExpectedRules,
  loadCorpusCaseContext,
  replayCorpusCaseWithPlaywright,
  violationsToReportFindings,
} from './lib/replay.js';
export {
  serializeCorpusDiff,
  verifyCorpus,
  verifyCorpusCaseDiff,
} from './lib/verify.js';
export { evaluateCorpusDifferentials } from './lib/differential.js';
export { evaluateCorpusDrift } from './lib/drift.js';
export {
  evaluateCorpusDriftAll,
  evaluateManifestEntryDrift,
  captureLiveDriftCandidate,
} from './lib/drift-manifest.js';
export {
  ADMISSION_REQUIREMENTS,
  CORPUS_ADMISSION_PROOF_REQUIREMENT,
  assertBlockedEntriesIsolated,
  assertManifestEntryDriftEligible,
  listDriftMonitorEntries,
  validateManifestEntryAdmission,
  verifySeededSourceManifestAdmission,
} from './lib/admission-gate.js';
export {
  buildDriftArtifactPayload,
  buildDriftHumanSummary,
  serializeDriftCaseResult,
  serializeDriftClassification,
  serializeDriftDiff,
  serializeDriftMetrics,
} from './lib/drift-artifact.js';
export {
  assertNeutralDriftArtifact,
  normalizeSanitizedDriftError,
  sanitizeDiagnosticText,
  sanitizeDriftStderr,
} from './lib/drift-error.js';
export {
  captureAtomicScannerPass,
  captureLiveStableDriftCandidate,
  buildFindingsIdentity,
} from './lib/live-drift-capture.js';
export { resolveCorpusCaseDir } from './lib/corpus-case-dir.js';
export {
  CASE_ID_PATTERN,
  REVIEWED_SOURCE_HOST_SUFFIXES,
  assertSafeCorpusNetworkUrl,
  assertSafeSourceNavigationUrl,
  assertSafeSubresourceUrl,
  installCorpusContextNetworkGuard,
  installCorpusNetworkGuard,
  installCorpusPageAndContextGuards,
  navigateToReviewedSource,
  validateManifestCaseId,
  validateSourceManifestUrl,
  validateSourceManifestUrlShape,
} from './lib/source-url-policy.js';
export {
  isPrivateOrReservedIpAddress,
  resolvePublicHostAddresses,
  resetDnsPolicyCacheForTests,
  setDnsResolverForTests,
} from './lib/dns-policy.js';
export {
  readCorpusCaseFile,
  readCorpusCaseJson,
  reassertSafeCorpusCaseDir,
} from './lib/corpus-case-read.js';
export {
  buildCorpusReportFromOracle,
  buildCorpusReportFromOracleFile,
  extractOracleFindings,
  parseAccessScanOraclePayload,
} from './lib/oracle-report.js';
export {
  listBlockedSourceEntries,
  listSeededSourceEntries,
  listSourceManifestEntries,
  loadSourceManifest,
  resolveOracleArtifactPath,
  SOURCE_MANIFEST_PATH,
  validateSourceManifest,
} from './lib/source-manifest.js';
export { printDeterministicJson, serializeDeterministicJson } from './lib/output.js';
export { resetAllCorpusToolingTestState } from './lib/test-state.js';
export {
  assertCommittedEvidenceNeutral,
  buildEvidenceSliceCaseFromOracle,
  reprocessCommittedEvidenceSliceCase,
} from './lib/oracle-evidence-slice.js';
export { verifyOracleEvidenceDigest } from './lib/oracle-digest-verify.js';
export {
  reprocessCommittedCorpusCases,
  verifyCommittedOracleDigests,
} from './seed.js';
