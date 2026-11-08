import './helpers/hermetic-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closeBrowser } from '../src/scanner/browser.js';
import { aggregateLabel, aggregateTarget, applyMeasuredChecks, judgeContrast, judgeLabel, judgeTarget } from '../src/scanner/measured-checks.js';
import { requireBrowser } from './helpers/require-browser.js';

const VPS = [{ name: 'desktop', width: 1280, height: 900 }];
const PX = 'data:image/gif;base64,R0lGODlhAQABAAAAACw=';

async function withPage(t, html, fn) {
  const browser = await requireBrowser(t);
  if (!browser) return;
  t.after(closeBrowser);
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  try {
    await page.setContent(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>t</title><style>body{margin:0;font:16px/1.5 sans-serif}.abs{position:absolute;display:block;padding:0}</style></head><body>${html}</body></html>`);
    await fn(page);
  } finally { await page.context().close(); }
}
const row = (ruleId, selector, layer = 'axe', evidence = {}) => ({ ruleId, layer, element: { selector, outerHTML: `<a id="${selector.slice(1)}">` }, verdict: 'confirmed', kind: 'deterministic', evidence });
const run = async (page, ruleId, ids, layer) => {
  const rows = ids.map((s) => row(ruleId, s, layer));
  await applyMeasuredChecks(page, rows, { viewports: VPS });
  return Object.fromEntries(rows.map((r) => [r.element.selector, r]));
};

// ─── contrast ────────────────────────────────────────────────────────────────

test('contrast: an unmeasured backdrop is not a measurement', () => {
  const s = { fg: [0, 0, 0, 1], bg: [255, 255, 255], opacity: 1, fontPx: 16, weight: 400, image: false, unmeasured: 'backdrop painted by a sibling' };
  assert.equal(judgeContrast(s, s).state, 'unmeasured');
});

test('contrast: ancestor opacity above the background owner does not change the ratio; opacity below it does', async (t) => {
  await withPage(t, `
    <div style="opacity:.5"><div style="background:#fff"><p id="above" style="margin:0;color:#999">Above</p></div></div>
    <div style="background:#fff"><p id="below" style="margin:0;color:#000;opacity:.5">Below</p></div>
    <div style="background:#fff"><p id="plain" style="margin:0;color:#999">Plain</p></div>`, async (page) => {
    const by = await run(page, 'color-contrast', ['#above', '#below', '#plain']);
    assert.equal(by['#above'].verdict, 'needs-review', 'a translucent ancestor above the owner: not decidable from colours');
    assert.equal(by['#below'].verdict, 'confirmed', 'black at 50% on white is 3.9:1');
    assert.equal(by['#plain'].verdict, 'confirmed');
  });
});

test('contrast: no opaque background reports unmeasured (never white) when a sibling paints behind; a bare page still measures against the white canvas', async (t) => {
  await withPage(t, `
    <div style="position:relative;height:60px"><div style="position:absolute;inset:0;background:#000"></div><p id="hero" style="position:relative;margin:0;color:#ddd">Over a dark overlay</p></div>
    <p id="bare" style="margin:0;color:#bbb">On the canvas</p>`, async (page) => {
    const by = await run(page, 'color-contrast', ['#hero', '#bare']);
    assert.equal(by['#hero'].verdict, 'needs-review');
    assert.match(by['#hero'].evidence.reviewReason, /backdrop|unmeasured|not decidable/i);
    assert.equal(by['#bare'].verdict, 'confirmed');
  });
});

test('contrast: text over a background image is needs-review unless glyph pixels proved it; inactive components and logotypes are needs-review', async (t) => {
  await withPage(t, `
    <div style="background:#fff url(${PX})"><p id="img" style="margin:0;color:#bbb">Over an image</p><p id="imgpx" style="margin:0;color:#bbb">Sampled</p></div>
    <div style="background:#fff">
      <button id="dis" disabled style="color:#bbb">Disabled</button>
      <a id="ariadis" href="/x" aria-disabled="true" style="color:#bbb">Soon</a>
      <fieldset disabled style="border:0"><span id="fs" style="color:#bbb">In disabled fieldset</span></fieldset>
      <a id="logo" class="site-logo" href="/" style="color:#bbb">Acme</a>
      <a id="real" href="/y" style="color:#bbb">Real low contrast</a>
    </div>`, async (page) => {
    const rows = ['#img', '#imgpx', '#dis', '#ariadis', '#fs', '#logo', '#real'].map((s) => row('color-contrast', s, 'axe', s === '#imgpx' ? { pixelContrast: { method: 'glyph-pixel-sampling', verdict: 'confirmed', min: 1.6 } } : {}));
    await applyMeasuredChecks(page, rows, { viewports: VPS });
    assert.deepEqual(rows.map((r) => r.verdict), ['needs-review', 'confirmed', 'needs-review', 'needs-review', 'confirmed', 'needs-review', 'confirmed']); // #fs: plain text in a disabled fieldset is not a control
  });
});

test('contrast: a link rgb(0,175,240) at 18px weight 300 on a white footer is confirmed with a traced ratio; a dark link passes', async (t) => {
  await withPage(t, `
    <footer style="background:#fff;padding:20px">
      <a id="bell" href="/f" style="color:rgb(0,175,240);font:300 18px/1.5 sans-serif">Footer link</a>
      <a id="ok" href="/g" style="color:#222;font:300 18px/1.5 sans-serif">Dark link</a>
    </footer>`, async (page) => {
    const by = await run(page, 'color-contrast', ['#bell', '#ok']);
    assert.equal(by['#bell'].verdict, 'confirmed');
    const c = by['#bell'].evidence.measured.contrast;
    assert.equal(c.state, 'stable');
    assert.ok(c.ratio > 2.3 && c.ratio < 2.7, `ratio ${c.ratio}`);
    assert.equal(c.threshold, 4.5);
    assert.equal(by['#bell'].evidence.proof.type, 'computed-ratio');
    assert.match(by['#bell'].evidence.proof.fact, /2\.\d+:1/);
    assert.equal(by['#ok'].verdict, 'needs-review');
  });
});

// ─── target size ─────────────────────────────────────────────────────────────

const A = (id, css, inner = '') => `<a id="${id}" class="abs" href="/${id}" style="${css}">${inner}</a>`;

test('target size: judgement of an author-resized native control, essential and inline exceptions', () => {
  const m = { w: 16, h: 16, ua: true, uaResized: true, clearance: -5 };
  assert.equal(judgeTarget(m).status, 'review');
  assert.equal(judgeTarget({ ...m, uaResized: false }).status, 'pass');
  assert.equal(aggregateTarget([{ viewport: { width: 1, height: 1 }, m }]).verdict, 'needs-review');
});

test('target size: the hit area is the union of the element and its descendants, not the inline fragment', async (t) => {
  await withPage(t, `
    <p style="margin:20px"><a id="icon" href="/i" style="display:inline"><span style="display:inline-block;width:32px;height:32px"></span></a></p>
    ${A('nb', 'left:36px;top:20px;width:12px;height:12px')}
    <p style="position:absolute;left:300px;top:200px;margin:0"><a id="small" href="/s" style="display:inline"><span style="display:inline-block;width:12px;height:12px"></span></a></p>
    ${A('nb2', 'left:314px;top:200px;width:12px;height:12px')}`, async (page) => {
    const by = await run(page, 'target-size', ['#icon', '#small']);
    assert.equal(by['#icon'].verdict, 'needs-review', '32x32 hit area');
    assert.equal(by['#small'].verdict, 'confirmed', 'a genuinely small hit area still fails (paired)');
  });
});

test('target size: an inner role node is measured as its outer native control', async (t) => {
  await withPage(t, `
    <button id="outer" class="abs" style="left:100px;top:100px;width:44px;height:44px"><span id="inner" role="button" tabindex="0" style="position:absolute;right:0;top:16px;width:12px;height:12px"></span></button>
    <button id="nb" class="abs" style="left:146px;top:110px;width:20px;height:20px"></button>`, async (page) => {
    const by = await run(page, 'target-size', ['#inner']);
    assert.equal(by['#inner'].verdict, 'needs-review');
    assert.equal(by['#inner'].evidence.measured[0].w, 44);
  });
});

test('target size: a large link behind a small control is not a neighbour; two small controls on it still crowd each other (paired)', async (t) => {
  await withPage(t, `
    <div style="position:relative;height:200px">
      <a href="/card" class="abs" style="left:0;top:0;width:400px;height:200px;z-index:0"></a>
      <button id="b1" class="abs" style="left:100px;top:50px;width:12px;height:12px;z-index:1"></button>
      <button id="b2" class="abs" style="left:300px;top:150px;width:12px;height:12px;z-index:1"></button>
      <button id="c1" class="abs" style="left:300px;top:100px;width:12px;height:12px;z-index:1"></button>
      <button id="c2" class="abs" style="left:314px;top:100px;width:12px;height:12px;z-index:1"></button>
    </div>`, async (page) => {
    const by = await run(page, 'target-size', ['#b1', '#b2', '#c1']);
    assert.equal(by['#b1'].verdict, 'needs-review');
    assert.equal(by['#b2'].verdict, 'needs-review');
    assert.equal(by['#c1'].verdict, 'confirmed');
  });
});

test('target size: a neighbour whose centre is covered but whose edge is reachable still counts', async (t) => {
  await withPage(t, `
    ${A('x', 'left:100px;top:100px;width:12px;height:12px')}
    <button id="n" class="abs" style="left:114px;top:96px;width:30px;height:20px"></button>
    <div class="abs" style="left:124px;top:101px;width:10px;height:10px;background:#f00"></div>`, async (page) => {
    const by = await run(page, 'target-size', ['#x']);
    assert.equal(by['#x'].verdict, 'confirmed');
  });
});

test('target size: role controls without tabindex and the label of a visually hidden checkbox are targets and neighbours', async (t) => {
  await withPage(t, `
    ${A('a1', 'left:100px;top:100px;width:12px;height:12px')}
    <span id="r1" role="button" class="abs" style="left:114px;top:100px;width:12px;height:12px"></span>
    ${A('a2', 'left:300px;top:100px;width:12px;height:12px')}
    <input type="checkbox" id="cb" style="position:absolute;opacity:0;left:0;top:0;width:1px;height:1px">
    <label id="lab" for="cb" class="abs" style="left:314px;top:100px;width:12px;height:12px"></label>`, async (page) => {
    const by = await run(page, 'target-size', ['#a1', '#a2', '#lab']);
    assert.equal(by['#a1'].verdict, 'confirmed', 'role=button without tabindex crowds it');
    assert.equal(by['#a2'].verdict, 'confirmed', 'the label of a hidden checkbox crowds it');
    assert.equal(by['#lab'].verdict, 'confirmed', 'and is itself a target');
  });
});

test('target size: an author-resized checkbox is needs-review; a default one is the user agent exception', async (t) => {
  await withPage(t, `
    <input id="big" type="checkbox" class="abs" style="left:100px;top:100px;width:16px;height:16px;margin:0">
    ${A('nbr', 'left:120px;top:100px;width:12px;height:12px')}
    <input id="def" type="checkbox" class="abs" style="left:300px;top:100px;margin:0">
    ${A('nbd', 'left:316px;top:100px;width:12px;height:12px')}`, async (page) => {
    const by = await run(page, 'target-size', ['#big', '#def']);
    assert.equal(by['#big'].verdict, 'needs-review');
    assert.match(by['#big'].evidence.reviewReason, /author-resized/i);
    assert.equal(by['#def'].verdict, 'needs-review');
  });
});

// ─── label in name ───────────────────────────────────────────────────────────

test('label in name: accents compose, long untitled card text is a review item', () => {
  assert.equal(judgeLabel({ label: 'Café menu', name: 'Café menu' }), 'pass');
  const long = 'one two three four five six seven eight nine ten eleven twelve';
  assert.equal(judgeLabel({ label: long, name: 'Open' }), 'review');
  assert.equal(judgeLabel({ label: 'Apply now', name: 'Submit' }), 'fail');
  assert.equal(aggregateLabel([{ viewport: { width: 1, height: 1 }, m: { label: long, name: 'Open' } }]).verdict, 'needs-review');
});

test('label in name: the alt of an image input is not visible text', async (t) => {
  await withPage(t, `<input id="img" type="image" src="${PX}" alt="Search" aria-label="Go" width="30" height="30"><input id="btn" type="submit" value="Search" aria-label="Go">`, async (page) => {
    const rows = ['#img', '#btn'].map((s) => row('VisibleTextPartOfAccessibleName', s, 'accessScan'));
    await applyMeasuredChecks(page, rows, { viewports: VPS });
    assert.deepEqual(rows.map((r) => r.verdict), ['needs-review', 'confirmed']);
  });
});

// ─── round 4 review: counterexamples ────────────────────────────────────────

test('target size: author-sized inline-block icon links are not the inline exception (row of 20px icons, with or without a sentence)', async (t) => {
  const ic = (id) => `<a id="${id}" href="/${id}" style="display:inline-block;width:20px;height:20px;margin-right:2px;background:#036;vertical-align:top"></a>`;
  await withPage(t, `
    <div style="margin:20px;font:16px/24px sans-serif"><h3 style="margin:0">Follow us</h3>${ic('s1')}${ic('s2')}</div>
    <p style="margin:20px;font:16px/24px sans-serif">Share this story: ${ic('t1')}${ic('t2')}</p>`, async (page) => {
    const by = await run(page, 'target-size', ['#s1', '#s2', '#t1', '#t2']);
    for (const k of ['#s1', '#s2', '#t1', '#t2']) assert.equal(by[k].verdict, 'confirmed', k);
  });
});

test('target size: a descendant clipped by the control overflow does not enlarge the hit area', async (t) => {
  await withPage(t, `<div style="margin:20px"><a id="sp1" href="/a" style="display:inline-block;width:14px;height:14px;overflow:hidden;vertical-align:top"><span style="display:block;width:200px;height:200px;margin-left:-20px;background:#036"></span></a><a id="sp2" href="/b" style="display:inline-block;width:14px;height:14px;overflow:hidden;vertical-align:top;margin-left:2px"><span style="display:block;width:200px;height:200px;margin-left:-40px;background:#036"></span></a></div>`, async (page) => {
    const by = await run(page, 'target-size', ['#sp1']);
    assert.equal(by['#sp1'].verdict, 'confirmed');
  });
});

test('contrast: logo and disabled exemptions apply to the logo or the control, not to any text near the word logo or inside a disabled fieldset', async (t) => {
  const L = '#bbb';
  await withPage(t, `<div style="background:#fff">
    <div class="logo-wall"><h2 style="margin:0"><span id="t1" style="color:${L}">Trusted by teams worldwide</span></h2></div>
    <div class="has-logo"><p id="t2" style="margin:0;color:${L}">Body copy that is real text</p></div>
    <div aria-label="Company logo gallery"><p id="t3" style="margin:0;color:${L}">Gallery caption</p></div>
    <fieldset disabled style="border:0"><legend><span id="lg" style="color:${L}">Choose a plan</span></legend><p id="hp" style="margin:0;color:${L}">Fill in the details below.</p><label for="di" id="dl" style="color:${L}">Disabled field</label><input id="di"></fieldset>
    <a id="ok" href="/h" class="site-logo" style="color:${L}">Acme</a><img src="${PX}" alt="Acme logo" style="display:none">
    </div>`, async (page) => {
    const by = await run(page, 'color-contrast', ['#t1', '#t2', '#t3', '#lg', '#hp', '#dl', '#ok']);
    for (const k of ['#t1', '#t2', '#t3', '#lg', '#hp']) assert.equal(by[k].verdict, 'confirmed', k);
    assert.equal(by['#dl'].verdict, 'needs-review', 'the label of a disabled control stays exempt');
    assert.equal(by['#ok'].verdict, 'needs-review', 'a link whose own class says logo stays exempt');
  });
});

test('contrast: oklch and other non-rgb colours are read, not defaulted to black or white', async (t) => {
  await withPage(t, `<p id="o1" style="margin:0;background:#fff;color:oklch(0.8 0 0)">Light grey text</p>
    <p id="o2" style="margin:0;background:oklch(0.88 0 0);color:#767676">Grey on grey</p>
    <p id="o3" style="margin:0;background:#fff;color:oklch(0.2 0 0)">Dark text passes</p>`, async (page) => {
    const by = await run(page, 'color-contrast', ['#o1', '#o2', '#o3']);
    assert.equal(by['#o1'].verdict, 'confirmed', 'oklch 0.8 on white is about 1.7:1');
    assert.equal(by['#o2'].verdict, 'confirmed', '#767676 on oklch 0.88 is below 4.5:1');
    assert.equal(by['#o3'].verdict, 'needs-review', 'a passing measurement is not a confirmed failure');
  });
});

test('contrast: white text on a dark sibling is unmeasured even when the element straddles the fold', async (t) => {
  await withPage(t, `<div style="position:relative;margin-top:840px;height:300px"><div style="position:absolute;inset:0;background:#000"></div><p id="h1" style="position:relative;margin:0;height:200px;color:#fff">Hero text</p></div>`, async (page) => {
    const by = await run(page, 'color-contrast', ['#h1']);
    assert.equal(by['#h1'].verdict, 'needs-review');
  });
});

test('target size: a stretched-link ::after overlay is the hit area, a small decorative one is not', async (t) => {
  const css = '<style>.card{position:relative;margin:20px;width:300px;height:200px;border:1px solid #999;font:12px/14px sans-serif}.stretched::after{content:"";position:absolute;inset:0}.dot::after{content:"";position:absolute;right:0;top:0;width:4px;height:4px}.over{position:relative;z-index:2}</style>';
  await withPage(t, `${css}<div class="card"><a id="t" class="stretched" href="/job/1" style="display:block;width:60px;margin:8px 8px 2px">Engineer</a><a id="s" class="over" href="/save" style="display:block;width:60px;margin:0 8px">Save job</a></div>
    <div class="card"><a id="d" class="dot" href="/job/2" style="display:block;width:60px;margin:8px 8px 2px">Engineer</a><a id="s2" class="over" href="/save" style="display:block;width:60px;margin:0 8px">Save job</a></div>`, async (page) => {
    const by = await run(page, 'target-size', ['#t', '#d']);
    assert.notEqual(by['#t'].verdict, 'confirmed', 'the pointer hits the whole card');
    assert.equal(by['#d'].verdict, 'confirmed', 'a 4px pseudo-element is not a hit area');
  });
});
