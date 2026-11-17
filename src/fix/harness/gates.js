// Gate runner: G1..G8 and the accept policy (docs/fix-harness.md sections 4 and 5). Functions only; no I/O except reading trees and screenshots.
import { compareLayout, compareStyles, compareVisual, compareBehaviour, comparePerf } from './compare.js';
import { compareTrees, readTree } from './tokens.js';

export const GATE_IDS = Object.freeze(['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8']);
const notProvided = (gate, what) => ({ gate, pass: false, evidence: [{ kind: 'NOT_PROVIDED', what }], regions: [] });

const BEHAVIOUR_RULE = /^(?:focus-lost|menu-links-unreachable|keyboard-trap|focus-)/i;

/** G1: target findings gone on affected routes; no new confirmed / needs-review finding (by stable id and root-cause key). */
export function evaluateTargeted({ targetFindingIds = [], affectedRoutes = [], before = [], after = [], gatedTiers = ['confirmed', 'needs-review'] }) {
  if (!targetFindingIds.length) return notProvided('G1', 'targetFindingIds (an empty target list never passes)');
  const onRoute = (f) => !affectedRoutes.length || affectedRoutes.includes(f.route);
  const targetIds = new Set(targetFindingIds);
  const targetKeys = new Set(before.filter((f) => targetIds.has(f.id)).map((f) => f.rootCauseKey).filter(Boolean));
  const beforeIds = new Set(before.map((f) => f.id));
  const beforeKeys = new Set(before.map((f) => f.rootCauseKey).filter(Boolean));
  const evidence = [];
  for (const f of after) if (onRoute(f) && (targetIds.has(f.id) || (f.rootCauseKey && targetKeys.has(f.rootCauseKey)))) evidence.push({ kind: 'TARGET_REMAINS', id: f.id, route: f.route, rule: f.native || f.rule, selector: f.selector });
  for (const f of after) if ((gatedTiers.includes(f.tier) || f.untraced) && !beforeIds.has(f.id) && !(f.rootCauseKey && beforeKeys.has(f.rootCauseKey))) evidence.push({ kind: 'NEW_FINDING', id: f.id, tier: f.tier, route: f.route, rule: f.native || f.rule, selector: f.selector, ...(BEHAVIOUR_RULE.test(f.native || f.rule || '') ? { note: 'a keyboard/focus behaviour finding the edit may have unmasked (the scan skips controls inside aria-hidden): check the same control on the unedited page before blaming the edit' } : {}) });
  // New findings of an ungated tier (likely: heading-order after an h1 retag) do not fail the gate but are reported, so a person sees what an edit introduced.
  const warnings = after.filter((f) => !gatedTiers.includes(f.tier) && !f.untraced && f.tier !== 'info' && f.tier && !beforeIds.has(f.id) && !(f.rootCauseKey && beforeKeys.has(f.rootCauseKey)))
    .map((f) => ({ kind: 'NEW_FINDING_WARNING', id: f.id, tier: f.tier, route: f.route, rule: f.native || f.rule, selector: f.selector }));
  return { gate: 'G1', pass: evidence.length === 0, evidence, regions: [], ...(warnings.length ? { warnings } : {}) };
}

// ---- line diff (prefix/suffix trim + LCS for the middle; one big hunk when the middle is too large: fails closed against the allowlist) ----

/** @returns {{aStart:number,aEnd:number,bStart:number,bEnd:number}[]} 1-based inclusive; aEnd = aStart - 1 for a pure insertion. */
export function diffLines(aText, bText) {
  const a = aText.split('\n'), b = bText.split('\n');
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const n = a.length - p - s, m = b.length - p - s;
  if (n === 0 && m === 0) return [];
  if (n * m > 4e6) return [{ aStart: p + 1, aEnd: p + n, bStart: p + 1, bEnd: p + m }];
  const w = m + 1;
  const dp = new Uint16Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i * w + j] = a[p + i] === b[p + j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
  const hunks = [];
  let i = 0, j = 0, cur = null;
  const close = () => { if (cur) { hunks.push(cur); cur = null; } };
  while (i < n || j < m) {
    if (i < n && j < m && a[p + i] === b[p + j]) { close(); i++; j++; continue; }
    cur ||= { aStart: p + i + 1, aEnd: p + i, bStart: p + j + 1, bEnd: p + j };
    if (j >= m || (i < n && dp[(i + 1) * w + j] >= dp[i * w + j + 1])) { cur.aEnd = p + i + 1; i++; } else { cur.bEnd = p + j + 1; j++; }
  }
  close();
  return hunks;
}

const FORBIDDEN = [[/^(?:dist|build)\//, 'BUILD_OUTPUT'], [/(?:^|\/)paradox-export[^/]*\.json$/i, 'EXPORT_JSON'], [/^JSON_for_[^/]*\//, 'EXPORT_JSON']];

const hunkAllowed = (h, entries) => entries.some((e) => (e.startLine == null && e.endLine == null) || (h.aStart >= e.startLine && h.aEnd <= e.endLine));

/**
 * G2 scope. allowlist: [{ file, startLine?, endLine? }] (before-tree line numbers; no lines = whole file, required to create or delete a file).
 * designLock: no change in the colour / design-token multiset. Backend tags and data-pdk-* attributes may never change.
 */
export function evaluateScope({ beforeTree, afterTree, allowlist = [], designLock = true }) {
  const toMap = (t) => (typeof t === 'string' ? readTree(t) : t);
  const [b, a] = [toMap(beforeTree), toMap(afterTree)];
  const evidence = [];
  const changed = [];
  for (const file of new Set([...b.keys(), ...a.keys()])) {
    const bb = b.get(file), ab = a.get(file);
    if (bb && ab && bb.equals(ab)) continue;
    changed.push(file);
    const forbidden = FORBIDDEN.find(([re]) => re.test(file));
    if (forbidden) { evidence.push({ kind: forbidden[1], file }); continue; }
    const entries = allowlist.filter((e) => e.file === file);
    if (!entries.length) { evidence.push({ kind: 'FILE_NOT_ALLOWLISTED', file }); continue; }
    if (!bb || !ab) { if (!entries.some((e) => e.startLine == null && e.endLine == null)) evidence.push({ kind: 'FILE_CREATED_OR_DELETED', file }); continue; }
    for (const h of diffLines(bb.toString('utf8'), ab.toString('utf8'))) if (!hunkAllowed(h, entries)) evidence.push({ kind: 'LINES_NOT_ALLOWLISTED', file, hunk: h });
    if (file.endsWith('.json')) { try { JSON.parse(ab.toString('utf8')); } catch { evidence.push({ kind: 'INVALID_JSON', file }); } }
  }
  const t = compareTrees(b, a);
  for (const x of t.backend.removed) evidence.push({ kind: 'BACKEND_TOKEN_REMOVED_OR_EDITED', token: x });
  for (const x of t.backend.added) evidence.push({ kind: 'BACKEND_TOKEN_ADDED_OR_EDITED', token: x });
  if (designLock) {
    for (const x of t.design.removed) evidence.push({ kind: 'DESIGN_TOKEN_REMOVED_OR_EDITED', token: x });
    for (const x of t.design.added) evidence.push({ kind: 'DESIGN_TOKEN_ADDED_OR_EDITED', token: x });
  }
  return { gate: 'G2', pass: evidence.length === 0, evidence, regions: [], changedFiles: changed.sort() };
}

/** G8 from already-measured facts (build, html-validate error counts, export validity, formatter). Any missing fact fails closed. */
export function evaluateBuildValidity({ build, htmlValidate, exportValid, formatterClean } = {}) {
  const evidence = [];
  if (!build) evidence.push({ kind: 'NOT_PROVIDED', what: 'build' }); else if (!build.ok) evidence.push({ kind: 'BUILD_FAILED', exitCode: build.exitCode ?? null });
  if (!htmlValidate) evidence.push({ kind: 'NOT_PROVIDED', what: 'htmlValidate' }); else if (htmlValidate.after > htmlValidate.before) evidence.push({ kind: 'HTML_VALIDATE_ERRORS_INCREASED', before: htmlValidate.before, after: htmlValidate.after });
  if (exportValid == null) evidence.push({ kind: 'NOT_PROVIDED', what: 'exportValid' }); else if (!exportValid) evidence.push({ kind: 'EXPORT_INVALID' });
  if (formatterClean == null) evidence.push({ kind: 'NOT_PROVIDED', what: 'formatterClean' }); else if (!formatterClean) evidence.push({ kind: 'FORMATTER_DIRTY' });
  return { gate: 'G8', pass: evidence.length === 0, evidence, regions: [] };
}

/**
 * Runs the selected gates. input: { before, after (snapshots), beforeTree, afterTree, allowlist, designLock, targets, documented,
 * findings: {targetFindingIds, affectedRoutes, before, after}, build: {...evaluateBuildValidity input}, perf: opts for comparePerf, only: ['G3', ...] }.
 * A gate whose input is missing fails closed (NOT_PROVIDED).
 */
export function runGates(input) {
  const only = input.only || GATE_IDS;
  const snaps = input.before && input.after;
  const o = { targets: input.targets || [], documented: input.documented || [], ...(input.compare || {}) };
  const run = {
    G1: () => (input.findings ? evaluateTargeted(input.findings) : notProvided('G1', 'findings')),
    G2: () => (input.beforeTree && input.afterTree ? evaluateScope({ beforeTree: input.beforeTree, afterTree: input.afterTree, allowlist: input.allowlist, designLock: input.designLock ?? true }) : notProvided('G2', 'beforeTree/afterTree')),
    G3: () => (snaps ? compareLayout(input.before, input.after, o) : notProvided('G3', 'snapshots')),
    G4: () => (snaps ? compareVisual(input.before, input.after, o) : notProvided('G4', 'snapshots')),
    G5: () => (snaps ? compareStyles(input.before, input.after, o) : notProvided('G5', 'snapshots')),
    G6: () => (snaps ? compareBehaviour(input.before, input.after, o) : notProvided('G6', 'snapshots')),
    G7: () => (snaps ? comparePerf(input.before, input.after, input.perf) : notProvided('G7', 'snapshots')),
    G8: () => evaluateBuildValidity(input.build),
  };
  const gates = GATE_IDS.filter((g) => only.includes(g)).map((g) => run[g]());
  return { pass: gates.every((g) => g.pass), failed: gates.filter((g) => !g.pass).map((g) => g.gate), gates, table: gates.map((g) => ({ gate: g.gate, pass: g.pass, issues: g.evidence.length })) };
}

/** Heuristic risk 0..1 from the change footprint; low is <= 0.3. */
export function riskScore({ changedLines = 0, files = [] }) {
  let r = Math.min(1, changedLines / 50);
  if (files.some((f) => /\.m?js$/.test(f))) r += 0.3;
  if (files.some((f) => /\.css$/.test(f))) r += 0.2;
  if (new Set(files).size > 1) r += 0.2;
  if (files.some((f) => /(?:^|\/)(?:partials|layouts)\//.test(f))) r += 0.2;
  return Math.min(1, Math.round(r * 100) / 100);
}

/**
 * Accept policy. Any failed gate: rollback (retry while iteration < maxIterations, else final). All pass: auto_accept only for a
 * mechanically-safe recipe or a small, low-risk diff; everything else goes to human review.
 */
export function decideAcceptance({ gateResult, mechanicallySafe = false, changedLines = 0, files = [], iteration = 1, maxIterations = 3, maxAutoLines = 10, maxAutoRisk = 0.3 }) {
  if (!gateResult.pass) return { decision: 'rollback', retry: iteration < maxIterations, reason: `gates failed: ${gateResult.failed.join(',')}` };
  const risk = riskScore({ changedLines, files });
  if (mechanicallySafe) return { decision: 'auto_accept', reason: 'mechanically safe recipe, all gates passed', risk };
  if (changedLines < maxAutoLines && risk <= maxAutoRisk) return { decision: 'auto_accept', reason: 'small low-risk diff, all gates passed', risk };
  return { decision: 'human_review', reason: 'all gates passed; not mechanically safe and not small and low risk', risk };
}
