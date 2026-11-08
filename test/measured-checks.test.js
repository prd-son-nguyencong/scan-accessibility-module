import './helpers/hermetic-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closeBrowser } from '../src/scanner/browser.js';
import { aggregateLabel, aggregateTarget, applyMeasuredChecks, judgeContrast, judgeLabel, judgeTarget, targetViewportNote } from '../src/scanner/measured-checks.js';
import { requireBrowser } from './helpers/require-browser.js';

const VPS = [{ name: 'desktop', width: 1280, height: 900 }, { name: 'mobile', width: 390, height: 844 }];
const PX = 'data:image/gif;base64,R0lGODlhAQABAAAAACw=';

// ─── pure judgements ─────────────────────────────────────────────────────────

test('target size: boundary cases from the WCAG 2.5.8 definition', () => {
  const m = (o) => ({ w: 20, h: 20, inline: false, ua: false, nearest: 4, clearance: -1, ...o });
  assert.equal(judgeTarget(m({ w: 24, h: 24 })).status, 'pass', '24 x 24 passes by size');
  assert.equal(judgeTarget(m({ w: 44, h: 44, clearance: -10 })).status, 'pass', '44px targets pass by size');
  assert.equal(judgeTarget(m({ w: 23.6, h: 30 })).status, 'fail', '23.6 wide with an intersecting circle fails');
  assert.equal(judgeTarget(m({ clearance: 0 })).status, 'pass', 'circles just touching do not intersect');
  assert.equal(judgeTarget(m({ clearance: -0.1, fontBox: true })).status, 'review', 'an overlap under 1px of an inline text box is font-metric rounding, not decidable');
  assert.equal(judgeTarget(m({ clearance: -0.1 })).status, 'fail', 'a fixed px box has no font noise: any overlap fails');
  assert.equal(judgeTarget(m({ clearance: -1 })).status, 'fail', 'one full pixel of overlap is a measured failure');
  assert.equal(judgeTarget(m({ clearance: null, nearest: null })).status, 'pass', 'no neighbour at all');
  assert.equal(judgeTarget(m({ inline: true })).status, 'pass');
  assert.equal(judgeTarget(m({ ua: true })).status, 'pass');
  assert.equal(judgeTarget({ hidden: true }).status, 'n/a');
  assert.equal(judgeTarget(m({ equivalent: true })).status, 'pass', 'the same function in a 24px target');
  assert.equal(judgeTarget(m({ vendorOnly: true })).status, 'review', 'the failing neighbour is a vendor control');
  assert.equal(judgeTarget(m({ vendor: true })).status, 'review');
  assert.equal(judgeTarget(m({ vendorOnly: true, clearance: 3 })).status, 'pass', 'no intersection, nothing to review');
});

test('target size: a failure that depends on a vendor control is needs-review, never confirmed; a real failure elsewhere still wins', () => {
  const vendor = { w: 101, h: 18, nearest: 0, clearance: -3, vendorOnly: true };
  const own = { w: 101, h: 18, nearest: 2, clearance: -1, vendorOnly: false };
  const only = aggregateTarget([{ viewport: { width: 390, height: 844 }, m: vendor }]);
  assert.equal(only.verdict, 'needs-review');
  assert.match(only.reason, /^depends on a third-party control: 101 x 18, nearest neighbour distance 0px, circle clearance -3px at viewport 390x844/);
  assert.equal(aggregateTarget([{ viewport: { width: 390, height: 844 }, m: vendor }, { viewport: { width: 1280, height: 900 }, m: own }]).verdict, 'confirmed');
});

test('target size proof: numbers and viewport; a failure at one viewport says so; a pass is needs-review with the reason', () => {
  const failing = { w: 20, h: 20, nearest: 3, clearance: -1.2 };
  const clear = { w: 20, h: 20, nearest: 40, clearance: 28 };
  const one = aggregateTarget([{ viewport: { width: 390, height: 844 }, m: failing }, { viewport: { width: 1280, height: 900 }, m: clear }]);
  assert.equal(one.verdict, 'confirmed');
  assert.equal(one.proof.type, 'measured-fact');
  assert.match(one.proof.fact, /^20 x 20, nearest neighbour distance 3px, circle clearance -1\.2px at viewport 390x844; fails only at 390x844/);
  const pass = aggregateTarget([{ viewport: { width: 390, height: 844 }, m: clear }]);
  assert.equal(pass.verdict, 'needs-review');
  assert.match(pass.reason, /spacing exception.*circle clearance 28px at viewport 390x844/);
  assert.match(aggregateTarget([{ viewport: { width: 390, height: 844 }, m: null }]).reason, /not measurable/);
});

test('target size: the finding text names the failing viewport and its clearance, and the viewport that passes (paired with a failure at every viewport)', () => {
  const failing = { w: 74.3, h: 18, nearest: 3, clearance: -2.9 };
  const clear = { w: 74.3, h: 18, nearest: 40, clearance: 28 };
  const mobileOnly = aggregateTarget([{ viewport: { width: 1280, height: 900 }, m: clear }, { viewport: { width: 390, height: 844 }, m: failing }]);
  assert.equal(targetViewportNote(mobileOnly), 'Fails at viewport 390x844 (74.3 x 18, circle clearance -2.9px); 1280x900: pass, so measure at the failing viewport.');
  const both = aggregateTarget([{ viewport: { width: 1280, height: 900 }, m: failing }, { viewport: { width: 390, height: 844 }, m: failing }]);
  assert.equal(targetViewportNote(both), 'Fails at viewport 1280x900 (74.3 x 18, circle clearance -2.9px), 390x844 (74.3 x 18, circle clearance -2.9px).');
  assert.equal(targetViewportNote(aggregateTarget([{ viewport: { width: 390, height: 844 }, m: clear }])), null, 'nothing failed');
});

test('target size: an engine row that fails only at 390px carries the viewport and clearance in its hint (what the report and exported tasks print); a desktop-only reading does not invent one', async (t) => {
  await withPage(t, `<style>.s{display:block;width:60px;height:18px;margin-bottom:40px}.wrap{width:1000px}@media (max-width:600px){.s{margin-bottom:2px}}</style>
    <div class="wrap"><a id="a1" class="s" href="/1">One</a><a id="a2" class="s" href="/2">Two</a></div>
    <div style="position:absolute;left:500px;top:300px"><a id="lone" class="s" href="/3">Lone</a></div>`, async (page) => {
    const rows = ['#a1', '#lone'].map((s) => row('target-size', s));
    rows.forEach((r) => { r.fix = { hint: 'Ensure touch targets have sufficient size and space' }; });
    await applyMeasuredChecks(page, rows, { viewports: VPS });
    const [a1, lone] = rows;
    assert.equal(a1.verdict, 'confirmed');
    assert.match(a1.fix.hint, /^Ensure touch targets have sufficient size and space\. Fails at viewport 390x844 \(60 x 18, circle clearance -[\d.]+px\); 1280x900: pass, so measure at the failing viewport\.$/);
    assert.notEqual(lone.verdict, 'confirmed');
    assert.equal(lone.fix.hint, 'Ensure touch targets have sufficient size and space', 'no failure, no note');
  });
});

test('label in name: no visible label and symbols are not applicable; case and whitespace are normalised', () => {
  assert.equal(judgeLabel({ label: '', name: 'Home' }), 'na');
  assert.equal(judgeLabel({ label: '×', name: 'Close' }), 'na');
  assert.equal(judgeLabel({ label: 'Start  your search', name: 'start your SEARCH now' }), 'pass');
  assert.equal(judgeLabel({ label: 'Start your search', name: 'Open chat' }), 'fail');
  assert.equal(judgeLabel({ label: 'Go', name: '' }), 'na');
  const v = aggregateLabel([{ viewport: { width: 1280, height: 900 }, m: { label: 'Start your search', name: 'Open chat' } }]);
  assert.deepEqual([v.verdict, v.proof.type], ['confirmed', 'name-vs-text']);
  assert.match(v.proof.fact, /visible text "Start your search" is not part of accessible name "Open chat"/);
});

test('label in name: a title plus separate caption passes when the name carries the title; a name without the title, or a one-block label, still fails', async (t) => {
  assert.equal(judgeLabel({ label: 'Return to work Watch on YouTube', name: 'Return to work (opens in new tab, watch video)', primary: 'Return to work' }), 'pass');
  assert.equal(judgeLabel({ label: 'Search Watch on YouTube', name: 'Find jobs', primary: 'Search' }), 'fail');
  assert.equal(judgeLabel({ label: 'Search', name: 'Find jobs' }), 'fail');
  await withPage(t, `
    <a id="card" href="/c" aria-label="Return to work confidently (opens in new tab, watch video)" style="display:flex"><div>Return to work <b>confidently</b></div><span>Watch on YouTube</span></a>
    <a id="bad" href="/b" aria-label="Find jobs" style="display:flex"><div>Search</div><span>Watch on YouTube</span></a>
    <a id="one" href="/o" aria-label="Find jobs">Search</a>`, async (page) => {
    const rows = ['#card', '#bad', '#one'].map((s) => row('VisibleTextPartOfAccessibleName', s, 'accessScan'));
    await applyMeasuredChecks(page, rows, { viewports: VPS });
    assert.deepEqual(rows.map((r) => r.verdict), ['needs-review', 'confirmed', 'confirmed']);
  });
});

test('label in name: a split label (tag, two words, reordered or longer caption) is still a mismatch; the title plus shorter caption passes', async (t) => {
  assert.equal(judgeLabel({ label: 'NEW Senior engineer', name: 'NEW', primary: 'NEW', rest: 'Senior engineer' }), 'fail');
  assert.equal(judgeLabel({ label: 'Read more Careers at Acme', name: 'Read more', primary: 'Read more', rest: 'Careers at Acme' }), 'fail');
  assert.equal(judgeLabel({ label: 'Return to work Watch on YouTube', name: 'Return to work', primary: 'Return to work', rest: 'Watch on YouTube' }), 'pass');
  await withPage(t, `
    <a id="tag" href="/1" aria-label="NEW" style="display:flex"><span>NEW</span><span>Senior engineer</span></a>
    <a id="words" href="/2" aria-label="Apply for job" style="display:flex"><span>Apply</span><span>Now</span></a>
    <a id="blocks" href="/3" aria-label="Learn about benefits"><span style="display:block">Learn</span><span style="display:block">more</span></a>
    <a id="rev" href="/4" aria-label="Read more" style="display:flex;flex-direction:column-reverse"><span>Read more</span><span>Careers</span></a>
    <a id="longcap" href="/5" aria-label="Read more" style="display:flex"><span>Read more</span><span>Careers at Acme</span></a>
    <a id="ok" href="/6" aria-label="Return to work (watch video)" style="display:flex"><div>Return to work</div><span>Watch on YouTube</span></a>`, async (page) => {
    const sels = ['#tag', '#words', '#blocks', '#rev', '#longcap', '#ok'];
    const rows = sels.map((s) => row('VisibleTextPartOfAccessibleName', s, 'accessScan'));
    await applyMeasuredChecks(page, rows, { viewports: VPS });
    assert.deepEqual(rows.map((r) => r.verdict), ['confirmed', 'confirmed', 'confirmed', 'confirmed', 'confirmed', 'needs-review']);
  });
});

test('contrast stability: a moving ratio is unstable, a steady one is judged', () => {
  const s = (a, bg = [255, 255, 255]) => ({ fg: [0, 0, 0, a], bg, opacity: 1, fontPx: 16, weight: 400, image: false });
  assert.equal(judgeContrast(s(0.3), s(1)).state, 'unstable');
  assert.equal(judgeContrast(s(1), s(1)).state, 'stable');
  assert.equal(judgeContrast({ ...s(1), image: true }, { ...s(1), image: true }).state, 'unmeasured');
});

// ─── live DOM ────────────────────────────────────────────────────────────────

async function withPage(t, html, fn) {
  const browser = await requireBrowser(t);
  if (!browser) return;
  t.after(closeBrowser);
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  try {
    await page.setContent(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>t</title><style>body{margin:0;font:16px/1.5 sans-serif}.abs{position:absolute;display:block}</style></head><body>${html}</body></html>`);
    await fn(page);
  } finally { await page.context().close(); }
}
const row = (ruleId, selector, layer = 'axe', html = `<a id="${selector.slice(1)}">`) => ({ ruleId, layer, element: { selector, outerHTML: html }, verdict: 'confirmed', kind: 'deterministic', evidence: {} });

test('target size: sibling footer links 8px apart pass (the engine flagged them), crowded 20px buttons fail, exact touching passes', async (t) => {
  await withPage(t, `
    <ul style="margin:0;padding:0;list-style:none;position:absolute;left:10px;top:300px">
      <li style="margin-bottom:8px"><a id="f1" href="/a" style="display:block;width:200px;height:17px">Alpha</a></li>
      <li style="margin-bottom:8px"><a id="f2" href="/b" style="display:block;width:200px;height:17px">Beta</a></li>
      <li><a id="f3" href="/c" style="display:block;width:200px;height:17px">Gamma</a></li>
    </ul>
    <a id="t1" class="abs" href="/1" style="left:600px;top:100px;width:20px;height:20px">1</a>
    <a id="t2" class="abs" href="/2" style="left:624px;top:100px;width:20px;height:20px">2</a>
    <a id="c1" class="abs" href="/3" style="left:600px;top:200px;width:20px;height:20px">3</a>
    <a id="c2" class="abs" href="/4" style="left:623px;top:200px;width:20px;height:20px">4</a>
    <a id="big1" class="abs" href="/5" style="left:900px;top:100px;width:44px;height:44px">5</a>
    <a id="big2" class="abs" href="/6" style="left:944px;top:100px;width:44px;height:44px">6</a>
    <a id="w236" class="abs" href="/7" style="left:900px;top:300px;width:23.6px;height:30px">7</a>
    <a id="w236b" class="abs" href="/8" style="left:920px;top:300px;width:23.6px;height:30px">8</a>`, async (page) => {
    const rows = ['#f1', '#f2', '#t1', '#t2', '#c1', '#c2', '#big1', '#w236'].map((s) => row('target-size', s));
    const { added } = await applyMeasuredChecks(page, rows, { viewports: VPS, url: 'http://127.0.0.1:1/' });
    const by = Object.fromEntries(rows.map((r) => [r.element.selector, r]));
    // false positives no longer confirmed: footer links with 8px spacing, touching circles, 44px targets
    for (const s of ['#f1', '#f2', '#t1', '#t2', '#big1']) {
      assert.equal(by[s].verdict, 'needs-review', s);
      assert.match(by[s].evidence.reviewReason, /measured geometry passes WCAG 2\.5\.8/, s);
    }
    // true positives stay confirmed, with the numbers and the viewport as proof
    for (const s of ['#c1', '#c2', '#w236']) {
      assert.equal(by[s].verdict, 'confirmed', s);
      assert.equal(by[s].evidence.proof.type, 'measured-fact');
      assert.match(by[s].evidence.proof.fact, /\d+(\.\d)? x \d+(\.\d)?, nearest neighbour distance [\d.]+px, circle clearance -[\d.]+px at viewport 1280x900/, s);
    }
    assert.match(by['#t1'].evidence.reviewReason, /circle clearance 0px/);
    // a failing target no engine row covers is reported with our proof (deterministic, measured)
    assert.ok(added.every((v) => v.layer === 'accessScan' && v.ruleId === 'TargetSize' && v.kind === 'deterministic' && v.verdict === 'confirmed' && v.evidence.proof.type === 'measured-fact'));
    assert.deepEqual(added.map((v) => v.element.selector).filter((s) => /w236b|c2|c1/.test(s)).length, 1, 'only #w236b is new (#c1, #c2 and #w236 have rows)');
    assert.match(added.find((v) => /w236b/.test(v.element.outerHTML)).evidence.proof.fact, /at viewport 1280x900/);
  });
});

test('target size: an inline link in a sentence is exempt; a link that fails at the mobile viewport only says so', async (t) => {
  await withPage(t, `
    <style>.pair a{position:absolute;top:500px;width:20px;height:20px;display:block}#m1{left:10px}#m2{left:60px}@media (max-width:500px){#m2{left:28px}}</style>
    <p style="position:absolute;top:50px;left:10px;margin:0;width:600px">Read our <a id="in1" href="/p" style="font-size:12px">privacy</a> and <a id="in2" href="/q" style="font-size:12px">terms</a> before you apply today.</p>
    <div class="pair"><a id="m1" href="/x">x</a><a id="m2" href="/y">y</a></div>`, async (page) => {
    const rows = ['#in1', '#in2', '#m1'].map((s) => row('target-size', s));
    await applyMeasuredChecks(page, rows, { viewports: VPS });
    assert.equal(rows[0].verdict, 'needs-review');
    assert.match(rows[0].evidence.reviewReason, /inline exception/);
    assert.equal(rows[2].verdict, 'confirmed');
    assert.match(rows[2].evidence.proof.fact, /at viewport 390x844; fails only at 390x844/);
    assert.equal(page.viewportSize().width, 1280, 'the shared page is put back');
  });
});

test('label in name: a logo link whose text is font-size:0 and whose img alt is empty has no visible label; a visible label missing from the name is confirmed', async (t) => {
  await withPage(t, `
    <a id="logo1" href="/" style="display:block;margin:5px"><span style="font-size:0">Acme home</span><img src="${PX}" alt="" width="40" height="20"></a>
    <a id="logo2" href="/" style="display:block;margin:5px"><span style="position:absolute;clip:rect(0,0,0,0);width:1px;height:1px;overflow:hidden">Acme home</span><img src="${PX}" alt="" width="40" height="20"></a>
    <button id="chat" aria-label="Open chat">Start your search</button>
    <a id="ok" href="/s" aria-label="Start your search now">Start your search</a>
    <a id="imgonly" href="/i" aria-label="Open chat"><img src="${PX}" alt="Careers" width="40" height="20"></a>
    <a id="plainlink" href="/p" title="Elsewhere">Plain link</a>
    <button id="lost" aria-label="Open menu">Browse jobs</button>`, async (page) => {
    const rows = ['#logo1', '#logo2', '#chat', '#ok'].map((s) => row('label-content-name-mismatch', s, 'lighthouse'));
    const { added } = await applyMeasuredChecks(page, rows, { viewports: VPS });
    const by = Object.fromEntries(rows.map((r) => [r.element.selector, r]));
    for (const s of ['#logo1', '#logo2']) {
      assert.equal(by[s].verdict, 'needs-review', s);
      assert.equal(by[s].evidence.reviewReason, 'no visible label in rendered text');
    }
    assert.equal(by['#ok'].verdict, 'needs-review');
    assert.match(by['#ok'].evidence.reviewReason, /contained in the accessible name/);
    assert.equal(by['#chat'].verdict, 'confirmed');
    assert.deepEqual([by['#chat'].evidence.visibleText, by['#chat'].evidence.accessibleName], ['Start your search', 'Open chat']);
    assert.equal(by['#chat'].evidence.proof.type, 'name-vs-text');
    const ids = added.map((v) => v.element.selector).sort();
    assert.deepEqual(ids, ['#lost'], 'failing controls no engine reported; image-only links (an alt is not visible text) and the logos are never reported');
    assert.ok(added.every((v) => v.layer === 'accessScan' && v.ruleId === 'VisibleTextPartOfAccessibleName' && v.evidence.proof.type === 'name-vs-text'));
  });
});

test('label in name: a one-character glyph and the value text of a slider are not text labels (reviewer reproduction: rule-seeds ButtonDiscernible and DraggingAlternative twins)', async (t) => {
  assert.equal(judgeLabel({ label: 'x', name: 'Close' }), 'na');
  assert.equal(judgeLabel({ label: '1', name: 'Level' }), 'review'); // a lone digit is speakable: never a confirmed failure, never silent
  assert.equal(judgeLabel({ label: '1', name: 'Slide 1' }), 'pass');
  assert.equal(judgeLabel({ label: 'Go', name: 'Open chat' }), 'fail', 'a two-letter label is still a label');
  // A single ideograph, kana or hangul syllable is a whole spoken word, so a mismatch with the name is a real failure.
  assert.equal(judgeLabel({ label: '送', name: 'Submit' }), 'fail');
  assert.equal(judgeLabel({ label: '検', name: 'Search' }), 'fail');
  assert.equal(judgeLabel({ label: 'あ', name: 'Submit' }), 'fail');
  assert.equal(judgeLabel({ label: '가', name: 'Submit' }), 'fail');
  await withPage(t, `
    <button id="glyph" type="button" aria-label="Close">x</button>
    <div id="slider" role="slider" tabindex="0" aria-valuenow="1" aria-valuemin="0" aria-valuemax="5" aria-label="Level">1</div>
    <div id="big" role="slider" tabindex="0" aria-valuenow="10" aria-valuemin="0" aria-valuemax="50" aria-label="Level">10 of 50</div>
    <button id="lost" aria-label="Open menu">Browse jobs</button>`, async (page) => {
    const rows = ['#glyph', '#slider', '#big'].map((s) => row('VisibleTextPartOfAccessibleName', s));
    const { added } = await applyMeasuredChecks(page, rows, { viewports: VPS });
    assert.deepEqual(rows.map((r) => r.verdict), ['needs-review', 'needs-review', 'needs-review']);
    assert.deepEqual(added.filter((v) => v.ruleId === 'VisibleTextPartOfAccessibleName').map((v) => v.element.selector), ['#lost'], 'a real mismatch is still reported');
  });
});

test('contrast: a Web Animation caught mid-fade is settled before measuring; a ratio that keeps moving is unstable; a steady failure stays confirmed', async (t) => {
  await withPage(t, `
    <p id="fade" style="margin:10px;color:#000">Fading in</p>
    <p id="tween" style="margin:10px;color:#000">Tweened</p>
    <p id="low" style="margin:10px;color:#bbb">Pale and steady</p>
    <p id="fine" style="margin:10px;color:#000">Dark enough</p>
    <script>
      document.getElementById('fade').animate([{ opacity: 0.2 }, { opacity: 1 }], { duration: 600000, fill: 'forwards' });
      let o = 0.2; setInterval(() => { o = o >= 1 ? 0.2 : o + 0.05; document.getElementById('tween').style.opacity = o; }, 20);
    </script>`, async (page) => {
    const rows = ['#fade', '#tween', '#low', '#fine'].map((s) => row('color-contrast', s, s === '#fade' ? 'lighthouse' : 'axe'));
    await applyMeasuredChecks(page, rows, { viewports: VPS });
    const by = Object.fromEntries(rows.map((r) => [r.element.selector, r]));
    assert.equal(by['#fade'].verdict, 'needs-review');
    assert.match(by['#fade'].evidence.reviewReason, /settled page is 21:1/);
    assert.equal(by['#tween'].verdict, 'needs-review');
    assert.match(by['#tween'].evidence.reviewReason, /two samples 300ms apart/);
    assert.equal(by['#low'].verdict, 'confirmed');
    assert.equal(by['#low'].evidence.measured.contrast.state, 'stable');
    assert.equal(by['#fine'].verdict, 'needs-review');
  });
});

test('a page that cannot be measured leaves the findings untouched', async () => {
  const rows = [row('target-size', '#x')];
  const dead = { viewportSize: () => ({ width: 1, height: 1 }), setViewportSize: async () => { throw new Error('closed'); } };
  assert.deepEqual((await applyMeasuredChecks(dead, rows, { viewports: VPS })).added, []);
  assert.equal(rows[0].verdict, 'confirmed');
});

// ─── operability filters (round 8): what counts as a target and as a neighbour ───

const T = (id, css, text = id) => `<a id="${id}" class="abs" href="/${id}" style="${css}">${text}</a>`;
const verdicts = (rows) => Object.fromEntries(rows.map((r) => [r.element.selector, r.verdict]));
const targetRows = (...ids) => ids.map((s) => row('target-size', s));

test('target size: links in a closed menu overlay (opacity 0, pointer-events none) are neither targets nor neighbours; opened, the same crowding fails', async (t) => {
  await withPage(t, `
    <div id="menu" style="position:fixed;left:0;top:0;width:100%;height:100%;opacity:0;pointer-events:none">
      ${T('m1', 'left:10px;top:300px;width:100px;height:18px')}${T('m2', 'left:10px;top:320px;width:100px;height:18px')}
    </div>
    ${T('f1', 'left:10px;top:306px;width:20px;height:20px')}
    <a id="off" class="abs" href="/off" style="left:-300px;top:10px;width:20px;height:20px">o</a>
    <a id="off2" class="abs" href="/off2" style="left:-280px;top:10px;width:20px;height:20px">p</a>`, async (page) => {
    const rows = targetRows('#m1', '#f1', '#off');
    await applyMeasuredChecks(page, rows, { viewports: VPS });
    const by = Object.fromEntries(rows.map((r) => [r.element.selector, r]));
    assert.equal(by['#m1'].verdict, 'needs-review');
    assert.match(by['#m1'].evidence.reviewReason, /not measurable/);
    assert.equal(by['#off'].verdict, 'needs-review', 'offscreen neighbours that no scroll reaches are not targets');
    assert.equal(by['#f1'].verdict, 'needs-review', 'the closed menu is not a neighbour');
    assert.match(by['#f1'].evidence.reviewReason, /measured geometry passes WCAG 2\.5\.8/);
    await page.evaluate(() => { const m = document.getElementById('menu'); m.style.opacity = '1'; m.style.pointerEvents = 'auto'; });
    const open = targetRows('#m1', '#f1');
    await applyMeasuredChecks(page, open, { viewports: VPS });
    assert.deepEqual(Object.values(verdicts(open)), ['confirmed', 'confirmed'], 'opened, the same links are real targets and fail');
    assert.match(open[1].evidence.proof.fact, /^20 x 20, nearest neighbour distance 0px, circle clearance -\d/);
  });
});

test('target size: sr-only skip link, hidden navigation, wrapper li and aria-hidden or inert subtrees are not neighbours; a spaced list passes and a crowded list fails and is grouped', async (t) => {
  const list = (cls, top, h, gap) => `<ul class="${cls}" style="margin:0;padding:0;list-style:none;position:absolute;left:300px;top:${top}px">${[1, 2, 3, 4, 5].map((i) => `<li tabindex="0" style="margin-bottom:${gap}px"><a id="${cls}${i}" href="/${cls}${i}" style="display:block;width:150px;height:${h}px;line-height:${h}px">Item ${i}</a></li>`).join('')}</ul>`;
  await withPage(t, `
    <a href="#main" style="position:absolute;left:300px;top:40px;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap">Skip</a>
    <nav id="mobile-navigation" style="display:none"><a href="/mn" style="position:absolute;left:300px;top:46px;width:150px;height:18px">Mobile</a></nav>
    <div aria-hidden="true"><a href="/ah" style="position:absolute;left:300px;top:52px;width:150px;height:18px" tabindex="-1">Hidden</a></div>
    <div inert><a href="/in" style="position:absolute;left:300px;top:58px;width:150px;height:18px">Inert</a></div>
    <div style="position:absolute;left:300px;top:44px;width:150px;height:20px;overflow:hidden;clip-path:inset(50%)"><a href="/cp" style="display:block;width:150px;height:18px">Clip</a></div>
    ${list('ok', 100, 17, 8)}${list('bad', 400, 18, 2)}`, async (page) => {
    const rows = targetRows('#ok1', '#ok3', '#bad2');
    const { added } = await applyMeasuredChecks(page, rows, { viewports: VPS });
    assert.deepEqual(verdicts(rows), { '#ok1': 'needs-review', '#ok3': 'needs-review', '#bad2': 'confirmed' });
    assert.match(rows[0].evidence.reviewReason, /spacing exception.*circle clearance 1px/, 'the first item sees only its real neighbour, a 25px pitch away');
    assert.match(rows[2].evidence.proof.fact, /^150 x 18, nearest neighbour distance 2px, circle clearance -4px at viewport 1280x900/);
    // the rest of the crowded list has no row: one finding with every occurrence; the spaced list adds nothing
    assert.equal(added.length, 1);
    assert.equal(added[0].ruleId, 'TargetSize');
    assert.equal(added[0].evidence.occurrences.count, 4, 'bad1, bad3, bad4, bad5');
    assert.match(added[0].evidence.proof.fact, /^150 x 18, nearest neighbour distance 2px/);
    assert.ok(added.every((v) => !/ok\d/.test(v.element.selector + v.element.outerHTML)));
  });
});

test('target size: a vendor banner container is not a target and a vendor control is never the only evidence of a confirmed failure', async (t) => {
  const page_ = (id) => `
    <footer style="position:absolute;left:0;top:800px"><a id="fl" href="/fl" style="display:block;width:101px;height:18px;margin-left:10px">Manage cookies</a></footer>
    <div id="${id}" tabindex="0" role="region" style="position:fixed;left:0;top:810px;width:100%;height:90px;background:#eee">
      <p style="margin:0;position:absolute;left:400px;top:0">We use cookies, see our <a id="pl" href="/privacy" style="font-size:12px">privacy statement.</a></p>
      <button id="ok" style="position:absolute;left:20px;top:8px;width:100px;height:40px">Accept</button>
    </div>`;
  await withPage(t, page_('onetrust-banner-sdk'), async (page) => {
    const rows = targetRows('#fl', '#pl');
    await applyMeasuredChecks(page, rows, { viewports: VPS });
    assert.equal(rows[0].verdict, 'needs-review');
    assert.match(rows[0].evidence.reviewReason, /^depends on a third-party control: 101 x 18/);
    assert.equal(rows[1].verdict, 'needs-review');
  });
  await withPage(t, page_('site-banner'), async (page) => {
    const rows = targetRows('#fl');
    await applyMeasuredChecks(page, rows, { viewports: VPS });
    assert.equal(rows[0].verdict, 'confirmed', 'the same crowding by the site\'s own button is a real failure');
    assert.match(rows[0].evidence.proof.fact, /^101 x 18, nearest neighbour distance 0px, circle clearance -[\d.]+px at viewport/);
  });
  // the banner box alone (no control near the link) is no neighbour
  await withPage(t, page_('onetrust-banner-sdk').replace('left:20px;top:8px', 'left:600px;top:8px'), async (page) => {
    const rows = targetRows('#fl');
    await applyMeasuredChecks(page, rows, { viewports: VPS });
    assert.equal(rows[0].verdict, 'needs-review');
    assert.match(rows[0].evidence.reviewReason, /measured geometry passes WCAG 2\.5\.8 \(spacing exception/);
  });
});

test('target size: an inline link in running text inside a focusable region is exempt; a standalone link in the same place fails', async (t) => {
  await withPage(t, `
    <section tabindex="0" style="position:absolute;left:10px;top:100px;width:600px">
      <p style="margin:0">We store cookies to improve your visit, see our <a id="pl" href="/privacy" style="font-size:12px">privacy statement.</a></p>
    </section>
    <button id="nb" style="position:absolute;left:330px;top:100px;width:20px;height:20px"></button>
    ${T('solo', 'left:10px;top:300px;width:20px;height:20px')}${T('solo2', 'left:30px;top:300px;width:20px;height:20px')}`, async (page) => {
    const rows = targetRows('#pl', '#solo');
    await applyMeasuredChecks(page, rows, { viewports: VPS });
    assert.equal(rows[0].verdict, 'needs-review');
    assert.match(rows[0].evidence.reviewReason, /inline exception/);
    assert.equal(rows[1].verdict, 'confirmed');
  });
});

test('target size: an equivalent control (same href or aria-controls) in a 24px target exempts the small one; a different function does not', async (t) => {
  await withPage(t, `
    ${T('a1', 'left:10px;top:100px;width:20px;height:20px')}${T('a2', 'left:32px;top:100px;width:20px;height:20px')}
    <a id="big" class="abs" href="/a1" style="left:400px;top:100px;width:120px;height:40px">Same as a1</a>
    <button id="b1" class="abs" aria-controls="panel" style="left:10px;top:200px;width:20px;height:20px"></button>
    <button id="b2" class="abs" aria-controls="other" style="left:32px;top:200px;width:20px;height:20px"></button>
    <button id="b3" class="abs" aria-controls="panel" style="left:400px;top:200px;width:80px;height:40px">Toggle</button>`, async (page) => {
    const rows = targetRows('#a1', '#a2', '#b1', '#b2');
    await applyMeasuredChecks(page, rows, { viewports: VPS });
    assert.deepEqual(verdicts(rows), { '#a1': 'needs-review', '#a2': 'confirmed', '#b1': 'needs-review', '#b2': 'confirmed' });
    assert.match(rows[0].evidence.reviewReason, /equivalent control/);
    assert.match(rows[2].evidence.reviewReason, /equivalent control/);
  });
});

test('target size: a neighbour hidden behind a fixed bar, or a node of the same control, is not a neighbour; the same crowding with a visible, separate neighbour fails (paired)', async (t) => {
  await withPage(t, `
    <div id="bar" style="position:fixed;left:0;top:0;width:100%;height:60px;background:#fff;z-index:5"></div>
    ${T('logo', 'left:10px;top:20px;width:12px;height:12px')}
    ${T('hidden', 'left:24px;top:20px;width:12px;height:12px')}
    <button id="tog" class="abs" style="left:400px;top:400px;width:12px;height:12px"><span id="inner" role="button" tabindex="0" style="display:block;width:12px;height:12px"></span></button>
    ${T('vis', 'left:10px;top:300px;width:12px;height:12px')}${T('vis2', 'left:24px;top:300px;width:12px;height:12px')}`, async (page) => {
    const rows = targetRows('#logo', '#tog', '#vis');
    await applyMeasuredChecks(page, rows, { viewports: VPS });
    const by = Object.fromEntries(rows.map((r) => [r.element.selector, r]));
    assert.equal(by['#logo'].verdict, 'needs-review', 'the neighbour behind the fixed bar is not a target');
    assert.match(by['#logo'].evidence.reviewReason, /measured geometry passes WCAG 2\.5\.8/);
    assert.equal(by['#tog'].verdict, 'needs-review', 'a node inside the same control is not a neighbour');
    assert.equal(by['#vis'].verdict, 'confirmed', 'a visible separate neighbour 2px away still fails');
  });
});

test('label in name: a descendant aria-label that replaces the visible text is judged; a name equal to the card title with extra description is needs-review, a name omitting the label stays confirmed', async (t) => {
  assert.equal(judgeLabel({ label: 'Shuttle Rides', name: 'Shuttle', primary: 'Shuttle', rest: 'Rides', title: true }), 'pass');
  assert.equal(judgeLabel({ label: 'NEW Senior engineer', name: 'NEW', primary: 'NEW', rest: 'Senior engineer', title: false }), 'fail');
  assert.equal(judgeLabel({ label: 'Corporate See Laboratory people', name: 'Corporate', primary: 'Corporate', rest: 'See Laboratory people', title: false }), 'fail');
  await withPage(t, `
    <a id="desc" href="/a"><span aria-label="Submit your application">Apply</span></a>
    <a id="descok" href="/b"><span aria-label="Apply now">Apply</span></a>
    <a id="imgdesc" href="/c"><img src="${PX}" alt="Logo" width="40" height="20" aria-label="Home"></a>
    <a id="hcard" href="/d" aria-label="Shuttle" style="display:flex;flex-direction:column"><h3 style="font-size:12px">Shuttle</h3><p style="font-size:12px">Door to door rides</p></a>
    <a id="bigcard" href="/e" aria-label="Paratransit" style="display:flex;flex-direction:column"><span style="font-size:24px">Paratransit</span><span style="font-size:12px">ADA service</span></a>
    <a id="omit" href="/f" aria-label="Corporate" style="display:flex;flex-direction:column"><span style="font-size:12px">See Laboratory people</span></a>`, async (page) => {
    const sels = ['#desc', '#descok', '#imgdesc', '#hcard', '#bigcard', '#omit'];
    const rows = sels.map((s) => row('VisibleTextPartOfAccessibleName', s, 'accessScan'));
    await applyMeasuredChecks(page, rows, { viewports: VPS });
    assert.deepEqual(rows.map((r) => r.verdict), ['confirmed', 'needs-review', 'needs-review', 'needs-review', 'needs-review', 'confirmed']);
  });
});

test('target size: a neighbour whose box only meets the 24px circle where a fixed bar covers it is not reachable, so the spacing exception holds; the same box in the open fails (paired)', async (t) => {
  await withPage(t, `
    <div id="bar" style="position:fixed;left:0;top:0;width:100%;height:60px;background:#fff;z-index:5"><button id="ham" style="position:absolute;left:344px;top:20px;width:30px;height:20px;padding:0"></button></div>
    <button id="btt" class="abs" style="left:318px;top:40px;width:46px;height:46px;padding:0"></button>
    <button id="free" class="abs" style="left:800px;top:300px;width:30px;height:20px;padding:0"></button>
    <button id="near" class="abs" style="left:774px;top:320px;width:46px;height:46px;padding:0"></button>`, async (page) => {
    const rows = targetRows('#ham', '#free');
    await applyMeasuredChecks(page, rows, { viewports: [VPS[0]] });
    const by = Object.fromEntries(rows.map((r) => [r.element.selector, r]));
    assert.equal(by['#ham'].verdict, 'needs-review', 'the box under the fixed bar cannot be pressed inside the circle');
    assert.match(by['#ham'].evidence.reviewReason, /measured geometry passes WCAG 2\.5\.8/);
    assert.equal(by['#free'].verdict, 'confirmed', 'an uncovered neighbour inside the circle still fails');
  });
});

// ─── label in name: symbols are compared as the words they speak ─────────────

test('label in name: & and "and", + and "plus", %, @, # compare as spoken words; hyphen and space variants match; real mismatches still fail', () => {
  assert.equal(judgeLabel({ label: 'Terms & Conditions', name: 'View Acme Homes Terms and Conditions (Opens in a new tab)' }), 'pass');
  assert.equal(judgeLabel({ label: 'Terms and Conditions', name: 'View Terms &amp; Conditions'.replace('&amp;', '&') }), 'pass');
  assert.equal(judgeLabel({ label: 'Terms＆Conditions', name: 'Terms and Conditions' }), 'pass', 'NFKC: a fullwidth ampersand is an ampersand');
  assert.equal(judgeLabel({ label: 'Q&A', name: 'Q and A page' }), 'pass');
  assert.equal(judgeLabel({ label: 'Save + Continue', name: 'Save plus continue' }), 'pass');
  assert.equal(judgeLabel({ label: '100% Remote', name: 'Jobs: 100 percent remote' }), 'pass');
  assert.equal(judgeLabel({ label: 'Email us @ HQ', name: 'Email us at HQ' }), 'pass');
  assert.equal(judgeLabel({ label: 'Job #5', name: 'Job number 5' }), 'pass');
  assert.equal(judgeLabel({ label: 'E-mail us', name: 'Email us today' }), 'pass');
  assert.equal(judgeLabel({ label: '&', name: 'Terms and Conditions' }), 'na', 'a symbol alone is not a label');
  // true defects: a different word, or a missing word, is still a mismatch
  assert.equal(judgeLabel({ label: 'Terms & Conditions', name: 'View Acme Homes Privacy Policy' }), 'fail');
  assert.equal(judgeLabel({ label: 'Terms & Conditions', name: 'Terms' }), 'fail');
  assert.equal(judgeLabel({ label: 'Search', name: 'Find jobs' }), 'fail');
  assert.equal(judgeLabel({ label: 'Save + Continue', name: 'Save for later' }), 'fail');
  // a name that drops the symbol, or says its word, both hold: no new confirmed failure where the symbol-blind check passed
  assert.equal(judgeLabel({ label: 'Job #5', name: 'Job 5' }), 'pass');
  assert.equal(judgeLabel({ label: 'Save 50%', name: 'Save 50 dollars' }), 'pass');
  assert.equal(judgeLabel({ label: 'Save 50%', name: 'Save 50 percent' }), 'pass');
  assert.equal(judgeLabel({ label: 'Terms and Conditions', name: 'Terms & Conditions' }), 'pass');
  assert.equal(judgeLabel({ label: 'Job #5', name: 'Job 6' }), 'fail');
});

test('label in name: the Acme Homes footer link (visible "Terms & Conditions", aria-label with "and") is no longer confirmed; a link whose name drops the words still is', async (t) => {
  await withPage(t, `
    <a id="terms" href="/terms" target="_blank" aria-label="View Acme Homes Terms and Conditions (Opens in a new tab)">Terms &amp; Conditions</a>
    <a id="bad" href="/privacy" target="_blank" aria-label="View Acme Homes Privacy Policy (Opens in a new tab)">Terms &amp; Conditions</a>`, async (page) => {
    const rows = ['#terms', '#bad'].map((s) => row('label-content-name-mismatch', s, 'lighthouse'));
    const { added } = await applyMeasuredChecks(page, rows, { viewports: VPS });
    assert.equal(rows[0].verdict, 'needs-review');
    assert.match(rows[0].evidence.reviewReason, /contained in the accessible name/);
    assert.equal(rows[1].verdict, 'confirmed');
    assert.equal(rows[1].evidence.proof.type, 'name-vs-text');
    assert.deepEqual(added, [], 'the passing link is not re-added as a missed failure');
  });
});
