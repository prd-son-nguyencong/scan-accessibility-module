// View model for the HTML report: one normalised shape for ScanReportV2 (preferred) and the legacy projection (older callers, older latest.json).
// Pure data in, plain objects out. No HTML here (render.js) and no browser code (client.js).
import { classifyOrigin, suggestedAction } from '../../tracer/ownership.js';
import { ownerBadge, groupNotYourCode } from '../origin-display.js';
import { WCAG_CRITERIA } from '../../utils/wcag-criteria.js';
import { runStatusLabel, w3cEngineNote } from '../wording.js';

export const IMPACTS = ['critical', 'serious', 'moderate', 'minor', 'info'];
export const IMPACT_RANK = Object.fromEntries(IMPACTS.map((k, i) => [k, IMPACTS.length - i]));
export const VERDICT_TEXT = {
  confirmed: ['Confirmed', 'A machine measured it. A person does not need to decide whether it is a defect.'],
  likely: ['Likely', 'A heuristic rule that guesses intent. Probably a defect; does not fail the gate.'],
  'needs-review': ['Needs review', 'Cannot be decided automatically. A person has to look.'],
};
/** Owner keys in filter order, with the plain words used in the UI. */
export const OWNERS = [
  ['site', 'Site code'],
  ['injected', 'Injected at runtime'],
  ['unbound', 'Platform data not bound'],
  ['unknown', 'Origin unknown'],
  ['third-party', 'Third party'],
  ['platform', 'Platform'],
  ['iframe', 'iframe'],
];
const OWNER_TEXT = Object.fromEntries(OWNERS);
export const NOT_YOURS = new Set(['third-party', 'platform', 'iframe']);

const SOURCE_METHODS = {
  'instrumentation-manifest': 'exact: build instrumentation marked this element',
  'source-attribute-search': 'searched the templates for this element\'s attributes',
  'source-hint-search': 'searched the templates for this element\'s id, class or text',
  'source-href-search': 'searched the templates for this tag and link',
  'liquid-tag-index': 'matched through the Liquid tag index',
  'liquid-render-call': 'followed the partial render call',
  'page-level-anchor': 'page-level check, anchored to the page template',
  'css-rule-candidate': 'matching CSS rule',
  'legacy-source-attribution': 'legacy attribution',
  'url-fallback': 'only the page is known',
  unresolved: 'not found in the project source',
  'third-party': 'not site code',
};

export const bucketOf = (f) => (NOT_YOURS.has(f.o) ? 'theirs' : (f.v === 'needs-review' || !['site', 'injected'].includes(f.o) ? 'review' : 'fix'));
const clip = (s, n) => { const t = String(s ?? ''); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
/** Cut at a word boundary, never mid-word. */
const clipWords = (s, n) => { const t = String(s ?? ''); return t.length <= n ? t : `${t.slice(0, n).replace(/\s+\S*$/, '')}…`; };
const firstSentence = (s, n = 220) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); const m = /^(.+?[.!?])(\s|$)/.exec(t); return clipWords(m ? m[1] : t, n); };
/** Five lines around the flagged one (the scanner marks it with ">"), enough to recognise the place without shipping whole files. */
const around = (snippet) => {
  const lines = String(snippet || '').split('\n');
  const at = lines.findIndex((l) => l.startsWith('>'));
  const part = at < 0 ? lines.slice(0, 5) : lines.slice(Math.max(0, at - 2), at + 3);
  return clip(part.join('\n'), 420);
};
const idOf = (f) => String(f.stableId || f.findingId || f.id || '').replace(/^sha256:/, '').slice(0, 10);

/** Owner as the report shows it: filter key, label, and why. */
export function ownerOf(origin) {
  const b = ownerBadge(origin);
  let key = b.key;
  if (origin?.kind === 'unbound-data') key = 'unbound';
  else if (origin?.kind === 'unknown-probe-failed') key = 'unknown';
  let label = OWNER_TEXT[key] || b.text;
  if (key === 'third-party') label = `Third party: ${origin.vendor || origin.label}`;
  if (key === 'platform') label = b.text;
  return { key, label };
}

function wcagOf(f) {
  const cap = (f.evidence?.observations || []).map((o) => o.evidence?.capture?.wcag).find(Boolean) || f.evidence?.capture?.wcag;
  const m = /(\d\.\d\.\d{1,2})/.exec(cap?.criterion || '') || /(\d\.\d\.\d{1,2})/.exec(f.wcagRef || '');
  if (!m) return { ref: f.wcagRef || '', id: '', title: '' };
  const row = WCAG_CRITERIA.find((c) => c.id === m[1]);
  return { ref: f.wcagRef || '', id: m[1], title: row?.title || '', url: cap?.url && /^https:\/\/www\.w3\.org\/WAI\/WCAG22\/Understanding\/[a-z0-9-]+\.html$/.test(cap.url) ? cap.url : '' };
}

/** Every finding of a report as one flat list in V2 field names; legacy violations are renamed. */
function flatFindings(report) {
  const out = [];
  for (const p of report.pages || []) {
    const route = p.route || p.url || p.name || p.page || '';
    for (const f of p.findings || p.violations || []) {
      out.push(p.findings ? { ...f, route: f.route || route } : { ...f, findingId: f.id, nativeRuleId: f.ruleId, route: f.route || route, source: { ...f.source } });
    }
  }
  return out;
}

const EVIDENCE_FILE = /^evidence\/[a-f0-9]{64}\.png$/;

function compactFinding(f, pageIndex, k) {
  const obs = f.evidence?.observations || [];
  const origin = f.origin || classifyOrigin({ ruleId: f.nativeRuleId, outerHTML: f.element?.outerHTML, selector: f.element?.selector, ownership: f.ownership, platformOwned: f.platformOwned });
  const own = ownerOf(origin);
  const cap = f.evidence?.capture || obs.map((o) => o.evidence?.capture).find(Boolean) || null;
  const w = wcagOf(f);
  const proofs = [];
  for (const p of [f.evidence?.proof, ...obs.map((o) => o.evidence?.proof)]) {
    if (p?.fact && !proofs.some((q) => q.fact === p.fact)) proofs.push({ t: p.type, fact: clip(p.fact, 900) });
  }
  const selectors = [...new Set(obs.map((o) => o.element?.selector).filter(Boolean))].filter((s) => s !== f.element?.selector);
  const s = f.source || {};
  const file = s.file || '';
  const rule = f.nativeRuleId || f.canonicalRuleId || '';
  const fileKey = file ? `${file}:${s.line || ''}` : '';
  const out = {
    k, id: idOf(f), r: rule, i: f.impact || 'minor', v: f.verdict || 'confirmed', o: own.key, ol: own.label,
    L: f.layer, n: f.count > 0 ? f.count : 1, p: pageIndex.get(f.route) ?? 0,
    w: w.id, wt: w.title, h: clip(f.fix?.hint || '', 500),
    y: firstSentence(cap?.reason || f.fix?.hint || f.evidence?.message || ''),
    rk: f.sharedSource?.id || (fileKey ? `${f.canonicalRuleId || rule}|${fileKey}` : (own.key !== 'site' && origin?.vendor ? `${origin.vendor}|${rule}` : `f:${idOf(f)}`)),
  };
  if (f.canonicalRuleId && f.canonicalRuleId !== rule) out.cr = f.canonicalRuleId;
  if (f.layers?.length) out.Ls = f.layers;
  if (f.enginesAgreeing?.length) { out.E = f.enginesAgreeing; out.ag = f.agreement; }
  if (w.ref) out.wr = w.ref;
  if (w.url) out.wu = w.url;
  const pg = (f.pages || []).map((r) => pageIndex.get(r)).filter((x) => x !== undefined && x !== out.p);
  if (pg.length) out.pg = pg;
  if (origin?.evidence?.length) out.oe = origin.evidence.slice(0, 4).map((e) => clip(e, 240));
  if (own.key !== 'site') out.oa = own.key === 'third-party' || own.key === 'platform' ? suggestedAction(origin) : '';
  if (origin?.kind) out.ok = origin.kind;
  if (file || s.method) {
    out.s = { f: file, l: s.line || 0, m: s.method || '', c: s.confidence || '', tr: s.traceReason || '', sn: around(s.snippet) };
    if (s.templateSource) out.s.ts = typeof s.templateSource === 'string' ? s.templateSource : `${s.templateSource.file || ''}:${s.templateSource.line || ''}`;
    if (s.dataFile) { out.s.df = s.dataFile; out.s.dl = s.dataLine || 0; }
    if (s.dataAmbiguous) out.s.da = 1;
  }
  if (f.sourceCandidates?.length) out.sc = f.sourceCandidates.slice(0, 6).map((c) => ({ f: c.file, l: c.line || 0, c: c.confidence || '', m: c.method || '' }));
  if (f.element?.selector) out.sel = f.element.selector;
  if (f.element?.outerHTML) out.html = clip(f.element.outerHTML, 600);
  if (selectors.length) out.xs = selectors.slice(0, 25);
  if (selectors.length > 25) out.xm = selectors.length - 25;
  const msg = f.evidence?.message || obs.find((o) => o.message)?.message || '';
  if (msg && msg !== f.fix?.hint) out.m = clip(msg, 500);
  if (proofs.length) out.pr = proofs.slice(0, 4);
  if (cap) {
    const c = { };
    if (cap.reason) c.re = clip(cap.reason, 400);
    if (cap.ax) c.ax = `${cap.ax.role || 'no role'}: ${cap.ax.ignored ? '(ignored in the accessibility tree)' : `"${clip(cap.ax.name, 120)}"`}`;
    const b = cap.geometry?.box;
    if (b && (b.width || b.height)) c.sz = `${b.width} x ${b.height} px`;
    if (cap.repro?.viewport) c.vp = `${cap.repro.viewport.width}x${cap.repro.viewport.height}`;
    if (cap.screenshot?.file && EVIDENCE_FILE.test(cap.screenshot.file)) c.shot = [cap.screenshot.file, Number(cap.screenshot.width) || 640, Number(cap.screenshot.height) || 400];
    if (Object.keys(c).length) out.cp = c;
  }
  if (f.fix?.deterministic) out.det = 1;
  if (f.link?.url) out.lk = { u: f.link.url, st: f.link.status ?? '', rs: f.link.reason || '' };
  if (f.manualChecks?.length) out.mc = f.manualChecks.slice(0, 4).map((m) => clip(typeof m === 'string' ? m : (m.title || m.text || m.id || JSON.stringify(m)), 240));
  if (f.demotion) out.dm = clip(typeof f.demotion === 'string' ? f.demotion : (f.demotion.reason || 'demoted to needs-review by label precision'), 200);
  if (f.sharedSource) out.ss = [f.sharedSource.findings, f.sharedSource.pages];
  return out;
}

const metricsOf = (data) => Object.entries(data?.metrics || {}).map(([k, m]) => ({ k, label: m.label || k, v: m.displayValue ?? '', rating: m.rating || '' }));

function lighthouseOf(report) {
  const map = {};
  const take = (name, d) => { if (name && d) map[name] = d; };
  for (const [name, d] of Object.entries(report.lighthouse || {})) take(name, d);
  if (!Object.keys(map).length) for (const p of report.pages || []) for (const [name, d] of Object.entries(p.artifacts?.lighthouseScores || p.lighthouseScores || {})) take(name, d);
  const out = {};
  for (const [name, d] of Object.entries(map)) {
    const side = (x) => (x ? { scores: x.scores || {}, metrics: metricsOf(x), device: x.device || '', vp: x.viewport ? `${x.viewport.width}x${x.viewport.height}` : '', runs: x.runs?.length || 0, warn: (x.runWarnings || []).slice(0, 3).map((w) => clip(typeof w === 'string' ? w : JSON.stringify(w), 200)) } : null);
    out[name] = { mobile: side(d.lighthouse?.mobile), desktop: side(d.lighthouse?.desktop), source: d.provenance?.actualSource || d.source || 'local', fallback: d.provenance?.fallbackReason?.code || '' };
  }
  return out;
}

function flatKv(obj, prefix = '', depth = 0, out = []) {
  for (const [k, v] of Object.entries(obj || {})) {
    if (v === null || v === undefined || v === '') continue;
    if (Array.isArray(v)) { if (v.length && v.every((x) => typeof x !== 'object')) out.push([prefix + k, v.join(', ')]); continue; }
    if (typeof v === 'object') { if (depth < 1) flatKv(v, `${prefix}${k}.`, depth + 1, out); continue; }
    out.push([prefix + k, String(v)]);
  }
  return out;
}

function partialReasons(page, runs) {
  if (page.partialReasons?.length) return page.partialReasons.map((r) => ({ layer: r.layer, reason: r.reason, gating: r.gating !== false }));
  return runs.filter((r) => ['error', 'timeout', 'skipped'].includes(r.status) && !(r.status === 'skipped' && r.evidence?.errorCode === 'external-disabled')).map((r) => ({ layer: r.layer, reason: r.status, gating: true }));
}

/** Scanner and vendor text sometimes carries em or en dashes; the report shows a plain hyphen instead. */
const plainDashes = (x) => {
  if (typeof x === 'string') return x.replace(/\s*[\u2013\u2014]\s*/g, ' - ');
  if (Array.isArray(x)) return x.map(plainDashes);
  if (x && typeof x === 'object') { const o = {}; for (const k of Object.keys(x)) o[k] = plainDashes(x[k]); return o; }
  return x;
};

export function buildModel(input) {
  return plainDashes(buildModelRaw(input));
}

function buildModelRaw(input) {
  const v2 = input.v2 || (input.schemaVersion === '2.0.0' ? input : null);
  const report = v2 || input;
  const rm = report.runMetadata || {};
  const pagesIn = report.pages || [];
  const pageIndex = new Map();
  pagesIn.forEach((p, i) => pageIndex.set(p.route || p.url || p.name || p.page || '', i));
  const flat = flatFindings(report);
  const lighthouse = lighthouseOf(input.lighthouse ? input : report);
  const runsOf = (p) => (v2 ? (report.scanners || []).filter((r) => (p.scannerRunIds || []).includes(r.runId)) : (p.scannerRuns || []));
  const findings = flat.map((f, k) => compactFinding(f, pageIndex, k));
  const counted = findings.filter((f) => f.i !== 'info');
  const occ = (list) => list.reduce((n, f) => n + f.n, 0);
  const bucket = bucketOf;
  const buckets = { fix: [], review: [], theirs: [] };
  for (const f of counted) buckets[bucket(f)].push(f);

  const pages = pagesIn.map((p, i) => {
    const mine = counted.filter((f) => f.p === i);
    const lh = lighthouse[p.name] || lighthouse[p.page] || null;
    const runs = runsOf(p);
    return {
      i, route: p.route || p.url || p.name || p.page || '', url: p.url || '', name: p.name || p.page || '', status: p.status || 'ok',
      reason: p.failure ? (p.failure.message || p.failure.reason || '') : (p.skipped ? `${p.skipped.reason || 'skipped'}${p.skipped.note ? `: ${p.skipped.note}` : ''}` : ''),
      partial: p.status === 'partial' ? partialReasons(p, runs) : [],
      fix: occ(mine.filter((f) => bucket(f) === 'fix')), review: occ(mine.filter((f) => bucket(f) === 'review')), theirs: occ(mine.filter((f) => bucket(f) === 'theirs')),
      findings: mine.length, lh,
    };
  });

  const gate = rm.thresholds || input.thresholds || null;
  const gateFails = gate ? (gate.pages || []).flatMap((p) => (p.metrics || []).filter((m) => m.status === 'fail').map((m) => ({ page: p.name || p.url, id: m.id, actual: m.actual, target: m.target, reason: m.reason || '' }))) : [];
  const excluded = gate ? (gate.pages || []).reduce((n, p) => n + (p.excluded || 0), 0) : 0;

  // Root causes: findings that share a source line (or a vendor + rule) are one thing to fix.
  const rc = new Map();
  for (const f of counted) {
    const g = rc.get(f.rk) || { rk: f.rk, ks: [], occ: 0, impact: 'info', rule: f.r, rules: new Set(), pages: new Set(), bucket: bucket(f), src: f.s?.f ? `${f.s.f}${f.s.l ? `:${f.s.l}` : ''}` : '', y: f.y, owner: f.o };
    g.ks.push(f.k); g.occ += f.n; g.rules.add(f.r); g.pages.add(f.p);
    if (IMPACT_RANK[f.i] > IMPACT_RANK[g.impact]) { g.impact = f.i; g.rule = f.r; g.y = f.y; }
    rc.set(f.rk, g);
  }
  const causes = [...rc.values()].map((g) => ({ ...g, rules: [...g.rules], pages: [...g.pages] }));
  // Root-cause key as a small number for the client; findings outside any cause (info) get a unique negative one.
  const ridx = new Map(causes.map((g, i) => [g.rk, i]));
  for (const f of findings) f.rk = ridx.has(f.rk) ? ridx.get(f.rk) : -1 - f.k;
  const rank = (a, b) => IMPACT_RANK[b.impact] - IMPACT_RANK[a.impact] || b.occ - a.occ || a.rule.localeCompare(b.rule);
  const fixFirst = causes.filter((g) => g.bucket === 'fix').sort(rank).slice(0, 5);
  const reviewFirst = fixFirst.length ? [] : causes.filter((g) => g.bucket === 'review').sort(rank).slice(0, 5);

  const nyc = groupNotYourCode(counted.filter((f) => NOT_YOURS.has(f.o)).map((f) => ({
    origin: flat[f.k].origin || classifyOrigin({ ruleId: f.r, outerHTML: flat[f.k].element?.outerHTML, selector: flat[f.k].element?.selector }), rule: f.r, page: pages[f.p]?.route || '', count: f.n, impact: f.i,
  })));

  // Dead links: one row per target, with the pages that carry it.
  const linkMap = new Map();
  for (const f of findings.filter((x) => x.lk)) {
    const g = linkMap.get(f.lk.u) || { u: f.lk.u, st: f.lk.st, rs: f.lk.rs, v: f.v, pages: new Set(), where: new Set(), chain: '', ks: [] };
    g.pages.add(f.p); g.ks.push(f.k);
    if (f.s?.f) g.where.add(`${f.s.f}${f.s.l ? `:${f.s.l}` : ''}`);
    const chain = f.pr?.find((p) => p.t === 'http-status')?.fact;
    if (chain && !g.chain) g.chain = chain;
    linkMap.set(f.lk.u, g);
  }
  const links = [...linkMap.values()].map((g) => ({ ...g, pages: [...g.pages].map((i) => pages[i]?.route), where: [...g.where] })).sort((a, b) => b.pages.length - a.pages.length);

  const scanner = (report.scanners || []).length ? report.scanners : pagesIn.flatMap((p) => p.scannerRuns || []);
  const engines = new Map();
  for (const r of scanner) {
    const key = `${r.layer}|${r.engine?.name || ''}|${r.engine?.version || ''}`;
    const e = engines.get(key) || { layer: r.layer, name: r.engine?.name || r.layer, version: r.engine?.version || '', complete: 0, other: {} };
    if (r.status === 'complete' || r.status === 'fallback') { e.complete++; const lbl = runStatusLabel(r); if (lbl !== r.status) e.note = lbl.slice(r.status.length).trim(); } else e.other[r.status] = (e.other[r.status] || 0) + 1;
    engines.set(key, e);
  }
  const durations = (rm.scan?.pages || []).map((p) => p.durationMs).filter(Number.isFinite);
  const target = report.target || {};
  const comparison = input.comparison || report.comparison || null;
  const verdictN = (v) => occ(counted.filter((f) => f.v === v));
  return {
    meta: {
      url: target.url || pagesIn[0]?.url || '', mode: target.mode || '', revision: target.buildRevision || '', generatedAt: report.generatedAt || report.timestamp || '',
      tool: report.producer ? `${report.producer.name} ${report.producer.version}` : '', node: report.producer?.nodeVersion || '', reportId: report.reportId || '',
      concurrency: rm.scan?.concurrency || 0, workMs: durations.reduce((a, b) => a + b, 0), wallMs: rm.durationMs || 0, profiles: rm.profiles || [], accessScan: rm.accessScan ? { profile: rm.accessScan.profile, comparator: rm.accessScan.comparatorVersion, thirdParty: rm.accessScan.includeThirdParty === true } : null,
      kv: flatKv({ htmlSource: rm.htmlSource, tracing: rm.tracing, sourceTracing: rm.sourceTracing, ...(rm.extra || {}) }),
      discoveryPartial: rm.discovery?.partial === true, discoveryWarnings: rm.discovery?.warnings || [], dropped: rm.discovery?.droppedRoutes || input.droppedRoutes || [],
      allowIncomplete: rm.allowIncomplete === true || input.allowIncomplete === true, warnings: report.warnings || [],
    },
    gate: gate ? { failed: gate.failed === true, fails: gateFails, excluded, notices: gate.notices || [], pages: gate.pages || [] } : null,
    counts: {
      fix: occ(buckets.fix), review: occ(buckets.review), theirs: occ(buckets.theirs), total: occ(counted), findings: counted.length, info: findings.length - counted.length,
      confirmed: verdictN('confirmed'), likely: verdictN('likely'), needsReview: verdictN('needs-review'),
      confirmedSite: occ(counted.filter((f) => f.v === 'confirmed' && ['site', 'injected'].includes(f.o))), roots: causes.filter((g) => g.bucket === 'fix').length,
    },
    pages, findings, causes, fixFirst, reviewFirst, nyc, links, lighthouse, engines: [...engines.values()], w3cNote: w3cEngineNote(scanner, flat), comparison, parity: input.parity || report.runMetadata?.parity || null,
    sourceMethods: SOURCE_METHODS,
    incomplete: pages.some((p) => p.status === 'failed' || p.status === 'partial'),
  };
}
