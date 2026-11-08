import { createHash } from 'node:crypto';
import { normalizeRoute as normalizeRouteKeepingQuery, redactUrl, scrubUrls } from '../utils/route.js';
import {
  SCAN_REPORT_SCHEMA_VERSION,
  STABLE_ID_VERSION,
  canonicalSha256,
  canonicalStringify,
  findingStableId,
  normalizeHtml,
  normalizeSelector,
  normalizeSourcePath,
  normalizedHtmlSha256,
  stableFindingFingerprint,
} from './fingerprint.js';
import { derivePageStatus, partialReasons } from '../scanner/page-health.js';
import { isLoopbackUrl } from '../utils/host-classify.js';
import { buildSummary as buildLegacySummary } from './legacy-summary.js';
import { canonicalizeRuleId } from './rule-aliases.js';
import { canonicalRuleForFixUnit } from '../fix/canonical/finding-aliases.js';
import { isKnownAttestationReason, sanitizeAttestationReason } from '../tracer/attestation-reasons.js';
import { TRACE_REASONS } from '../tracer/trace-reasons.js';
import { classifyOrigin, classifyOwnership, suggestedAction } from '../tracer/ownership.js';
import { annotateAgreement, DERIVED_PAIRS, distinctElements, familyOf, rootCauseKey, sameElement, PAGE_LEVEL } from './engine-agreement.js';
import { applyRuleDemotions } from './labels.js';
import { isAdvisoryRule, isAxeIncomplete, kindForRule, proofFor, settleFinding, strongerVerdict, verdictFor } from '../utils/verdict.js';
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
const ROOT_CAUSE_RULES = new Set(['duplicate-id-referenced']);
const TARGET_MODES = new Set(['url-only', 'local-only', 'hybrid']);
const SCANNER_STATUSES = new Set(['complete', 'fallback', 'error', 'timeout', 'skipped']);
const PAGE_STATUSES = new Set(['ok', 'partial', 'failed', 'skipped-empty']);
const SOURCE_CONFIDENCE = new Set(['high', 'medium', 'low', 'none']);
const TRACE_CONFIDENCE = new Set(['high', 'medium', 'low', 'ambiguous', 'untraceable', 'stale']);
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

const normalizeRoute = (route) => normalizeRouteKeepingQuery(route, { keepQuery: false });

function inferTargetMode(scanResults) {
  const urls = scanResults.map((page) => page.url).filter(Boolean);
  return urls.length > 0 && urls.every(isLoopbackUrl)
    ? 'local-only'
    : 'url-only';
}

// Downgrades (instead of throwing) anything validateScanReportV2 would reject; reports each downgrade via warn().
function normalizeSource(source = {}, warn = () => {}) {
  let file = normalizeSourcePath(source.file);
  if (file === 'unknown') file = ''; // legacy placeholder for "no file"
  if (file && (file.startsWith('/') || /^[A-Za-z]:\//.test(file) || file.split('/').includes('..'))) {
    warn(`source file "${file}" is not a POSIX relative path; source dropped`);
    file = '';
  }
  const line = file && Number.isInteger(source.line) && source.line > 0 ? source.line : null;
  let confidence = SOURCE_CONFIDENCE.has(source.confidence)
    ? source.confidence
    : file
      ? 'low'
      : 'none';
  const hasSourceLine = Boolean(file && line);
  let preimageSha256 = hasSourceLine ? source.preimageSha256 || null : null;
  if (preimageSha256 !== null && !SHA256_PATTERN.test(preimageSha256)) {
    warn('source preimage is not a SHA-256 hash; preimage dropped');
    preimageSha256 = null;
  }
  if (confidence === 'high' && !(file && line && preimageSha256)) {
    if (source.confidence === 'high') warn('high-confidence source lacks file, line or preimage; downgraded to medium');
    confidence = file ? 'medium' : 'none';
  }
  return {
    mode: source.mode || 'url',
    file: file || null,
    line,
    snippet: source.snippet || source.snippetId || null,
    method: source.method || (file ? 'legacy-source-attribution' : 'unresolved'),
    confidence,
    preimageSha256,
    preimageRange: preimageSha256 ? clone(source.preimageRange || null) : null,
    routeDependencies: Array.isArray(source.routeDependencies)
      ? [...new Set(source.routeDependencies.map(normalizeRoute))].sort()
      : [],
    // Additive: where the data behind a link/text/image is authored (the template's .liquid.json line).
    ...(typeof source.dataFile === 'string' && source.dataFile && !source.dataFile.startsWith('/') && !source.dataFile.split('/').includes('..')
      ? { dataFile: normalizeSourcePath(source.dataFile), ...(Number.isInteger(source.dataLine) && source.dataLine > 0 ? { dataLine: source.dataLine } : {}) }
      : {}),
    // Additive: a link finding re-pointed at its data line keeps the template line it renders from.
    ...(source.templateSource?.file && typeof source.templateSource.file === 'string' && !source.templateSource.file.startsWith('/') && !source.templateSource.file.split('/').includes('..')
      ? { templateSource: { file: normalizeSourcePath(source.templateSource.file), line: Number.isInteger(source.templateSource.line) && source.templateSource.line > 0 ? source.templateSource.line : null } }
      : {}),
    // Additive: other places the cause may live (a script that only ties to the element weakly, the markup a script works around).
    ...(Array.isArray(source.alsoLikelyIn) && source.alsoLikelyIn.some((x) => x && typeof x.file === 'string' && x.file && !x.file.startsWith('/') && !x.file.split('/').includes('..'))
      ? { alsoLikelyIn: source.alsoLikelyIn.filter((x) => x && typeof x.file === 'string' && x.file && !x.file.startsWith('/') && !x.file.split('/').includes('..')).slice(0, 5)
        .map((x) => ({ file: normalizeSourcePath(x.file), line: Number.isInteger(x.line) && x.line > 0 ? x.line : null, ...(x.confidence === 'low' ? { confidence: 'low' } : {}) })) }
      : {}),
    ...(Array.isArray(source.dataAmbiguous) && source.dataAmbiguous.length ? { dataAmbiguous: source.dataAmbiguous.filter((x) => typeof x === 'string') } : {}),
    // Additive: a size finding re-pointed at the CSS rule declaring the size keeps the markup location it came from.
    ...(typeof source.cssSelector === 'string' && typeof source.markupFile === 'string' && source.markupFile && !source.markupFile.startsWith('/') && !source.markupFile.split('/').includes('..')
      ? { cssSelector: source.cssSelector, markupFile: normalizeSourcePath(source.markupFile), ...(Number.isInteger(source.markupLine) && source.markupLine > 0 ? { markupLine: source.markupLine } : {}) }
      : {}),
    // Additive: a note on how the source was chosen (a size that comes from an inherited rule keeps the markup line as primary).
    ...(typeof source.note === 'string' && source.note ? { note: source.note.slice(0, 300) } : {}),
    // Additive: why a finding is ambiguous/untraceable (traceElement); absent on older scans.
    ...(TRACE_CONFIDENCE.has(source.traceConfidence) ? { traceConfidence: source.traceConfidence } : {}),
    ...(typeof source.traceReason === 'string' && TRACE_REASONS.has(source.traceReason) ? { traceReason: source.traceReason } : {}),
  };
}

function normalizeSourceCandidates(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((candidate) => candidate?.file)
    .map((candidate) => ({
      file: normalizeSourcePath(candidate.file),
      line: Number.isInteger(candidate.line) && candidate.line > 0 ? candidate.line : null,
      confidence: SOURCE_CONFIDENCE.has(candidate.confidence) ? candidate.confidence : 'low',
      method: candidate.method || 'candidate',
      preimageSha256: SHA256_PATTERN.test(candidate.preimageSha256 || '') ? candidate.preimageSha256 : null,
    }));
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

function normalizeFindingCandidate(violation, route, pageState, warn) {
  const nativeRuleId = violation.nativeRuleId || violation.ruleId || violation.rule || violation.id;
  const canonicalRuleId = violation.canonicalRuleId || canonicalizeRuleId(nativeRuleId);
  const source = normalizeSource(violation.source, warn);
  if (source.routeDependencies.length === 0) source.routeDependencies = [normalizeRoute(route)];
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
  const kind = violation.kind || kindForRule(violation.layer, nativeRuleId);
  const origin = classifyOrigin({ ...violation, outerHTML, selector: element.selector });
  const settled = settleFinding({
    kind,
    verdict: violation.verdict || verdictFor({ kind }),
    impact: IMPACT_PRIORITY[violation.impact] ? violation.impact : 'moderate',
    ruleId: nativeRuleId,
    incomplete: isAxeIncomplete(violation),
    proof: proofFor({ ...violation, ruleId: nativeRuleId }),
    advisory: isAdvisoryRule({ layer: violation.layer, ruleId: nativeRuleId, tags: violation.evidence?.tags || [] }),
  });
  const { impact } = settled;
  const candidate = {
    schemaVersion: SCAN_REPORT_SCHEMA_VERSION,
    nativeRuleId,
    canonicalRuleId,
    layer: violation.layer || 'unknown',
    category: violation.category || 'accessibility',
    impact,
    priority: Number.isInteger(violation.priority) && impact === violation.impact
      ? violation.priority
      : IMPACT_PRIORITY[impact] || 3,
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
    kind,
    ...(violation.linkTarget?.url ? { linkTarget: clone(violation.linkTarget) } : {}),
    sourceCandidates: normalizeSourceCandidates(violation.sourceCandidates),
    origin,
    ownership: classifyOwnership({ origin }),
    ...(violation.siteFix ? { siteFix: clone(violation.siteFix) } : {}),
  };
  if (origin.owner !== 'site') {
    // Not the site's code: never attributed to a template file, whatever an earlier layer guessed.
    candidate.source = {
      ...candidate.source, file: null, line: null, snippet: null, confidence: 'none', preimageSha256: null, preimageRange: null,
      method: origin.owner === 'third-party' ? 'third-party' : 'platform-owned',
      traceReason: origin.owner === 'third-party' ? `third-party: ${origin.vendor || origin.kind}` : 'platform-owned',
    };
  } else if (!candidate.source.file) {
    candidate.source.traceReason = candidate.source.traceReason || (candidate.source.method === 'no-source-project' ? 'no-source-project' : 'unresolved');
  }
  candidate.verdict = settled.verdict;
  // Nothing proves the site cannot change DOM that a script injected and no vendor claims: never confirmed.
  if (origin.kind === 'injected-runtime' && candidate.verdict !== 'needs-review') candidate.verdict = 'needs-review';
  // Ownership that could not be established (live probe failed) is a question, not a defect to confirm.
  if (origin.kind === 'unknown-probe-failed') candidate.verdict = 'needs-review';
  // A vendor's injected DOM (consent banner, chat, widget SDK) is not the site's to fix: reported for context, never confirmed.
  if (origin.owner === 'third-party' && candidate.verdict !== 'needs-review') candidate.verdict = 'needs-review';
  // Content bound by the platform is not rendered in a local build: what is missing there proves nothing.
  if (origin.kind === 'unbound-data' && candidate.verdict !== 'needs-review') candidate.verdict = 'needs-review';
  if (candidate.verdict === 'confirmed') candidate.proof = proofFor({ ...violation, ruleId: nativeRuleId });
  candidate.findingId = stableFindingFingerprint(candidate);
  candidate.stableId = findingStableId(candidate);
  candidate.observation = normalizeObservation(violation, source, element);
  return candidate;
}

/** The stableId the report will give this violation, so evidence files can be named before the report exists. */
export function violationStableId(violation, pageUrl, pageState = 'initial') {
  const route = redactUrl(normalizeRouteKeepingQuery(pageUrl || '/'));
  return normalizeFindingCandidate(violation, route, violation.pageState || pageState, () => {}).stableId;
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

// Distinct observations of one rule from one layer add up; the same element seen by several layers or rules (merged root cause) is still one issue.
function sumOccurrences(observations) {
  const perLayer = new Map();
  for (const observation of observations) {
    const key = `${observation.layer}|${observation.nativeRuleId}`;
    perLayer.set(key, (perLayer.get(key) || 0) + observation.count);
  }
  return Math.max(...perLayer.values());
}

function finalizeFinding(candidates) {
  // The rule that names the root cause (with its occurrence count and affected elements) speaks for a merged finding, whatever its impact tie-break.
  const ordered = [...candidates].sort((a, b) =>
    Number(ROOT_CAUSE_RULES.has(b.nativeRuleId)) - Number(ROOT_CAUSE_RULES.has(a.nativeRuleId))
    || candidateSortKey(a).localeCompare(candidateSortKey(b))
  );
  const primary = ordered[0];
  // The same element seen by several engines keeps the strongest verdict (and the kind that earned it).
  const surest = ordered.reduce((best, c) => (strongerVerdict(best.verdict, c.verdict) === best.verdict ? best : c));
  // Any candidate that proves the element is not the site's (or holds unbound platform data) decides for the merged finding: no site source, never confirmed on unbound data.
  const foreign = ordered.find((c) => c.origin.owner !== 'site');
  const unbound = ordered.some((c) => c.origin.kind === 'unbound-data');
  const mergedOrigin = (foreign || ordered.find((c) => c.origin.kind === 'unbound-data') || primary).origin;
  // A derived row (axe `region` on the skip link) only points at the element; the root cause's own rows say where the fix goes (the page's <main>).
  const rooted = ordered.filter((c) => !DERIVED_PAIRS[c.nativeRuleId]);
  const bySource = (a, b) => (CONFIDENCE_PRIORITY[a.source.confidence] || 99) - (CONFIDENCE_PRIORITY[b.source.confidence] || 99) || candidateSortKey(a).localeCompare(candidateSortKey(b));
  const rootBest = [...(rooted.length ? rooted : ordered)].sort(bySource)[0];
  // Missing <main> rows only anchor where a landmark would go; a derived `region` row that located a real element in a partial (the header outside any landmark) is where the fix is made. The anchor stays listed.
  const located = rooted.length && rooted.every((c) => c.source.method === 'page-level-anchor' && /main/.test(c.nativeRuleId))
    ? ordered.filter((c) => DERIVED_PAIRS[c.nativeRuleId] && /^src\/(partials|components)\//.test(c.source.file || '') && ['medium', 'high'].includes(c.source.confidence)).sort(bySource)[0] : null;
  const bestSource = foreign ? foreign.source : (located || rootBest).source;
  const observations = [...new Map(
    ordered
      .map((candidate) => candidate.observation)
      .map((observation) => [observation.rawReference, observation])
  ).values()].sort((a, b) => a.rawReference.localeCompare(b.rawReference));
  const manualChecks = [...new Map(
    ordered.flatMap((candidate) => candidate.manualChecks)
      .map((check) => [canonicalStringify(check), check])
  ).values()].sort((a, b) => canonicalStringify(a).localeCompare(canonicalStringify(b)));

  const sourceCandidates = [...new Map(
    [...ordered.flatMap((candidate) => candidate.sourceCandidates), ...(located && rootBest.source.file ? [{ file: rootBest.source.file, line: rootBest.source.line, confidence: 'low', method: 'page-level-anchor', preimageSha256: null }] : [])]
      .map((entry) => [canonicalStringify(entry), entry])
  ).values()].sort((a, b) => canonicalStringify(a).localeCompare(canonicalStringify(b)));

  // One element per finding: element, source and proof describe the same node. A value-keyed merge (one duplicated id, one skipped heading) can hold rows of
  // several elements; the element follows the row that supplied the source, so the markup, selector and file:line are never a mix.
  const carrier = (foreign || located || rootBest);
  const oneElement = carrier !== primary && distinctElements(carrier, primary) ? carrier.element : primary.element;
  const finding = {
    findingId: primary.findingId,
    stableId: primary.stableId,
    nativeRuleId: primary.nativeRuleId,
    nativeRuleIds: [...new Set(ordered.map((candidate) => candidate.nativeRuleId))].sort(),
    canonicalRuleId: primary.canonicalRuleId,
    layer: primary.layer,
    layers: [...new Set(ordered.map((candidate) => candidate.layer))].sort(),
    category: primary.category,
    kind: surest.kind,
    verdict: mergedOrigin.owner === 'third-party' || (unbound && surest.verdict === 'confirmed') ? 'needs-review' : surest.verdict,
    ownership: classifyOwnership({ origin: mergedOrigin }),
    origin: mergedOrigin,
    impact: primary.impact,
    priority: Math.min(...ordered.map((candidate) => candidate.priority)),
    count: sumOccurrences(observations),
    pageState: primary.pageState,
    route: primary.route,
    wcagRef: primary.wcagRef,
    element: clone(oneElement),
    source: clone(bestSource),
    evidence: {
      message: primary.fix.hint,
      observations,
      ...(!unbound && mergedOrigin.owner !== 'third-party' && surest.verdict === 'confirmed' && surest.proof ? { proof: clone(surest.proof) } : {}),
    },
    manualChecks,
    fix: clone(primary.fix),
    ...(sourceCandidates.length > 0 && !foreign ? { sourceCandidates } : {}),
    ...(foreign?.siteFix ? { siteFix: clone(foreign.siteFix) } : {}),
    ...(primary.linkTarget ? { link: { url: primary.linkTarget.url, status: primary.linkTarget.status, reason: primary.linkTarget.reason, fragments: primary.linkTarget.fragment ? [primary.linkTarget.fragment] : [] } } : {}),
  };
  // A merged finding takes the best source of any candidate, which can differ from the primary's: its ids hash the merged content.
  if (ordered.length > 1) {
    finding.findingId = stableFindingFingerprint({ ...finding, schemaVersion: SCAN_REPORT_SCHEMA_VERSION });
    finding.stableId = findingStableId(finding);
  }
  return finding;
}

const CONFIDENT_SOURCE = new Set(['medium', 'high']);

/** True when the finding names a source file and line with confidence of at least medium (the designated anchor of an absence finding counts). */
export function hasTracedSource(source) {
  if (!source?.file || source.file === 'unknown') return false;
  if (source.method === 'page-level-anchor') return true;
  if (source.templateSource?.line && CONFIDENT_SOURCE.has(source.traceConfidence)) return true; // a script match was ambiguous, the markup line was not
  if (source.method === 'data-sidecar' && source.dataLine && !source.dataAmbiguous) return true; // exact value hit in the sidecar
  return Boolean(source.line) && CONFIDENT_SOURCE.has(source.confidence);
}

/**
 * Product rule: a site-owned finding is `confirmed` only when a source file:line is attributed with confidence of at least medium.
 * One without it becomes `likely` (kept in the report and in the fix export as "untraced: locate manually"): `untraced` is set, the
 * verdict it had stays in verdictBeforeAgreement (baseline comparison still sees it), and `source.traceReason` says why. Vendor and
 * platform findings are never confirmed anyway, so they are left alone.
 */
export function demoteUntraced(pages) {
  for (const page of pages) {
    for (const f of page.findings) {
      if (f.verdict !== 'confirmed' || (f.ownership && f.ownership !== 'source') || hasTracedSource(f.source)) continue;
      f.verdictBeforeAgreement ??= 'confirmed';
      f.verdict = 'likely';
      f.untraced = true;
      f.source = { ...f.source, traceReason: f.source.traceReason || (f.source.line ? 'multiple-candidates' : 'unresolved') };
    }
  }
}

/**
 * One defect seen by several layers is one finding: groups (candidates sharing a findingId) that are the same canonical rule family on the same
 * element and page state, from different layers, are merged. A layer that already reported an element never merges into another element's bucket.
 * Axe 'region' on an element that has a skip-link finding is derived from it and merges into it.
 * shortcut: elements match by selector, or by opening tag when it is distinctive or unambiguous per layer; upgrade to a DOM-path match if engines disagree on both.
 */
function mergeByRootCause(groups) {
  const buckets = [];
  // A generic opening tag (`<a href="#"></a>`) says nothing about which element it is: it only matches when it carries an id/class/real href/src,
  // or when each layer reported just one element of that family on the page.
  const distinctive = (f) => /^<[^>]*(\sid=|\sclass=|\s(?:href|src)=["']?(?!#?["'\s>]|x["'\s>]|javascript))/i.test(f.element?.outerHTML || '');
  const famOf = (g) => familyOf({ ...g[0], evidence: { message: g[0].fix.hint } });
  const perLayer = new Map();
  for (const g of groups) { const k = `${famOf(g)}|${g[0].pageState}|${g[0].layer}`; perLayer.set(k, (perLayer.get(k) || 0) + 1); }
  const lone = (fam, state, layer) => perLayer.get(`${fam}|${state}|${layer}`) === 1;
  // Two layers that resolved to one authoring line (and report once each there) saw the same element, whatever their selectors or markup quoting.
  const lineKey = (c, fam) => (c.source?.file && c.source.line ? `${fam}|${c.pageState}|${c.layer}|${c.source.file}:${c.source.line}` : null);
  const perLine = new Map();
  for (const g of groups) { const k = lineKey(g[0], famOf(g)); if (k) perLine.set(k, (perLine.get(k) || 0) + 1); }
  const sameLine = (c, probe, fam) => { const a = lineKey(c, fam); const b = lineKey(probe, fam); return a && b && perLine.get(a) === 1 && perLine.get(b) === 1 && a.split('|').pop() === b.split('|').pop(); };
  const match = (c, probe, fam) => (c.element?.selector && c.element.selector === probe.element?.selector)
    || (!distinctElements(c, probe) && ((sameElement(c, probe) && (distinctive(probe) || (lone(fam, probe.pageState, probe.layer) && lone(fam, c.pageState, c.layer))))
    || (!PAGE_LEVEL.has(fam) && sameLine(c, probe, fam))));
  const derived = (g) => Boolean(DERIVED_PAIRS[g[0].nativeRuleId]);
  // A value-keyed root cause (one duplicated id, one skipped heading, one list structure) is one finding whatever layer or element reported it.
  const keyOf = (g) => rootCauseKey(g[0]);
  for (const group of groups.filter(keyOf)) {
    const probe = group[0];
    const key = keyOf(group);
    // Two skipped headings with the same text are two defects: one layer cannot report one heading twice at different places.
    const twin = (b) => b.family === 'heading-order' && b.candidates.some((c) => c.layer === probe.layer && c.element?.selector && probe.element?.selector && c.element.selector !== probe.element.selector);
    const bucket = buckets.find((b) => b.key === key && b.pageState === probe.pageState && !twin(b));
    if (bucket) { bucket.candidates.push(...group); group.forEach((c) => bucket.layers.push(c.layer)); }
    else buckets.push({ key, family: familyOf({ ...probe, evidence: { message: probe.fix.hint } }), pageState: probe.pageState, layers: [...new Set(group.map((c) => c.layer))], candidates: [...group] });
  }
  for (const group of [...groups.filter((g) => !derived(g) && !keyOf(g)), ...groups.filter((g) => derived(g) && !keyOf(g))]) {
    const probe = group[0];
    const family = familyOf({ ...probe, evidence: { message: probe.fix.hint } });
    const wanted = derived(group) ? DERIVED_PAIRS[probe.nativeRuleId] : family ? [family] : [];
    const layers = new Set(group.map((c) => c.layer));
    const bucket = buckets.find((b) => wanted.includes(b.family) && b.pageState === probe.pageState
      && (derived(group) || !b.layers.some((l) => layers.has(l))) && (PAGE_LEVEL.has(b.family) || b.candidates.some((c) => match(c, probe, b.family))));
    if (bucket) {
      bucket.candidates.push(...group);
      layers.forEach((l) => bucket.layers.push(l));
    } else {
      buckets.push({ family, pageState: probe.pageState, layers: [...layers], candidates: [...group] });
    }
  }
  return mergeLoopRepeats(buckets.map((b) => b.candidates));
}

/**
 * One authoring line that a template loop renders N times (4 tabpanels of one {% for %}) is one root cause: buckets with the same layers, the same
 * canonical rules, page state and resolved source line merge into one finding whose occurrences count every element. Different lines stay apart;
 * unresolved or low-confidence sources, other data lines of one loop template (a link per data row) and value-keyed root causes (duplicate ids, heading order) never merge (a guessed line proves nothing).
 * shortcut: the line is the key, so two unrelated elements that tracing wrongly maps to one confident line merge; upgrade to a DOM-path check if that shows up.
 */
function mergeLoopRepeats(groups) {
  const byKey = new Map();
  const out = [];
  for (const g of groups) {
    const p = g[0];
    const traced = g.every((c) => c.source?.file && c.source.line && !['low', 'none'].includes(c.source.confidence) && c.origin?.owner === 'site' && !rootCauseKey(c));
    if (!traced) { out.push(g); continue; }
    const key = [p.pageState, `${p.source.file}:${p.source.line}:${p.source.dataFile || ''}:${p.source.dataLine || ''}`, [...new Set(g.map((c) => c.layer))].sort(), [...new Set(g.map((c) => c.canonicalRuleId))].sort()].join('|');
    const hit = byKey.get(key);
    if (hit) hit.push(...g); else { byKey.set(key, g); out.push(g); }
  }
  return out;
}

function buildFindings(violations, route, pageState, warnings = [], agreementPolicy = 'strict', demotedRuleIds = null) {
  const groups = new Map();
  for (const violation of violations || []) {
    const ruleId = violation?.nativeRuleId || violation?.ruleId || violation?.rule || violation?.id || null;
    const warn = (message) => warnings.push({ type: 'validation', route, ruleId, message });
    let candidate;
    try {
      candidate = normalizeFindingCandidate(violation, route, violation.pageState || pageState, warn);
    } catch (error) {
      warn(`finding dropped: ${error.message}`);
      continue;
    }
    if (!groups.has(candidate.findingId)) groups.set(candidate.findingId, []);
    groups.get(candidate.findingId).push(candidate);
  }
  return applyRuleDemotions(annotateAgreement(
    mergeByRootCause([...groups.values()]).map(finalizeFinding).sort((a, b) => a.findingId.localeCompare(b.findingId)),
    agreementPolicy,
  ), demotedRuleIds);
}

function normalizeScannerRun(run, route, scrub = (v) => v) {
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
    raw: scrub(clone(run.raw || null)),
    supplemental: scrub(clone(run.supplemental || null)),
    emitted: scrub(clone(run.emitted || null)),
    evidence: scrub(clone(run.evidence || null)),
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

/**
 * A dead link is one defect per target URL and kind (rule, verdict, status, reason), however many pages and elements carry it: the shared footer
 * link on 40 pages is one finding. It stays on the page whose copy has the best source (so its ids stay valid) and lists `pages`, every distinct
 * authoring `sources` and the URL `fragments` (never probed, but reported); `count` sums the occurrences.
 */
function groupLinkFindings(pages) {
  const groups = new Map();
  for (const page of pages) {
    for (const f of page.findings) {
      if (!f.link?.url) continue;
      const key = [f.nativeRuleId, f.verdict, f.link.status, f.link.reason, f.link.url, f.origin?.owner || 'site', f.origin?.kind === 'unbound-data'].join('|');
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ f, page });
    }
  }
  for (const members of groups.values()) {
    const rank = ({ f }) => (f.source?.file ? (CONFIDENCE_PRIORITY[f.source.confidence] || 99) : 1000);
    const [keep] = [...members].sort((a, b) => rank(a) - rank(b));
    const srcKey = (f) => (f.source?.file ? `${f.source.dataFile || f.source.file}:${f.source.dataLine || f.source.line || 0}` : null);
    const sources = [...new Map(members.map(({ f }) => [srcKey(f), f]).filter(([k]) => k).map(([k, f]) => [k, {
      file: f.source.file, line: f.source.line ?? null,
      ...(f.source.dataFile ? { dataFile: f.source.dataFile, dataLine: f.source.dataLine ?? null } : {}),
    }])).values()];
    keep.f.pages = [...new Set(members.map(({ page }) => page.route))].sort();
    keep.f.count = members.reduce((n, { f }) => n + (f.count || 1), 0);
    keep.f.link = { ...keep.f.link, fragments: [...new Set(members.flatMap(({ f }) => f.link.fragments))].sort() };
    if (sources.length > 1) keep.f.link.sources = sources;
    for (const m of members) if (m !== keep) m.page.findings = m.page.findings.filter((x) => x !== m.f);
  }
}

/**
 * Findings that come from one source line and one canonical rule (a shared layout or partial rendered on many pages, or one line repeated on a page)
 * stay per-page findings but carry the same sharedSource id, so exports and reports can show the defect once. Same grouping key as the fix tasks.
 */
function annotateSharedSource(pages) {
  const groups = new Map();
  for (const page of pages) {
    for (const f of page.findings) {
      if (!f.source?.file || !f.source.line || f.impact === 'info') continue;
      const id = createHash('sha256').update(`${canonicalRuleForFixUnit(f.canonicalRuleId || f.nativeRuleId)}|${f.source.file}:${f.source.line}`).digest('hex').slice(0, 16);
      if (!groups.has(id)) groups.set(id, []);
      groups.get(id).push({ f, route: page.route });
    }
  }
  for (const [id, members] of groups) {
    if (members.length < 2) continue;
    const info = { id, findings: members.length, pages: new Set(members.map((m) => m.route)).size };
    members.forEach(({ f }) => { f.sharedSource = { ...info }; });
  }
}

const NOT_YOURS_SEVERITY = ['critical', 'serious', 'moderate', 'minor'];

/**
 * Findings in code the site team cannot change (vendor scripts, platform widgets, cross-origin iframes), once per site:
 * grouped by owner + vendor/kind + rule + selector across pages, with the pages listed.
 */
export function buildNotYourCode(pages) {
  const groups = new Map();
  for (const page of pages) {
    for (const f of page.findings) {
      if (!f.origin || f.origin.owner === 'site' || f.impact === 'info') continue;
      const key = [f.origin.owner, f.origin.vendor || f.origin.kind, f.nativeRuleId, f.element.selector].join('|');
      const g = groups.get(key) || {
        owner: f.origin.owner, kind: f.origin.kind, ...(f.origin.vendor ? { vendor: f.origin.vendor } : {}), label: f.origin.label,
        rule: f.nativeRuleId, selector: f.element.selector, impact: f.impact, verdict: f.verdict ?? 'confirmed',
        occurrences: 0, findings: 0, pages: [], evidence: f.origin.evidence, suggestedAction: suggestedAction(f.origin),
      };
      if (NOT_YOURS_SEVERITY.indexOf(f.impact) < NOT_YOURS_SEVERITY.indexOf(g.impact)) g.impact = f.impact;
      g.occurrences += f.count;
      g.findings += 1;
      if (!g.pages.includes(page.route)) g.pages.push(page.route);
      groups.set(key, g);
    }
  }
  return [...groups.values()].map((g) => ({ ...g, pages: g.pages.sort() }))
    .sort((a, b) => NOT_YOURS_SEVERITY.indexOf(a.impact) - NOT_YOURS_SEVERITY.indexOf(b.impact) || a.label.localeCompare(b.label) || a.rule.localeCompare(b.rule) || a.selector.localeCompare(b.selector));
}

function buildSummary(pages, scanners = []) {
  const sharedSources = new Set();
  const layerCounts = {};
  let findingCount = 0;
  let occurrenceCount = 0;
  let infoCount = 0;
  let pagesFailed = 0;
  let pagesPartial = 0;
  let pagesPartialGating = 0;
  let pagesSkipped = 0;
  const verdictCounts = { confirmed: 0, likely: 0, needsReview: 0 };
  let hasVerdicts = false;
  const ownershipCounts = { source: 0, platform: 0, thirdParty: 0 };
  const ownershipFindingCounts = { source: 0, platform: 0, thirdParty: 0 };
  let thirdPartyConfirmed = 0;
  let platformConfirmed = 0;
  for (const page of pages) {
    if (page.status === 'failed') pagesFailed++;
    else if (page.status === 'partial') {
      pagesPartial++;
      if (!page.partialReasons || page.partialReasons.some((r) => r.gating)) pagesPartialGating++;
    }
    else if (page.status === 'skipped-empty') pagesSkipped++;
    findingCount += page.findings.length;
    for (const finding of page.findings) {
      if (finding.sharedSource) sharedSources.add(finding.sharedSource.id);
      if (finding.impact === 'info') {
        infoCount += finding.count;
        continue;
      }
      occurrenceCount += finding.count;
      const ownerKey = finding.ownership === 'third-party' ? 'thirdParty' : finding.ownership || 'source';
      ownershipCounts[ownerKey] += finding.count;
      ownershipFindingCounts[ownerKey] += 1;
      if (ownerKey === 'thirdParty' && (finding.verdict ?? 'confirmed') === 'confirmed') thirdPartyConfirmed += finding.count;
      if (ownerKey === 'platform' && (finding.verdict ?? 'confirmed') === 'confirmed') platformConfirmed += finding.count;
      if (finding.verdict) {
        hasVerdicts = true;
        verdictCounts[finding.verdict === 'needs-review' ? 'needsReview' : finding.verdict] += finding.count;
      }
      for (const layer of finding.layers) {
        layerCounts[layer] = (layerCounts[layer] || 0) + finding.count;
      }
    }
  }
  const lighthouse = {};
  for (const run of scanners) {
    if (run.layer === 'lighthouse') lighthouse[run.status] = (lighthouse[run.status] || 0) + 1;
  }
  return {
    pagesScanned: pages.length,
    pagesFailed,
    pagesPartial,
    ...(pagesPartialGating !== pagesPartial ? { pagesPartialGating } : {}),
    ...(pagesSkipped ? { pagesSkipped } : {}),
    scannerErrors: scanners.filter((run) => run.status === 'error' || run.status === 'timeout').length,
    ...(Object.keys(lighthouse).length ? { lighthouse: Object.fromEntries(Object.entries(lighthouse).sort(([a], [b]) => a.localeCompare(b))) } : {}),
    // findingCount: merged findings (one per defect per page per element, layers combined); occurrenceCount: sum of finding.count (distinct DOM occurrences, an element seen by several layers counts once).
    findingCount,
    occurrenceCount,
    ...(sharedSources.size > 0 ? { sharedSourceGroups: sharedSources.size } : {}),
    ...(infoCount > 0 ? { infoCount } : {}),
    ...(hasVerdicts ? { verdictCounts } : {}),
    // Additive. ownershipCounts sums occurrences (finding.count); ownershipFindingCounts counts findings. Platform and third-party findings stay out of the gate unless gate.countPlatform / gate.countThirdParty.
    ...(ownershipCounts.platform + ownershipCounts.thirdParty > 0 ? { ownershipCounts, ownershipFindingCounts } : {}),
    // Confirmed occurrences inside cross-origin iframes: the gate and --fail-on-violations leave them out unless gate.countThirdParty.
    ...(thirdPartyConfirmed > 0 ? { thirdPartyConfirmed } : {}),
    // Same for platform-owned findings (widgets, chat): outside the gate unless gate.countPlatform.
    ...(platformConfirmed > 0 ? { platformConfirmed } : {}),
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
  const keepQuery = Boolean(context.keepQuery);
  const redact = (url) => redactUrl(url, { keepQuery });
  const scrub = (v) => scrubUrls(v, { keepQuery });
  const target = {
    mode: context.target?.mode || inferTargetMode(scanResults),
    url: redact(context.target?.url || scanResults[0]?.url || null),
    buildRevision: context.target?.buildRevision ?? null,
    instrumentationDigest: context.target?.instrumentationDigest ?? null,
    deploymentUrl: redact(context.target?.deploymentUrl ?? null),
    attestationStatus: context.target?.attestationStatus ?? null,
    attestationReason: sanitizeAttestationReason(context.target?.attestationReason ?? null),
  };
  const scanners = [];
  const warnings = [];
  const demotedRuleIds = new Set((context.ruleDemotions || []).map((d) => d.ruleId));
  const pages = scanResults.map((page) => {
    const route = redactUrl(normalizeRouteKeepingQuery(page.route || page.url || '/'));
    const status = page.status || derivePageStatus(page.failure, page.scannerRuns);
    const scannerRuns = (page.scannerRuns || []).map((run) => normalizeScannerRun(run, route, scrub));
    scanners.push(...scannerRuns);
    const pageState = scannerRuns[0]?.pageState || 'initial';
    const findings = buildFindings(page.violations || page.findings || [], route, pageState, warnings, context.agreementPolicy, demotedRuleIds);
    return {
      name: page.page || page.name || route,
      route,
      url: redact(page.url) || target.url,
      status,
      ...(status === 'partial' ? { partialReasons: scrub(partialReasons(page.scannerRuns, { strict: context.strict })) } : {}),
      failure: scrub(clone(page.failure || null)),
      ...(page.skipped ? { skipped: clone(page.skipped) } : {}),
      ...(page.contentHash ? { contentHash: page.contentHash } : {}),
      scannerRunIds: scannerRuns.map((run) => run.runId).sort(),
      dependencies: [...new Set(findings.map((finding) => finding.source.file).filter(Boolean))].sort(),
      findings,
      artifacts: {
        lighthouseScores: scrub(clone(page.lighthouseScores || {})),
        axeSummary: clone(page.axeSummary || null),
      },
    };
  }).sort((a, b) => a.route.localeCompare(b.route) || a.name.localeCompare(b.name));
  scanners.sort((a, b) => scannerSortKey(a).localeCompare(scannerSortKey(b)));
  groupLinkFindings(pages);
  annotateSharedSource(pages);
  if (context.sourceTracing?.requireSource) demoteUntraced(pages);

  const report = {
    schemaVersion: SCAN_REPORT_SCHEMA_VERSION,
    stableIdVersion: STABLE_ID_VERSION,
    reportId: null,
    generatedAt,
    producer,
    target,
    scanners,
    pages,
    summary: buildSummary(pages, scanners),
  };
  const notYourCode = buildNotYourCode(pages);
  if (notYourCode.length) report.notYourCode = notYourCode;
  const accessScan = extractAccessScanRunMetadata(scanners);
  if (accessScan) {
    report.runMetadata = { accessScan };
  }
  if (context.allowIncomplete) {
    report.runMetadata = { ...report.runMetadata, allowIncomplete: true };
  }
  if (context.sourceTracing) {
    report.runMetadata = { ...report.runMetadata, sourceTracing: clone(context.sourceTracing) };
  }
  if (context.sourceDrift) {
    report.runMetadata = { ...report.runMetadata, sourceDrift: clone(context.sourceDrift) };
  }
  if (context.scan) {
    const scan = clone(context.scan);
    scan.pages = scan.pages?.map((p) => ({ ...p, route: redactUrl(p.route) }));
    report.runMetadata = { ...report.runMetadata, scan };
  }
  if (context.profiles) {
    report.runMetadata = { ...report.runMetadata, profiles: clone(context.profiles) };
  }
  if (context.parity) {
    report.runMetadata = { ...report.runMetadata, parity: clone(context.parity) };
  }
  if (context.thresholds) {
    report.runMetadata = { ...report.runMetadata, thresholds: clone(context.thresholds) };
  }
  if (context.ruleDemotions?.length) {
    const demotedFindings = pages.reduce((n, p) => n + p.findings.filter((f) => f.demotion).length, 0);
    report.runMetadata = { ...report.runMetadata, ruleDemotions: { rules: context.ruleDemotions.map(({ ruleId, n, precision }) => ({ ruleId, n, precision })), demotedFindings } };
  }
  if (context.discovery) {
    const discovery = clone(context.discovery);
    discovery.pages = discovery.pages?.map((p) => ({ ...p, route: redactUrl(p.route) }));
    report.runMetadata = { ...report.runMetadata, discovery };
  }
  if (warnings.length > 0) report.warnings = warnings;
  if (context.comparison) report.comparison = clone(context.comparison);
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
    ...(finding.verdict ? { kind: finding.kind, verdict: finding.verdict } : {}),
    ...(finding.agreement ? { enginesAgreeing: [...finding.enginesAgreeing], agreement: finding.agreement } : {}),
    ...(finding.origin ? { origin: clone(finding.origin), ownership: finding.ownership } : {}),
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
    ...(finding.sourceCandidates ? { sourceCandidates: clone(finding.sourceCandidates) } : {}),
  };
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
      status: page.status,
      failure: clone(page.failure),
      ...(page.skipped ? { skipped: clone(page.skipped) } : {}),
      lighthouseScores: clone(page.artifacts.lighthouseScores),
      axeSummary: clone(page.artifacts.axeSummary),
      scannerRuns,
    };
  });
  return {
    timestamp: report.generatedAt,
    ...(report.runMetadata?.allowIncomplete ? { allowIncomplete: true } : {}),
    ...(report.runMetadata?.profiles ? { profiles: clone(report.runMetadata.profiles) } : {}),
    ...(report.runMetadata?.parity ? { parity: clone(report.runMetadata.parity) } : {}),
    ...(report.runMetadata?.thresholds ? { thresholds: clone(report.runMetadata.thresholds) } : {}),
    ...(report.runMetadata?.discovery?.droppedRoutes?.length ? { droppedRoutes: clone(report.runMetadata.discovery.droppedRoutes) } : {}),
    ...(report.comparison ? { comparison: clone(report.comparison) } : {}),
    ...(report.notYourCode ? { notYourCode: clone(report.notYourCode) } : {}),
    summary: buildLegacySummary(pages),
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
  // No scanner runs is valid only when no page ran a layer (every page skipped-empty: nothing was scanned).
  invariant(
    Array.isArray(report.scanners)
      && (report.scanners.length > 0 || (report.pages.length > 0 && report.pages.every((p) => p.status === 'skipped-empty'))),
    'scanner metadata is required',
  );
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
    invariant(PAGE_STATUSES.has(page.status), 'page status is invalid');
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
      // Reports saved under another algorithm version keep the stable IDs they were written with.
      if (finding.stableId !== undefined && (report.stableIdVersion ?? 1) === STABLE_ID_VERSION) {
        invariant(finding.stableId === findingStableId(finding), 'stable ID does not match canonical content');
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
    canonicalStringify(report.summary) === canonicalStringify(buildSummary(report.pages, report.scanners)),
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
  findingStableId,
} from './fingerprint.js';
