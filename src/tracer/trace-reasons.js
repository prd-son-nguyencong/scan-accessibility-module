/** Why an element has no (single) source. `multiple-candidates` accompanies `ambiguous`; `unknown-framework` / `unsupported-framework` mean no source adapter; `no-source-project` is a scan without --source; `unresolved` is the report-level catch-all. */
export const TRACE_REASONS = Object.freeze(new Set([
  'no-marker',
  'no-manifest',
  'platform-owned',
  'third-party',
  'no-source-project',
  'unresolved',
  'preview-without-reference',
  'scope-mismatch',
  'no-match',
  'no-element',
  'page-source-missing',
  'multiple-candidates',
  'source-changed-since-build',
  'unknown-framework',
  'unsupported-framework',
]));
