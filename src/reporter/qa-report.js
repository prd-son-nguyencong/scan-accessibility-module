// QA report for PMs and clients (T-E5.4): pass/fail per standard and page, top issues, platform-owned items, baseline, limits.
// Built from a ScanReportV2 only; E4.3 (`ownership`) and E5.3 (`comparison`) fields are optional.
import { escapeHtml as esc } from '../utils/escape-html.js';
import { docParts, THEME_TOGGLE_HTML, wbr } from './ui/theme.js';
import { wcagCoverageSentence } from '../utils/wcag-criteria.js';
import { rulePrecision, lowPrecisionRules, staleLabels, pct, MIN_LABELS, MIN_PRECISION } from './labels.js';
import { ownerBadge, ownerHtml, groupNotYourCode, notYourCodeHtml } from './origin-display.js';
import { excludedNote } from '../utils/thresholds.js';
import { GATE_NOTE, totalsLabel, w3cEngineNote, runStatusLabel } from './wording.js';
import { MANUAL_CHECKS, summarizeManual, manualPageSentence, manualVerdict } from './manual-checks.js';

const STANDARDS = [
  { id: 'a11y', title: 'Accessibility (confirmed findings gate; Lighthouse accessibility score)', ids: ['a11y.critical', 'a11y.serious', 'a11y.moderate', 'a11y.minor', 'lighthouse.mobile.accessibility', 'lighthouse.desktop.accessibility'] },
  { id: 'html', title: 'HTML validity (engine named below)', ids: ['w3c.errors', 'w3c.warnings'] },
  { id: 'perf', title: 'Performance (Lighthouse performance score only)', ids: ['lighthouse.mobile.performance', 'lighthouse.desktop.performance'] },
  { id: 'bp', title: 'Best practices', ids: ['lighthouse.mobile.bestPractices', 'lighthouse.desktop.bestPractices'] },
  { id: 'seo', title: 'SEO (advisory)', ids: ['lighthouse.mobile.seo', 'lighthouse.desktop.seo'] },
];

const STATUS_WORD = { pass: 'PASS', fail: 'FAIL', advisory: 'ADVISORY', skipped: 'N/A', report: 'REPORT' };

/** WCAG level from the tag suffix an engine wrote into wcagRef (axe: WCAG2AA, WCAG21AA, WCAG22AAA); null when the metadata has no level. */
export function wcagLevel(wcagRef) {
  const m = /^WCAG\d+(A{1,3})$/i.exec(String(wcagRef || '').trim());
  return m ? m[1].toUpperCase() : null;
}

const counted = (f) => f.impact !== 'info';
const verdictKey = (f) => (f.verdict === 'needs-review' ? 'needsReview' : f.verdict || 'confirmed');

function sourceLabel(f) {
  const s = f.source || {};
  const traced = s.file && (s.confidence === 'high' || s.confidence === 'medium');
  return traced ? `${s.file}${Number.isInteger(s.line) && s.line > 0 ? `:${s.line}` : ''}` : null;
}

function groupByRule(findings) {
  const groups = new Map();
  for (const { f, route } of findings) {
    const id = f.canonicalRuleId || f.nativeRuleId;
    const g = groups.get(id) || { ruleId: id, layer: f.layer, impact: f.impact, wcagRef: f.wcagRef || null, confirmed: 0, likely: 0, needsReview: 0, total: 0, sources: new Set(), engines: new Set(), owners: new Set(), instances: [] };
    g[verdictKey(f)] += f.count;
    g.total += f.count;
    const src = sourceLabel(f);
    if (src) g.sources.add(src);
    (f.enginesAgreeing || []).forEach((e) => g.engines.add(e));
    g.owners.add(ownerBadge(f.origin).text);
    g.instances.push({ stableId: f.stableId, route, selector: f.element?.selector || '', source: src, count: f.count, verdict: f.verdict || 'confirmed', origin: f.origin || null, ...(f.sharedSource ? { sharedSource: f.sharedSource } : {}) });
    groups.set(id, g);
  }
  return [...groups.values()]
    .sort((a, b) => b.confirmed - a.confirmed || b.total - a.total || a.ruleId.localeCompare(b.ruleId))
    .map((g) => ({ ...g, sources: [...g.sources].sort(), engines: [...g.engines].sort(), owners: [...g.owners].sort() }));
}

/** manual: the loaded manual-checks store (or null); manualError: why it could not be loaded. Sign-off age is measured against the report's own date, so the model stays deterministic. */
export function buildQaModel(report, { topN = 10, instanceCap = 15, manual = null, manualError = null, labels = [], labelsError = null } = {}) {
  const pages = report.pages || [];
  const all = pages.flatMap((p) => (p.findings || []).filter(counted).map((f) => ({ f, route: p.route || p.url || p.name })));
  const owned = all.filter(({ f }) => (f.ownership || 'source') === 'source');
  const platform = all.filter(({ f }) => (f.ownership || 'source') !== 'source');
  const gate = report.runMetadata?.thresholds || null;
  const requested = report.runMetadata?.discovery?.pages?.length ?? pages.length;
  const s = report.summary || {};
  const confirmedTotal = all.reduce((n, { f }) => n + (verdictKey(f) === 'confirmed' ? f.count : 0), 0);

  const reasons = [];
  if (!pages.length) reasons.push('no pages were scanned');
  if (s.pagesFailed) reasons.push(`${s.pagesFailed} page(s) failed`);
  if (s.pagesPartial) {
    const why = pages.filter((p) => p.status === 'partial').flatMap((p) => (p.partialReasons || []).map((r) => `${p.route} ${r.layer}: ${r.reason}${r.gating ? '' : ' (supplementary)'}`));
    reasons.push(`${s.pagesPartial} page(s) partial${why.length ? ` (${why.join('; ')})` : ''}`);
  }
  if (s.scannerErrors) reasons.push(`${s.scannerErrors} scanner error(s)`);
  if (requested > pages.length) reasons.push(`${pages.length} of ${requested} requested pages scanned`);
  const failed = gate ? gate.failed === true : confirmedTotal > 0;
  const failReason = gate
    ? 'a quality gate threshold was not met'
    : `${confirmedTotal} confirmed finding(s); no thresholds recorded in this report`;
  const status = failed ? 'FAIL' : reasons.length ? 'INCOMPLETE' : 'PASS';
  const statusReason = failed ? [failReason, ...reasons].join('; ') : status === 'PASS' ? 'all recorded automated checks met their thresholds' : reasons.join('; ');

  const scanners = new Map();
  for (const run of report.scanners || []) {
    const k = `${run.layer}|${run.engine?.name}|${run.engine?.version || ''}`;
    scanners.set(k, { layer: run.layer, engine: run.engine?.name || run.layer, version: run.engine?.version || null, status: runStatusLabel(run) });
  }

  const gatePages = (gate?.pages || []).map((gp) => ({ name: gp.name, url: gp.url, devServer: gp.devServer, noindex: gp.noindex, metrics: gp.metrics }));
  const standards = STANDARDS.map((st) => ({
    ...st,
    pages: gatePages.map((gp) => ({ url: gp.url, metrics: gp.metrics.filter((m) => st.ids.includes(m.id)) })),
  })).filter((st) => st.pages.some((p) => p.metrics.length));

  // WCAG levels: confirmed findings of the accessibility category, by level in the rule metadata.
  const wcag = { A: 0, AA: 0, AAA: 0, unspecified: 0 };
  for (const { f } of owned) {
    if (f.category !== 'accessibility' || verdictKey(f) !== 'confirmed') continue;
    wcag[wcagLevel(f.wcagRef) || 'unspecified'] += f.count;
  }

  const metrics = gatePages.flatMap((p) => p.metrics);
  const manualItems = all.reduce((n, { f }) => n + (verdictKey(f) !== 'confirmed' ? f.count : 0), 0);
  const cmp = report.comparison;
  const pageAuto = (p) => (p.findings || []).some((f) => counted(f) && verdictKey(f) === 'confirmed')
    || gatePages.some((gp) => gp.url === p.url && gp.metrics.some((x) => x.status === 'fail')) ? 'FAIL' : status === 'INCOMPLETE' ? 'INCOMPLETE' : 'PASS';
  const msum = summarizeManual(manual || { signoffs: [] }, pages.map((p) => ({ route: p.route || p.url || p.name, contentHash: p.contentHash })), String(report.generatedAt).slice(0, 10));
  const manualModel = {
    error: manualError,
    verdict: manualVerdict(status, msum),
    pages: msum.rows.map((r, i) => ({ ...r, sentence: manualPageSentence(pageAuto(pages[i]), r) })),
  };
  return {
    status,
    statusReason,
    gateNote: GATE_NOTE,
    totals: { occurrences: all.reduce((n, { f }) => n + f.count, 0), findings: all.length },
    htmlEngine: w3cEngineNote(report.scanners || [], all.map(({ f }) => f)),
    generatedAt: report.generatedAt,
    target: { mode: report.target?.mode || null, url: report.target?.url || null },
    profiles: report.runMetadata?.profiles || (report.runMetadata?.accessScan?.profile ? [report.runMetadata.accessScan.profile] : []),
    engines: [...scanners.values()].sort((a, b) => a.layer.localeCompare(b.layer)),
    pages: { scanned: pages.length, requested, failed: s.pagesFailed || 0, partial: s.pagesPartial || 0 },
    skippedPages: pages.filter((p) => p.status === 'skipped-empty').map((p) => ({ route: p.route || p.url || p.name, reason: p.skipped?.note || 'empty page' })),
    gate: gate ? { failed: gate.failed, notices: gate.notices || [], excluded: gate.pages?.reduce((n, p) => n + (p.excluded || 0), 0) || 0 } : null,
    standards,
    wcag,
    topIssues: groupByRule(owned).slice(0, topN).map((g) => ({ ...g, instances: g.instances.slice(0, instanceCap), moreInstances: Math.max(0, g.instances.length - instanceCap) })),
    notYourCode: groupNotYourCode(all.map(({ f, route }) => ({ origin: f.origin, rule: f.nativeRuleId, page: route, count: f.count, impact: f.impact }))),
    platformOwned: groupByRule(platform).map((g) => ({ ...g, instances: g.instances.slice(0, instanceCap) })),
    baseline: cmp ? {
      source: cmp.baseline?.source || null,
      generatedAt: cmp.baseline?.generatedAt || null,
      totals: cmp.totals || null,
      newItems: (cmp.new || []).slice(0, topN),
      warnings: cmp.warnings || [],
    } : null,
    manual: manualModel,
    rulePrecision: { error: labelsError, rules: rulePrecision(labels), low: lowPrecisionRules(rulePrecision(labels)).map((r) => r.ruleId), staleLabels: staleLabels(labels).length, demotions: report.runMetadata?.ruleDemotions || null },
    limits: {
      automatedPassed: metrics.filter((m) => m.status === 'pass').length,
      automatedRecorded: metrics.filter((m) => m.status !== 'skipped').length,
      manualReviewItems: manualItems,
      standingChecks: MANUAL_CHECKS.map((c) => c.title),
    },
  };
}

const slug = (id) => `rule-${String(id).replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`;
const cell = (m) => (m ? `<td class="s-${esc(m.status)}"><strong>${m.status === 'skipped' && m.reason === 'unscorable' ? 'SKIPPED(unscorable)' : STATUS_WORD[m.status] || esc(m.status)}</strong> ${esc(m.actual ?? 'n/a')} / ${esc(m.target)}${m.reason ? `<br><small>${esc(m.reason)}</small>` : ''}</td>` : '<td>-</td>');

function standardTable(st) {
  const ids = st.ids.filter((id) => st.pages.some((p) => p.metrics.some((m) => m.id === id)));
  const head = ids.map((id) => `<th scope="col">${esc(id.replace(/^lighthouse\./, 'Lighthouse '))}</th>`).join('');
  const rows = st.pages.map((p) => `<tr><th scope="row">${esc(p.url)}</th>${ids.map((id) => cell(p.metrics.find((m) => m.id === id))).join('')}</tr>`).join('');
  return `<section aria-labelledby="std-${esc(st.id)}"><h3 id="std-${esc(st.id)}">${esc(st.title)}</h3>
<table><caption>${esc(st.title)}: actual score or count / threshold, per page</caption><thead><tr><th scope="col">Page</th>${head}</tr></thead><tbody>${rows}</tbody></table></section>`;
}

export function skippedPagesHtml(skipped = []) {
  if (!skipped.length) return '';
  return `<section aria-labelledby="skipped"><h2 id="skipped">Skipped pages</h2>
<p>These pages were not scanned and are not counted as failed or incomplete.</p>
<ul>${skipped.map((p) => `<li><code>${wbr(p.route)}</code>: ${esc(p.reason)}</li>`).join('')}</ul></section>`;
}

function issueTable(groups, caption) {
  if (!groups.length) return '<p>None.</p>';
  const rows = groups.map((g) => `<tr><th scope="row"><a href="#${slug(g.ruleId)}">${esc(g.ruleId)}</a></th><td>${esc(g.impact)}</td><td>${g.confirmed}</td><td>${g.likely}</td><td>${g.needsReview}</td><td>${g.engines.length ? esc(g.engines.join(', ')) : '-'}</td><td>${esc(g.owners.join(', '))}</td><td>${g.sources.length ? g.sources.slice(0, 3).map((x) => `<code>${wbr(x)}</code>`).join(', ') + (g.sources.length > 3 ? ` +${g.sources.length - 3} more` : '') : 'not traced to local source'}</td></tr>`).join('');
  return `<table><caption>${esc(caption)}</caption><thead><tr><th scope="col">Rule</th><th scope="col">Impact</th><th scope="col">Confirmed</th><th scope="col">Likely</th><th scope="col">Needs review</th><th scope="col">Engines agreeing</th><th scope="col">Owner</th><th scope="col">Source</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function details(groups) {
  return groups.map((g) => `<div class="rule-group"><h3 id="${slug(g.ruleId)}">${wbr(g.ruleId)}${g.wcagRef ? ` (${esc(g.wcagRef)})` : ''}</h3><ul>${g.instances.map((i) => `<li>${esc(i.route)} <code>${wbr(i.selector)}</code> (${esc(i.verdict)}, ${i.count}x) ${ownerHtml(i.origin)}${i.sharedSource ? ` [same source line in ${i.sharedSource.findings} findings on ${i.sharedSource.pages} page${i.sharedSource.pages === 1 ? '' : 's'}]` : ''}${i.source ? ` at <code>${wbr(i.source)}</code>` : ''}${i.stableId ? `<details><summary>Label this finding</summary><code>ada-scan label ${esc(i.stableId)} --tp --by YOUR_NAME</code> or <code>--fp</code> with <code>--note "why"</code></details>` : ''}</li>`).join('')}${g.moreInstances ? `<li>and ${g.moreInstances} more</li>` : ''}</ul></div>`).join('');
}

function precisionHtml(p) {
  const rows = p.rules.map((r) => `<tr><th scope="row">${esc(r.ruleId)}</th><td>${r.tp}</td><td>${r.fp}</td><td>${r.n}</td><td>${esc(pct(r.precision))}${r.n < MIN_LABELS ? ` (under ${MIN_LABELS} labels, not acted on)` : p.low.includes(r.ruleId) ? ' (below threshold)' : ''}</td></tr>`).join('');
  return `${p.error ? `<p class="note">Labels could not be read: ${esc(p.error)}</p>` : ''}${p.staleLabels ? `<p class="note">${p.staleLabels} label(s) were made under another stable-id version and cannot be matched to these findings; they still count here.</p>` : ''}${p.demotions ? `<p class="note">${p.demotions.demotedFindings} finding(s) in this scan were moved to needs-review because their rule has precision below ${esc(pct(MIN_PRECISION))} over at least ${MIN_LABELS} labels.</p>` : ''}${rows
    ? `<table><caption>Share of QA-labelled findings that were real problems, per rule (rules with at least ${MIN_LABELS} labels and precision below ${esc(pct(MIN_PRECISION))} can be demoted with <code>ada-scan labels apply --yes</code>)</caption><thead><tr><th scope="col">Rule</th><th scope="col">True positives</th><th scope="col">False positives</th><th scope="col">Labels</th><th scope="col">Precision</th></tr></thead><tbody>${rows}</tbody></table>`
    : '<p>No QA labels yet. Each finding above shows the command that labels it.</p>'}`;
}

/** Every table (also the shared Not-your-code one) gets the report table class and a keyboard-focusable scroll container for narrow screens. */
const scrollableTables = (html) => html.replace(/<table>/g, `<div class="tbl-scroll" tabindex="0" role="group" aria-label="Table, scrolls sideways"><table class="tbl">`).replace(/<\/table>/g, '</table></div>');

export function renderQaHtml(m) {
  const b = m.baseline;
  const t = b?.totals;
  const baseline = b && t
    ? `<p>Compared with the ${esc(b.source)} from ${esc(b.generatedAt)}: <strong>fixed ${t.fixed}, remaining ${t.remaining}, new ${t.new}</strong>. Needs-review items are not compared (${t.needsReview?.baseline ?? 0} before, ${t.needsReview?.current ?? 0} now).</p>${b.newItems.length ? `<ul>${b.newItems.map((i) => `<li>New: ${esc(i.ruleId)} <code>${wbr(i.selector)}</code>${i.file ? ` at <code>${esc(i.file)}${i.line ? `:${i.line}` : ''}</code>` : ''}</li>`).join('')}</ul>` : ''}${b.warnings.map((w) => `<p class="note">${esc(w)}</p>`).join('')}`
    : '<p>No baseline comparison in this scan. Run with <code>--baseline</code> once to save one.</p>';
  const w = m.wcag;
  const l = m.limits;
  const page = docParts({ title: 'QA report', css: '' });
  return scrollableTables(`<!doctype html>
<html lang="en"><head>
${page.head}
</head><body class="doc">
${page.bodyStart}
<a class="skip" href="#main">Skip to the report</a>
<header class="top"><div class="wrap">
<div class="top-row"><h1>QA report</h1>${THEME_TOGGLE_HTML}</div>
<p class="lead">Automated checks: <span class="status st-${esc(m.status)}">${esc(m.status)}</span></p>
<p>${esc(m.statusReason.charAt(0).toUpperCase() + m.statusReason.slice(1))}.</p>
<p><strong>${esc(m.manual.verdict)}</strong></p>
<p>${esc(m.gateNote)} Totals: ${esc(totalsLabel(m.totals.occurrences, m.totals.findings))}.</p>
<p>This is the result of automated checks only. See <a href="#limits">Limits of automated testing</a>.</p></div></header>
<main id="main" class="wrap">
<section aria-labelledby="exec"><h2 id="exec">Executive status</h2>
<dl><dt>Scan date</dt><dd>${esc(m.generatedAt)}</dd>
<dt>Target</dt><dd>${esc(m.target.url || 'local source')} (${esc(m.target.mode)})</dd>
<dt>Profile</dt><dd>${esc(m.profiles.join(', ') || 'not recorded')}</dd>
<dt>Pages scanned</dt><dd>${m.pages.scanned} of ${m.pages.requested} requested (${m.pages.failed} failed, ${m.pages.partial} partial)</dd>
<dt>Engines and layers</dt><dd>${m.engines.map((e) => esc(`${e.layer}: ${e.engine}${e.version ? ` ${e.version}` : ''}${e.status && e.status !== 'complete' ? ` [${e.status}]` : ''}`)).join('; ') || 'none recorded'}</dd></dl></section>
${skippedPagesHtml(m.skippedPages)}
<section aria-labelledby="stds"><h2 id="stds">Results by standard</h2>
${m.htmlEngine ? `<p>HTML validity (w3c.* rows) fed by: ${esc(m.htmlEngine)}.</p>` : ''}
${m.standards.length ? m.standards.map(standardTable).join('') : '<p>No quality gate result is recorded in this report, so there are no per-page scores.</p>'}
<table><caption>WCAG level of confirmed findings (level read from rule metadata)</caption><thead><tr><th scope="col">Level A</th><th scope="col">Level AA</th><th scope="col">Level AAA</th><th scope="col">Level not in metadata</th></tr></thead><tbody><tr><td>${w.A}</td><td>${w.AA}</td><td>${w.AAA}</td><td>${w.unspecified}</td></tr></tbody></table></section>
<section aria-labelledby="top"><h2 id="top">Top issues by rule</h2>${issueTable(m.topIssues, 'Issues the development team can fix, with counts by confidence')}${details(m.topIssues)}</section>
${notYourCodeHtml(m.notYourCode, 'They are not attributed to the development team and stay out of the gate unless gate.countPlatform / gate.countThirdParty is set.')}
<section aria-labelledby="plat"><h2 id="plat">Platform-owned and third-party</h2>
<p>These come from Paradox widgets or third-party content and cannot be fixed in the project source.${m.gate?.excluded ? ` Gate: ${esc(excludedNote(m.gate.excluded))}.` : ''}</p>
${issueTable(m.platformOwned, 'Platform-owned and third-party issues')}${details(m.platformOwned)}</section>
<section aria-labelledby="prec"><h2 id="prec">Rule precision</h2>${precisionHtml(m.rulePrecision)}</section>
<section aria-labelledby="base"><h2 id="base">Baseline</h2>${baseline}</section>
<section id="limits" class="limits" aria-labelledby="lim"><h2 id="lim">Limits of automated testing</h2>
<p>Automated tools find only part of the WCAG issues. Automated: ${l.automatedPassed} of ${l.automatedRecorded} recorded checks passed. Manual review: ${l.manualReviewItems} flagged item(s) plus the standing checks below. ${esc(wcagCoverageSentence())} This report does not state that the site meets WCAG.</p>
<ul>${l.standingChecks.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>
${m.manual.error ? `<p class="note">Manual sign-offs could not be read: ${esc(m.manual.error)}</p>` : ''}
<table><caption>Manual review sign-offs per page (record them with <code>ada-scan manual sign</code>)</caption><thead><tr><th scope="col">Page</th><th scope="col">Status</th><th scope="col">Stale sign-offs</th></tr></thead><tbody>${m.manual.pages.map((p) => `<tr><th scope="row">${esc(p.route)}</th><td>${esc(p.sentence)}</td><td>${p.stale.length ? p.stale.map((x) => esc(`${x.item}: ${x.reason}`)).join('<br>') : 'none'}</td></tr>`).join('')}</tbody></table></section>
</main>
<footer class="wrap"><p>Generated by ada-scan on ${esc(m.generatedAt)}.</p></footer>
${page.bodyEnd}
</body></html>
`);
}
