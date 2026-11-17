import './helpers/hermetic-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closeBrowser } from '../src/scanner/browser.js';
import { disclosureVerdict, judgeDisclosure, scanDisclosures } from '../src/scanner/disclosure.js';
import { scanBehaviorChecks } from '../src/scanner/behavior-checks.js';
import { requireBrowser } from './helpers/require-browser.js';

const S = (o) => ({ shown: false, hidden: false, ariaHidden: '', height: 0, ...o });

test('disclosure judgement: a changed panel is a measured toggle, an unchanged one is needs-review', () => {
  const j = judgeDisclosure({ before: S({}), after: S({ shown: true, height: 300 }), targetLabel: 'nav#drawer' });
  assert.equal(j.toggled, true);
  assert.match(j.fact, /nav#drawer: before not visible, height 0px; after visible, height 300px; page state restored/);
  const v = disclosureVerdict({ judged: j, hasTarget: true, targetHow: 'controls' });
  assert.deepEqual([v.verdict, v.proof.type], ['confirmed', 'measured-fact']);
  const still = disclosureVerdict({ judged: judgeDisclosure({ before: S({ shown: true, height: 9 }), after: S({ shown: true, height: 9 }), targetLabel: 'x' }), hasTarget: true });
  assert.equal(still.verdict, 'needs-review');
  assert.match(disclosureVerdict({ judged: null, hasTarget: false }).reason, /no panel that toggles/);
  assert.equal(judgeDisclosure({ before: S({ hidden: true }), after: S({ hidden: false }), targetLabel: 'x' }).toggled, true, 'hidden attribute counts');
});

async function withPage(t, html, fn) {
  const browser = await requireBrowser(t);
  if (!browser) return;
  t.after(closeBrowser);
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  try {
    await page.setContent(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>t</title></head><body>${html}</body></html>`);
    await fn(page);
  } finally { await page.context().close(); }
}
const SCRIPT = `<script>
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-t]'); if (!b) return;
  const p = document.getElementById(b.dataset.t); p.hidden = !p.hidden;
});</script>`;

test('disclosure: hamburger button and div[role=button] accordion trigger without aria-expanded are confirmed with before/after proof, and the page is restored', async (t) => {
  await withPage(t, `
    <header><button id="ham" class="c-header__hamburger" aria-label="menu button" data-t="drawer"><span></span></button>
    <nav id="drawer" class="drawer" hidden><a href="/a">A</a></nav></header>
    <section class="faq"><div id="q1" role="button" tabindex="0" class="faq__question" data-t="a1">Pay?</div><div id="a1" class="faq__answer" hidden>Yes</div></section>
    <button id="ok" aria-expanded="false" aria-controls="p2" data-t="p2">Fine</button><div id="p2" hidden>x</div>
    <button id="dead" aria-controls="p3" data-t="nothing">Inert</button><div id="p3" hidden>y</div>
    <div id="onetrust-pc-sdk" style="display:none"><button id="filter-btn-handler" aria-haspopup="true" aria-label="Filter Vendors List">f</button></div>
    <div id="onetrust-banner-sdk"><button id="ot-pc" aria-haspopup="true" aria-controls="pc" data-t="pc">Settings</button></div><div id="pc" hidden>z</div>
    ${SCRIPT}`, async (page) => {
    const rows = await scanDisclosures(page);
    const by = Object.fromEntries(rows.map((r) => [r.element.selector, r]));
    assert.deepEqual(Object.keys(by).sort(), ['#dead', '#ham', '#q1']);
    for (const s of ['#ham', '#q1']) {
      assert.equal(by[s].rule, 'disclosure-missing-aria-expanded', s);
      assert.equal(by[s].verdict, 'confirmed', s);
      assert.match(by[s].evidence.proof.fact, /before not visible, height 0px, hidden; after visible, height [1-9]/, s);
      assert.ok(by[s].element.html.includes('<'), 'html and selector come from the same element');
    }
    assert.equal(by['#dead'].verdict, 'needs-review');
    assert.match(by['#dead'].evidence.reviewReason, /did not change/);
    assert.equal(await page.evaluate(() => [document.getElementById('drawer').hidden, document.getElementById('a1').hidden].join()), 'true,true', 'state restored');
    // the display:none vendor control and the visible consent-banner control are not site disclosure rows
    assert.ok(!rows.some((r) => /filter-btn-handler|ot-pc/.test(r.element.selector + r.element.html)));
  });
});

test('disclosure: a toggle whose script sets aria-expanded on activation is needs-review with the runtime state; one that never exposes a state stays confirmed (paired)', async (t) => {
  const j = judgeDisclosure({ before: S({}), after: S({ shown: true, height: 220 }), targetLabel: 'div' });
  const v = disclosureVerdict({ judged: j, hasTarget: true, targetHow: 'sibling', expandedAfter: 'true', expandedClosed: 'false', panelAfter: S({ shown: true, height: 220 }), panelClosed: S({}), reactivated: true });
  assert.equal(v.verdict, 'needs-review');
  assert.match(v.reason, /aria-expanded="true".*"false" when it is activated again.*only the initial collapsed state is missing/);
  assert.equal(disclosureVerdict({ judged: j, hasTarget: true, targetHow: 'sibling', expandedAfter: null }).verdict, 'confirmed', 'no state ever appears');
  await withPage(t, `
    <header><div><button id="sub" type="button" class="sub-menu-toggle" aria-label="Toggle Our Sectors submenu" data-t="sectors" data-state="1"><span></span></button>
    <div id="sectors" class="sub-menu" hidden>x</div></div>
    <div><button id="bare" type="button" class="sub-menu-toggle" aria-label="Toggle About submenu" data-t="about"><span></span></button>
    <div id="about" class="sub-menu" hidden>y</div></div></header>
    <script>
    document.addEventListener('click', (e) => {
      const b = e.target.closest('[data-t]'); if (!b) return;
      const p = document.getElementById(b.dataset.t); p.hidden = !p.hidden;
      if (b.dataset.state) b.setAttribute('aria-expanded', String(!p.hidden));
    });</script>`, async (page) => {
    const by = Object.fromEntries((await scanDisclosures(page)).map((r) => [r.element.selector, r]));
    assert.equal(by['#sub'].verdict, 'needs-review');
    assert.match(by['#sub'].evidence.reviewReason, /script set aria-expanded="true"/);
    assert.equal(by['#sub'].evidence.measured.expandedAfter, 'true');
    assert.equal(by['#bare'].verdict, 'confirmed');
    assert.equal(await page.evaluate(() => document.getElementById('sub').hasAttribute('aria-expanded')), false, 'the attribute the click added is removed again');
  });
});

test('disclosure: a script-set aria-expanded that is stuck or inverted is a measured wrong state (confirmed with the measurement); a correct one is needs-review (paired)', async (t) => {
  const j = judgeDisclosure({ before: S({}), after: S({ shown: true, height: 220 }), targetLabel: 'div' });
  const open = S({ shown: true, height: 220 });
  const base = { judged: j, hasTarget: true, targetHow: 'controls', panelAfter: open, panelClosed: S({}), reactivated: true };
  assert.equal(disclosureVerdict({ ...base, expandedAfter: 'true', expandedClosed: 'false' }).verdict, 'needs-review', 'correct');
  const stuck = disclosureVerdict({ ...base, expandedAfter: 'true', expandedClosed: 'true' });
  assert.equal(stuck.verdict, 'confirmed');
  assert.match(stuck.proof.fact, /second activation the panel is closed but aria-expanded="true"/);
  const inverted = disclosureVerdict({ ...base, expandedAfter: 'false', expandedClosed: 'true' });
  assert.equal(inverted.verdict, 'confirmed');
  assert.match(inverted.proof.fact, /first activation the panel is open but aria-expanded="false".*second activation the panel is closed but aria-expanded="true"/);
  assert.equal(disclosureVerdict({ ...base, targetHow: 'fallback', expandedAfter: 'false', expandedClosed: 'true' }).verdict, 'needs-review', 'a guessed panel proves nothing');
  const skipped = disclosureVerdict({ ...base, reactivated: false, expandedAfter: 'true', expandedClosed: null });
  assert.equal(skipped.verdict, 'needs-review');
  assert.doesNotMatch(skipped.reason, /activated again/, 'no second activation, no claim about it');
  await withPage(t, `
    <button id="ok" type="button" class="menu-toggle" aria-controls="p0" data-t="p0">Ok</button><div id="p0" hidden>x</div>
    <button id="stuck" type="button" class="menu-toggle" aria-controls="p1" data-t="p1">Stuck</button><div id="p1" hidden>x</div>
    <button id="wrong" type="button" class="menu-toggle" aria-controls="p2" data-t="p2">Wrong</button><div id="p2" hidden>y</div>
    <script>
    document.addEventListener('click', (e) => {
      const b = e.target.closest('[data-t]'); if (!b) return;
      const p = document.getElementById(b.dataset.t); p.hidden = !p.hidden;
      b.setAttribute('aria-expanded', b.id === 'stuck' ? 'true' : b.id === 'wrong' ? String(p.hidden) : String(!p.hidden));
    });</script>`, async (page) => {
    const by = Object.fromEntries((await scanDisclosures(page)).map((r) => [r.element.selector, r]));
    assert.equal(by['#ok'].verdict, 'needs-review');
    for (const id of ['#stuck', '#wrong']) {
      assert.equal(by[id].verdict, 'confirmed', id);
      assert.equal(by[id].evidence.proof.type, 'measured-fact', id);
      assert.match(by[id].evidence.proof.fact, /does not match the panel/, id);
    }
    assert.equal(by['#wrong'].evidence.measured.expandedAfter, 'false');
  });
});

test('disclosure at the mobile width: a desktop control rewritten by a resize handler or an interval is not repeated at 390; the hamburger-only control still is (paired)', async (t) => {
  const html = (script) => `<style>.ham{display:none}.panel{display:none}.panel.open{display:block;height:80px}@media (max-width:600px){.ham{display:block}}</style>
    <button id="t" type="button" class="menu-toggle dot" aria-controls="p1" data-t="p1">Menu</button><div id="p1" class="panel">x</div>
    <button id="ham" type="button" class="hamburger ham" aria-label="Nav" data-t="p2">N</button><div id="p2" class="panel">y</div>
    <script>document.addEventListener('click', (e) => { const b = e.target.closest('[data-t]'); if (b) document.getElementById(b.dataset.t).classList.toggle('open'); });${script}</script>`;
  for (const script of ["addEventListener('resize', () => document.getElementById('t').setAttribute('data-w', innerWidth));", "let i = 0; setInterval(() => document.getElementById('t').classList.toggle('on', i++ % 2), 100);"]) {
    await withPage(t, html(script), async (page) => {
      const rows = (await scanBehaviorChecks(page)).filter((r) => /missing-aria-expanded$/.test(r.rule));
      assert.deepEqual(rows.map((r) => [r.element.selector, r.verdict, r.evidence.viewports?.[0]?.name]), [['#ham', 'confirmed', 'mobile']], script);
    });
  }
});

test('disclosure at the mobile width: a hamburger that only renders below the desktop breakpoint is measured there (confirmed when no state ever appears, needs-review when the click sets it); a desktop control is not repeated (paired)', async (t) => {
  const html = (setsState) => `<style>.ham,.ham2{display:flex;width:44px;height:44px}.panel{display:none}.panel.open{display:block;height:80px}@media (min-width:1024px){.ham,.ham2{display:none}}</style>
    <header><button id="ham" class="hamburger ham" aria-label="Menu" data-t="drawer"><span></span></button><div id="drawer" class="drawer panel">links</div>
    <button id="ham2" class="hamburger ham2" aria-label="Menu 2" data-t="drawer2"><span></span></button><div id="drawer2" class="drawer panel">more</div>
    <button id="always" class="menu-toggle" aria-controls="p9" data-t="p9">Always</button><div id="p9" class="panel">x</div></header>
    <script>document.addEventListener('click', (e) => { const b = e.target.closest('[data-t]'); if (!b) return; const p = document.getElementById(b.dataset.t); p.classList.toggle('open'); ${setsState ? "if (b.id === 'ham2') b.setAttribute('aria-expanded', String(p.classList.contains('open')));" : ''} });</script>`;
  await withPage(t, html(true), async (page) => {
    const rows = (await scanBehaviorChecks(page)).filter((r) => /missing-aria-expanded$/.test(r.rule));
    const by = Object.fromEntries(rows.map((r) => [r.element.selector, r]));
    assert.equal(by['#ham'].verdict, 'confirmed', 'no state ever appears');
    assert.deepEqual(by['#ham'].evidence.viewports, [{ name: 'mobile', width: 390, height: 844 }]);
    assert.equal(by['#ham2'].verdict, 'needs-review', 'the click sets aria-expanded');
    assert.ok(!by['#always'], 'rendered at the desktop width too: the desktop pass owns it');
    assert.deepEqual(page.viewportSize(), { width: 1280, height: 900 });
  });
});

test('disclosure: aria-haspopup keeps the menu-trigger rule id', async (t) => {
  await withPage(t, `<button id="m" aria-haspopup="menu" aria-controls="mm" data-t="mm">Menu</button><ul id="mm" hidden><li>x</li></ul>${SCRIPT}`, async (page) => {
    const [r] = await scanDisclosures(page);
    assert.equal(r.rule, 'menu-trigger-missing-aria-expanded');
    assert.equal(r.verdict, 'confirmed');
  });
});

test('new-tab notice without target=_blank is needs-review; a link with target=_blank or no notice yields no row', async (t) => {
  const { scanNewTabNotices } = await import('../src/scanner/disclosure.js');
  await withPage(t, `
    <a id="bad" href="/x" aria-label="Leadership Team (Opens in a new tab)">Leadership</a>
    <a id="ok" href="/y" target="_blank" aria-label="Careers (Opens in a new tab)">Careers</a>
    <a id="plain" href="/z">Plain</a>`, async (page) => {
    const rows = await scanNewTabNotices(page);
    assert.deepEqual(rows.map((r) => r.element.selector), ['#bad']);
    assert.equal(rows[0].verdict, 'needs-review');
  });
});

test('disclosure: ARIA tabs, menu items, options and pagination/carousel dots are not disclosure controls; a real accordion beside them still is', async (t) => {
  await withPage(t, `
    <div role="tablist" aria-label="Sections"><button role="tab" id="t1" aria-selected="true" aria-controls="tp1" data-t="tp1">One</button><button role="tab" id="t2" aria-selected="false" aria-controls="tp2" data-t="tp2">Two</button></div>
    <div id="tp1" role="tabpanel" hidden>a</div><div id="tp2" role="tabpanel" hidden>b</div>
    <ul role="menu"><li role="none"><button role="menuitem" id="mi" aria-controls="tp1" data-t="tp1">Item</button></li></ul>
    <nav aria-label="Pagination"><button id="pg" aria-controls="tp2" data-t="tp2">2</button></nav>
    <div class="carousel-dots"><button id="dot" aria-controls="tp2" data-t="tp2">dot</button></div>
    <button id="acc" aria-controls="tp3" data-t="tp3">Real accordion</button><div id="tp3" hidden>c</div>
    ${SCRIPT}`, async (page) => {
    const rows = await scanDisclosures(page);
    assert.deepEqual(rows.map((r) => r.element.selector), ['#acc']);
  });
});
