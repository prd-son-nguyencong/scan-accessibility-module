import {
  SCAN_REPORT_SCHEMA_VERSION,
  canonicalSha256,
  canonicalStringify,
  normalizeHtml,
  normalizeSelector,
  normalizeSourcePath,
  normalizedHtmlSha256,
  stableFindingFingerprint,
} from './fingerprint.js';
import { canonicalizeRuleId } from './rule-aliases.js';
import { isKnownAttestationReason, sanitizeAttestationReason } from '../tracer/attestation-reasons.js';
import { mergeAccessScanExecutionTotals } from '../scanner/access-scan/engine/execution-totals.js';

const IMPACT_PRIORITY = {
  critical: 1,
  serious: 2,
  moderate: 3,
  minor: 4,
  info: 5,
};
const CONFIDENCE_PRIORITY = {
  high: 1,
  medium: 2,
  low: 3,
  none: 4,
};
const TARGET_MODES = new Set(['url-only', 'local-only', 'hybrid']);
const SCANNER_STATUSES = new Set(['complete', 'fallback', 'error', 'skipped']);
const SOURCE_CONFIDENCE = new Set(['high', 'medium', 'low', 'none']);
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function normalizeRoute(urlOrRoute = '/') {
  try {
    const pathname = new URL(urlOrRoute).pathname || '/';
    return pathname !== '/' ? pathname.replace(/\/+$/, '') || '/' : '/';
  } catch {
    const route = String(urlOrRoute || '/').split(/[?#]/, 1)[0] || '/';
    const prefixed = route.startsWith('/') ? route : `/${route}`;
    return prefixed !== '/' ? prefixed.replace(/\/+$/, '') || '/' : '/';
  }
}

function inferTargetMode(scanResults) {
  const urls = scanResults.map((page) => page.url).filter(Boolean);
  return urls.length > 0 && urls.every((url) => /^https?:\/\/(localhost|127\.0\.0\.1)(?::|\/|$)/i.test(url))
    ? 'local-only'
    : 'url-only';
}

function normalizeSource(source = {}) {
  const file = normalizeSourcePath(source.file);
  const line = Number.isInteger(source.line) && source.line > 0 ? source.line : null;
  const confidence = SOURCE_CONFIDENCE.has(source.confidence)
    ? source.confidence
    : file
      ? 'low'
      : 'none';
  const hasSourceLine = Boolean(file && line);
  return {
    mode: source.mode || 'url',
    file: file || null,
    line,
    snippet: source.snippet || source.snippetId || null,
    method: source.method || (file ? 'legacy-source-attribution' : 'unresolved'),
    confidence,
    preimageSha256: hasSourceLine ? source.preimageSha256 || null : null,
    preimageRange: hasSourceLine ? clone(source.preimageRange || null) : null,
    routeDependencies: Array.isArray(source.routeDependencies)
      ? [...new Set(source.routeDependencies.map(normalizeRoute))].sort()
      : [],
  };
}

function normalizeObservation(violation, source, element) {
  const nativeRuleId = violation.nativeRuleId || violation.ruleId || violation.rule || violation.id;
  const canonicalRuleId = violation.canonicalRuleId || canonicalizeRuleId(nativeRuleId);
  const layer = violation.layer || 'unknown';
  const message = violation.fix?.hint || violation.description || violation.message || '';
  const evidence = clone(violation.evidence || null);
  const relatedRuleIds = [
    ...new Set([
      ...(violation.related || []),
      ...(canonicalRuleId !== nativeRuleId ? [canonicalRuleId] : []),
    ]),
  ].sort();
  const rawReference = canonicalSha256({
    layer,
    nativeRuleId,
    selector: element.selector,
    normalizedHtmlHash: element.normalizedHtmlHash,
    source: {
      file: source.file,
      line: source.line,
      preimageSha256: source.preimageSha256,
    },
    message,
    evidence,
    relatedRuleIds,
  });
  return {
    rawReference,
    layer,
    nativeRuleId,
    impact: violation.impact || 'moderate',
    wcagRef: violation.wcagRef || null,
    count: Number.isInteger(violation.count) && violation.count > 0 ? violation.count : 1,
    message,
    element: clone(element),
    source: clone(source),
    evidence,
    relatedRuleIds,
  };
}

function normalizeFindingCandidate(violation, route, pageState) {
  const nativeRuleId = violation.nativeRuleId || violation.ruleId || violation.rule || violation.id;
  const canonicalRuleId = violation.canonicalRuleId || canonicalizeRuleId(nativeRuleId);
  const source = normalizeSource(violation.source);
  if (source.routeDependencies.length === 0) source.routeDependencies = [route];
  const outerHTML = normalizeHtml(
    violation.element?.outerHTML || violation.element?.html || violation.html || ''
  );
  const element = {
    selector: normalizeSelector(violation.element?.selector || violation.selector || ''),
    normalizedHtmlHash: violation.element?.normalizedHtmlHash || normalizedHtmlSha256(outerHTML),
    outerHTML,
    scanId: violation.element?.scanId || null,
    ...(Array.isArray(violation.element?.framePath) && violation.element.framePath.length > 0
      ? { framePath: [...violation.element.framePath] }
      : {}),
    ...(Array.isArray(violation.element?.shadowPath) && violation.element.shadowPath.length > 0
      ? { shadowPath: [...violation.element.shadowPath] }
      : {}),
  };
  const candidate = {
    schemaVersion: SCAN_REPORT_SCHEMA_VERSION,
    nativeRuleId,
    canonicalRuleId,
    layer: violation.layer || 'unknown',
    category: violation.category || 'accessibility',
    impact: violation.impact || 'moderate',
    priority: Number.isInteger(violation.priority)
      ? violation.priority
      : IMPACT_PRIORITY[violation.impact] || 3,
    count: Number.isInteger(violation.count) && violation.count > 0 ? violation.count : 1,
    pageState,
    route,
    wcagRef: violation.wcagRef || null,
    element,
    source,
    fix: {
      deterministic: violation.fix?.deterministic ?? false,
      hint: violation.fix?.hint || violation.description || '',
      patch: violation.fix?.patch || null,
    },
    manualChecks: clone(violation.manualChecks || []),
  };
  candidate.findingId = stableFindingFingerprint(candidate);
  candidate.observation = normalizeObservation(violation, source, element);
  return candidate;
}

function candidateSortKey(candidate) {
  return [
    String(IMPACT_PRIORITY[candidate.impact] || 99).padStart(2, '0'),
    String(CONFIDENCE_PRIORITY[candidate.source.confidence] || 99).padStart(2, '0'),
    candidate.layer,
    candidate.nativeRuleId,
    candidate.observation.rawReference,
  ].join('|');
}

function finalizeFinding(candidates) {
  const ordered = [...candidates].sort((a, b) =>
    candidateSortKey(a).localeCompare(candidateSortKey(b))
  );
  const primary = ordered[0];
  const bestSource = [...ordered].sort((a, b) =>
    (CONFIDENCE_PRIORITY[a.source.confidence] || 99)
    - (CONFIDENCE_PRIORITY[b.source.confidence] || 99)
    || candidateSortKey(a).localeCompare(candidateSortKey(b))
  )[0].source;
  const observations = [...new Map(
    ordered
      .map((candidate) => candidate.observation)
      .map((observation) => [observation.rawReference, observation])
  ).values()].sort((a, b) => a.rawReference.localeCompare(b.rawReference));
  const manualChecks = [...new Map(
    ordered.flatMap((candidate) => candidate.manualChecks)
      .map((check) => [canonicalStringify(check), check])
  ).values()].sort((a, b) => canonicalStringify(a).localeCompare(canonicalStringify(b)));

  return {
    findingId: primary.findingId,
    nativeRuleId: primary.nativeRuleId,
    nativeRuleIds: [...new Set(ordered.map((candidate) => candidate.nativeRuleId))].sort(),
    canonicalRuleId: primary.canonicalRuleId,
    layer: primary.layer,
    layers: [...new Set(ordered.map((candidate) => candidate.layer))].sort(),
    category: primary.category,
    impact: primary.impact,
    priority: Math.min(...ordered.map((candidate) => candidate.priority)),
    count: Math.max(...ordered.map((candidate) => candidate.count)),
    pageState: primary.pageState,
    route: primary.route,
    wcagRef: primary.wcagRef,
    element: clone(primary.element),
    source: clone(bestSource),
    evidence: {
      message: primary.fix.hint,
      observations,
    },
    manualChecks,
    fix: clone(primary.fix),
  };
}

function buildFindings(violations, route, pageState) {
  const groups = new Map();
  for (const violation of violations || []) {
    const candidate = normalizeFindingCandidate(violation, route, violation.pageState || pageState);
    if (!groups.has(candidate.findingId)) groups.set(candidate.findingId, []);
    groups.get(candidate.findingId).push(candidate);
  }
  return [...groups.values()]
    .map(finalizeFinding)
    .sort((a, b) => a.findingId.localeCompare(b.findingId));
}

function normalizeScannerRun(run, route) {
  const normalized = {
    route,
    layer: run.layer,
    engine: {
      name: run.engine?.name || run.layer || 'unknown',
      version: run.engine?.version || null,
    },
    viewport: run.viewport
      ? {
          name: run.viewport.name || null,
          width: run.viewport.width || null,
          height: run.viewport.height || null,
        }
      : null,
    pageState: run.pageState || 'initial',
    status: run.status || 'complete',
    source: run.source || null,
    provenance: clone(run.provenance || null),
    raw: clone(run.raw || null),
    supplemental: clone(run.supplemental || null),
    emitted: clone(run.emitted || null),
    evidence: clone(run.evidence || null),
  };
  normalized.runId = canonicalSha256(normalized);
  return normalized;
}

function scannerSortKey(run) {
  return [
    run.route,
    run.layer,
    run.engine.name,
    run.engine.version || '',
    run.viewport?.name || '',
    String(run.viewport?.width || ''),
    String(run.viewport?.height || ''),
    run.pageState,
    run.runId,
  ].join('|');
}

function buildSummary(pages) {
  const layerCounts = {};
  let findingCount = 0;
  let occurrenceCount = 0;
  for (const page of pages) {
    findingCount += page.findings.length;
    for (const finding of page.findings) {
      occurrenceCount += finding.count;
      for (const layer of finding.layers) {
        layerCounts[layer] = (layerCounts[layer] || 0) + finding.count;
      }
    }
  }
  return {
    pagesScanned: pages.length,
    findingCount,
    occurrenceCount,
    layerCounts: Object.fromEntries(Object.entries(layerCounts).sort(([a], [b]) => a.localeCompare(b))),
  };
}

export function extractAccessScanRunMetadata(scanners = []) {
  const accessRuns = scanners.filter((scanner) => scanner.layer === 'accessScan');
  if (accessRuns.length === 0) {
    return null;
  }

  const profiles = [...new Set(
    accessRuns.map((run) => run.evidence?.profile).filter((profile) => typeof profile === 'string'),
  )];
  const comparators = [...new Set(
    accessRuns
      .map((run) => run.evidence?.comparatorVersion)
      .filter((version) => typeof version === 'string'),
  )];

  if (profiles.length !== 1) {
    throw new Error('Invalid ScanReportV2: accessScan profile must be consistent across scanner runs');
  }
  if (comparators.length !== 1) {
    throw new Error('Invalid ScanReportV2: accessScan comparatorVersion must be consistent across scanner runs');
  }

  const execution = mergeAccessScanExecutionTotals(
    accessRuns.map((run) => run.evidence?.execution).filter(Boolean),
  );

  return {
    profile: profiles[0],
    includeThirdParty: accessRuns.some((run) => run.evidence?.includeThirdParty === true),
    comparatorVersion: comparators[0],
    execution,
    pageRunCount: accessRuns.length,
  };
}

export function computeReportId(report) {
  return canonicalSha256({
    schemaVersion: report.schemaVersion,
    producer: report.producer,
    target: report.target,
    scanners: report.scanners,
    pages: report.pages,
    summary: report.summary,
  });
}

export function buildScanReportV2(scanResults = [], context = {}) {
  const generatedAt = context.generatedAt || new Date().toISOString();
  const producer = {
    name: context.producer?.name || 'ada-scan',
    version: context.producer?.version || null,
    nodeVersion: context.producer?.nodeVersion || process.versions.node,
  };
  const target = {
    mode: context.target?.mode || inferTargetMode(scanResults),
    url: context.target?.url || scanResults[0]?.url || null,
    buildRevision: context.target?.buildRevision ?? null,
    instrumentationDigest: context.target?.instrumentationDigest ?? null,
    deploymentUrl: context.target?.deploymentUrl ?? null,
    attestationStatus: context.target?.attestationStatus ?? null,
    attestationReason: sanitizeAttestationReason(context.target?.attestationReason ?? null),
  };
  const scanners = [];
  const pages = scanResults.map((page) => {
    const route = normalizeRoute(page.route || page.url || '/');
    const scannerRuns = (page.scannerRuns || []).map((run) => normalizeScannerRun(run, route));
    scanners.push(...scannerRuns);
    const pageState = scannerRuns[0]?.pageState || 'initial';
    const findings = buildFindings(page.violations || page.findings || [], route, pageState);
    return {
      name: page.page || page.name || route,
      route,
      url: page.url || target.url,
      scannerRunIds: scannerRuns.map((run) => run.runId).sort(),
      dependencies: [...new Set(findings.map((finding) => finding.source.file).filter(Boolean))].sort(),
      findings,
      artifacts: {
        lighthouseScores: clone(page.lighthouseScores || {}),
        axeSummary: clone(page.axeSummary || null),
      },
    };
  }).sort((a, b) => a.route.localeCompare(b.route) || a.name.localeCompare(b.name));
  scanners.sort((a, b) => scannerSortKey(a).localeCompare(scannerSortKey(b)));

  const report = {
    schemaVersion: SCAN_REPORT_SCHEMA_VERSION,
    reportId: null,
    generatedAt,
    producer,
    target,
    scanners,
    pages,
    summary: buildSummary(pages),
  };
  const accessScan = extractAccessScanRunMetadata(scanners);
  if (accessScan) {
    report.runMetadata = { accessScan };
  }
  report.reportId = computeReportId(report);
  validateScanReportV2(report);
  return report;
}

function projectFindingV1(finding, generatedAt, pageUrl) {
  return {
    id: finding.findingId,
    ruleId: finding.nativeRuleId,
    canonicalRuleId: finding.canonicalRuleId,
    layer: finding.layer,
    layers: clone(finding.layers),
    category: finding.category,
    wcagRef: finding.wcagRef,
    impact: finding.impact,
    priority: finding.priority,
    count: finding.count,
    foundAt: generatedAt,
    related: [...new Set([
      ...finding.nativeRuleIds.filter((ruleId) => ruleId !== finding.nativeRuleId),
      ...finding.evidence.observations.flatMap((observation) => observation.relatedRuleIds || []),
    ])].sort(),
    element: {
      outerHTML: finding.element.outerHTML,
      selector: finding.element.selector,
      scanId: finding.element.scanId,
    },
    source: {
      ...clone(finding.source),
      url: pageUrl,
    },
    fix: clone(finding.fix),
    evidence: clone(finding.evidence),
    manualChecks: clone(finding.manualChecks),
  };
}

function buildProjectedV1Summary(pages) {
  const summary = {
    pagesScanned: pages.length,
    totalViolations: 0,
    critical: 0,
    serious: 0,
    moderate: 0,
    minor: 0,
    layerCounts: {},
    violationsByRule: {},
    violationsByFile: {},
  };
  for (const page of pages) {
    for (const violation of page.violations) {
      const count = Number.isInteger(violation.count) && violation.count > 0
        ? violation.count
        : 1;
      summary.totalViolations += count;
      if (Object.hasOwn(summary, violation.impact)) summary[violation.impact] += count;
      summary.layerCounts[violation.layer] = (summary.layerCounts[violation.layer] || 0) + count;
      summary.violationsByRule[violation.ruleId] =
        (summary.violationsByRule[violation.ruleId] || 0) + count;
      if (violation.source.file) {
        if (!summary.violationsByFile[violation.source.file]) {
          summary.violationsByFile[violation.source.file] = [];
        }
        summary.violationsByFile[violation.source.file].push({
          ruleId: violation.ruleId,
          description: violation.fix?.hint || '',
          impact: violation.impact,
          layer: violation.layer,
          sourceConfidence: violation.source.confidence,
          sourceLine: violation.source.line,
          snippetId: violation.source.snippet || null,
        });
      }
    }
  }
  summary.layerCounts = Object.fromEntries(
    Object.entries(summary.layerCounts).sort(([a], [b]) => a.localeCompare(b))
  );
  summary.violationsByRule = Object.fromEntries(
    Object.entries(summary.violationsByRule).sort(([a], [b]) => a.localeCompare(b))
  );
  summary.violationsByFile = Object.fromEntries(
    Object.entries(summary.violationsByFile).sort(([a], [b]) => a.localeCompare(b))
  );
  return summary;
}

export function projectReportV1(report) {
  const pages = report.pages.map((page) => {
    const runIds = new Set(page.scannerRunIds);
    const scannerRuns = report.scanners
      .filter((run) => runIds.has(run.runId))
      .map(({ runId: _runId, route: _route, ...run }) => clone(run));
    return {
      page: page.name,
      url: page.url,
      violations: page.findings.map((finding) =>
        projectFindingV1(finding, report.generatedAt, page.url)
      ),
      lighthouseScores: clone(page.artifacts.lighthouseScores),
      axeSummary: clone(page.artifacts.axeSummary),
      scannerRuns,
    };
  });
  return {
    timestamp: report.generatedAt,
    summary: buildProjectedV1Summary(pages),
    pages,
  };
}

function invariant(condition, message) {
  if (!condition) throw new Error(`Invalid ScanReportV2: ${message}`);
}

export function validateScanReportV2(report) {
  invariant(report?.schemaVersion === SCAN_REPORT_SCHEMA_VERSION, 'schemaVersion must be 2.0.0');
  invariant(typeof report.producer?.version === 'string' && report.producer.version, 'producer version is required');
  invariant(TARGET_MODES.has(report.target?.mode), 'target mode is required');
  if (report.target.mode === 'hybrid') {
    invariant(
      typeof report.target.buildRevision === 'string' && report.target.buildRevision,
      'build revision is required for hybrid targets',
    );
    invariant(
      typeof report.target.instrumentationDigest === 'string'
        && SHA256_PATTERN.test(report.target.instrumentationDigest),
      'instrumentation digest is required for hybrid targets',
    );
    invariant(
      typeof report.target.deploymentUrl === 'string' && report.target.deploymentUrl,
      'deployment URL is required for hybrid targets',
    );
    invariant(
      report.target.attestationStatus === 'complete',
      'hybrid targets require complete remote attestation',
    );
  }
  if (report.target.instrumentationDigest !== null) {
    invariant(
      SHA256_PATTERN.test(report.target.instrumentationDigest),
      'instrumentation digest must be a SHA-256 hash',
    );
  }
  if (report.target.attestationReason != null) {
    invariant(
      isKnownAttestationReason(report.target.attestationReason),
      'attestation reason must be a known fail-closed code',
    );
  }
  invariant(Array.isArray(report.scanners) && report.scanners.length > 0, 'scanner metadata is required');
  const scannerRunIds = new Set();
  const scannerRoutes = new Map();
  for (const scanner of report.scanners) {
    invariant(
      typeof scanner.route === 'string' && scanner.route.startsWith('/'),
      'scanner route is required',
    );
    invariant(typeof scanner.layer === 'string' && scanner.layer, 'scanner layer is required');
    invariant(typeof scanner.engine?.name === 'string' && scanner.engine.name, 'scanner engine name is required');
    invariant(
      scanner.status === 'error' || (typeof scanner.engine.version === 'string' && scanner.engine.version),
      'scanner engine version is required',
    );
    invariant(typeof scanner.pageState === 'string' && scanner.pageState, 'scanner page state is required');
    invariant(SCANNER_STATUSES.has(scanner.status), 'scanner status is invalid');
    const { runId, ...canonicalRun } = scanner;
    invariant(
      typeof runId === 'string'
        && SHA256_PATTERN.test(runId)
        && runId === canonicalSha256(canonicalRun),
      'scanner run ID does not match canonical content',
    );
    invariant(!scannerRunIds.has(runId), 'scanner run IDs must be unique');
    scannerRunIds.add(runId);
    scannerRoutes.set(runId, scanner.route);
  }
  invariant(Array.isArray(report.pages), 'pages are required');
  for (const page of report.pages) {
    invariant(typeof page.route === 'string' && page.route.startsWith('/'), 'page route is required');
    invariant(Array.isArray(page.scannerRunIds), 'page scanner run references are required');
    invariant(
      page.scannerRunIds.every((runId) =>
        scannerRunIds.has(runId) && scannerRoutes.get(runId) === page.route
      ),
      'page contains a dangling scanner run reference',
    );
    invariant(Array.isArray(page.findings), 'page findings are required');
    for (const finding of page.findings) {
      invariant(finding.route === page.route, 'finding route must match its page');
      invariant(
        typeof finding.findingId === 'string' && SHA256_PATTERN.test(finding.findingId),
        'finding ID is required',
      );
      invariant(typeof finding.nativeRuleId === 'string' && finding.nativeRuleId, 'native rule ID is required');
      invariant(typeof finding.canonicalRuleId === 'string' && finding.canonicalRuleId, 'canonical rule ID is required');
      invariant(
        typeof finding.source?.confidence === 'string' && SOURCE_CONFIDENCE.has(finding.source.confidence),
        'source confidence is required',
      );
      invariant(typeof finding.source.method === 'string' && finding.source.method, 'source method is required');
      if (finding.source.file) {
        invariant(
          !finding.source.file.startsWith('/')
            && !/^[A-Za-z]:\//.test(finding.source.file)
            && !finding.source.file.split('/').includes('..'),
          'source file must be a POSIX relative path',
        );
      }
      if (finding.source.preimageSha256 !== null) {
        invariant(
          SHA256_PATTERN.test(finding.source.preimageSha256),
          'source preimage must be a SHA-256 hash',
        );
      }
      if (finding.source.confidence === 'high') {
        invariant(
          typeof finding.source.file === 'string'
            && Number.isInteger(finding.source.line)
            && typeof finding.source.preimageSha256 === 'string'
            && SHA256_PATTERN.test(finding.source.preimageSha256),
          'high-confidence source trace requires file, line, and preimage hash',
        );
      }
      invariant(
        finding.findingId === stableFindingFingerprint({
          ...finding,
          schemaVersion: report.schemaVersion,
        }),
        'finding ID does not match canonical content',
      );
    }
  }
  invariant(
    typeof report.reportId === 'string' && SHA256_PATTERN.test(report.reportId),
    'report ID is required',
  );
  invariant(
    canonicalStringify(report.summary) === canonicalStringify(buildSummary(report.pages)),
    'report summary does not match page findings',
  );
  const hasAccessScanRuns = report.scanners.some((scanner) => scanner.layer === 'accessScan');
  if (hasAccessScanRuns) {
    invariant(
      report.runMetadata?.accessScan,
      'reports with accessScan scanner runs require runMetadata.accessScan',
    );
    const derived = extractAccessScanRunMetadata(report.scanners);
    invariant(
      canonicalStringify(derived) === canonicalStringify(report.runMetadata.accessScan),
      'runMetadata.accessScan must match scanner evidence',
    );
  } else if (report.runMetadata?.accessScan) {
    invariant(false, 'runMetadata.accessScan requires accessScan scanner runs');
  }
  invariant(report.reportId === computeReportId(report), 'report ID does not match canonical content');
  return true;
}

export {
  SCAN_REPORT_SCHEMA_VERSION,
  stableFindingFingerprint,
} from './fingerprint.js';
