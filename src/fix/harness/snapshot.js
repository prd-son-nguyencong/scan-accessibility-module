// Baseline / after snapshot of a running site (docs/fix-harness.md section 3). Reuses the scanner's browser helpers and motion freeze.
import { constants as fsConstants, copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getBrowser, newPage, resilientGoto } from '../../scanner/browser.js';
import { FREEZE_MOTION_CSS, settleMotion } from '../../scanner/pixel-contrast.js';

export const SNAPSHOT_VERSION = 2;
export const VIEWPORTS = Object.freeze([[375, 812], [768, 1024], [1280, 800], [1440, 900]].map(([width, height]) => ({ width, height })));
export const STYLE_PROPS = Object.freeze([
  'display', 'position', 'visibility', 'opacity', 'z-index', 'overflow-x', 'overflow-y', 'transform', 'cursor',
  'margin-top', 'margin-right', 'margin-bottom', 'margin-left', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'color', 'background-color', 'background-image', 'box-shadow', 'text-shadow',
  'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width', 'border-top-style', 'border-top-color',
  'border-top-left-radius', 'border-top-right-radius', 'border-bottom-left-radius', 'border-bottom-right-radius',
  'font-family', 'font-size', 'font-weight', 'font-style', 'line-height', 'letter-spacing', 'text-align', 'text-transform', 'text-decoration-line',
  'flex-direction', 'flex-wrap', 'justify-content', 'align-items', 'gap', 'grid-template-columns',
]);
const MAX_ELEMENTS = 3000, MAX_TAB_STOPS = 60, MAX_CONTROLS = 12, MAX_PAGE_HEIGHT = 16000;

export const slug = (route) => route.replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '') || 'root';
export const viewportName = (vp) => `${vp.width}x${vp.height}`;

// Runs in the page. Stable key = path of `tag:nth(n)` where n counts siblings with the same tag AND class attribute,
// so inserting a differently-classed sibling (a skip link) does not renumber the others. Adding or removing a class re-keys that element.
// Ids are not part of the key (a fix that adds an id, such as one on <main> for a skip link, must not re-key the subtree); they are recorded in
// `ids` and G6 fails when an id that existed is removed or renamed.
const INSTALL_KEY_FN = () => {
  const memo = new WeakMap();
  const step = (n) => {
    if (memo.has(n)) return memo.get(n);
    const sig = n.getAttribute('class') || '';
    let i = 1;
    for (let s = n.previousElementSibling; s; s = s.previousElementSibling) if (s.localName === n.localName && (s.getAttribute('class') || '') === sig) i++;
    const r = `${n.localName}:nth(${i})`;
    memo.set(n, r);
    return r;
  };
  window.__adaId = (n) => (n.id && !/\d{4,}/.test(n.id) && document.querySelectorAll(`[id="${CSS.escape(n.id)}"]`).length === 1 ? n.id : null);
  window.__adaKey = (el) => { const parts = []; for (let n = el; n && n.nodeType === 1; n = n.parentElement) parts.push(step(n)); return parts.reverse().join(' > '); };
};

const COLLECT = ({ props, max }) => {
  const SKIP = new Set(['script', 'style', 'link', 'meta', 'head', 'title', 'noscript', 'template', 'br', 'source', 'track', 'base']);
  const sx = window.scrollX, sy = window.scrollY;
  const r1 = (v) => Math.round(v * 10) / 10;
  const layout = {}, styles = {}, ids = {};
  let count = 0, truncated = false, sig = '';
  const all = document.documentElement.querySelectorAll('*');
  for (const el of all) {
    sig += `${el.localName}[${el.getAttributeNames().sort().join(',')}]`;
    if (SKIP.has(el.localName)) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.display === 'contents' || cs.visibility === 'hidden') continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    if (++count > max) { truncated = true; continue; }
    const k = window.__adaKey(el);
    const x = r1(r.left + sx), y = r1(r.top + sy), w = r1(r.width), h = r1(r.height);
    const hid = (w <= 1 && h <= 1) || x + w <= 0 || y + h <= 0 || cs.opacity === '0' || /^rect\(0(px)?,? 0(px)?,? 0(px)?,? 0(px)?\)$/.test(cs.clip) || /inset\(50%\)/.test(cs.clipPath);
    layout[k] = { x, y, w, h, hid };
    const eid = window.__adaId(el);
    if (eid) ids[k] = eid;
    const s = {};
    for (const p of props) s[p] = cs.getPropertyValue(p);
    styles[k] = s;
  }
  let hash = 2166136261;
  for (let i = 0; i < sig.length; i++) { hash ^= sig.charCodeAt(i); hash = Math.imul(hash, 16777619) >>> 0; }
  const links = [...document.querySelectorAll('a[href]')].map((a) => {
    try { const u = new URL(a.getAttribute('href'), location.href); if (u.origin !== location.origin) return u.href; return u.pathname + u.search === location.pathname + location.search && u.hash ? u.hash : u.pathname + u.search + u.hash; } catch { return a.getAttribute('href'); }
  }).sort();
  return { layout, styles, ids, truncated, domHash: hash.toString(16), links, docHeight: Math.round(document.documentElement.scrollHeight), docWidth: Math.round(document.documentElement.scrollWidth) };
};

const INTERACT = ({ max }) => {
  const sel = 'button, summary, [role=tab], [role=button], [aria-controls]';
  const vis = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'; };
  const count = () => { let n = 0; for (const el of document.body.querySelectorAll('*')) if (vis(el)) n++; return n; };
  const controls = [...document.querySelectorAll(sel)].filter((el) => vis(el) && !el.disabled && el.type !== 'submit' && !el.closest('form')).slice(0, max);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  // Settled = the visible element count is equal on two reads 80ms apart (an accordion's height transition, a late render), at most ~1s.
  const settle = async () => { let n = count(); for (let i = 0; i < 12; i++) { await wait(80); const m = count(); if (m === n) return m; n = m; } return n; };
  return (async () => {
    const out = {};
    for (const el of controls) {
      const href = location.href, base = await settle();
      try { el.click(); } catch { /* ignore */ }
      const open = await settle();
      const nav = location.href !== href;
      let restored = false;
      if (!nav) { try { el.click(); } catch { /* ignore */ } restored = (await settle()) === base; }
      out[window.__adaKey(el)] = { delta: open - base, restored: !nav && restored, nav };
      if (nav) break;
    }
    return out;
  })();
};

async function prepare(page) {
  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'light' }).catch(() => {});
  await page.addStyleTag({ content: FREEZE_MOTION_CSS }).catch(() => {});
  await page.evaluate(INSTALL_KEY_FN);
  // Trigger lazy content, wait for images and fonts, then rest at the top.
  await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let y = 0, i = 0; y < document.documentElement.scrollHeight && i < 40; y += innerHeight, i++) { scrollTo(0, y); await wait(40); }
    scrollTo(0, 0);
    await Promise.race([Promise.all([...document.images].map((im) => (im.complete ? 0 : new Promise((r) => { im.onload = im.onerror = r; })))), wait(2500)]);
    await Promise.race([document.fonts?.ready, wait(2500)]);
    // Let finite animations end (a GSAP counter mid-count, a Web Animation) so two captures see the same end state; infinite ones are left alone.
    const busy = () => {
      try { const g = window.gsap?.globalTimeline; if (g?.getChildren?.(true, true, false).some((t) => t.isActive() && t.repeat() !== -1 && t.totalDuration() < 60)) return true; } catch { /* no gsap */ }
      try { return document.getAnimations().some((a) => a.playState === 'running' && Number.isFinite(a.effect?.getComputedTiming().endTime)); } catch { return false; }
    };
    for (const end = Date.now() + 4000; busy() && Date.now() < end;) await wait(100);
  }).catch(() => {});
  await settleMotion(page);
}

async function tabOrder(page) {
  await page.evaluate(() => { document.activeElement?.blur?.(); scrollTo(0, 0); });
  const keys = [];
  for (let i = 0; i < MAX_TAB_STOPS; i++) {
    await page.keyboard.press('Tab');
    const key = await page.evaluate(() => (document.activeElement && document.activeElement !== document.body ? window.__adaKey(document.activeElement) : null));
    if (!key || keys.includes(key)) break;
    keys.push(key);
  }
  await page.evaluate(() => { document.activeElement?.blur?.(); scrollTo(0, 0); });
  return keys;
}

async function captureCell({ browser, baseUrl, route, viewport, dir, timeoutMs }) {
  const page = await newPage(browser, { viewport, timeout: 8000 });
  const origin = new URL(baseUrl).origin;
  const clean = (t) => String(t).split(origin).join('');
  const consoleErrors = [], failed = [], responses = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(`console.error: ${clean(m.text())}`); });
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${clean(e.message)}`));
  page.on('requestfailed', (r) => failed.push(`${r.method()} ${clean(r.url())} FAILED`));
  page.on('response', (r) => { responses.push(r); if (r.status() >= 400) failed.push(`${r.request().method()} ${clean(r.url())} ${r.status()}`); });
  try {
    await resilientGoto(page, new URL(route, baseUrl).href, { timeout: timeoutMs });
    await prepare(page);
    const collected = await page.evaluate(COLLECT, { props: STYLE_PROPS, max: MAX_ELEMENTS });
    const file = `${slug(route)}__${viewportName(viewport)}.png`;
    const height = Math.min(collected.docHeight, MAX_PAGE_HEIGHT);
    await page.screenshot({ path: join(dir, file), fullPage: true, clip: { x: 0, y: 0, width: viewport.width, height }, animations: 'disabled', caret: 'hide', scale: 'css' });
    const a11y = await page.locator('body').ariaSnapshot().catch(() => null);
    const tab = await tabOrder(page);
    const interactions = await page.evaluate(INTERACT, { max: MAX_CONTROLS }).catch(() => ({}));
    let transfer = 0;
    for (const r of responses) { const s = await r.request().sizes().catch(() => null); if (s) transfer += s.responseBodySize + s.responseHeadersSize; }
    return {
      screenshot: { file, width: viewport.width, height },
      docHeight: collected.docHeight, docWidth: collected.docWidth, domHash: collected.domHash, truncatedElements: collected.truncated,
      layout: collected.layout, styles: collected.styles, ids: collected.ids, a11yTree: a11y ? a11y.split('\n') : null,
      tabOrder: tab, interactions, console: [...consoleErrors].sort(), failedRequests: [...failed].sort(), links: collected.links, transfer,
    };
  } finally {
    await page.context().close().catch(() => {});
  }
}

/** Built-in perf run: FCP, LCP, CLS, TBT (long tasks after FCP, no throttling) and transfer size. No Lighthouse score; inject perfRunner for that. */
export async function measurePerfOnce(browser, url, viewport = VIEWPORTS[2], timeoutMs = 30000) {
  const page = await newPage(browser, { viewport, timeout: 8000 });
  const responses = [];
  page.on('response', (r) => responses.push(r));
  try {
    await page.addInitScript(() => {
      window.__perf = { lcp: 0, cls: 0, tasks: [] };
      const obs = (type, fn) => { try { new PerformanceObserver((l) => l.getEntries().forEach(fn)).observe({ type, buffered: true }); } catch { /* unsupported */ } };
      obs('largest-contentful-paint', (e) => { window.__perf.lcp = e.startTime; });
      obs('layout-shift', (e) => { if (!e.hadRecentInput) window.__perf.cls += e.value; });
      obs('longtask', (e) => window.__perf.tasks.push([e.startTime, e.duration]));
    });
    await resilientGoto(page, url, { timeout: timeoutMs });
    await page.waitForTimeout(500);
    const m = await page.evaluate(() => {
      const fcp = performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? null;
      const tbt = window.__perf.tasks.filter(([s]) => fcp == null || s >= fcp).reduce((n, [, d]) => n + Math.max(0, d - 50), 0);
      return { fcp, lcp: window.__perf.lcp || null, cls: window.__perf.cls, tbt };
    });
    let transfer = 0;
    for (const r of responses) { const s = await r.request().sizes().catch(() => null); if (s) transfer += s.responseBodySize + s.responseHeadersSize; }
    return { score: null, si: null, ...m, transfer };
  } finally {
    await page.context().close().catch(() => {});
  }
}

/**
 * Captures a versioned snapshot. Screenshots are written to `dir`; the returned object is JSON-serialisable (it records `screenshotDir`).
 * Bounded: timeBudgetMs ends the capture with truncated:true (gates then fail closed). Routes sorted.
 * perfRunner(browser, url) overrides the built-in runner; perfRuns 0 skips perf; perfRoutes limits which routes get perf runs.
 * concurrency: cells (route x viewport, each its own browser context) run that many at a time; the perf runs follow one after another, never
 * beside a cell, because they measure timing. The result does not depend on the concurrency: cells are stored by route and viewport.
 * reuse: { snapshot, routes } captures only `routes` and takes every other route (cells, perf, screenshot files) from the earlier snapshot, which is the
 * caller's proof that those routes cannot have changed; the PNGs are cloned into `dir` so the result is complete on its own.
 */
export async function captureSnapshot({ baseUrl, routes, dir, viewports = VIEWPORTS, perfRuns = 3, perfRoutes = null, perfRunner = measurePerfOnce, timeBudgetMs = 180000, cellTimeoutMs = 30000, concurrency = 1, reuse = null }) {
  mkdirSync(dir, { recursive: true });
  const browser = await getBrowser();
  const deadline = Date.now() + timeBudgetMs;
  const snap = { version: SNAPSHOT_VERSION, baseUrl, screenshotDir: dir, viewports: viewports.map(viewportName), styleProps: [...STYLE_PROPS], truncated: false, routes: {}, perf: {}, timings: { cellsMs: 0, perfMs: 0 }, reused: { routes: 0, cells: 0, perf: 0 } };
  const all = [...routes].sort();
  const fresh = new Set(reuse ? all.filter((r) => reuse.routes.includes(r)) : all);
  const jobs = [];
  for (const route of all) {
    snap.routes[route] = {};
    if (fresh.has(route)) for (const viewport of viewports) jobs.push({ route, viewport });
  }
  const started = Date.now();
  let next = 0;
  const worker = async () => {
    for (let job = jobs[next++]; job; job = jobs[next++]) {
      if (Date.now() > deadline) { snap.truncated = true; continue; }
      try { snap.routes[job.route][viewportName(job.viewport)] = await captureCell({ browser, baseUrl, route: job.route, viewport: job.viewport, dir, timeoutMs: cellTimeoutMs }); } catch (err) { snap.routes[job.route][viewportName(job.viewport)] = { error: String(err.message).slice(0, 300) }; }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(Number.isInteger(concurrency) && concurrency >= 1 ? concurrency : 1, jobs.length)) }, worker));
  snap.timings.cellsMs = Date.now() - started;
  // cells land in completion order: put them back in viewport order so the stored snapshot is the same whatever the concurrency
  for (const route of fresh) snap.routes[route] = Object.fromEntries(viewports.map(viewportName).filter((v) => v in snap.routes[route]).map((v) => [v, snap.routes[route][v]]));
  const perfStarted = Date.now();
  for (const route of all) {
    if (!fresh.has(route)) continue;
    if (perfRuns > 0 && (!perfRoutes || perfRoutes.includes(route))) {
      const runs = [];
      for (let i = 0; i < perfRuns && Date.now() <= deadline; i++) { try { runs.push(await perfRunner(browser, new URL(route, baseUrl).href)); } catch { /* a failed run is simply absent */ } }
      snap.perf[route] = { runs };
      if (runs.length < perfRuns) snap.truncated = true;
    }
  }
  snap.timings.perfMs = Date.now() - perfStarted;
  for (const route of all) {
    if (fresh.has(route)) continue;
    const cells = reuse.snapshot.routes[route] || {};
    snap.routes[route] = cells;
    if (reuse.snapshot.perf?.[route]) { snap.perf[route] = reuse.snapshot.perf[route]; snap.reused.perf += 1; }
    snap.reused.routes += 1;
    for (const c of Object.values(cells)) {
      if (!c?.screenshot) continue;
      snap.reused.cells += 1;
      try { copyFileSync(join(reuse.snapshot.screenshotDir, c.screenshot.file), join(dir, c.screenshot.file), fsConstants.COPYFILE_FICLONE); } catch { snap.truncated = true; }
    }
  }
  writeFileSync(join(dir, 'snapshot.json'), JSON.stringify(snap));
  return snap;
}

/** Resolves CSS selectors (from scan findings) to snapshot keys on one route and viewport, to feed `targets`. */
export async function resolveKeys({ baseUrl, route, viewport = VIEWPORTS[2], selectors }) {
  const browser = await getBrowser();
  const page = await newPage(browser, { viewport, timeout: 8000 });
  try {
    await resilientGoto(page, new URL(route, baseUrl).href, { timeout: 30000 });
    await page.evaluate(INSTALL_KEY_FN);
    return await page.evaluate((sels) => sels.flatMap((s) => { try { return [...document.querySelectorAll(s)].map((el) => window.__adaKey(el)); } catch { return []; } }), selectors);
  } finally {
    await page.context().close().catch(() => {});
  }
}
