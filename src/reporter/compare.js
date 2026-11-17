// Compares two ScanReportV2 reports by finding stableId (never by counts).
// Only confirmed and likely findings are compared; needs-review is reported as separate counts.
// A finding the agreement policy moved to needs-review is compared by the verdict it had before, so a fix still shows as fixed.

const COMPARED = new Set(['confirmed', 'likely']);
const verdictOf = (f) => f.verdictBeforeAgreement ?? f.verdict;

function origin(url) {
  try {
    return new URL(url).origin;
  } catch {
    return url || null;
  }
}

function profileKey(report) {
  return JSON.stringify([report.runMetadata?.profiles || null, report.runMetadata?.accessScan?.profile || null]);
}

function layersOf(finding) {
  return finding.layers?.length ? finding.layers : [finding.layer];
}

// Layers that finished on this route; a layer that did not run cannot prove a finding fixed.
function completeLayers(report, page) {
  const ids = new Set(page.scannerRunIds || []);
  return new Set(report.scanners.filter((run) => ids.has(run.runId) && run.status === 'complete').map((run) => run.layer));
}

// Findings the re-verifier saw fail to reproduce in either scan: neither fixed nor new.
function flakyKeys(...reports) {
  return new Set(reports.flatMap((r) => (r.runMetadata?.scan?.reverify?.flakyFindings || [])
    .map((f) => `${f.route}|${f.layer}|${f.ruleId}|${f.selector}`)));
}

const naturalOrder = (a, b) => a.localeCompare(b, 'en', { numeric: true });

// Findings sharing one stableId (identical scripts once their position is dropped) get an ordinal in document order.
function keyed(findings) {
  const sorted = [...findings].sort((a, b) => naturalOrder(a.element?.selector || '', b.element?.selector || ''));
  const seen = new Map();
  return new Map(sorted.map((f) => {
    const n = (seen.get(f.stableId) || 0) + 1;
    seen.set(f.stableId, n);
    return [n === 1 ? f.stableId : `${f.stableId}#${n}`, f];
  }));
}

function item(finding) {
  return {
    stableId: finding.stableId,
    ruleId: finding.canonicalRuleId || finding.nativeRuleId,
    impact: finding.impact,
    verdict: verdictOf(finding),
    selector: finding.element?.selector || '',
    ...(finding.source?.file ? { file: finding.source.file, ...(finding.source.line ? { line: finding.source.line } : {}) } : {}),
  };
}

function hasStableIds(report) {
  return report.pages.every((page) => page.findings.every((finding) => finding.stableId));
}

/**
 * @returns {object} { baseline, totals, pages, fixed, remaining, new, reclassified, addedPages, removedPages, notCompared, warnings }
 *   or { unusable: reason } when the baseline cannot be diffed by stableId.
 */
export function compareReports(current, baseline, { source = 'baseline' } = {}) {
  if (baseline?.schemaVersion !== '2.0.0' || !hasStableIds(baseline)) {
    return { unusable: 'the baseline has no stable finding ids (older report format); run with --baseline to save a new one' };
  }
  if ((baseline.stableIdVersion ?? 1) !== (current.stableIdVersion ?? 1)) {
    return { unusable: `the baseline was saved with stable-id algorithm v${baseline.stableIdVersion ?? 1} and this scan uses v${current.stableIdVersion ?? 1}, so findings cannot be matched exactly; run with --baseline to save a new one` };
  }
  const warnings = [];
  if (profileKey(current) !== profileKey(baseline)) {
    warnings.push('profiles differ between the baseline and this scan; the comparison is not apples to apples');
  }
  if (current.target.mode !== baseline.target.mode || origin(current.target.url) !== origin(baseline.target.url)) {
    warnings.push(`targets differ (${baseline.target.mode} ${origin(baseline.target.url)} vs ${current.target.mode} ${origin(current.target.url)}); the comparison is not apples to apples`);
  }
  if (current.reportId === baseline.reportId) warnings.push('the baseline is identical to this scan');

  const curPages = new Map(current.pages.map((p) => [p.route, p]));
  const basePages = new Map(baseline.pages.map((p) => [p.route, p]));
  const addedPages = [...curPages.keys()].filter((r) => !basePages.has(r)).sort();
  const removedPages = [...basePages.keys()].filter((r) => !curPages.has(r)).sort();

  const flaky = flakyKeys(current, baseline);
  const isFlaky = (route, f) => layersOf(f).some((l) => flaky.has(`${route}|${l}|${f.nativeRuleId}|${f.element?.selector || ''}`));
  // Platform widgets and third-party iframes are not the page owner's to fix and load differently on each run.
  let foreign = 0;
  const isOut = (route, f) => {
    if (isFlaky(route, f)) return true;
    const out = (f.ownership || 'source') !== 'source';
    if (out && f.impact !== 'info') foreign++;
    return out;
  };
  const out = { fixed: [], remaining: [], new: [], reclassified: [] };
  const pages = [];
  const notCompared = [];
  const skippedLayers = new Set();
  const needsReview = { baseline: 0, current: 0 };

  for (const route of [...curPages.keys()].filter((r) => basePages.has(r)).sort()) {
    const cur = curPages.get(route);
    const base = basePages.get(route);
    const failed = [cur.status === 'failed' && 'this scan', base.status === 'failed' && 'the baseline'].filter(Boolean);
    if (failed.length) {
      notCompared.push({ route, reason: `page failed in ${failed.join(' and ')}` });
      continue;
    }
    if (cur.status === 'partial') warnings.push(`${route}: partial scan; fixed counts may be overstated`);
    const baseLayers = completeLayers(baseline, base);
    const common = new Set([...completeLayers(current, cur)].filter((l) => baseLayers.has(l)));
    const inScope = (f) => {
      if (f.impact === 'info') return false;
      const ok = layersOf(f).some((l) => common.has(l));
      if (!ok) layersOf(f).forEach((l) => skippedLayers.add(l));
      return ok;
    };
    const curAll = keyed(cur.findings.filter((f) => !isOut(route, f)));
    const baseAll = keyed(base.findings.filter((f) => !isOut(route, f)));
    const scoped = (all) => new Map([...all].filter(([, f]) => inScope(f)));
    const curScope = scoped(curAll);
    const baseScope = scoped(baseAll);
    const compared = (m) => new Map([...m].filter(([, f]) => COMPARED.has(verdictOf(f))));
    needsReview.current += [...curScope.values()].filter((f) => verdictOf(f) === 'needs-review').length;
    needsReview.baseline += [...baseScope.values()].filter((f) => verdictOf(f) === 'needs-review').length;
    const curCmp = compared(curScope);
    const baseCmp = compared(baseScope);
    const page = { route, fixed: 0, remaining: 0, new: 0 };
    for (const [id, f] of baseCmp) {
      if (curCmp.has(id)) { out.remaining.push(item(curCmp.get(id))); page.remaining++; }
      else if (curAll.has(id)) out.reclassified.push({ ...item(curAll.get(id)), from: verdictOf(f), to: verdictOf(curAll.get(id)) });
      else { out.fixed.push(item(f)); page.fixed++; }
    }
    for (const [id, f] of curCmp) {
      if (baseCmp.has(id)) continue;
      if (baseAll.has(id)) out.reclassified.push({ ...item(f), from: verdictOf(baseAll.get(id)), to: verdictOf(f) });
      else { out.new.push(item(f)); page.new++; }
    }
    pages.push(page);
  }
  if (foreign) warnings.push(`${foreign} finding${foreign === 1 ? '' : 's'} in platform-owned or third-party markup were left out of both scans' comparison`);
  if (skippedLayers.size) warnings.push(`findings from layers not completed in both scans were left out: ${[...skippedLayers].sort().join(', ')}`);
  if (addedPages.length || removedPages.length) {
    warnings.push(`route set changed (${addedPages.length} added, ${removedPages.length} removed); those pages are not counted as fixed or new`);
  }

  return {
    baseline: {
      source,
      generatedAt: baseline.generatedAt,
      reportId: baseline.reportId,
      target: { mode: baseline.target.mode, url: baseline.target.url },
    },
    totals: { fixed: out.fixed.length, remaining: out.remaining.length, new: out.new.length, reclassified: out.reclassified.length, needsReview },
    pages,
    ...out,
    addedPages,
    removedPages,
    notCompared,
    warnings,
  };
}

/** Console lines for a comparison, or the reason there is none. */
export function formatComparison(comparison, skipReason) {
  if (!comparison) return [`\nComparison: skipped (${skipReason})`];
  const { totals: t } = comparison;
  const lines = [`\nComparison vs ${comparison.baseline.source} (${comparison.baseline.generatedAt}): fixed ${t.fixed}, remaining ${t.remaining}, new ${t.new}`];
  lines.push(`  Needs review (not compared): ${t.needsReview.baseline} before, ${t.needsReview.current} now${t.reclassified ? `; ${t.reclassified} finding(s) changed confidence` : ''}`);
  for (const p of comparison.pages) {
    if (p.fixed || p.new) lines.push(`  ${p.route}: fixed ${p.fixed}, remaining ${p.remaining}, new ${p.new}`);
  }
  for (const r of comparison.addedPages) lines.push(`  ${r}: page added (not in the baseline)`);
  for (const r of comparison.removedPages) lines.push(`  ${r}: page not scanned this time (not counted as fixed)`);
  for (const n of comparison.notCompared) lines.push(`  ${n.route}: not compared (${n.reason})`);
  for (const w of comparison.warnings) lines.push(`  Warning: ${w}`);
  return lines;
}
