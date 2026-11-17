import './helpers/hermetic-env.mjs';
import http from 'node:http';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closeBrowser } from '../src/scanner/browser.js';
import { aggregateTarget, applyMeasuredChecks, judgeTarget } from '../src/scanner/measured-checks.js';
import { requireBrowser } from './helpers/require-browser.js';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installNoHydrateJobsRoutes } from '../src/scanner/access-scan/runtime/no-hydrate.js';
import { narrowByOwnText } from '../src/tracer/structural-source.js';

// WCAG 2.5.8 spacing: a row is measured on the element it names. Round 5 confirmed footer links whose Lighthouse selector matched a whole list (the first
// match was measured), a resize-only layout (script-fixed heights) and links whose utility stylesheet had not loaded.

const VPS = [{ name: 'desktop', width: 1280, height: 900 }, { name: 'mobile', width: 390, height: 844 }];
const HEAD = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>t</title><style>body{margin:0;font:16px/20px sans-serif}.abs{position:absolute;display:block;padding:0}</style>';

async function withPage(t, html, fn, { head = '', origin = null } = {}) {
  const browser = await requireBrowser(t);
  if (!browser) return;
  t.after(closeBrowser);
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  try {
    if (origin) await page.goto(origin);
    else await page.setContent(`${HEAD}${head}</head><body>${html}</body></html>`);
    await fn(page);
  } finally { await page.context().close(); }
}
async function serve(t, body) {
  const server = http.createServer((q, r) => { r.setHeader('content-type', 'text/html'); r.end(body); });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  t.after(() => new Promise((res) => server.close(res)));
  return `http://127.0.0.1:${server.address().port}/`;
}
async function serveFiles(t, files) {
  const hits = {};
  const server = http.createServer((q, r) => { const p = q.url.split('?')[0]; hits[p] = (hits[p] || 0) + 1; const f = files[p]; if (!f) { r.statusCode = 404; return r.end(); } r.setHeader('content-type', f.type); r.end(f.body); });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  t.after(() => new Promise((res) => server.close(res)));
  return { origin: `http://127.0.0.1:${server.address().port}`, hits };
}
const row = (ruleId, selector, html, layer = 'axe', evidence = {}) => ({ ruleId, layer, element: { selector, outerHTML: html }, verdict: 'confirmed', kind: 'deterministic', evidence });
const measured = (r, vp) => r.evidence.measured.find((m) => m.viewport === vp);

// ─── pure ────────────────────────────────────────────────────────────────────

test('target size: an ambiguous selector is not measurable (needs-review), a display class that did not apply is needs-review, a real crowding still fails', () => {
  const crowded = { w: 70, h: 18, nearest: 3, clearance: -2.9 };
  assert.equal(judgeTarget({ ambiguous: 6 }).status, 'n/a');
  const amb = aggregateTarget([{ viewport: { width: 390, height: 844 }, m: { ambiguous: 6 } }]);
  assert.equal(amb.verdict, 'needs-review');
  assert.match(amb.reason, /selector matches 6 elements/);
  assert.equal(judgeTarget({ ...crowded, styleUnapplied: 'inline-flex' }).status, 'review');
  assert.equal(aggregateTarget([{ viewport: { width: 1280, height: 900 }, m: { ...crowded, styleUnapplied: 'inline-flex' } }]).verdict, 'needs-review');
  assert.equal(aggregateTarget([{ viewport: { width: 390, height: 844 }, m: crowded }]).verdict, 'confirmed');
  assert.equal(judgeTarget({ ...crowded, styleUnapplied: 'inline-flex', clearance: 4 }).status, 'pass', 'no intersection, nothing to review');
});

test('target size: a circle overlap below 1px is needs-review (platform font metrics), 1px and more is a confirmed failure, a viewport that really fails still wins', () => {
  const at390 = { width: 390, height: 844 }; const at1280 = { width: 1280, height: 900 };
  const sliver = { w: 105, h: 17, nearest: 3, clearance: -0.5, fontBox: true };
  const sliverVerdict = aggregateTarget([{ viewport: at390, m: sliver }]);
  assert.equal(sliverVerdict.verdict, 'needs-review');
  assert.match(sliverVerdict.reason, /circle overlap of 0\.5px is below the 1px rounding/);
  assert.equal(aggregateTarget([{ viewport: at390, m: { ...sliver, clearance: -1 } }]).verdict, 'confirmed');
  assert.equal(aggregateTarget([{ viewport: at390, m: { ...sliver, fontBox: false } }]).verdict, 'confirmed', 'a fixed px box has no font metrics: 0.5px overlap is a real failure');
  assert.equal(aggregateTarget([{ viewport: at390, m: { ...sliver, clearance: -2.9 } }]).verdict, 'confirmed', 'stacked 18px footer links 3px apart overlap by 2.9px');
  assert.equal(aggregateTarget([{ viewport: at390, m: sliver }, { viewport: at1280, m: { ...sliver, clearance: -2.9 } }]).verdict, 'confirmed');
});

// ─── ambiguous selectors (Lighthouse reports the shared "ul>li>a" of a link list) ─────────────

const LIST = `
  <ul style="margin:0;padding:0;list-style:none;position:absolute;left:10px;top:100px">
    <li><a class="lnk" href="/a">Alpha</a></li>
    <li style="margin-top:1px"><a class="lnk" href="/b">Beta</a></li>
    <li style="margin-top:1px"><a class="lnk" href="/c">Gamma</a></li>
  </ul>
  <a class="lnk abs" href="/far" style="left:700px;top:500px;width:90px;height:18px">Far</a>`;

test('target size: a selector that matches a whole list measures the row\'s own element (html, then DOM path), never the first match', async (t) => {
  await withPage(t, LIST, async (page) => {
    // path of /far in Lighthouse's childNodes format
    const farPath = await page.evaluate(() => { const parts = []; for (let n = document.querySelector('a[href="/far"]'); n && n !== document; n = n.parentNode) parts.unshift(`${[...n.parentNode.childNodes].indexOf(n)},${n.nodeName}`); return parts.join(','); });
    const far = row('target-size', '.lnk', '<a class="lnk abs" href="/far" style="left:700px;top:500px;width:90px;height:18px">', 'lighthouse');
    const beta = row('target-size', '.lnk', '<a class="lnk" href="/b">', 'lighthouse');
    const blind = row('target-size', '.lnk', '<a class="lnk">', 'lighthouse');
    const byPath = row('target-size', '.lnk', '', 'lighthouse', { path: farPath });
    await applyMeasuredChecks(page, [far, beta, blind, byPath], { viewports: VPS });
    // FALSE positive: the isolated link is not the crowded first <li> link
    assert.equal(far.verdict, 'needs-review', 'the far link has no neighbour; the first match of .lnk (Alpha) is crowded and must not decide');
    assert.equal(measured(far, '1280x900').w, 90);
    // TRUE defect: the crowded middle link still confirms
    assert.equal(beta.verdict, 'confirmed');
    assert.equal(measured(beta, '1280x900').status, 'fail');
    // no html, no path that narrows it: undecidable, demoted, never measured on the first match
    assert.equal(blind.verdict, 'needs-review');
    assert.match(blind.reason, /selector matches 4 elements/);
    assert.equal(byPath.verdict, 'needs-review', 'the DOM path alone singles out the far link');
    assert.equal(measured(byPath, '1280x900').w, 90);
  });
});

test('target size: an engine selector that names one element is measured as before (unique selector, crowded list still confirms)', async (t) => {
  await withPage(t, LIST, async (page) => {
    const r = row('target-size', 'a[href="/b"]', '<a class="lnk" href="/b">');
    await applyMeasuredChecks(page, [r], { viewports: VPS });
    assert.equal(r.verdict, 'confirmed');
  });
});

// ─── display class that did not apply ────────────────────────────────────────

test('target size: a link whose own display class is not in effect (stylesheet missing) is needs-review; the same crowding with the class applied confirms', async (t) => {
  const links = (cls) => `<div style="position:absolute;left:10px;top:100px"><a id="s1" class="${cls}" href="/one">One</a><br><a id="s2" class="${cls}" href="/two">Two</a></div>`;
  await withPage(t, links('inline-flex'), async (page) => {
    const r = row('TargetSize', '#s1', '<a id="s1" class="inline-flex" href="/one">', 'accessScan');
    await applyMeasuredChecks(page, [r], { viewports: VPS });
    assert.equal(r.verdict, 'needs-review', 'inline-flex says display:inline-flex but the browser draws inline: the box is not the designed one');
    assert.match(r.reason, /display class \(inline-flex\) is not in effect/);
  });
  await withPage(t, links('inline-flex'), async (page) => {
    const r = row('TargetSize', '#s1', '<a id="s1" class="inline-flex" href="/one">', 'accessScan');
    await applyMeasuredChecks(page, [r], { viewports: VPS });
    assert.equal(r.verdict, 'confirmed', 'TRUE defect: the stylesheet is in effect and the 18px links are 20px apart');
  }, { head: '<style>.inline-flex{display:inline-flex}</style>' });
});

test('target size: a responsive display class with the stylesheet loaded ("block md:inline") confirms; with no rule for it anywhere the same links stay needs-review', async (t) => {
  const links = '<ul style="margin:0;padding:0;list-style:none;position:absolute;left:10px;top:100px"><li style="height:20px"><a id="a1" class="block md-inline" href="/1">First link</a></li><li style="height:20px"><a id="a2" class="block md-inline" href="/2">Second link</a></li></ul>';
  // TRUE defect (reviewer repro): display:inline at >=800px is the author's rendering; 59.6x18 links with centres 20px apart fail at 1280
  await withPage(t, links, async (page) => {
    const r = row('TargetSize', '#a1', '<a id="a1" class="block md-inline" href="/1">', 'accessScan');
    await applyMeasuredChecks(page, [r], { viewports: [VPS[0]] });
    assert.equal(r.verdict, 'confirmed');
    assert.equal(measured(r, '1280x900').status, 'fail');
  }, { head: '<style>.block{display:block;padding:8px 0}@media(min-width:800px){.md-inline{display:inline;padding:0}}</style>' });
  // FALSE positive kept: no stylesheet defines any display for these links (not even in a media query)
  await withPage(t, links, async (page) => {
    const r = row('TargetSize', '#a1', '<a id="a1" class="block md-inline" href="/1">', 'accessScan');
    await applyMeasuredChecks(page, [r], { viewports: [VPS[0]] });
    assert.equal(r.verdict, 'needs-review');
    assert.match(r.reason, /display class \(block\) is not in effect/);
  });
});

test('target size: a responsive display class whose stylesheet is loaded through @import confirms (the imported rules are read); an @import that 404s keeps the links needs-review', async (t) => {
  const LINKS = '<ul style="margin:0;padding:0;list-style:none;position:absolute;left:10px;top:100px"><li style="height:20px"><a id="a1" class="block md-inline" href="/1">First link</a></li><li style="height:20px"><a id="a2" class="block md-inline" href="/2">Second link</a></li></ul>';
  const page = (imp) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>t</title><style>body{margin:0;font:16px/20px sans-serif}</style><style>@import url(${imp});</style></head><body>${LINKS}</body></html>`;
  const { origin } = await serveFiles(t, {
    '/imp.css': { type: 'text/css', body: '.block{display:block;padding:8px 0}@media(min-width:800px){.md-inline{display:inline;padding:0}}' },
    '/a.html': { type: 'text/html', body: page('/imp.css') },
    '/missing.html': { type: 'text/html', body: page('/nope.css') },
  });
  // TRUE defect (reviewer repro): the display:inline at >=800px lives in an @import'ed sheet
  await withPage(t, '', async (p) => {
    const r = row('TargetSize', '#a1', '<a id="a1" class="block md-inline" href="/1">', 'accessScan');
    await applyMeasuredChecks(p, [r], { viewports: [VPS[0]], url: `${origin}/a.html` });
    assert.equal(r.verdict, 'confirmed');
    assert.equal(measured(r, '1280x900').status, 'fail');
  }, { origin: `${origin}/a.html` });
  // FALSE positive kept: the imported sheet is absent, so no rule sets the display
  await withPage(t, '', async (p) => {
    const r = row('TargetSize', '#a1', '<a id="a1" class="block md-inline" href="/1">', 'accessScan');
    await applyMeasuredChecks(p, [r], { viewports: [VPS[0]], url: `${origin}/missing.html` });
    assert.equal(r.verdict, 'needs-review');
    assert.match(r.reason, /display class \(block\) is not in effect/);
  }, { origin: `${origin}/missing.html` });
});

test('target size: --no-hydrate-jobs: the fresh re-measure keeps the scanned page\'s request blocking (a blocked script never runs there); a failure that only the blocked script hides still confirms', async (t) => {
  const { origin, hits } = await serveFiles(t, {
    '/job-list.js': { type: 'text/javascript', body: "document.querySelectorAll('li')[1].style.marginTop='80px'" },
    '/b.html': { type: 'text/html', body: `${HEAD}<style>ul{margin:0;padding:0;list-style:none;position:absolute;left:10px;top:100px}li{height:20px}@media(min-width:800px){li{height:60px}}</style><script src="/job-list.js" defer></script></head><body><ul><li><a id="a1" href="/1">First link</a></li><li><a id="a2" href="/2">Second link</a></li></ul></body></html>` },
  });
  const scan = async (noHydrateJobs) => {
    let r;
    await withPage(t, '', async (p) => {
      await installNoHydrateJobsRoutes(p);
      await p.goto(`${origin}/b.html`);
      r = row('target-size', '#a1', '<a id="a1" href="/1">');
      hits['/job-list.js'] = 0;
      await applyMeasuredChecks(p, [r], { viewports: VPS, url: `${origin}/b.html`, noHydrateJobs });
    });
    return r;
  };
  const r = await scan(true);
  assert.equal(r.verdict, 'confirmed', 'TRUE defect: with the widget script blocked the links crowd at 390');
  assert.equal(measured(r, '390x844').status, 'fail');
  assert.equal(hits['/job-list.js'], 0, 'the blocked script never reached the server from the fresh page');
  // original behaviour without the option: the fresh page runs the script, so the resize-only crowding is not confirmed
  assert.notEqual((await scan(false)).verdict, 'confirmed');
});

test('target size: two 60x20 fixed px links 0.5px inside each other\'s circle confirm; the same overlap between inline text boxes stays needs-review', async (t) => {
  await withPage(t, '<a id="b1" class="abs" style="left:10px;top:100px;width:60px;height:20px" href="/1">One</a><a id="b2" class="abs" style="left:10px;top:123.5px;width:60px;height:20px" href="/2">Two</a>', async (page) => {
    const r = row('target-size', '#b1', '<a id="b1" class="abs" style="left:10px;top:100px;width:60px;height:20px" href="/1">', 'axe');
    await applyMeasuredChecks(page, [r], { viewports: VPS });
    assert.equal(r.verdict, 'confirmed', 'deterministic px geometry, no font metrics');
    assert.equal(measured(r, '1280x900').clearance, -0.5);
  });
  // inline links with centres 23.5px apart: the 24px circles overlap by 0.5px and the box height is the platform font's
  await withPage(t, '<div style="position:absolute;left:10px;top:100px"><a id="i1" href="/1">One</a></div><div style="position:absolute;left:10px;top:123.5px"><a id="i2" href="/2">Two</a></div>', async (page) => {
    const r = row('target-size', '#i1', '<a id="i1" href="/1">', 'axe');
    await applyMeasuredChecks(page, [r], { viewports: [VPS[0]] });
    assert.equal(r.verdict, 'needs-review');
    assert.equal(measured(r, '1280x900').status, 'review');
  });
});

// ─── layout that only exists after a resize ──────────────────────────────────

// A script fixes a margin at load on a wide screen (never re-run on resize): resized to 390 the two links crowd, a visitor who loads at 390 gets 60px of space.
const SPACED_ON_LOAD = (script) => `${HEAD}<style>#wrap a{display:block;width:80px;height:18px}#b{margin-top:60px}@media(min-width:800px){#wrap{display:flex}#b{margin-left:400px;margin-top:0}}</style></head>
  <body><div id="wrap" style="padding:20px"><a id="a" href="/a">A</a><a id="b" href="/b">B</a></div><script>${script}</script></body></html>`;

test('target size: a failure that only exists after resizing a page that fixed its layout at load is re-measured on a fresh load (needs-review); a page that really crowds at that width still confirms', async (t) => {
  const stale = await serve(t, SPACED_ON_LOAD("if (innerWidth >= 800) document.getElementById('b').style.marginTop = '0';"));
  await withPage(t, '', async (page) => {
    const r = row('target-size', '#a', '<a id="a" href="/a">');
    await applyMeasuredChecks(page, [r], { viewports: VPS, url: stale });
    assert.notEqual(r.verdict, 'confirmed', 'a visitor loading at 390 sees 60px between the links');
    assert.equal(measured(r, '390x844').status, 'pass');
  }, { origin: stale });
  const real = await serve(t, SPACED_ON_LOAD('/* no script: 390 wide really has B at margin-top 0 */').replace('#b{margin-top:60px}', '#b{margin-top:0}'));
  await withPage(t, '', async (page) => {
    const r = row('target-size', '#a', '<a id="a" href="/a">');
    await applyMeasuredChecks(page, [r], { viewports: VPS, url: real });
    assert.equal(r.verdict, 'confirmed', 'TRUE defect: crowded on a fresh load at 390');
    assert.equal(measured(r, '390x844').status, 'fail');
    assert.match(r.evidence.proof.fact, /at viewport 390x844/);
  }, { origin: real });
});

test('target size: a failure the engines skipped is reported only when a fresh load at that width shows it too (the tool-owned scan of all undersized targets)', async (t) => {
  const stale = await serve(t, SPACED_ON_LOAD("if (innerWidth >= 800) document.getElementById('b').style.marginTop = '0';"));
  await withPage(t, '', async (page) => {
    const { added } = await applyMeasuredChecks(page, [], { viewports: VPS, url: stale });
    assert.equal(added.length, 0, 'FALSE positive: resize-only crowding is not added as a finding');
  }, { origin: stale });
  const real = await serve(t, SPACED_ON_LOAD('').replace('#b{margin-top:60px}', '#b{margin-top:0}'));
  await withPage(t, '', async (page) => {
    const { added } = await applyMeasuredChecks(page, [], { viewports: VPS, url: real });
    assert.equal(added.length, 1, 'TRUE defect: crowded on a fresh load at 390 is reported');
    assert.equal(added[0].verdict, 'confirmed');
    assert.match(added[0].evidence.proof.fact, /at viewport 390x844/);
  }, { origin: real });
});

test('own-text narrowing reads every tag of a candidate line: the FR link of an `EN | FR` line is told apart from a link with the same href', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-l1-'));
  try {
    mkdirSync(join(root, 'src/partials'), { recursive: true });
    writeFileSync(join(root, 'src/partials/footer.liquid'), '<a href="/our-people" target="_blank">Nos employ\u00e9s</a>\n<a href="https://careers.example.ca">EN</a> | <a class="selected" href="/">FR</a>\n');
    writeFileSync(join(root, 'src/partials/header.liquid'), '<a href="/our-people">Our people</a>\n');
    const list = [{ file: 'src/partials/header.liquid', line: 1 }, { file: 'src/partials/footer.liquid', line: 1 }, { file: 'src/partials/footer.liquid', line: 2 }];
    // FALSE positive of round 5: the FR link was attributed to line 1 (same href)
    assert.deepEqual(narrowByOwnText(list, '<a class="selected" href="http://127.0.0.1:6216/our-people">FR</a>', root), [list[2]]);
    // TRUE: a link whose text the template wrote on line 1 still narrows to line 1
    assert.deepEqual(narrowByOwnText(list, '<a href="http://127.0.0.1:6216/our-people" target="_blank">Nos employ\u00e9s</a>', root), [list[1]]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
