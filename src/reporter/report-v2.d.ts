export const SCAN_REPORT_SCHEMA_VERSION: '2.0.0';

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
  nativeRuleId: string;
  nativeRuleIds: string[];
  canonicalRuleId: string;
  layer: string;
  layers: string[];
  category: string;
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
  pages: Array<{
    name: string;
    route: string;
    url: string | null;
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
    findingCount: number;
    occurrenceCount: number;
    layerCounts: Record<string, number>;
  };
  runMetadata?: {
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

export function stableFindingFingerprint(finding: Record<string, unknown>): string;
export function buildScanReportV2(
  scanResults?: Array<Record<string, unknown>>,
  context?: ScanReportContext,
): ScanReportV2;
export function computeReportId(report: ScanReportV2): string;
export function extractAccessScanRunMetadata(scanners: ScannerRun[]): ScanReportV2['runMetadata'] extends { accessScan?: infer T } ? T | null : null;
export function projectReportV1(report: ScanReportV2): Record<string, unknown>;
export function validateScanReportV2(report: ScanReportV2): true;
