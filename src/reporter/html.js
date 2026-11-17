import { writeFileSync, mkdirSync } from 'fs';
import path from 'path';
import { getReportsDir } from '../utils/paths.js';
import { classifyOrigin } from '../tracer/ownership.js';
import { ownerBadge as badgeOf, ownerHtml as htmlOf, groupNotYourCode, notYourCodeHtml, OWNER_KEYS } from './origin-display.js';

// Reports from before origin existed carry none: classify from the markup, as the scanner did offline.
const originOf = (v) => v.origin || classifyOrigin({ ruleId: v.ruleId, outerHTML: v.element?.outerHTML, selector: v.element?.selector, ownership: v.ownership, platformOwned: v.platformOwned });
const ownerBadge = (o) => badgeOf(o);
const ownerHtml = (o) => htmlOf(o);
import { buildReportHtml } from './ui/render.js';
import { escapeHtml as esc } from '../utils/escape-html.js';
import { groupViolations, ACCESSSCAN_CATEGORIES } from '../schema.js';
import { skippedPagesHtml } from './qa-report.js';
import { excludedNote } from '../utils/thresholds.js';
import { GATE_NOTE, totalsLabel, w3cEngineNote, runStatusLabel } from './wording.js';
import { wcagCoverageSentence } from '../utils/wcag-criteria.js';
import { getAccessScanCategory, getAccessScanRuleRequirement } from '../scanner/access-scan/engine/public-catalog.js';


const TOOL_CONFIG = [
  { id: 'axe', label: 'Axe-core', layer: 'axe', color: '#4040bf', icon: 'M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10zm-1-15a1 1 0 112 0v6a1 1 0 11-2 0V7zm0 10a1 1 0 112 0 1 1 0 01-2 0z' },
  { id: 'accessScan', label: 'AccessScan', layer: 'accessScan', color: '#ff385c', icon: 'M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z' },
  { id: 'w3c', label: 'Nu Checker HTML + W3C', layer: 'w3c', color: '#460479', icon: 'M14.7 6.3a1 1 0 010 1.4L10.4 12l4.3 4.3a1 1 0 01-1.4 1.4l-5-5a1 1 0 010-1.4l5-5a1 1 0 011.4 0z' },
  { id: 'htmlValidate', label: 'HTML validity (offline)', layer: 'htmlValidate', color: '#6b3fa0', icon: 'M14.7 6.3a1 1 0 010 1.4L10.4 12l4.3 4.3a1 1 0 01-1.4 1.4l-5-5a1 1 0 010-1.4l5-5a1 1 0 011.4 0z' },
  { id: 'links', label: 'Dead Link Checker', layer: 'links', color: '#c13515', icon: 'M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1' },
  { id: 'behavioral', label: 'Behavioral Scanners', layers: ['keyboard', 'focusTrap', 'ariaLive', 'dynamicContent', 'screenReader'], color: '#0d7377', icon: 'M15 15l-2 5L9 9l11 4-5 2zm0 0l5 5M7.188 2.239l.777 2.897M5.136 7.965l-2.898-.777M13.95 4.05l-2.122 2.122m-5.657 5.656l-2.12 2.122' },
  { id: 'lighthouseA11y', label: 'Accessibility (Lighthouse)', layer: 'lighthouse', category: 'accessibility', color: '#2f6f9f', icon: 'M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z' },
  { id: 'performance', label: 'Performance', layer: 'lighthouse', notCategory: 'accessibility', color: '#222222', icon: 'M13 10V3L4 14h7v7l9-11h-7z' },
];


/** Sum occurrence counts so Serious/Total match Nu message totals (not fix-unit cards). */
/** Violations a tool section owns: its layer(s), and for Lighthouse only its own category so a11y audits never count as Performance. */
export function toolViolations(tool, violations = []) {
  const inLayers = tool.layers ? violations.filter((v) => tool.layers.includes(v.layer)) : violations.filter((v) => v.layer === tool.layer);
  if (tool.category) return inLayers.filter((v) => v.category === tool.category);
  if (tool.notCategory) return inLayers.filter((v) => v.category !== tool.notCategory);
  return inLayers;
}

export function countIssueOccurrences(violations = []) {
  return violations.reduce((sum, violation) => {
    const count = Number.isInteger(violation.count) && violation.count > 0
      ? violation.count
      : 1;
    return sum + count;
  }, 0);
}

export function formatAccessScanProfileLabel(profile) {
  if (profile === 'commercial-parity') {
    return 'Commercial parity (accessScan oracle)';
  }
  if (profile === 'standards') {
    return 'Standards (WCAG)';
  }
  return 'Unknown accessScan profile';
}

function resolveAccessScanMetadata(report = {}, pages = []) {
  if (report.runMetadata?.accessScan) {
    return report.runMetadata.accessScan;
  }

  for (const page of pages) {
    for (const run of page.scannerRuns || []) {
      if (run.layer === 'accessScan' && run.evidence?.profile) {
        return {
          profile: run.evidence.profile,
          includeThirdParty: run.evidence.includeThirdParty === true,
          comparatorVersion: run.evidence.comparatorVersion || null,
          execution: run.evidence.execution || null,
        };
      }
    }
  }

  return null;
}

function prettyHtml(raw) {
  let out = '';
  let indent = 0;
  const step = 2;
  const tokens = raw.replace(/>\s*</g, '>\n<').split('\n');
  for (const token of tokens) {
    const t = token.trim();
    if (!t) continue;
    if (t.startsWith('</')) indent = Math.max(0, indent - step);
    out += ' '.repeat(indent) + t + '\n';
    if (t.match(/^<[a-zA-Z][^>]*[^/]>$/) && !t.startsWith('</') && !t.match(/^<(br|hr|img|input|meta|link|col|area|base|source|track|wbr)\b/i)) {
      indent += step;
    }
  }
  return out.trimEnd();
}

const INCOMPLETE_NOTE = '<div class="no-issues"><span>No issues reported - scan incomplete, this is not a pass</span></div>';

function isIncompleteScan(report) {
  const summary = report.summary || {};
  return (summary.pagesFailed || 0) > 0 || (summary.pagesPartial || 0) > 0;
}

function buildIncompleteBanner(report) {
  if (!isIncompleteScan(report)) return '';
  const failed = [];
  const partial = [];
  for (const page of report.pages || []) {
    if (page.status === 'failed') {
      failed.push(`${esc(page.url)}: not scanned (${esc(page.failure?.message || page.failure?.reason || 'failed')})`);
    } else if (page.status === 'partial') {
      const layers = page.partialReasons?.map((r) => `${r.layer} ${r.reason}${r.gating ? '' : ' [supplementary]'}`)
        ?? (page.scannerRuns || [])
          .filter((run) => ['error', 'timeout', 'skipped'].includes(run.status))
          .map((run) => `${run.layer} ${run.status}`);
      partial.push(`${esc(page.url)}: partial (${esc(layers.join(', '))})`);
    }
  }
  const skipped = (report.pages || []).filter((p) => p.status === 'skipped-empty').map((p) => `${esc(p.url || p.route || p.name)}: skipped-empty (${esc(p.skipped?.note || 'empty page')}); not a failure`);
  const dropped = (report.droppedRoutes || []).map((d) => `${esc(d.route)}: dropped (not served, HTTP ${esc(d.status)}); not scanned and not a failure`);
  const group = (title, items) => (items.length ? `<li><strong>${title}</strong><ul>${items.map((item) => `<li>${item}</li>`).join('')}</ul></li>` : '');
  return `<section class="incomplete-banner" role="alert">
  <h2>&#9888; Incomplete scan</h2>
  <p>Results below do not cover everything. A clean total is not a pass.${report.allowIncomplete ? ' Exit code 2 was suppressed by --allow-incomplete.' : ''}</p>
  <ul>${group(`Failed (${failed.length})`, failed)}${group(`Partial (${partial.length})`, partial)}${group(`Skipped-empty (${skipped.length})`, skipped)}${group(`Dropped, not served (${dropped.length})`, dropped)}</ul>
</section>`;
}

export function buildGateSection(report) {
  const gate = report.thresholds;
  if (!gate) return '';
  const engine = w3cEngineNote((report.pages || []).flatMap((p) => p.scannerRuns || []), (report.pages || []).flatMap((p) => p.violations || []));
  const rows = gate.pages.flatMap((page) => [
    ...page.metrics.map((m) => `<tr><td>${esc(page.url)}</td><td>${esc(m.id)}${m.id.startsWith('w3c.') && engine ? `<br><small>${esc(engine)}</small>` : ''}</td><td>${esc(String(m.actual ?? 'n/a'))} / ${esc(String(m.target))}</td><td>${esc(m.status)}${m.reason ? ` - ${esc(m.reason)}` : ''}</td></tr>`),
    ...(page.excluded ? [`<tr><td>${esc(page.url)}</td><td colspan="3">${esc(excludedNote(page.excluded))}</td></tr>`] : []),
  ]);
  return `<section class="quality-gate">
  <h2>Quality gate: ${gate.failed ? 'failed' : 'passed'}</h2>
  <p>${esc(GATE_NOTE)}</p>
  <table><thead><tr><th scope="col">Page</th><th scope="col">Metric</th><th scope="col">Actual / target</th><th scope="col">Status</th></tr></thead><tbody>${rows.join('')}</tbody></table>
</section>`;
}

/** Fixed / remaining / new against the baseline, matched by stableId; null comparison renders nothing. */
export function buildComparisonSection(report) {
  const c = report.comparison;
  if (!c) return '';
  const { totals: t } = c;
  const rows = c.pages.map((p) => `<tr><td>${esc(p.route)}</td><td>${esc(p.fixed)}</td><td>${esc(p.remaining)}</td><td>${esc(p.new)}</td></tr>`);
  const notes = [
    ...c.addedPages.map((r) => `${esc(r)}: page added, not in the baseline`),
    ...c.removedPages.map((r) => `${esc(r)}: not scanned this time, not counted as fixed`),
    ...c.notCompared.map((n) => `${esc(n.route)}: not compared (${esc(n.reason)})`),
    ...c.warnings.map((w) => `Warning: ${esc(w)}`),
  ];
  return `<section class="comparison">
  <h2>Compared with ${esc(c.baseline.source)} (${esc(c.baseline.generatedAt)}): fixed ${esc(t.fixed)}, remaining ${esc(t.remaining)}, new ${esc(t.new)}</h2>
  <p>Matched by finding id, confirmed and likely findings only. Needs review (not compared): ${esc(t.needsReview.baseline)} before, ${esc(t.needsReview.current)} now.</p>
  ${notes.length ? `<ul>${notes.map((n) => `<li>${n}</li>`).join('')}</ul>` : ''}
  ${rows.length ? `<table><thead><tr><th scope="col">Page</th><th scope="col">Fixed</th><th scope="col">Remaining</th><th scope="col">New</th></tr></thead><tbody>${rows.join('')}</tbody></table>` : ''}
</section>`;
}

export function buildParitySection(report) {
  const parity = report.parity;
  if (!parity) return '';
  const rows = parity.pages.flatMap((page) => page.findings.map((f) => `<tr><td>${esc(page.url)}</td><td>${esc(f.ruleId)}</td><td>${esc(f.impact)}</td><td><code>${esc(f.selector)}</code></td></tr>`));
  const errors = parity.pages.filter((p) => p.error).map((p) => `<li>${esc(p.url)}: ${esc(p.error)}</li>`).join('');
  return `<section class="parity-supplement">
  <h2>Supplementary: commercial-parity profile</h2>
  <p>Gate profile: ${esc((report.profiles || ['standards'])[0])}. These findings are extra information from a commercial-scanner-style profile. They are not counted in the totals, the quality gate or the exit code.</p>
  ${errors ? `<ul>${errors}</ul>` : ''}
  ${rows.length ? `<table><thead><tr><th scope="col">Page</th><th scope="col">Rule</th><th scope="col">Impact</th><th scope="col">Element</th></tr></thead><tbody>${rows.join('')}</tbody></table>` : '<p>No additional findings.</p>'}
</section>`;
}

/** "axe, accessScan (multi)": the engines that report this finding and how far they agree; '' for reports without agreement data. */
const enginesLabel = (v) => (v.enginesAgreeing?.length ? `${v.enginesAgreeing.join(', ')} (${v.agreement})` : '');

/** "N confirmed, M likely, K need review" over occurrence counts; null when no violation carries a verdict. */
export function verdictSummaryLine(violations = []) {
  if (!violations.some((v) => v.verdict)) return null;
  const n = (verdict) => countIssueOccurrences(violations.filter((v) => v.verdict === verdict && v.impact !== 'info'));
  return `${n('confirmed')} confirmed, ${n('likely')} likely, ${n('needs-review')} need review`;
}

/** Confidence counts plus the findings that never fail a gate, each under its own heading. */
export function buildVerdictSection(violations = []) {
  const line = verdictSummaryLine(violations);
  if (!line) return '';
  const list = (verdict, heading, note) => {
    const items = violations.filter((v) => v.verdict === verdict && v.impact !== 'info');
    if (items.length === 0) return '';
    const rows = items.map((v) => `<tr><td>${esc(v.ruleId)}</td><td>${esc(v.impact)}</td><td>${countIssueOccurrences([v])}</td><td>${esc(enginesLabel(v))}</td><td><code>${esc(v.element?.selector || '')}</code></td></tr>`);
    return `<h3>${heading}</h3><p>${note}</p>
  <table><thead><tr><th scope="col">Rule</th><th scope="col">Impact</th><th scope="col">Count</th><th scope="col">Engines agreeing</th><th scope="col">Element</th></tr></thead><tbody>${rows.join('')}</tbody></table>`;
  };
  return `<section class="verdicts">
  <h2>Findings by confidence: ${esc(line)}</h2>
  <p>Only confirmed findings (a machine can decide) count toward the quality gate and exit code.</p>
  ${list('likely', 'Likely issues', 'Heuristic rules that guess intent, and confirmed findings with no traced source line (untraced: locate manually); they do not fail the gate.')}
  ${list('needs-review', 'Needs review', 'Cannot be decided automatically; a person must check.')}
</section>`;
}

/** "Not your code (N)": vendor-script, platform-widget and iframe findings by vendor/component, with pages, rules and what to do. */
export function buildOwnershipSection(violations = [], pages = null) {
  const items = (pages || [{ url: '', violations }]).flatMap((p) => (p.violations || []).map((v) => ({
    origin: originOf(v), rule: v.ruleId, page: p.url || p.page || '', count: Number.isInteger(v.count) && v.count > 0 ? v.count : 1, impact: v.impact,
  })));
  return notYourCodeHtml(groupNotYourCode(items), 'None of them count in the quality gate unless gate.countPlatform / gate.countThirdParty is set.');
}

export function writeHtmlReport(report) {
  mkdirSync(getReportsDir(), { recursive: true });
  const outPath = path.join(getReportsDir(), 'scan-visual.html');
  writeFileSync(outPath, buildHtml(report));
  return outPath;
}

function scoreColor(score) {
  if (score === null || score === undefined) return '#929292';
  if (score >= 90) return '#008a05';
  if (score >= 50) return '#ff385c';
  return '#c13515';
}

function metricDotColor(rating) {
  if (rating === 'good') return '#008a05';
  if (rating === 'average') return '#ff385c';
  return '#c13515';
}

function impactBadge(impact) {
  const map = {
    critical: { bg: 'rgba(193,53,21,0.08)', text: '#c13515', border: 'rgba(193,53,21,0.3)' },
    serious:  { bg: 'rgba(255,56,92,0.08)',  text: '#ff385c', border: 'rgba(255,56,92,0.3)' },
    moderate: { bg: 'rgba(180,120,0,0.08)',  text: '#8a6200', border: 'rgba(180,120,0,0.3)' },
    minor:    { bg: 'rgba(0,138,5,0.07)',    text: '#007003', border: 'rgba(0,138,5,0.25)' },
  };
  const s = map[impact] || { bg: '#f7f7f7', text: '#929292', border: '#dddddd' };
  return `<span class="badge" style="background:${s.bg};color:${s.text};border:1px solid ${s.border}">${esc(impact || 'info')}</span>`;
}

function svgIcon(pathD, size = 16, color = '#222222') {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${pathD}"/></svg>`;
}

function scannerRunMetrics(run = {}) {
  const metrics = [];
  const add = (value, label) => {
    if (value !== undefined && value !== null) metrics.push(`${value} ${label}`);
  };
  add(run.raw?.messageCount, 'raw messages');
  add(run.raw?.errors, 'errors');
  add(run.raw?.warnings, 'warnings');
  add(run.raw?.artifactFilteredCount, 'artifacts filtered');
  add(run.supplemental?.candidateCount, 'supplemental candidates');
  add(run.supplemental?.addedCount, 'supplemental findings added');
  add(run.supplemental?.suppressedCount, 'supplemental duplicates suppressed');
  add(run.emitted?.actionableOccurrences ?? run.emitted?.findingOccurrences, 'finding occurrences');
  add(run.emitted?.actionableFixUnits ?? run.emitted?.fixUnits, 'fix units');
  add(run.emitted?.infoFixUnits, 'informational fix units');
  add(run.evidence?.issueGroups ?? run.evidence?.ruleGroups, 'issue groups');
  add(run.evidence?.affectedNodes, 'affected nodes');
  add(run.evidence?.findingOccurrences, 'finding occurrences');
  add(run.evidence?.fixUnits, 'fix units');
  add(run.evidence?.incomplete, 'incomplete');
  add(run.evidence?.accessibility?.rawAuditCount, 'accessibility audits');
  add(run.evidence?.accessibility?.issueGroups, 'accessibility issue groups');
  add(run.evidence?.accessibility?.affectedNodes, 'accessibility nodes');
  add(run.evidence?.accessibility?.passed, 'accessibility passes');
  add(run.evidence?.accessibility?.manual, 'manual checks');
  add(run.evidence?.accessibility?.notApplicable, 'not applicable');
  add(run.evidence?.accessibility?.incomplete, 'incomplete accessibility audits');
  if (run.layer === 'accessScan' && run.evidence?.profile) {
    metrics.push(`Profile: ${formatAccessScanProfileLabel(run.evidence.profile)}`);
  }
  if (run.layer === 'accessScan' && run.evidence?.comparatorVersion) {
    metrics.push(`Comparator: ${run.evidence.comparatorVersion}`);
  }
  for (const check of run.evidence?.execution?.perCheck || []) {
    const statusLabel = check.statusCounts
      ? `${check.status} (${Object.entries(check.statusCounts).map(([status, count]) => `${status}:${count}`).join(', ')})`
      : check.status;
    metrics.push(
      `${check.checkId}: ${statusLabel}, ${check.candidateCount} candidates, ${check.findingCount} findings`,
    );
  }
  return metrics;
}

export function buildScannerRunEvidence(pages = []) {
  const records = pages.flatMap((page) =>
    (page.scannerRuns || []).map((run) => ({ page, run }))
  );
  if (records.length === 0) return '';

  const cards = records.map(({ page, run }) => {
    const viewport = run.viewport
      ? `${run.viewport.name || 'viewport'}${run.viewport.width && run.viewport.height ? ` · ${run.viewport.width} × ${run.viewport.height}` : ''}`
      : 'Not viewport-specific';
    const state = `${String(run.pageState || 'initial').replace(/[-_]/g, ' ')} state`;
    const status = ['complete', 'fallback', 'error', 'skipped'].includes(run.status) ? run.status : 'unknown';
    const engine = run.engine?.name || run.layer || 'Scanner';
    const metrics = scannerRunMetrics(run);
    return `<article class="scanner-run-card">
      <div class="scanner-run-heading">
        <div>
          <h3>${esc(engine)}</h3>
          <p>${esc(page.name || page.url || 'Scanned page')} · ${esc(run.layer || 'unknown layer')}</p>
        </div>
        <span class="scanner-status scanner-status--${status}">${esc(runStatusLabel({ ...run, status }))}</span>
      </div>
      <dl class="scanner-run-context">
        <div><dt>Engine</dt><dd>${esc(run.engine?.version ? `${engine} ${run.engine.version}` : engine)}</dd></div>
        <div><dt>Page state</dt><dd>${esc(state.charAt(0).toUpperCase() + state.slice(1))}</dd></div>
        <div><dt>Viewport</dt><dd>${esc(viewport)}</dd></div>
        ${run.source ? `<div><dt>Source</dt><dd>${esc(run.source)}</dd></div>` : ''}
      </dl>
      ${metrics.length > 0 ? `<ul class="scanner-run-metrics">${metrics.map((metric) => `<li>${esc(metric)}</li>`).join('')}</ul>` : ''}
    </article>`;
  }).join('');

  return `<section class="scanner-evidence" aria-labelledby="scanner-evidence-title">
    <details>
      <summary>
        <span id="scanner-evidence-title">Scan evidence</span>
        <span class="scanner-evidence-count">${records.length} run${records.length === 1 ? '' : 's'}</span>
      </summary>
      <div class="scanner-evidence-body">
        <p>Engine versions, tested page states, viewports, and raw scanner totals retained with this report.</p>
        <div class="scanner-run-grid">${cards}</div>
      </div>
    </details>
  </section>`;
}

// ─── Performance Dashboard (kept from original) ─────────────────────────────

function buildCircleGauge(score, label, size = 120) {
  const r = 50;
  const circumference = 2 * Math.PI * r;
  if (score === null || score === undefined) {
    return `<div class="gauge-wrap">
      <svg width="${size}" height="${size}" viewBox="0 0 120 120">
        <circle cx="60" cy="60" r="${r}" fill="none" stroke="#ebebeb" stroke-width="6"/>
        <text x="60" y="56" text-anchor="middle" dominant-baseline="central" fill="#929292" font-size="32" font-weight="600" font-family="system-ui,sans-serif">--</text>
      </svg>
      <span class="gauge-lbl">${esc(label)}</span>
    </div>`;
  }
  const color = scoreColor(score);
  const offset = circumference - (score / 100) * circumference;
  return `<div class="gauge-wrap">
    <svg width="${size}" height="${size}" viewBox="0 0 120 120">
      <circle cx="60" cy="60" r="${r}" fill="none" stroke="#ebebeb" stroke-width="6"/>
      <circle cx="60" cy="60" r="${r}" fill="none" stroke="${color}" stroke-width="6"
        stroke-dasharray="${circumference}" stroke-dashoffset="${offset}" stroke-linecap="round"
        transform="rotate(-90 60 60)" class="gauge-ring"/>
      <text x="60" y="52" text-anchor="middle" dominant-baseline="central" fill="${color}" font-size="32" font-weight="700" font-family="system-ui,sans-serif">${esc(score)}</text>
      <text x="60" y="76" text-anchor="middle" fill="#929292" font-size="10" font-weight="400" font-family="system-ui,sans-serif">${score >= 90 ? 'Good' : score >= 50 ? 'Needs Work' : 'Poor'}</text>
    </svg>
    <span class="gauge-lbl">${esc(label)}</span>
  </div>`;
}

function buildMetricRow(metric) {
  const dotColor = metricDotColor(metric.rating);
  return `<tr>
    <td><span class="metric-dot" style="background:${dotColor}"></span>${esc(metric.label)}</td>
    <td class="metric-val" style="color:${dotColor}">${esc(metric.displayValue)}</td>
    <td class="metric-target">${esc(metric.target || '')}${metric.rating ? ` (${esc(metric.rating)})` : ''}</td>
  </tr>`;
}

export function buildPerformanceProvenance(pageData = {}) {
  const source = pageData.source || 'local';
  const provenance = pageData.provenance || {
    requestedSource: source === 'psi-api' || source === 'local-fallback' ? 'psi-api' : 'local',
    actualSource: source === 'psi-api' ? 'psi-api' : source === 'error' ? 'error' : 'local',
    comparableToPsi: source === 'psi-api',
    fallbackReason: source === 'local-fallback' ? { code: 'unavailable', status: null } : null,
  };

  if (provenance.actualSource === 'psi-api') {
    return `<div class="perf-provenance">
      <strong>PageSpeed Insights API</strong>
      <span>Remote lab evidence; comparable to PSI baselines collected with the same strategy.</span>
    </div>`;
  }

  if (provenance.requestedSource === 'psi-api') {
    const reasonLabels = {
      'quota-exceeded': 'PSI API quota exceeded',
      timeout: 'PSI API timed out',
      'invalid-response': 'PSI API returned an invalid response',
      'http-error': 'PSI API request failed',
      unavailable: 'PSI API unavailable',
    };
    const reason = reasonLabels[provenance.fallbackReason?.code] || 'PSI API unavailable';
    if (provenance.actualSource === 'local') {
      return `<div class="perf-provenance perf-provenance--fallback">
        <strong>Local Lighthouse fallback</strong>
        <span>${esc(reason)}. These scores are not comparable to a PageSpeed Insights baseline.</span>
      </div>`;
    }
    return `<div class="perf-provenance perf-provenance--fallback">
      <strong>PageSpeed Insights unavailable</strong>
      <span>${esc(reason)}. No PSI-comparable performance scores were produced.</span>
    </div>`;
  }

  return `<div class="perf-provenance">
    <strong>Local Lighthouse</strong>
    <span>Local lab evidence; not comparable to a PageSpeed Insights baseline.</span>
  </div>`;
}

export function buildPerformanceDashboard(lighthouseData) {
  if (!lighthouseData || Object.keys(lighthouseData).length === 0) return '';
  let html = '';
  for (const [pageName, pageData] of Object.entries(lighthouseData)) {
    const lh = pageData.lighthouse;
    html += `<div class="perf-dashboard">
      ${buildPerformanceProvenance(pageData)}`;
    if (!lh) {
      html += `<p class="perf-unavailable">No performance scores were produced for this page.</p></div>`;
      continue;
    }
    html += `<div class="device-tabs">
        <button class="device-tab active" type="button" data-show="mobile-${esc(pageName)}" data-hide="desktop-${esc(pageName)}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="2" width="14" height="20" rx="2"/><line x1="12" y1="18" x2="12" y2="18"/></svg>
          Mobile
        </button>
        <button class="device-tab" type="button" data-show="desktop-${esc(pageName)}" data-hide="mobile-${esc(pageName)}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
          Desktop
        </button>
      </div>`;
    if (lh.mobile) html += buildDeviceReport(lh.mobile, `mobile-${pageName}`, false, pageData.runSummary?.mobile);
    if (lh.desktop) html += buildDeviceReport(lh.desktop, `desktop-${pageName}`, true, pageData.runSummary?.desktop);
    html += '</div>';
  }
  return html;
}

function buildRunScores(summary) {
  if (!summary) return '';
  const names = [['performance', 'Performance'], ['accessibility', 'Accessibility'], ['bestPractices', 'Best Practices'], ['seo', 'SEO']];
  const rows = names.map(([k, label]) => {
    const all = summary.runs.map((r) => r[k] ?? 'n/a').join(', ');
    const spread = summary.spread[k];
    return `<tr><td>${esc(label)}</td><td class="metric-val">${esc(summary.median[k] ?? 'n/a')}</td><td>${esc(all)}</td><td>${spread ?? 'n/a'}${spread > 5 ? ' (score variance: treat the median with care)' : ''}</td></tr>`;
  }).join('');
  return `<div class="metrics-card"><div class="metrics-title">Scores per run (${summary.runs.length})</div><table class="metrics-table"><tr><th scope="col">Category</th><th scope="col">Median</th><th scope="col">Runs</th><th scope="col">Spread</th></tr>${rows}</table></div>`;
}

function buildDeviceReport(data, id, hidden = false, runSummary = null) {
  const s = data.scores;
  const gauges = [
    buildCircleGauge(s.performance, 'Performance'),
    buildCircleGauge(s.accessibility, 'Accessibility'),
    buildCircleGauge(s.bestPractices, 'Best Practices'),
    buildCircleGauge(s.seo, 'SEO'),
  ].join('');

  const metricRows = Object.values(data.metrics || {}).map(buildMetricRow).join('');

  let auditGroupsHtml = '';
  if (data.groups && Object.keys(data.groups).length > 0) {
    for (const [groupName, audits] of Object.entries(data.groups)) {
      const auditRows = audits.map((a) => {
        const dotColor = a.score === 0 ? '#c13515' : a.score < 0.5 ? '#ff385c' : '#929292';
        let detailsHtml = '';
        if (a.details && a.details.length > 0) {
          const items = a.details.map((d) => {
            const parts = [];
            if (d.url) parts.push(esc(d.url.split('/').pop().split('?')[0].slice(0, 60)));
            if (d.wastedMs) parts.push(`${Math.round(d.wastedMs)} ms`);
            if (d.wastedBytes) parts.push(`${(d.wastedBytes / 1024).toFixed(1)} KB`);
            if (d.label) parts.push(esc(d.label));
            return parts.join(' &middot; ');
          }).filter(Boolean);
          if (items.length > 0) {
            detailsHtml = `<ul class="audit-details">${items.map((d) => `<li>${d}</li>`).join('')}</ul>`;
          }
        }
        return `<div class="audit-item">
          <div class="audit-row">
            <span class="metric-dot" style="background:${dotColor}"></span>
            <span class="audit-title">${esc(a.title)}</span>
            ${a.displayValue ? `<span class="audit-value">${esc(a.displayValue)}</span>` : ''}
          </div>
          ${detailsHtml}
        </div>`;
      }).join('');
      auditGroupsHtml += `<details class="audit-group">
        <summary>${esc(groupName)}<span class="audit-count">${audits.length}</span></summary>
        ${auditRows}
      </details>`;
    }
  }

  let gapHtml = '';
  if (s.performance < 100 && data.groups) {
    const opportunities = Object.entries(data.groups)
      .flatMap(([, audits]) => audits)
      .filter((a) => a.score !== null && a.score < 1 && a.wastedMs > 0)
      .sort((a, b) => (b.wastedMs || 0) - (a.wastedMs || 0))
      .slice(0, 10);
    if (opportunities.length > 0) {
      const gap = 100 - (s.performance || 0);
      const totalWasted = opportunities.reduce((sum, o) => sum + (o.wastedMs || 0), 0);
      const opRows = opportunities.map((o) => {
        const pct = totalWasted > 0 ? Math.round(((o.wastedMs || 0) / totalWasted) * gap) : 0;
        return `<div class="gap-item">
          <div class="gap-label">${esc(o.title)}</div>
          <div class="gap-bar-track"><div class="gap-bar-fill" style="width:${Math.min(100, pct * 3)}%;background:${scoreColor(100 - pct)}"></div></div>
          <div class="gap-pts">~${pct} pts</div>
        </div>`;
      }).join('');
      gapHtml = `<div class="gap-to-100">
        <div class="metrics-title">Gap to 100 <span class="section-badge" style="background:${scoreColor(s.performance)}">${gap} pts to go</span></div>
        ${opRows}
      </div>`;
    }
  }

  let stepsHtml = '';
  if (s.performance < 100 && data.groups) {
    const AUDIT_TO_ACTION = {
      'unminified-javascript': 'Run `pnpm build:prod` to enable JS minification',
      'unminified-css': 'Run `pnpm build:prod` to enable CSS minification',
      'unused-css-rules': 'Move page-specific CSS out of global head.liquid',
      'render-blocking-resources': 'Defer non-critical CSS/JS or use async loading',
      'uses-long-cache-ttl': 'Set Cache-Control headers for static assets (CDN config)',
      'uses-responsive-images': 'Serve correctly-sized images via srcset or <picture>',
      'offscreen-images': 'Add loading="lazy" to below-fold images',
      'largest-contentful-paint-element': 'Preload hero image + add fetchpriority="high"',
      'total-byte-weight': 'Audit asset sizes - compress images, code-split JS',
      'dom-size': 'Reduce DOM nodes - simplify nested containers',
      'server-response-time': 'Optimize server response (CDN, caching)',
      'uses-text-compression': 'Enable gzip/brotli compression on server',
    };
    const failedAudits = Object.entries(data.groups)
      .flatMap(([, audits]) => audits)
      .filter((a) => a.score !== null && a.score < 0.9);
    const actions = failedAudits
      .map((a) => ({ id: a.id || a.title, title: a.title, action: AUDIT_TO_ACTION[a.id] }))
      .filter((a) => a.action);
    if (actions.length > 0) {
      const rows = actions.map((a) =>
        `<label class="step-item"><input type="checkbox"><span>${esc(a.title)}</span><em>${esc(a.action)}</em></label>`
      ).join('');
      stepsHtml = `<div class="steps-to-100">
        <div class="metrics-title">Steps to 100</div>
        <div class="steps-list">${rows}</div>
      </div>`;
    }
  }

  let passedHtml = '';
  if (data.passedGroups && Object.keys(data.passedGroups).length > 0) {
    let passedCount = 0;
    let passedItems = '';
    for (const [groupName, audits] of Object.entries(data.passedGroups)) {
      passedCount += audits.length;
      const rows = audits.map((a) =>
        `<div class="audit-item passed-item">
          <div class="audit-row">
            <span class="metric-dot" style="background:#008a05"></span>
            <span class="audit-title">${esc(a.title)}</span>
          </div>
        </div>`
      ).join('');
      passedItems += `<details class="audit-group passed-group">
        <summary>${esc(groupName)}<span class="audit-count">${audits.length}</span></summary>
        ${rows}
      </details>`;
    }
    passedHtml = `<details class="passed-audits-section">
      <summary class="passed-summary"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#008a05" stroke-width="2"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg> ${passedCount} passed audit${passedCount === 1 ? '' : 's'}</summary>
      <div class="passed-body">${passedItems}</div>
    </details>`;
  }

  return `<div class="device-panel" id="${esc(id)}" ${hidden ? 'style="display:none"' : ''}>
    <div class="gauges-row">${gauges}</div>
    ${buildRunScores(runSummary)}
    ${metricRows ? `<div class="metrics-card"><div class="metrics-title">Performance metrics (informational)</div><table class="metrics-table">${metricRows}</table></div>` : ''}
    ${gapHtml}
    ${stepsHtml}
    ${auditGroupsHtml ? `<div class="audit-groups"><div class="metrics-title">Diagnostics</div>${auditGroupsHtml}</div>` : ''}
    ${passedHtml}
  </div>`;
}

// ─── Shared violation rendering helpers ──────────────────────────────────────

function buildSourcePath(v) {
  const file = v.source?.file || '';
  const line = v.source?.line || '';
  const partial = v.source?.partial || '';
  const page = v.source?.page || '';
  if (!file && !partial) return '';
  const fileIcon = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#929292" stroke-width="2"><path d="M13 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>';
  const arrowIcon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#FF5A5F" stroke-width="2.5" style="margin: 0 4px;"><path d="M5 12h14"/><path d="M12 5l7 7-7 7"/></svg>';
  if (partial && page && partial !== page) {
    const lineStr = line ? `<span class="source-line">:${esc(line)}</span>` : '';
    return `<div class="v-source">${fileIcon}<code class="source-page">${esc(page)}</code>${arrowIcon}<code class="source-partial">${esc(partial)}${lineStr}</code></div>`;
  }
  return `<div class="v-source">${fileIcon}<code>${esc(file)}${line ? `:${esc(line)}` : ''}</code></div>`;
}

const EVIDENCE_FILE = /^evidence\/[a-f0-9]{64}\.png$/;
const WCAG_URL = /^https:\/\/www\.w3\.org\/WAI\/WCAG22\/Understanding\/[a-z0-9-]+\.html$/;

function findCapture(v) {
  return v.evidence?.capture || (v.evidence?.observations || []).map((o) => o.evidence?.capture).find(Boolean) || null;
}

/** "Why flagged": reason, WCAG link, measured facts, repro recipe and the outlined screenshot (lazy loaded). */
export function buildWhyFlagged(v) {
  const c = findCapture(v);
  if (!c) return '';
  const rows = [];
  if (c.ax) rows.push(['Accessible name', `${c.ax.role || 'no role'}: ${c.ax.ignored ? '(ignored in the accessibility tree)' : `"${c.ax.name}"`}`]);
  const box = c.geometry?.box;
  if (box) rows.push(['Size', `${box.width} x ${box.height} px at (${box.x}, ${box.y})`]);
  if (c.styles) rows.push(['Computed styles', Object.entries(c.styles).map(([k, val]) => `${k}: ${val ?? 'n/a'}`).join('; ')]);
  const r = c.repro;
  if (r) rows.push(['Reproduce', `open ${r.url}${r.viewport ? ` at ${r.viewport.width}x${r.viewport.height}` : ''}, select ${r.selector} (state: ${r.state})`]);
  const link = c.wcag?.url && WCAG_URL.test(c.wcag.url)
    ? `<a href="${esc(c.wcag.url)}" target="_blank" rel="noopener">WCAG ${esc(c.wcag.criterion)} Understanding</a>` : '';
  const shot = c.screenshot?.file && EVIDENCE_FILE.test(c.screenshot.file)
    ? `<img class="evidence-shot" src="${esc(c.screenshot.file)}" loading="lazy" width="${Number(c.screenshot.width) || 640}" height="${Number(c.screenshot.height) || 400}" alt="Screenshot of the flagged element, outlined">` : '';
  return `<details class="why-flagged"><summary>Why flagged</summary>
    ${c.reason ? `<p class="why-reason">${esc(c.reason)} ${link}</p>` : link}
    <dl class="why-facts">${rows.map(([k, val]) => `<dt>${esc(k)}</dt><dd>${esc(val)}</dd>`).join('')}</dl>${shot}
  </details>`;
}

// ─── Axe-core section builder ────────────────────────────────────────────────

function buildAxeSection(violations, incomplete = false) {
  if (violations.length === 0) {
    if (incomplete) return INCOMPLETE_NOTE;
    return `<div class="no-issues"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#008a05" stroke-width="2"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg><span>No automated axe-core issues found</span></div>`;
  }
  const byRule = groupViolations(violations, (v) => v.ruleId);
  let html = '';
  for (const [ruleId, ruleViols] of byRule) {
    const first = ruleViols[0];
    const hint = first.fix?.hint || '';
    const dequeUrl = `https://dequeuniversity.com/rules/axe/4.10/${encodeURIComponent(ruleId)}`;
    const issueCards = ruleViols.map((v) => {
      const selector = v.element?.selector || '';
      const outerHTML = v.element?.outerHTML || '';
      return `<div class="violation-card" data-impact="${esc(v.impact)}" data-layer="${esc(v.layer)}" data-category="${esc(v.category)}" data-owner="${ownerBadge(originOf(v)).key}">
        ${selector ? `<div class="v-location"><span class="location-label">Element Location:</span><code>${esc(selector)}</code></div>` : ''}
        ${outerHTML ? `<pre class="code-snippet">${esc(prettyHtml(outerHTML.slice(0, 500)))}</pre>` : ''}
        <div class="v-fix-row">
          <span class="fix-label">To solve this problem, you need to fix the following:</span>
          <p class="v-hint">${esc(hint)}</p>
        </div>
        <div class="v-meta-row">
          ${impactBadge(v.impact)}
          ${v.wcagRef ? `<span class="wcag-tag">${esc(v.wcagRef)}</span>` : ''}
          ${v.fix?.deterministic ? '<span class="fix-auto">Auto-fix</span>' : '<span class="fix-ai">AI-fix</span>'}
          ${enginesLabel(v) ? `<span class="wcag-tag">Engines agreeing: ${esc(enginesLabel(v))}</span>` : ''}
          <span class="found-date">Found: ${v.foundAt ? new Date(v.foundAt).toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', year: 'numeric' }) : new Date().toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', year: 'numeric' })}</span>
        </div>
        <div class="v-owner">${ownerHtml(originOf(v))}</div>
        ${buildSourcePath(v)}
        ${buildWhyFlagged(v)}
      </div>`;
    }).join('');

    html += `<details class="rule-accordion">
      <summary>
        <div class="rule-summary-left">
          ${impactBadge(first.impact)}
          <span class="rule-title">${esc(ruleId)}</span>
        </div>
        <span class="rule-count">${ruleViols.length} issue${ruleViols.length === 1 ? '' : 's'}</span>
      </summary>
      <div class="rule-body">
        <p class="rule-description">${esc(hint)}</p>
        <a class="rule-link" href="${esc(dequeUrl)}" target="_blank" rel="noopener">more information &#x2197;</a>
        ${issueCards}
      </div>
    </details>`;
  }
  return html;
}

// ─── AccessScan section builder ──────────────────────────────────────────────

export { getAccessScanRuleRequirement };

export function buildAccessScanRuleCard(ruleId, ruleViols) {
  const first = ruleViols[0];
  const failCount = ruleViols.reduce((sum, violation) => {
    const count = Number.isInteger(violation.count) && violation.count > 0
      ? violation.count
      : 1;
    return sum + count;
  }, 0);
  const wcagRef = first.wcagRef || '';
  const wcagVersion = wcagRef.match(/WCAG\s*\d+\.?\d*/)?.[0] || 'WCAG 2.0';
  const wcagLevel = wcagRef.match(/(A{1,3})\b/)?.[1] || (wcagRef.includes('Best Practice') ? 'BP' : 'A');
  const ruleInfo = getAccessScanRuleRequirement(ruleId);
  const ruleTitle = ruleInfo?.title || ruleId;
  const requirement = ruleInfo?.requirement || first.fix?.hint || (
    getAccessScanCategory(ruleId) === null
      ? 'This rule is not in the current accessScan catalog. The finding is preserved for review.'
      : ''
  );

  const dedupMap = new Map();
  for (const v of ruleViols) {
    const html = v.element?.outerHTML || '';
    const key = html.slice(0, 500) || v.id;
    const occurrence = Number.isInteger(v.count) && v.count > 0 ? v.count : 1;
    if (dedupMap.has(key)) {
      dedupMap.get(key).count += occurrence;
    } else {
      dedupMap.set(key, { v, html, count: occurrence });
    }
  }

  const snapshotEntries = [...dedupMap.values()];
  let codeSnapshots = '';
  const uniqueCount = snapshotEntries.filter((e) => e.html).length;
  if (uniqueCount > 0) {
    codeSnapshots = snapshotEntries.map((entry, i) => {
      if (!entry.html) return '';
      const countBadge = entry.count > 1 ? `<span class="dedup-badge">&times;${entry.count}</span>` : '';
      const perHint = entry.v.fix?.hint && entry.v.fix.hint !== requirement ? `<div class="snap-hint">${esc(entry.v.fix.hint)}</div>` : '';
      const sourcePath = buildSourcePath(entry.v);
      return `<div class="snapshot-block">
      <span class="snapshot-num">${i + 1}</span>
      <div class="snapshot-content">
        <pre class="code-snippet">${esc(prettyHtml(entry.html.slice(0, 500)))}</pre>
        ${countBadge}${perHint}${sourcePath}${buildWhyFlagged(entry.v)}
      </div>
    </div>`;
    }).filter(Boolean).join('');
  }

  const successfulMap = new Map();
  for (const violation of ruleViols) {
    const directElements = violation.evidence?.successfulElements || [];
    const observedElements = (violation.evidence?.observations || [])
      .flatMap((observation) => observation.evidence?.successfulElements || []);
    for (const element of [...directElements, ...observedElements]) {
      const elementHtml = element?.outerHTML || '';
      const key = elementHtml.slice(0, 500) || element?.selector;
      if (key && !successfulMap.has(key)) {
        successfulMap.set(key, element);
      }
    }
  }
  const successfulElements = [...successfulMap.values()];
  const successfulSnapshots = successfulElements.map((element, index) =>
    `<div class="snapshot-block success-snapshot">
      <span class="snapshot-num">${index + 1}</span>
      <div class="snapshot-content">
        <pre class="code-snippet">${esc(prettyHtml((element.outerHTML || '').slice(0, 500)))}</pre>
      </div>
    </div>`
  ).join('');
  const successfulContent = successfulSnapshots
    ? `<div class="as-snapshots as-success-snapshots"><span class="as-snap-label">${successfulElements.length} code snapshot${successfulElements.length === 1 ? '' : 's'} of successful element${successfulElements.length === 1 ? '' : 's'}</span>${successfulSnapshots}</div>`
    : '';

  const impactLabel = first.impact === 'critical' ? 'Critical' : first.impact === 'serious' ? 'Serious' : first.impact === 'moderate' ? 'Moderate' : 'Minor';
  const foundDate = first.foundAt ? new Date(first.foundAt).toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', year: 'numeric' }) : new Date().toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', year: 'numeric' });

  const leftContent = `<div class="as-rule-header">
          <span class="as-wcag-version">${esc(wcagVersion)}</span>
          <h4 class="as-rule-title">${esc(ruleTitle)}</h4>
        </div>
        <div class="as-requirement">
          <span class="as-req-label">Requirement:</span>
          <p>${esc(requirement)}</p>
        </div>
        ${codeSnapshots
          ? `<div class="as-snapshots"><span class="as-snap-label">${failCount} code snapshot${failCount === 1 ? '' : 's'} of failed element${failCount === 1 ? '' : 's'}</span>${codeSnapshots}</div>`
          : `<div class="as-page-level">Page-level violation - no specific element to display.</div>`}
        ${successfulContent}`;

  return `<div class="as-rule-card violation-card" data-impact="${esc(first.impact)}" data-layer="accessScan" data-category="accessibility" data-owner="${ownerBadge(originOf(first)).key}">
    <div class="as-rule-layout">
      <div class="as-rule-left">
        ${leftContent}
      </div>
      <div class="as-rule-right">
        <table class="as-prop-table">
          <tr><th>Property</th><th>Value</th></tr>
          <tr><td>WCAG Version</td><td>${esc(wcagVersion)}</td></tr>
          <tr><td>WCAG Level</td><td>${esc(wcagLevel)}</td></tr>
          <tr><td>Rule Name</td><td><code>${esc(ruleId)}</code></td></tr>
          <tr><td>Failures</td><td><span class="fail-count">${failCount}</span></td></tr>
          <tr><td>Impact</td><td>${impactLabel}</td></tr>
          <tr><td>Found on</td><td>${foundDate}</td></tr>
          <tr><td>Owner</td><td>${ownerHtml(originOf(first))}</td></tr>
        </table>
      </div>
    </div>
  </div>`;
}

/** A card shows one owner, so a rule hit in the site's markup and in a vendor's gets one card each. */
function splitByOwner(violations) {
  const by = new Map();
  for (const v of violations) {
    const k = ownerBadge(originOf(v)).text;
    by.set(k, [...(by.get(k) || []), v]);
  }
  return [...by.values()];
}

function buildAccessScanSection(violations, metadata = {}) {
  const totalIssues = violations.length;
  const incomplete = metadata.incomplete === true;
  const isCompliant = totalIssues === 0 && !incomplete;
  const profileLabel = metadata.profile
    ? formatAccessScanProfileLabel(metadata.profile)
    : null;

  let html = '';
  if (profileLabel) {
    html += `<div class="as-profile-banner" role="note">
      <strong>accessScan profile:</strong> ${esc(profileLabel)}
      ${metadata.comparatorVersion
        ? `<span class="as-profile-meta">Comparator ${esc(metadata.comparatorVersion)}</span>`
        : ''}
      ${metadata.includeThirdParty
        ? '<span class="as-profile-meta">Legacy includeThirdParty: true</span>'
        : ''}
    </div>`;
  }

  html += `<div class="as-compliance-bar">
    <span class="as-compliance-badge ${incomplete && totalIssues === 0 ? 'incomplete' : isCompliant ? 'compliant' : 'non-compliant'}">
      ${incomplete && totalIssues === 0 ? '&#9888; Incomplete scan' : isCompliant ? '&#x2713; No automated issues found' : '&#x2717; Non-compliant'}
    </span>
    ${incomplete && totalIssues === 0
      ? '<span class="as-compliance-text">Some pages or scanner layers did not complete, so the result cannot be determined.</span>'
      : isCompliant
      ? '<span class="as-compliance-text">Automated checks found no issues. Manual review is still required.</span>'
      : '<span class="as-compliance-text">Your scan found serious accessibility issues. Let\'s fix them now to help you meet accessibility requirements and mitigate legal risk.</span>'}
  </div>`;

  if (totalIssues === 0) {
    if (incomplete) return html;
    return html + `<div class="no-issues"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#008a05" stroke-width="2"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg><span>No automated issues found</span></div>`;
  }

  const cataloguedRuleIds = new Set(ACCESSSCAN_CATEGORIES.flatMap((category) => category.rules));

  for (const cat of ACCESSSCAN_CATEGORIES) {
    const catViols = violations.filter((v) => cataloguedRuleIds.has(v.ruleId) && cat.rules.includes(v.ruleId));
    const catCount = catViols.reduce((sum, violation) => {
      const count = Number.isInteger(violation.count) && violation.count > 0
        ? violation.count
        : 1;
      return sum + count;
    }, 0);
    const catStatusClass = catCount > 0 ? 'has-issues' : 'no-issues-cat';

    const byRule = groupViolations(catViols, (v) => v.ruleId);
    let ruleCards = '';
    for (const [ruleId, ruleViols] of byRule) {
      ruleCards += splitByOwner(ruleViols).map((group) => buildAccessScanRuleCard(ruleId, group)).join('');
    }

    if (catCount === 0) {
      ruleCards = `<div class="as-cat-pass"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#008a05" stroke-width="2"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg> No automated issues found in this category</div>`;
    }

    html += `<details class="cat-accordion ${catStatusClass}" ${catCount > 0 ? 'open' : ''}>
      <summary>
        <span class="cat-label">${esc(cat.label)}</span>
        <span class="cat-wcag">${esc(cat.wcagVersions.join(' + '))}</span>
        <span class="cat-count ${catCount > 0 ? 'has-count' : 'zero-count'}">${catCount}</span>
      </summary>
      <div class="cat-body">${ruleCards}</div>
    </details>`;
  }

  const uncatalogued = violations.filter((v) => !cataloguedRuleIds.has(v.ruleId));
  if (uncatalogued.length > 0) {
    const byRule = groupViolations(uncatalogued, (v) => v.ruleId);
    let ruleCards = '';
    for (const [ruleId, ruleViols] of byRule) {
      ruleCards += splitByOwner(ruleViols).map((group) => buildAccessScanRuleCard(ruleId, group)).join('');
    }

    html += `<details class="cat-accordion has-issues uncatalogued" open>
      <summary>
        <span class="cat-label">Uncatalogued</span>
        <span class="cat-wcag">Stale or unknown accessScan rules</span>
        <span class="cat-count has-count">${uncatalogued.length}</span>
      </summary>
      <div class="cat-body">${ruleCards}</div>
    </details>`;
  }

  return html;
}

export { buildAccessScanSection, buildAxeSection, buildGenericViolationSection };

// ─── Generic violations section (W3C, Links, Behavioral) ────────────────────

function buildGenericViolationSection(violations, incomplete = false) {
  if (violations.length === 0) {
    if (incomplete) return INCOMPLETE_NOTE;
    return `<div class="no-issues"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#008a05" stroke-width="2"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg><span>No automated issues found</span></div>`;
  }

  const byRule = groupViolations(violations, (v) => v.ruleId);
  let html = '';
  for (const [ruleId, ruleViols] of byRule) {
    const first = ruleViols[0];
    const issueCards = ruleViols.map((v) => {
      const outerHTML = v.element?.outerHTML || '';
      const selector = v.element?.selector || '';
      const occurrence = Number.isInteger(v.count) && v.count > 0 ? v.count : 1;
      const countBadge = occurrence > 1 ? `<span class="dedup-badge">&times;${occurrence}</span>` : '';
      return `<div class="violation-card" data-impact="${esc(v.impact)}" data-layer="${esc(v.layer)}" data-category="${esc(v.category)}" data-owner="${ownerBadge(originOf(v)).key}">
        <div class="v-meta-row">
          ${impactBadge(v.impact)}
          ${v.wcagRef ? `<span class="wcag-tag">${esc(v.wcagRef)}</span>` : ''}
          ${v.fix?.deterministic ? '<span class="fix-auto">Auto-fix</span>' : '<span class="fix-ai">AI-fix</span>'}
          ${enginesLabel(v) ? `<span class="wcag-tag">Engines agreeing: ${esc(enginesLabel(v))}</span>` : ''}
          ${countBadge}
        </div>
        <p class="v-hint">${esc(v.fix?.hint || '')}</p>
        ${selector ? `<div class="v-location"><code>${esc(selector)}</code></div>` : ''}
        ${outerHTML ? `<pre class="code-snippet">${esc(prettyHtml(outerHTML.slice(0, 500)))}</pre>` : ''}
        <div class="v-owner">${ownerHtml(originOf(v))}</div>
        ${buildSourcePath(v)}
        ${buildWhyFlagged(v)}
      </div>`;
    }).join('');

    const ruleOcc = countIssueOccurrences(ruleViols);
    html += `<details class="rule-accordion">
      <summary>
        <div class="rule-summary-left">
          ${impactBadge(first.impact)}
          <span class="rule-title">${esc(ruleId)}</span>
        </div>
        <span class="rule-count">${ruleOcc} issue${ruleOcc === 1 ? '' : 's'}</span>
      </summary>
      <div class="rule-body">${issueCards}</div>
    </details>`;
  }
  return html;
}

// ─── Tool section wrapper ────────────────────────────────────────────────────

function buildToolSection(tool, allViolations, lighthouseData, accessScanMetadata = null, incomplete = false) {
  const toolViols = toolViolations(tool, allViolations);
  const count = countIssueOccurrences(toolViols);
  const toolLabel = tool.id === 'accessScan' && accessScanMetadata?.profile
    ? `AccessScan - ${formatAccessScanProfileLabel(accessScanMetadata.profile)}`
    : tool.label;

  let content = '';
  if (tool.id === 'performance') {
    content = buildPerformanceDashboard(lighthouseData);
    const perfViols = toolViols.filter((v) => v.impact !== 'info');
    if (perfViols.length > 0) {
      content += buildGenericViolationSection(perfViols);
    }
  } else if (tool.id === 'axe') {
    content = buildAxeSection(toolViols, incomplete);
  } else if (tool.id === 'accessScan') {
    content = buildAccessScanSection(toolViols, { ...accessScanMetadata, incomplete });
  } else {
    content = buildGenericViolationSection(toolViols, incomplete);
  }

  const isPerf = tool.id === 'performance';

  return `<details class="tool-section" id="section-${tool.id}" ${count > 0 || isPerf ? 'open' : ''}>
    <summary class="tool-header">
      <div class="tool-icon" style="background:${tool.color}10;color:${tool.color}">
        ${svgIcon(tool.icon, 18, tool.color)}
      </div>
      <h2>${esc(toolLabel)}</h2>
      <span class="tool-total">Total issues: <strong>${count}</strong></span>
      <span class="section-badge" style="background:${count > 0 ? tool.color : '#008a05'}">${count}</span>
      <svg class="chevron" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
    </summary>
    <div class="tool-body">${content}</div>
  </details>`;
}

// ─── Main HTML builder ───────────────────────────────────────────────────────

/** The scan-visual.html document: a ScanReportV2 (report.v2, or the report itself) or the legacy projection. Layout and client code live in ./ui/. */
export function buildHtml(report) {
  return buildReportHtml(report);
}
