// Remaining report (docs/fix-harness.md section 7): every finding that is not fixed gets exactly one reason class.
// "Zero remaining" is claimed only when nothing is left and the final scan of the final state proves it: see the statement in the output.
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { isDesignLocked } from '../export/recipes.js';
import { familyOf, PAGE_LEVEL } from '../../reporter/engine-agreement.js';
import { HARNESS_LAYERS } from './scanner-cli.js';

export const REASON_CLASSES = Object.freeze([
  'needs_design_decision', 'platform_or_third_party', 'data_not_bound_locally', 'needs_human_content',
  'fixer_could_not_produce_safe_change', 'gate_failed', 'awaiting_review', 'not_reproduced_locally', 'not_traced', 'needs_review_finding', 'baseline_incomplete',
]);

// Rules whose fix needs words or a judgement that a person must supply.
const HUMAN_CONTENT = /^(?:image-alt|input-image-alt|role-img-alt|svg-img-alt|object-alt|area-alt|button-name|link-name|label|select-name|frame-title|document-title|empty-heading|heading-empty|aria-.*-name|aria-command-name|aria-input-field-name|aria-toggle-field-name|aria-tooltip-name|aria-treeitem-name|aria-dialog-name|aria-meter-name|aria-progressbar-name)$/i;
// A heading-one task needs the page's own title text (invented content is never an automatic fix).
const HUMAN_CONTENT_EXTRA = /^(?:page-has-heading-one|missing-h1)$/i;
/** Reason class of a task the fixer or editor declined: text or judgement a person writes, else null (the caller picks the fallback). */
export const declineReasonClass = (rule) => (HUMAN_CONTENT.test(rule || '') || HUMAN_CONTENT_EXTRA.test(rule || '') ? 'needs_human_content' : null);
/**
 * Identity of a defect across layers and rescans: rule family (lighthouse meta-viewport and accessScan MetaViewportScalable are one), route, and the element.
 * Page-level checks use no element; otherwise the element's #id when its selector has one (a long path and a short id selector name the same node), else the selector.
 */
export function defectKey(rule, route, selector) {
  const fam = familyOf({ nativeRuleId: String(rule || '') }) ?? String(rule || '').toLowerCase();
  const sel = String(selector || '');
  const el = PAGE_LEVEL.has(fam) || fam === 'meta-viewport' || fam === 'meta-refresh' ? '' : (sel.split(/\s*>\s*|\s+/).pop().replace(/\[[^\]]*\]/g, '').match(/#[\w-]+/)?.[0] ?? sel);
  return `${fam}|${route ?? ''}|${el}`.toLowerCase();
}
/** One row per defect: later rows with the same key become `duplicates` of the preferred row (one that has a task, then the first). */
function mergeDuplicates(rows) {
  const by = new Map();
  for (const r of rows) by.set(r.defect, [...(by.get(r.defect) || []), r]);
  const kept = [], duplicates = [];
  for (const g of by.values()) {
    const first = g.find((r) => r.taskId) || g[0];
    kept.push(first);
    for (const r of g) if (r !== first) duplicates.push({ ...r, duplicateOf: first.id });
  }
  return { kept: rows.filter((r) => kept.includes(r)), duplicates };
}
/** Layers that reported a finding but are not run by the harness rescan: the usual reason it is not seen again. */
const unseenLayers = (f) => { const ran = HARNESS_LAYERS.split(','); const all = [...new Set(f.layers?.length ? f.layers : [f.layer].filter(Boolean))]; return all.length && all.every((l) => !ran.includes(l)) ? all : []; };
const tierOf = (f) => f.verdict || 'confirmed';
const idOf = (f) => f.stableId || f.findingId;

function classify(f, task, res, { workingTree = false } = {}) {
  if (f.ownership && f.ownership !== 'source') return { cls: 'platform_or_third_party', detail: `owner: ${f.origin?.owner || f.ownership}${f.origin?.vendor ? ` (${f.origin.vendor})` : ''}` };
  if (f.origin?.kind === 'unbound-data') return { cls: 'data_not_bound_locally', detail: 'the value comes from a platform data binding that the local render does not resolve' };
  if (task?.requiresDesignDecision || isDesignLocked(f.nativeRuleId)) return { cls: 'needs_design_decision', detail: 'design lock: colour, token, opacity and background changes are never automatic' };
  if (!task) return tierOf(f) === 'needs-review'
    ? { cls: 'needs_review_finding', detail: 'needs-review finding: no task was created, a person must judge it' }
    : { cls: 'not_traced', detail: 'no traced source line, so no task and no allowlist could be built' };
  if (!res) return { cls: 'fixer_could_not_produce_safe_change', detail: 'not attempted in this run' };
  switch (res.outcome) {
    case 'skipped': return ['needs_design_decision', 'not_reproduced_locally', 'not_traced', 'baseline_incomplete'].includes(res.reasonClass)
      ? { cls: res.reasonClass, detail: res.detail || res.reasonClass }
      : { cls: 'fixer_could_not_produce_safe_change', detail: res.detail || 'skipped' };
    case 'declined': {
      const who = res.editorFlow ? 'the editor made no change for this task' : 'fixer declined';
      return declineReasonClass(f.nativeRuleId) === 'needs_human_content'
        ? { cls: 'needs_human_content', detail: `${who} (${res.detail || 'no reason'}); the fix needs text or a judgement a person writes` }
        : { cls: 'fixer_could_not_produce_safe_change', detail: `${who}: ${res.detail || 'no reason'}` };
    }
    case 'queued': return { cls: 'awaiting_review', detail: workingTree ? 'every gate passed, but the policy asked for a human decision: the edit is still in your working tree (the shadow did not keep it, so the rescan still reports the finding); keep or revert it yourself' : 'every gate passed; waiting for a human decision in the review workbench' };
    case 'rolled_back': case 'rejected': return res.failedGates?.length
      ? { cls: 'gate_failed', detail: `last candidate failed ${res.failedGates.join(', ')}`, gates: res.failedGates, evidence: res.evidence || [] }
      : { cls: 'fixer_could_not_produce_safe_change', detail: res.detail || 'no safe candidate within the repair budget' };
    default: return { cls: 'fixer_could_not_produce_safe_change', detail: res.detail || res.outcome };
  }
}

/**
 * report: ScanReportV2-like ({ pages: [{ route, findings }] }) or null (then the task occurrences are the finding universe).
 * tasks: normalised harness tasks ({ id, ids, rule, requiresDesignDecision, source, occurrences }); results: runner task results.
 * incomplete: array of reasons (truncated snapshot, failed rescan, missing gate input, aborted); empty means complete.
 * finalScan: { proved: true } only when the real scanner ran on the final state (the rescan after accepted changes, or the baseline scan when nothing changed).
 */
export function buildRemainingReport({ report = null, tasks = [], results = [], notActionable = [], incomplete = [], scanDelta = null, finalScan = null, baselineFindings = null, finalFindings = null, queuedEdits = [], workingTree = false }) {
  const byFinding = new Map();
  for (const t of tasks) for (const id of t.ids || []) byFinding.set(id, t);
  const resultOf = new Map(results.map((r) => [r.taskId, r]));
  const universe = [];
  if (report) {
    for (const pg of report.pages || []) for (const f of pg.findings || []) if (f.impact !== 'info') universe.push({ ...f, route: pg.route ?? f.route });
  } else {
    for (const t of tasks) for (const o of t.occurrences || []) universe.push({ stableId: o.stableId, nativeRuleId: t.rule, impact: t.severity || 'unknown', verdict: t.verdict || 'confirmed', ownership: 'source', route: o.route, element: { selector: o.selector } });
  }
  const fixed = [], remaining = [], duplicates = [];
  let notRescanned = [];
  // Derived from the final rescan when the runner has one: a report finding the shadow rescan never saw (another layer, an unreproduced route) is
  // neither fixed nor remaining, it is `notRescanned` and blocks the zero claim.
  if (finalFindings) {
    // The scanner's row order differs between identical runs (routes finish in any order): sort before any pick or count.
    const order = (a, b) => `${a.route}|${a.rule}|${a.selector}|${a.id}`.localeCompare(`${b.route}|${b.rule}|${b.selector}|${b.id}`);
    baselineFindings = [...(baselineFindings || [])].sort(order); finalFindings = [...finalFindings].sort(order);
    const reportById = new Map(universe.map((f) => [idOf(f), f]));
    const finalIds = new Set(finalFindings.map((f) => f.id));
    const baseIds = new Set((baselineFindings || []).map((f) => f.id));
    const fromRescan = (n) => reportById.get(n.id) || { stableId: n.id, nativeRuleId: n.native || n.rule, verdict: n.tier, ownership: 'source', route: n.route, element: { selector: n.selector } };
    const rowOf = (f) => { const id = idOf(f); const task = byFinding.get(id) || null; return { f, task, res: task ? resultOf.get(task.id) : null, row: { id, rule: f.nativeRuleId, route: f.route, selector: f.element?.selector || null, tier: tierOf(f), siteOwned: !f.ownership || f.ownership === 'source', taskId: task?.id || null, defect: defectKey(f.nativeRuleId, f.route, f.element?.selector) }, via: (task ? resultOf.get(task.id) : null)?.outcome === 'accepted' }; };
    for (const n of baselineFindings || []) if (!finalIds.has(n.id)) { const { row, via } = rowOf(fromRescan(n)); fixed.push({ ...row, viaTask: via }); }
    for (const n of finalFindings) { const { f, task, res, row } = rowOf(fromRescan(n)); remaining.push({ ...row, ...classify(f, task, res?.outcome === 'accepted' ? { ...res, outcome: 'rejected', detail: 'accepted, but the final rescan still reports it' } : res, { workingTree }) }); }
    const seen = new Set([...(baselineFindings || []), ...finalFindings].map((n) => defectKey(n.native || n.rule, n.route, n.selector)));
    notRescanned = universe.filter((f) => !finalIds.has(idOf(f)) && !baseIds.has(idOf(f)) && !seen.has(defectKey(f.nativeRuleId, f.route, f.element?.selector))).map((f) => { const { row } = rowOf(f); return { ...row, layers: unseenLayers(f) }; });
    // Counted once per defect (two layers or two ids of one defect are one) and in a fixed order, so identical runs give identical counts and lists.
    notRescanned = [...notRescanned.sort((a, b) => `${a.route}|${a.rule}|${a.selector}|${a.id}`.localeCompare(`${b.route}|${b.rule}|${b.selector}|${b.id}`)).reduce((m, r) => m.set(r.defect, m.has(r.defect) ? { ...m.get(r.defect), tier: [m.get(r.defect).tier, r.tier].includes('confirmed') ? 'confirmed' : m.get(r.defect).tier, layers: [...new Set([...m.get(r.defect).layers, ...r.layers])].sort() } : r), new Map()).values()];
    universe.length = 0;
    // The same defect reported by two layers (or under two ids) is one defect: merged so it is counted once.
    for (const [name, list] of [['fixed', fixed], ['remaining', remaining]]) { const m = mergeDuplicates(list); list.splice(0, list.length, ...m.kept); duplicates.push(...m.duplicates.map((d) => ({ ...d, list: name }))); }
  }
  for (const f of universe) {
    const id = idOf(f);
    const task = byFinding.get(id) || null;
    const res = task ? resultOf.get(task.id) : null;
    const row = { id, rule: f.nativeRuleId, route: f.route, selector: f.element?.selector || null, tier: tierOf(f), siteOwned: !f.ownership || f.ownership === 'source', taskId: task?.id || null };
    if (res?.outcome === 'accepted') fixed.push({ ...row, taskId: task.id });
    else remaining.push({ ...row, ...classify(f, task, res) });
  }
  const perClass = Object.fromEntries(REASON_CLASSES.map((c) => [c, 0]));
  const perTier = {};
  for (const r of remaining) { perClass[r.cls] += 1; perTier[r.tier] = (perTier[r.tier] || 0) + 1; }
  const confirmedSite = (list) => list.filter((r) => r.siteOwned && r.tier === 'confirmed');
  const unexplained = remaining.filter((r) => !REASON_CLASSES.includes(r.cls)).length;
  const status = incomplete.length ? 'incomplete' : 'complete';
  // An explained finding is still a remaining finding: the claim needs an empty list and a final scan of the final state that found nothing.
  const zeroRemainingClaim = status === 'complete' && unexplained === 0 && remaining.length === 0 && notRescanned.length === 0 && finalScan?.proved === true && scanDelta?.after === 0;
  return {
    status, incompleteReasons: incomplete,
    zeroRemainingClaim,
    statement: 'Zero remaining is claimed only when no finding remains and the final scan of the final state found none. Findings in an explained class still remain. Needs-review findings are never counted as fixed or clean. An incomplete run (truncated snapshot, failed rescan, missing gate input) claims nothing.',
    source: finalFindings ? 'final-rescan' : 'report',
    totals: { findings: finalFindings ? remaining.length + fixed.length : universe.length, fixed: fixed.length, remaining: remaining.length, unexplained, ...(finalFindings ? { baselineRescan: (baselineFindings || []).length, finalRescan: finalFindings.length, notRescanned: notRescanned.length } : {}) },
    ...(finalFindings ? { acceptedTasks: results.filter((r) => r.outcome === 'accepted').length, fixedByAcceptedTask: fixed.filter((r) => r.viaTask).length, fixedAsSideEffect: fixed.filter((r) => !r.viaTask).length, duplicates } : {}),
    confirmedSiteOwned: { fixed: confirmedSite(fixed).length, remaining: confirmedSite(remaining).length },
    perClass, perTier,
    needsReviewOpen: remaining.filter((r) => r.tier === 'needs-review').length,
    notActionable: notActionable.map((n) => ({ rule: n.rule, ownership: n.ownership, pages: n.pages, findings: n.findings })),
    scanDelta, fixed, remaining, ...(finalFindings ? { notRescanned } : {}),
    ...(queuedEdits.length ? { queuedEdits: queuedEdits.map((q) => ({ taskId: q.taskId, rule: q.rule, file: q.file, line: q.line ?? null, files: q.files || [], routes: q.routes || [], review: q.review || null })).sort((a, b) => `${a.file}:${a.line}:${a.taskId}`.localeCompare(`${b.file}:${b.line}:${b.taskId}`)), workingTree } : {}),
  };
}

export function renderRemainingMarkdown(r) {
  const L = ['# Remaining report', '', `Status: ${r.status}${r.incompleteReasons.length ? ` (${r.incompleteReasons.join('; ')})` : ''}`, `Zero remaining claimed: ${r.zeroRemainingClaim ? 'yes' : 'no'}`, '', r.statement, ''];
  const rows = r.source === 'final-rescan' && r.totals.baselineRescan !== r.totals.findings ? ` (${r.totals.baselineRescan} baseline rescan row(s); ${r.duplicates?.length || 0} merged as the same defect, the rest share an id)` : '';
  L.push(`Findings: ${r.totals.findings} distinct defect(s)${rows}; fixed ${r.totals.fixed}; remaining ${r.totals.remaining}; unexplained ${r.totals.unexplained}.`);
  if (r.source === 'final-rescan') L.push(`Counted from the harness rescan of the shadow (baseline ${r.totals.baselineRescan}, final ${r.totals.finalRescan}), not from the original report. ${r.totals.notRescanned} report finding(s) were not seen by the rescan (a layer the rescan does not run, or a route it did not reproduce) and are listed under "Not seen by the rescan": they are neither fixed nor proved remaining.`);
  if (r.source === 'final-rescan') L.push(`Reconciliation: ${r.acceptedTasks} accepted task(s); ${r.totals.fixed} distinct defect(s) fixed (${r.fixedByAcceptedTask} in an accepted task's scope, ${r.fixedAsSideEffect} as a side effect no accepted task targeted)${r.duplicates.length ? `; ${r.duplicates.length} row(s) merged because another layer reports the same defect` : ''}. The scan delta counts rescan ids, so it can be higher.`);
  L.push(`Confirmed site-owned: fixed ${r.confirmedSiteOwned.fixed}, remaining ${r.confirmedSiteOwned.remaining}. Needs-review findings still open: ${r.needsReviewOpen}.`, '');
  L.push('| Reason class | Count |', '| --- | --- |', ...REASON_CLASSES.map((c) => `| ${c} | ${r.perClass[c]} |`), '');
  L.push('| Tier | Remaining |', '| --- | --- |', ...Object.entries(r.perTier).sort().map(([t, n]) => `| ${t} | ${n} |`), '');
  for (const c of REASON_CLASSES) {
    const rows = r.remaining.filter((x) => x.cls === c);
    if (!rows.length) continue;
    L.push(`## ${c}`, '', ...rows.map((x) => `- ${x.rule} on ${x.route} \`${x.selector || ''}\` (${x.tier}${x.siteOwned ? '' : ', not site-owned'}): ${x.detail}${x.gates ? ` [${x.gates.join(',')}]` : ''}`), '');
  }
  if (r.queuedEdits?.length) L.push(`## Queued edits: all gates passed, a person decides (${r.queuedEdits.length})`, '', ...r.queuedEdits.map((q) => `- ${q.rule} ${q.file}${q.line > 0 ? `:${q.line}` : ''}${q.files.length > 1 ? ` (and ${q.files.length - 1} more file(s))` : ''}, task ${q.taskId}: ${r.workingTree ? 'the edit is in your working tree and stays there; the shadow rolled it back, so the finding still counts as remaining until you keep it and rescan' : 'registered for the review workbench'}${q.review && q.review.registered === false ? ` (not registered for review: ${q.review.reason || 'unknown'})` : ''}`), '');
  if (r.duplicates?.length) L.push('## Same defect reported twice (counted once)', '', ...r.duplicates.map((x) => `- ${x.rule} on ${x.route} \`${x.selector || ''}\`: same defect as ${x.duplicateOf}`), '');
  if (r.notRescanned?.length) L.push('## Not seen by the rescan', '', ...r.notRescanned.map((x) => `- ${x.rule} on ${x.route} \`${x.selector || ''}\` (${x.tier}): ${x.layers?.length ? `reported only by the ${x.layers.join(', ')} layer, which the harness rescan does not run (it runs ${HARNESS_LAYERS})` : 'its layer ran but the rescan did not reproduce it on this route'}`), '');
  return `${L.join('\n')}\n`;
}

export function writeRemainingReport(r, dir) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'remaining.json'), `${JSON.stringify(r, null, 2)}\n`);
  writeFileSync(join(dir, 'remaining.md'), renderRemainingMarkdown(r));
  return { json: join(dir, 'remaining.json'), markdown: join(dir, 'remaining.md') };
}
