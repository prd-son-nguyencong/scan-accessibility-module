export const SCAN_REPORT_SCHEMA_VERSION: '2.0.0';

/** `kind`: site-source | react-widget | platform-component | vendor-script | injected-runtime | unbound-data | unknown-probe-failed | iframe. `injected-runtime` and `unbound-data` (PDK data not bound in a local render) are site-owned but never confirmed; so is `unknown-probe-failed` (the live probe could not resolve the node). */
export interface ScanOrigin {
  owner: 'site' | 'platform' | 'third-party';
  kind: 'site-source' | 'react-widget' | 'platform-component' | 'vendor-script' | 'injected-runtime' | 'unbound-data' | 'unknown-probe-failed' | 'iframe';
  vendor?: string;
  label: string;
  evidence: string[];
}

/** A finding in code the site cannot change, once per site (grouped by owner + vendor/kind + rule + selector across pages). */
export interface NotYourCodeGroup {
  owner: 'platform' | 'third-party'; kind: string; vendor?: string; label: string; rule: string; selector: string;
  impact: string; verdict: string; occurrences: number; findings: number; pages: string[]; evidence: string[]; suggestedAction: string;
}

export interface ScanSource {
  mode: string;
  file: string | null;
  line: number | null;
  snippet: string | null;
  method: string;
  confidence: 'high' | 'medium' | 'low' | 'none';
  preimageSha256: string | null;
  preimageRange: { start: number; end: number } | null;
  routeDependencies: string[];
  traceConfidence?: 'high' | 'medium' | 'low' | 'ambiguous' | 'untraceable' | 'stale';
  /** Why the finding has no single source: a TRACE_REASONS value (`no-source-project`, `platform-owned`, `unresolved`, ...). Always present when `file` is null. */
  traceReason?: string;
  /** Size findings (target-size) whose size is declared in a project stylesheet: `file`/`line` is that rule (method `css-rule`), these keep the markup it applies to. Additive. */
  cssSelector?: string;
  markupFile?: string;
  markupLine?: number;
  /** How the source was chosen, e.g. `size comes from inherited font-size/line-height` (markup line primary, generic CSS rules listed as low-confidence candidates). Additive. */
  note?: string;
}

export interface ScannerRun {
  runId: string;
  route: string;
  layer: string;
  engine: { name: string; version: string | null };
  viewport: { name: string | null; width: number | null; height: number | null } | null;
  pageState: string;
  status: 'complete' | 'fallback' | 'error' | 'skipped';
  source: string | null;
  provenance: unknown;
  raw: unknown;
  supplemental: unknown;
  emitted: unknown;
  evidence: unknown;
}

export interface ScanFinding {
  findingId: string;
  /** Same across runs for the same rule + route + element; additive in 2.0.0. */
  stableId?: string;
  sourceCandidates?: Array<{ file: string; line: number | null; confidence: string; method: string; preimageSha256: string | null }>;
  /** Third-party overlay findings only: the owner stays the vendor, but the site can mitigate it; `candidate` is where (global stylesheet or the template loading the vendor script), null when not found. Additive. */
  siteFix?: { note: string; candidate: { file: string; line: number; method: string; confidence: string } | null };
  nativeRuleId: string;
  nativeRuleIds: string[];
  canonicalRuleId: string;
  layer: string;
  layers: string[];
  category: string;
  /** How sure the rule is (E11.2). `verdict` is confirmed (deterministic), likely (heuristic) or needs-review (manual); only confirmed fails a gate. Absent in reports written before E11.2. */
  kind?: 'deterministic' | 'heuristic' | 'manual';
  verdict?: 'confirmed' | 'likely' | 'needs-review';
  /** Present when other findings share this one's source line and canonical rule (shared layout/partial on many pages, or a repeated line): same id on all of them, so they are one defect to fix. Additive. */
  sharedSource?: { id: string; findings: number; pages: number };
  /** Layers (engines) reporting the same problem on this element, sorted (E11.4). Additive. */
  enginesAgreeing?: string[];
  /** `multi` = at least 2 independent engines (Lighthouse a11y counts with axe as one, it runs axe-core); otherwise the kind of the single engine. */
  agreement?: 'multi' | 'single-deterministic' | 'single-heuristic';
  /** Set when verdict.agreementPolicy 'strict' moved a single-heuristic finding to needs-review: the verdict it had. */
  verdictBeforeAgreement?: 'confirmed' | 'likely';
  /** True when a site-owned finding that would be `confirmed` has no source file:line with confidence of at least medium: it is `likely` (verdictBeforeAgreement keeps `confirmed`), source.traceReason says why, and the fix export marks it "untraced: locate manually". Only set by local scans with a source adapter. Additive. */
  untraced?: boolean;
  /** `rule-precision` when ada-scan labels apply demoted this finding's rule (low QA precision) to needs-review; verdictBeforeAgreement keeps the earlier verdict. */
  demotion?: 'rule-precision';
  /** Who can fix it: the PDK `source`, the Paradox `platform` (widgets, component_data, chat) or a `third-party` iframe. Additive; only `source` belongs in a dev fix list. */
  ownership?: 'source' | 'platform' | 'third-party';
  /** Who owns the element's code (site source, Paradox widget, vendor script, cross-origin iframe) and why; non-site origins have no source file. */
  origin?: ScanOrigin;
  impact: string;
  priority: number;
  count: number;
  pageState: string;
  route: string;
  wcagRef: string | null;
  element: {
    selector: string;
    normalizedHtmlHash: string;
    outerHTML: string;
    scanId: string | null;
    framePath?: string[];
    shadowPath?: string[];
  };
  source: ScanSource;
  evidence: {
    message: string;
    observations: unknown[];
    /** The measured or structural fact behind a 'confirmed' verdict; absent on every other verdict. */
    proof?: { type: string; fact: string };
  };
  manualChecks: unknown[];
  fix: {
    deterministic: boolean;
    hint: string;
    patch: unknown;
  };
}

export interface ScanReportV2 {
  schemaVersion: '2.0.0';
  /** Version of the stableId algorithm (absent = 1, the pre-normalisation ids). Baselines with another version cannot be diffed. */
  stableIdVersion?: number;
  reportId: string;
  generatedAt: string;
  producer: {
    name: string;
    version: string;
    nodeVersion: string;
  };
  target: {
    mode: 'url-only' | 'local-only' | 'hybrid';
    url: string | null;
    buildRevision: string | null;
    instrumentationDigest: string | null;
    deploymentUrl: string | null;
    attestationStatus: 'complete' | 'missing' | 'malformed' | 'scope-mismatch' | null;
    attestationReason: string | null;
  };
  scanners: ScannerRun[];
  /** Findings in vendor scripts, platform widgets and cross-origin iframes, once per site; absent when there are none. */
  notYourCode?: NotYourCodeGroup[];
  pages: Array<{
    name: string;
    route: string;
    url: string | null;
    contentHash?: string;
    /** Only on a partial page: why, per incomplete layer; gating false = supplementary layer (lighthouse, w3c), exit 2 only with scan.strict. */
    partialReasons?: Array<{ layer: string; reason: string; gating: boolean }>;
    scannerRunIds: string[];
    dependencies: string[];
    findings: ScanFinding[];
    artifacts: {
      lighthouseScores: unknown;
      axeSummary: unknown;
    };
  }>;
  summary: {
    pagesScanned: number;
    /** Merged findings: the same canonical rule family on the same element from several layers is ONE finding (layers[], enginesAgreeing). */
    findingCount: number;
    occurrenceCount: number;
    /** Number of source line + rule groups spanning more than one finding. Additive. */
    sharedSourceGroups?: number;
    infoCount?: number;
    /** Occurrences per verdict; present when findings carry verdicts. */
    verdictCounts?: { confirmed: number; likely: number; needsReview: number };
    /** Occurrences by owner; present only when some finding is platform- or third-party-owned. They are still part of the totals and the gate. */
    ownershipCounts?: { source: number; platform: number; thirdParty: number };
    /** Same split as ownershipCounts but counting findings (not occurrences), excluding info findings. */
    ownershipFindingCounts?: { source: number; platform: number; thirdParty: number };
    /** Confirmed occurrences inside cross-origin iframes (confirmed needs a measured live-DOM proof); excluded from the gate and --fail-on-violations unless gate.countThirdParty. */
    thirdPartyConfirmed?: number;
    /** Confirmed occurrences in platform-owned widgets; excluded from the gate and --fail-on-violations unless gate.countPlatform. */
    platformConfirmed?: number;
    layerCounts: Record<string, number>;
  };
  runMetadata?: {
    scan?: { concurrency: number; maxTimeSec?: number; retries: number; pages: { route: string; status: string; durationMs: number; attempts: number; phases?: Record<string, number> }[];
      /** Re-verification (T-E11.5): flaky findings are excluded from the gate and listed here; absent with --no-reverify. */
      reverify?: { enabled: boolean; maxPerPage: number; timeoutMs: number; checked: number; stable: number; flaky: number; unverified: number; overCap: number; flakeRate: Record<string, { checked: number; flaky: number; rate: number }>; flakyFindings: { route: string; ruleId: string; layer: string; impact: string; selector: string; stability: string }[] } };
    /** Rules demoted to needs-review by QA labels (T-E11.6) and how many findings that moved in this scan. */
    ruleDemotions?: { rules: { ruleId: string; n: number; precision: number }[]; demotedFindings: number };
    /** Quality gate result (T-E3.7): per page and metric, `actual` vs `target` with status pass|fail|advisory|skipped|report. */
    thresholds?: {
      failed: boolean;
      notices: string[];
      thresholds: unknown;
      pages: { name: string; url: string; devServer: boolean; noindex?: boolean; /** Confirmed third-party and platform occurrences the gate did not count (absent when 0). */ excluded?: number; metrics: { id: string; actual: number | null; target: number | 'report'; status: 'pass' | 'fail' | 'advisory' | 'skipped' | 'report'; reason?: string }[] }[];
    };
    discovery?: { partial: boolean; warnings?: string[]; templates?: { template: string; samples: number }[]; skippedDuplicates?: number; brokenLinks?: { route: string; status: number; referrers: string[] }[]; droppedRoutes?: { route: string; source: string; status: number }[]; pages: { route: string; source: string; template?: string }[] };
    /** Profiles run: the first ('standards') decides the gate; 'commercial-parity' is supplementary (D9). */
    profiles?: ('standards' | 'commercial-parity')[];
    /** Supplementary commercial-parity findings beyond the standards run; never gating. */
    parity?: { profile: 'commercial-parity'; gating: false; pages: { url: string; error: string | null; findings: { ruleId: string; impact: string; wcagRef: string | null; selector: string; html: string; count: number }[] }[] };
    accessScan?: {
      profile: 'standards' | 'commercial-parity';
      includeThirdParty: boolean;
      comparatorVersion: string;
      pageRunCount?: number;
      execution: {
        aggregates: {
          rules: {
            complete: number;
            inapplicable: number;
            error: number;
            timeout: number;
            skipped: number;
          };
          checks: {
            complete: number;
            inapplicable: number;
            error: number;
            timeout: number;
            skipped: number;
            candidates: number;
            findings: number;
          };
        };
        perCheck: Array<{
          checkId: string;
          status: string;
          statusCounts?: Record<string, number>;
          candidateCount: number;
          findingCount: number;
        }>;
      } | null;
    };
  };
}

export interface ScanReportContext {
  generatedAt?: string;
  producer?: {
    name?: string;
    version?: string | null;
    nodeVersion?: string;
  };
  target?: {
    mode?: 'url-only' | 'local-only' | 'hybrid';
    url?: string | null;
    buildRevision?: string | null;
    instrumentationDigest?: string | null;
    deploymentUrl?: string | null;
    attestationStatus?: 'complete' | 'missing' | 'malformed' | 'scope-mismatch' | null;
    attestationReason?: string | null;
  };
}

export function findingStableId(finding: Record<string, unknown>): string;
export function stableFindingFingerprint(finding: Record<string, unknown>): string;
export function buildScanReportV2(
  scanResults?: Array<Record<string, unknown>>,
  context?: ScanReportContext,
): ScanReportV2;
export function computeReportId(report: ScanReportV2): string;
export function extractAccessScanRunMetadata(scanners: ScannerRun[]): ScanReportV2['runMetadata'] extends { accessScan?: infer T } ? T | null : null;
export function projectReportV1(report: ScanReportV2): Record<string, unknown>;
export function validateScanReportV2(report: ScanReportV2): true;
