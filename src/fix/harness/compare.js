// Pure comparison of two snapshots (see snapshot.js). Every gate function returns { gate, pass, evidence, regions }.
// Fail closed: a cell present in the baseline and missing after, or a truncated snapshot, fails the gate.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodePng } from './png.js';

export const DEFAULTS = Object.freeze({
  tolerancePx: 1,          // G3: max box delta (x, y, width, height) for a non-target element
  channelTolerance: 8,     // G4: per-channel delta below which a pixel is considered equal (anti-aliasing)
  maxDiffFraction: 0.0002, // G4: differing pixels outside allowed regions / total pixels
  minDiffPixels: 25,       // G4: absolute floor so tiny pages are not failed by a handful of pixels
  regionPad: 2,            // G4: allowed regions are grown by this many px
  transferPct: 0.02,       // G7: transfer size growth allowed
  noiseFloor: { score: 3, lcp: 200, fcp: 150, si: 300, tbt: 50, cls: 0.01 }, // G7: minimum margin per metric
  maxEvidence: 50,
});

const result = (gate, offenders, regions = [], extra = {}) => ({ gate, pass: offenders.length === 0, evidence: offenders.slice(0, DEFAULTS.maxEvidence), regions, ...extra });
const under = (key, keys) => keys.some((t) => key === t || key.startsWith(`${t} > `));
const exemptKeys = (o = {}) => [...(o.targets || []), ...(o.documented || [])];
const EMPTY_NOISE = Object.freeze({ layout: [], styles: [], interactions: [], pixels: [], doc: false });
/** Noise recorded on the baseline for one cell (see baselineNoise): keys and regions that differed between two captures of the same untouched site. */
const noiseOf = (before, route, vp) => {
  const n = before?.noise?.[route]?.[vp] || EMPTY_NOISE;
  // Exact keys only: a noisy ancestor (body moved by a late banner) must not exempt its whole subtree.
  return { ...n, layoutSet: new Set(n.layout), stylesSet: new Set(n.styles), interactionsSet: new Set(n.interactions) };
};

/** Calls fn(route, viewport, beforeCell, afterCell) for each baseline cell; returns offenders for missing or truncated cells. */
function eachCell(before, after, fn, bad = []) {
  if (before?.truncated || after?.truncated) bad.push({ kind: 'SNAPSHOT_TRUNCATED', before: !!before?.truncated, after: !!after?.truncated });
  for (const [route, vps] of Object.entries(before?.routes || {})) {
    for (const [vp, b] of Object.entries(vps)) {
      const a = after?.routes?.[route]?.[vp];
      if (!a || b.error || a.error) bad.push({ kind: 'MISSING_CELL', route, viewport: vp, error: b.error || a?.error || 'absent after' });
      else fn(route, vp, b, a);
    }
  }
  return bad;
}

const parentOf = (k) => k.slice(0, k.lastIndexOf(' > '));
const isHeadingKey = (k) => /(^| > )h[1-6]:nth\(\d+\)$/.test(k);
/** Heading level changes (heading-order fixes) re-tag an element: same parent, same box, a different h1..h6 key. Returns the keys of both sides. */
function retaggedHeadings(b, a, tol) {
  const out = new Set();
  const added = Object.keys(a.layout).filter((k) => !b.layout[k] && isHeadingKey(k));
  for (const k of Object.keys(b.layout)) {
    if (a.layout[k] || !isHeadingKey(k)) continue;
    const be = b.layout[k];
    const m = added.find((x) => !out.has(x) && parentOf(x) === parentOf(k) && Math.max(Math.abs(be.x - a.layout[x].x), Math.abs(be.y - a.layout[x].y), Math.abs(be.w - a.layout[x].w), Math.abs(be.h - a.layout[x].h)) <= tol);
    if (m) { out.add(k); out.add(m); }
  }
  return out;
}

const box = (e) => (e ? { x: e.x, y: e.y, w: e.w, h: e.h } : null);

/** G3: visible elements keep their bounding boxes (tolerance) unless target / documented; added elements must be visually hidden. */
export function compareLayout(before, after, opts = {}) {
  const tol = opts.tolerancePx ?? DEFAULTS.tolerancePx;
  const ex = exemptKeys(opts);
  const regions = [];
  const offenders = [];
  eachCell(before, after, (route, vp, b, a) => {
    let exemptChanged = false, offending = false;
    const nz = noiseOf(before, route, vp);
    const retag = opts.allowHeadingRetag ? retaggedHeadings(b, a, tol) : new Set();
    const flag = (o, rects) => { offending = true; offenders.push({ route, viewport: vp, ...o }); for (const r of rects) if (r) regions.push({ route, viewport: vp, ...r }); };
    for (const [key, be] of Object.entries(b.layout)) {
      const ae = a.layout[key];
      const exempt = under(key, ex) || retag.has(key) || nz.layoutSet.has(key);
      if (!ae) { if (exempt) exemptChanged = true; else if (!be.hid) flag({ kind: 'REMOVED', key }, [box(be)]); continue; }
      const moved = Math.max(Math.abs(be.x - ae.x), Math.abs(be.y - ae.y), Math.abs(be.w - ae.w), Math.abs(be.h - ae.h)) > tol;
      if (moved && exempt) exemptChanged = true;
      else if (moved) flag({ kind: 'MOVED', key, before: box(be), after: box(ae) }, [box(be), box(ae)]);
    }
    for (const [key, ae] of Object.entries(a.layout)) {
      if (b.layout[key]) continue;
      if (under(key, ex) || retag.has(key) || nz.layoutSet.has(key)) exemptChanged = true;
      else if (!ae.hid) flag({ kind: 'ADDED_VISIBLE', key, after: box(ae) }, [box(ae)]);
    }
    if (!exemptChanged && !offending && !nz.doc && Math.abs(b.docHeight - a.docHeight) > tol) flag({ kind: 'DOC_HEIGHT', before: b.docHeight, after: a.docHeight }, []);
  }, offenders);
  return result('G3', offenders, regions);
}

/** G5: tracked computed-style properties of non-target elements must be identical. */
export function compareStyles(before, after, opts = {}) {
  const ex = exemptKeys(opts);
  const offenders = [];
  eachCell(before, after, (route, vp, b, a) => {
    const nz = noiseOf(before, route, vp);
    for (const [key, bs] of Object.entries(b.styles)) {
      const as = a.styles[key];
      if (!as || under(key, ex) || nz.stylesSet.has(key)) continue;
      for (const prop of Object.keys(bs)) if (bs[prop] !== as[prop]) offenders.push({ route, viewport: vp, key, prop, before: bs[prop], after: as[prop] });
    }
  }, offenders);
  return result('G5', offenders);
}

/** Pure RGBA diff. ignore: rects in image pixels. Returns diff count and the 32px grid cells holding differences. */
export function diffImages(a, b, { ignore = [], channelTolerance = DEFAULTS.channelTolerance, maxRegions = 20 } = {}) {
  const w = Math.min(a.w, b.w), h = Math.min(a.h, b.h);
  const masked = new Uint8Array(w * h);
  for (const r of ignore) {
    for (let y = Math.max(0, Math.floor(r.y)); y < Math.min(h, Math.ceil(r.y + r.h)); y++) {
      for (let x = Math.max(0, Math.floor(r.x)); x < Math.min(w, Math.ceil(r.x + r.w)); x++) masked[y * w + x] = 1;
    }
  }
  let diff = 0;
  const cells = new Map();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (masked[y * w + x]) continue;
      const i = (y * a.w + x) * 4, j = (y * b.w + x) * 4;
      if (Math.abs(a.data[i] - b.data[j]) > channelTolerance || Math.abs(a.data[i + 1] - b.data[j + 1]) > channelTolerance
        || Math.abs(a.data[i + 2] - b.data[j + 2]) > channelTolerance || Math.abs(a.data[i + 3] - b.data[j + 3]) > channelTolerance) {
        diff++;
        const c = `${x >> 5},${y >> 5}`;
        cells.set(c, (cells.get(c) || 0) + 1);
      }
    }
  }
  const extra = a.w * a.h + b.w * b.h - 2 * w * h; // area present in only one image counts as different
  const regions = [...cells].sort((p, q) => q[1] - p[1]).slice(0, maxRegions).map(([c, pixels]) => { const [cx, cy] = c.split(',').map(Number); return { x: cx * 32, y: cy * 32, w: 32, h: 32, pixels }; });
  return { diffPixels: diff + extra, total: Math.max(a.w * a.h, b.w * b.h), regions };
}

/** G4: per-viewport pixel diff outside target boxes (before and after). Screenshots are read from each snapshot's screenshotDir. */
export function compareVisual(before, after, opts = {}) {
  const ex = exemptKeys(opts);
  const pad = opts.regionPad ?? DEFAULTS.regionPad;
  const regions = [];
  const perCell = [];
  const offenders = [];
  eachCell(before, after, (route, vp, b, a) => {
    let ia, ib;
    try {
      ib = decodePng(readFileSync(join(before.screenshotDir, b.screenshot.file)));
      ia = decodePng(readFileSync(join(after.screenshotDir, a.screenshot.file)));
    } catch (err) { offenders.push({ route, viewport: vp, kind: 'SCREENSHOT_UNREADABLE', error: err.message }); return; }
    const nz = noiseOf(before, route, vp);
    const ignore = nz.pixels.map((r) => ({ ...r }));
    for (const cell of [b, a]) for (const [key, e] of Object.entries(cell.layout)) if (under(key, ex) || nz.layoutSet.has(key)) ignore.push({ x: e.x - pad, y: e.y - pad, w: e.w + 2 * pad, h: e.h + 2 * pad });
    const d = diffImages(ib, ia, { ignore, channelTolerance: opts.channelTolerance });
    const limit = Math.max(opts.minDiffPixels ?? DEFAULTS.minDiffPixels, (opts.maxDiffFraction ?? DEFAULTS.maxDiffFraction) * d.total);
    perCell.push({ route, viewport: vp, diffPixels: d.diffPixels, limit });
    if (d.diffPixels > limit) { offenders.push({ route, viewport: vp, kind: 'PIXEL_DIFF', diffPixels: d.diffPixels, limit }); for (const r of d.regions) regions.push({ route, viewport: vp, ...r }); }
  }, offenders);
  return result('G4', offenders, regions, { cells: perCell });
}

/**
 * Noise of the untouched site: two captures of the same baseline are compared and everything that differs (a counter mid-count, an animation
 * frame, antialiasing speckle) is recorded per route and viewport. The gates then ignore those keys and regions, so an edit is never blamed for them.
 * Result shape: { [route]: { [viewport]: { layout, styles, interactions, pixels, doc } } } (empty cells are left out). Stored on the baseline snapshot.
 */
export function baselineNoise(first, second, opts = {}) {
  const tol = opts.tolerancePx ?? DEFAULTS.tolerancePx;
  const noise = {};
  for (const [route, vps] of Object.entries(first?.routes || {})) {
    for (const [vp, a] of Object.entries(vps)) {
      const b = second?.routes?.[route]?.[vp];
      if (!b || a.error || b.error) continue;
      const cell = { layout: [], styles: [], interactions: [], pixels: [], doc: Math.abs(a.docHeight - b.docHeight) > tol };
      for (const k of new Set([...Object.keys(a.layout), ...Object.keys(b.layout)])) {
        const x = a.layout[k], y = b.layout[k];
        if (!x || !y || Math.max(Math.abs(x.x - y.x), Math.abs(x.y - y.y), Math.abs(x.w - y.w), Math.abs(x.h - y.h)) > tol) cell.layout.push(k);
      }
      for (const [k, sa] of Object.entries(a.styles)) { const sb = b.styles[k]; if (sb && Object.keys(sa).some((p) => sa[p] !== sb[p])) cell.styles.push(k); }
      for (const k of new Set([...Object.keys(a.interactions || {}), ...Object.keys(b.interactions || {})])) {
        const x = a.interactions?.[k], y = b.interactions?.[k];
        if (!x || !y || x.delta !== y.delta || x.restored !== y.restored || x.nav !== y.nav) cell.interactions.push(k);
      }
      try {
        const d = diffImages(decodePng(readFileSync(join(first.screenshotDir, a.screenshot.file))), decodePng(readFileSync(join(second.screenshotDir, b.screenshot.file))), { channelTolerance: opts.channelTolerance, maxRegions: Infinity });
        cell.pixels = d.regions.map(({ x, y, w, h }) => ({ x, y, w, h }));
      } catch { /* unreadable screenshot: the gate reports it itself */ }
      if (cell.layout.length || cell.styles.length || cell.interactions.length || cell.pixels.length || cell.doc) (noise[route] ||= {})[vp] = cell;
    }
  }
  return noise;
}

const bag = (arr) => arr.reduce((m, k) => m.set(k, (m.get(k) || 0) + 1), new Map());
const isSubsequence = (small, big) => { let i = 0; for (const k of big) if (i < small.length && small[i] === k) i++; return i === small.length; };

/** G6: console errors, failed requests, link map, tab order and interaction smoke. documented keys may add tab stops. */
export function compareBehaviour(before, after, opts = {}) {
  const ex = exemptKeys(opts);
  const addedHrefs = new Set(opts.allowAddedHrefs || []);
  const offenders = [];
  eachCell(before, after, (route, vp, b, a) => {
    const add = (o) => offenders.push({ route, viewport: vp, ...o });
    for (const field of ['console', 'failedRequests']) {
      const seen = bag(b[field]);
      for (const m of a[field]) { const n = seen.get(m) || 0; if (n > 0) seen.set(m, n - 1); else add({ kind: field === 'console' ? 'NEW_CONSOLE_ERROR' : 'NEW_FAILED_REQUEST', message: m }); }
    }
    const after_ = bag(a.links);
    for (const h of b.links) { const n = after_.get(h) || 0; if (n > 0) after_.set(h, n - 1); else add({ kind: 'LINK_REMOVED_OR_CHANGED', href: h }); }
    for (const [h, n] of after_) if (n > 0 && !h.startsWith('#') && !addedHrefs.has(h)) add({ kind: 'LINK_ADDED', href: h });
    if (!isSubsequence(b.tabOrder, a.tabOrder)) add({ kind: 'TAB_ORDER_CHANGED', before: b.tabOrder, after: a.tabOrder });
    else { const kept = new Set(b.tabOrder); for (const k of a.tabOrder) if (!kept.has(k) && !under(k, ex) && !(opts.allowFirstTabStop && k === a.tabOrder[0])) add({ kind: 'TAB_STOP_ADDED', key: k }); }
    // An id the page had must survive (scripts, labels and anchors reference it); an added id is fine.
    for (const [key, id] of Object.entries(b.ids || {})) if (a.ids && a.ids[key] !== id && !under(key, ex)) add({ kind: 'ID_CHANGED', key, before: id, after: a.ids[key] ?? null });
    const nz = noiseOf(before, route, vp);
    for (const [key, bi] of Object.entries(b.interactions)) {
      if (nz.interactionsSet.has(key)) continue;
      const ai = a.interactions[key];
      if (!ai) add({ kind: 'INTERACTION_MISSING', key });
      else if (bi.delta !== ai.delta || bi.restored !== ai.restored || bi.nav !== ai.nav) add({ kind: 'INTERACTION_CHANGED', key, before: bi, after: ai });
    }
  }, offenders);
  return result('G6', offenders);
}

const median = (xs) => { const s = xs.filter((x) => x != null).sort((p, q) => p - q); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };
const METRICS = [['score', -1], ['lcp', 1], ['fcp', 1], ['si', 1], ['tbt', 1], ['cls', 1]]; // [name, direction: +1 lower is better]

/** Noise margin of a metric from baseline runs: the larger of the run range (max - min) and the floor. */
export function noiseMargin(values, floor = 0) {
  const v = values.filter((x) => x != null);
  return v.length ? Math.max(floor, Math.max(...v) - Math.min(...v)) : floor;
}

/**
 * G7: medians of the after runs against the medians of the baseline runs, with a margin from the baseline run spread.
 * opts.requireImprovement = { metric, minGain } turns it into the performance-track gate (a measured gain beyond the margin).
 */
export function comparePerf(before, after, opts = {}) {
  const floors = { ...DEFAULTS.noiseFloor, ...(opts.noiseFloor || {}) };
  const offenders = [];
  const detail = [];
  for (const [route, bp] of Object.entries(before?.perf || {})) {
    const ap = after?.perf?.[route];
    if (!bp.runs?.length || !ap?.runs?.length) { offenders.push({ route, kind: 'PERF_MISSING' }); continue; }
    const row = { route, metrics: {} };
    for (const [m, dir] of [...METRICS, ['transfer', 1]]) {
      const bv = median(bp.runs.map((r) => r[m])), av = median(ap.runs.map((r) => r[m]));
      if (bv == null || av == null) continue;
      const margin = m === 'transfer' ? bv * (opts.transferPct ?? DEFAULTS.transferPct) : noiseMargin(bp.runs.map((r) => r[m]), floors[m]);
      const worse = dir * (av - bv); // positive = worse
      row.metrics[m] = { before: bv, after: av, margin };
      if (worse > margin) offenders.push({ route, kind: 'PERF_REGRESSION', metric: m, before: bv, after: av, margin });
    }
    const need = opts.requireImprovement;
    if (need) {
      const r = row.metrics[need.metric];
      const dir = METRICS.find(([n]) => n === need.metric)?.[1] ?? 1;
      if (!r || -dir * (r.after - r.before) < Math.max(r.margin, need.minGain ?? 0)) offenders.push({ route, kind: 'NO_MEASURED_IMPROVEMENT', metric: need.metric, ...(r || {}) });
    }
    detail.push(row);
  }
  if (!detail.length && !offenders.length) offenders.push({ kind: 'PERF_MISSING', reason: 'no perf runs in the baseline' });
  return result('G7', offenders, [], { perf: detail });
}
