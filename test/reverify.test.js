import './helpers/hermetic-env.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { reverifyFindings, summarizeReverify, needsReverify } from '../src/scanner/reverify.js';
import { scanOnePage, reverifyKey } from '../src/index.js';
import { scanPageWithAxe } from '../src/scanner/axe.js';
import { parseCliArgs } from '../src/utils/cli-args.js';
import { validateConfig } from '../src/utils/config.js';
import { closeBrowser, getBrowser } from '../src/scanner/browser.js';
import { openScanPage } from '../src/scanner/session.js';
import { requireBrowser } from './helpers/require-browser.js';
import { startParadoxSite } from './helpers/paradox-site-server.js';

after(() => closeBrowser());

const f = (layer, ruleId, id, impact = 'serious') => ({ layer, ruleId, impact, element: { selector: id } });
const key = (v) => `${v.ruleId}|${v.element.selector}`;

test('needsReverify: sensitive layers always, axe/accessScan critical/serious/moderate, others never', () => {
  assert.equal(needsReverify(f('keyboard', 'r', 'a', 'minor')), true);
  assert.equal(needsReverify(f('axe', 'r', 'a', 'critical')), true);
  assert.equal(needsReverify(f('accessScan', 'r', 'a', 'moderate')), true);
  assert.equal(needsReverify(f('axe', 'r', 'a', 'minor')), false);
  assert.equal(needsReverify(f('w3c', 'r', 'a', 'serious')), false);
});

test('reverifyFindings: a finding that flips between runs is flaky, a stable one passes (synthetic source)', async () => {
  const first = [f('keyboard', 'keyboard-trap', 'stable'), f('keyboard', 'keyboard-trap', 'flip'), f('axe', 'color-contrast', 'a'), f('axe', 'label', 'b', 'minor')];
  let call = 0;
  // run 1 = the first pass (not re-run); run 2 loses the 'flip' finding and the axe one
  const rerun = async (layer) => { call++; return layer === 'keyboard' ? [f('keyboard', 'keyboard-trap', 'stable')] : []; };
  const out = await reverifyFindings(first, { rerun, key });
  assert.equal(call, 2, 'one re-run per layer, not per finding');
  assert.deepEqual(out.kept.map(key), ['keyboard-trap|stable', 'label|b']);
  assert.deepEqual(out.flaky.map((x) => [x.ruleId, x.selector, x.stability]), [['keyboard-trap', 'flip', '1/2'], ['color-contrast', 'a', '1/2']]);
  assert.equal(out.summary.checked, 3);
  assert.equal(out.summary.stable, 1);
  assert.deepEqual(out.summary.byRule['keyboard-trap'], { checked: 2, flaky: 1 });
});

test('reverifyFindings: cap, failing re-run and time budget leave findings unverified and kept', async () => {
  const many = Array.from({ length: 5 }, (_, i) => f('links', 'dead-link-404', `l${i}`));
  const capped = await reverifyFindings(many, { rerun: async () => [], key, maxPerPage: 2 });
  assert.equal(capped.flaky.length, 2);
  assert.equal(capped.kept.length, 3);
  assert.equal(capped.summary.overCap, 3);

  const failed = await reverifyFindings(many, { rerun: async () => { throw new Error('boom'); }, key });
  assert.equal(failed.flaky.length, 0);
  assert.equal(failed.summary.unverified, 5);

  const slow = await reverifyFindings(many, { rerun: () => new Promise(() => {}), key, timeoutMs: 30 });
  assert.equal(slow.kept.length, 5);
  assert.equal(slow.summary.unverified, 5);
});

test('reverifyFindings hands each layer its own targets to the re-run', async () => {
  const seen = {};
  const first = [f('links', 'dead-link-404', 'l1'), f('keyboard', 'keyboard-trap', 'k1'), f('links', 'dead-link-404', 'l2')];
  await reverifyFindings(first, { rerun: async (layer, mine) => { seen[layer] = mine.map((v) => v.element.selector); return []; }, key });
  assert.deepEqual(seen, { links: ['l1', 'l2'], keyboard: ['k1'] });
});

test('reverifyFindings: layers of different lanes re-run together, layers of one lane in order; result order is stable', async () => {
  const first = [f('axe', 'r', 'a'), f('accessScan', 'r', 'b'), f('links', 'dead-link-404', 'l')];
  const log = [];
  let running = 0;
  let peak = 0;
  const rerun = async (layer, mine) => {
    log.push(`start ${layer}`);
    running++; peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, layer === 'links' ? 5 : 20));
    running--;
    log.push(`end ${layer}`);
    return mine;
  };
  const out = await reverifyFindings(first, { rerun, key, laneOf: (l) => (l === 'links' ? 1 : 0) });
  assert.equal(peak, 2);
  assert.ok(log.indexOf('end axe') < log.indexOf('start accessScan'), 'same-lane layers never overlap');
  assert.equal(out.summary.stable, 3);
});

test('scanPageWithAxe: onlyRules limits a re-verify run to the rules of the findings being confirmed', async (t) => {
  if (!await requireBrowser(t)) return;
  const site = await startParadoxSite({
    routes: { '/page': (req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><html><title>T</title><main><h1>Hi</h1><img src="/x.png"><button></button></main></html>') },
  });
  try {
    const cfg = { axe: { viewports: [{ name: 'desktop', width: 1280, height: 800 }] } };
    const all = await scanPageWithAxe(`${site.url}/page`, cfg, { sourceMode: 'url' });
    const only = await scanPageWithAxe(`${site.url}/page`, cfg, { sourceMode: 'url', onlyRules: new Set(['image-alt']) });
    assert.ok(all.violations.some((v) => v.id === 'button-name') && all.violations.some((v) => v.id === 'image-alt'));
    assert.deepEqual(only.violations.map((v) => v.id), ['image-alt']);
    assert.deepEqual(only.violations[0].nodes.map((n) => n.html), all.violations.find((v) => v.id === 'image-alt').nodes.map((n) => n.html));
  } finally {
    await site.close();
  }
});

const IMG_PAGE = '<!doctype html><html lang="en"><title>T</title><main><h1>Hi</h1><img src="/x.png"></main></html>';

test('scanPageWithAxe: a pre-opened warm context is reused and closed without opening another; a failed or missing one falls back', async (t) => {
  const browser = await requireBrowser(t);
  if (!browser) return;
  let loads = 0;
  const site = await startParadoxSite({
    routes: { '/page': (req, res) => { loads++; res.writeHead(200, { 'content-type': 'text/html' }).end(IMG_PAGE); } },
  });
  const url = `${site.url}/page`;
  const vp = { name: 'tablet', width: 700, height: 900 };
  const cfg = { axe: { viewports: [vp] } };
  try {
    const warm = await openScanPage(browser, url, { viewport: { width: 700, height: 900 } });
    assert.equal(loads, 1);
    const warmPages = new Map([['700x900', Promise.resolve(warm)]]);
    const res = await scanPageWithAxe(url, cfg, { sourceMode: 'url', warmPages });
    assert.equal(loads, 1, 'the warm page served the scan: nothing was navigated again');
    assert.ok(res.violations.some((v) => v.id === 'image-alt'));
    assert.ok(warm.page.isClosed(), 'the warm context is closed after use');
    assert.equal(warmPages.size, 0, 'each warm context is used once');

    // the pre-open failed (null) or landed on an unscannable page: the scan opens its own context
    loads = 0;
    const nullWarm = await scanPageWithAxe(url, cfg, { sourceMode: 'url', warmPages: new Map([['700x900', Promise.resolve(null)]]) });
    assert.equal(loads, 1);
    assert.ok(nullWarm.violations.some((v) => v.id === 'image-alt'));
    let closed = false;
    const bad = { failure: { message: 'HTTP 500' }, page: null, close: async () => { closed = true; } };
    loads = 0;
    const badWarm = await scanPageWithAxe(url, cfg, { sourceMode: 'url', warmPages: new Map([['700x900', Promise.resolve(bad)]]) });
    assert.ok(closed, 'an unusable warm context is closed');
    assert.equal(loads, 1);
    assert.ok(badWarm.violations.some((v) => v.id === 'image-alt'));
  } finally {
    await site.close();
  }
});

test('scanOnePage: warm contexts open only for findings that need re-verification, are used by it, and none stay open', async (t) => {
  const browser = await requireBrowser(t);
  if (!browser) return;
  let loads = 0;
  let body = IMG_PAGE;
  const site = await startParadoxSite({
    routes: { '/page': (req, res) => { loads++; res.writeHead(200, { 'content-type': 'text/html' }).end(body); } },
  });
  const run = async (options) => { loads = 0; const res = await scanOnePage({ name: 'p', url: `${site.url}/page` }, { layers: { axe: true, accessScan: true } }, { isUrlMode: true, ...options }); return { res, loads }; };
  try {
    const before = browser.contexts().length;
    // No axe finding: only accessScan has something to re-check, so only the default fresh page is pre-opened, not the mobile one.
    body = '<!doctype html><html lang="en"><title>T</title><main><h1>Hi</h1><p>Clean page</p></main></html>';
    const cleanBase = await run({ reverify: false });
    const clean = await run({});
    assert.equal(clean.res.violations.filter((v) => v.layer === 'axe').length, 0);
    assert.equal(clean.loads, cleanBase.loads + 1, 'one extra load: the fresh page accessScan re-checks on');
    assert.equal(browser.contexts().length, before, 'no context left open');

    // An image without alt is seen at both viewports: the fresh default page and the mobile one are each loaded once and re-verification reuses them.
    body = IMG_PAGE;
    const base = await run({ reverify: false });
    const withFinding = await run({});
    assert.ok(withFinding.res.reverify.summary.stable >= 1);
    assert.equal(withFinding.loads, base.loads + 2);
    assert.equal(browser.contexts().length, before, 'no context left open');
  } finally {
    await site.close();
  }
});

test('reverifyKey: the same element with a different generated id matches across loads, another element does not', () => {
  const pop = (n, text = 'Menu') => ({ layer: 'accessScan', ruleId: 'VisibleTextPartOfAccessibleName', element: { selector: `div#el-popover-${n}`, outerHTML: `<div id="el-popover-${n}" aria-label="x">${text}</div>` } });
  assert.equal(reverifyKey(pop(3850)), reverifyKey(pop(5016)));
  assert.notEqual(reverifyKey(pop(3850)), reverifyKey(pop(3850, 'Other')));
});

test('summarizeReverify: flake rate per rule across pages', () => {
  const page = (route, byRule, flaky) => ({ route, reverify: { summary: { checked: 0, stable: 0, flaky: 0, unverified: 0, overCap: 0, byRule }, flaky } });
  const s = summarizeReverify([
    page('/a', { r: { checked: 2, flaky: 1 } }, [{ ruleId: 'r', layer: 'links', impact: 'moderate', selector: 'x', stability: '1/2' }]),
    page('/b', { r: { checked: 2, flaky: 0 } }, []),
    { route: '/c', reverify: null },
  ], { maxPerPage: 25, timeoutMs: 1 });
  assert.deepEqual(s.flakeRate.r, { checked: 4, flaky: 1, rate: 0.25 });
  assert.equal(s.flakyFindings[0].route, '/a');
});

test('--no-reverify parses and verify config validates', () => {
  assert.equal(parseCliArgs(['--no-reverify'])['no-reverify'], true);
  assert.deepEqual(validateConfig({ verify: { maxPerPage: 5 } }), []);
  assert.equal(validateConfig({ verify: { maxPerPage: 0 } }).length, 1);
});

test('scanOnePage: a dead link that appears only on the first load is flaky and excluded; a stable one stays', async (t) => {
  if (!await requireBrowser(t)) return;
  let loads = 0;
  const site = await startParadoxSite({
    routes: {
      '/page': (req, res) => {
        loads++;
        res.writeHead(200, { 'content-type': 'text/html' }).end(
          '<!doctype html><html lang="en"><title>T</title><main><h1>Hi</h1><a href="/stable-dead">Gone</a> <a href="/flip-dead">Sometimes</a></main></html>');
      },
      '/stable-dead': (req, res) => res.writeHead(404).end('no'),
      '/flip-dead': (req, res) => res.writeHead(loads <= 1 ? 404 : 200).end('x'),
    },
  });
  const run = (options) => scanOnePage({ name: 'p', url: `${site.url}/page` }, { layers: { links: true } }, { isUrlMode: true, ...options });
  try {
    loads = 0;
    const on = await run({});
    const sel = on.violations.filter((v) => v.ruleId === 'dead-link-404').map((v) => v.element.outerHTML);
    assert.equal(sel.length, 1);
    assert.match(sel[0], /stable-dead/);
    assert.equal(on.reverify.flaky.length, 1);
    assert.equal(on.reverify.flaky[0].stability, '1/2');
    assert.equal(on.reverify.summary.stable, 1);
    loads = 0;
    const off = await run({ reverify: false });
    assert.equal(off.violations.filter((v) => v.ruleId === 'dead-link-404').length, 2);
    assert.equal(off.reverify, null);
  } finally {
    await site.close();
  }
});

test('scanOnePage: an axe re-verify run leaves axeSummary equal to the first pass and prints one axe line', async (t) => {
  if (!await requireBrowser(t)) return;
  let loads = 0;
  const imgs = (n) => '<img src="/x.png">'.repeat(n);
  const site = await startParadoxSite({
    routes: {
      // first load carries three alt-less images, later loads only one: a re-run must not shrink the totals
      '/page': (req, res) => {
        loads++;
        res.writeHead(200, { 'content-type': 'text/html' }).end(
          `<!doctype html><html lang="en"><title>T</title><main><h1>Hi</h1>${imgs(loads === 1 ? 3 : 1)}</main></html>`);
      },
    },
  });
  const lines = [];
  const origLog = console.log;
  try {
    console.log = (...a) => { lines.push(a.join(' ')); };
    const res = await scanOnePage({ name: 'p', url: `${site.url}/page` }, { layers: { axe: true } }, { isUrlMode: true });
    console.log = origLog;
    assert.ok(res.reverify.summary.checked > 0, 're-verify must have run');
    assert.ok(loads > 1, 'axe must have loaded the page again');
    assert.equal(res.axeSummary.affectedNodes >= 3, true, 'totals come from the first pass');
    assert.equal(lines.filter((l) => /\baxe: \d+ rule group/.test(l)).length, 1);
  } finally {
    console.log = origLog;
    await site.close();
  }
});

test('scanOnePage: per-phase timings reach the result and the console, and an axe re-run only revisits the viewports its findings were seen at', async (t) => {
  if (!await requireBrowser(t)) return;
  let loads = 0;
  const site = await startParadoxSite({
    routes: {
      // the alt-less image exists only at desktop width: the mobile viewport has nothing to re-check
      '/page': (req, res) => {
        loads++;
        res.writeHead(200, { 'content-type': 'text/html' }).end(
          '<!doctype html><html lang="en"><title>T</title><style>.d{display:none}@media(min-width:800px){.d{display:inline}}</style><main><h1>Hi</h1><img class="d" src="/x.png"></main></html>');
      },
    },
  });
  const lines = [];
  const origLog = console.log;
  try {
    console.log = (...a) => { lines.push(a.join(' ')); };
    const res = await scanOnePage({ name: 'p', url: `${site.url}/page` }, { layers: { axe: true } }, { isUrlMode: true });
    console.log = origLog;
    assert.equal(res.reverify.summary.stable, 1, 'the desktop-only finding is re-checked and stable');
    assert.equal(loads, 3, 'first pass: desktop page + mobile context; re-verify: one fresh page, no mobile context');
    for (const phase of ['navigate', 'axe', 'reverify', 'reverify.axe']) assert.ok(res.phases[phase] >= 0, phase);
    assert.ok(lines.some((l) => /\[p\] phases: navigate [\d.]+s, axe [\d.]+s/.test(l)), lines.join('\n'));
  } finally {
    console.log = origLog;
    await site.close();
  }
});
