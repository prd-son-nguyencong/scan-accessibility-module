import './helpers/hermetic-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeBrowser } from '../src/scanner/browser.js';
import { judgeEscapeInsidePanel, judgeFocusReturn, judgeReflow, scanFocusReturn, scanMenuKeyboard, scanReflow } from '../src/scanner/behavior-checks.js';
import { scanKeyboardNavigation } from '../src/scanner/keyboard.js';
import { requireBrowser } from './helpers/require-browser.js';
import { startParadoxSite } from './helpers/paradox-site-server.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RETURN_DIR = path.join(HERE, 'fixtures/focus-return');
const MENU_DIR = path.join(HERE, 'fixtures/menu-keyboard');
const KB_DIR = path.join(HERE, 'fixtures/keyboard-contrast');

async function onPage(t, file, fn, { dir = RETURN_DIR, html } = {}) {
  const browser = await requireBrowser(t);
  if (!browser) return;
  t.after(closeBrowser);
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  try {
    await page.route('http://example.test/**', (r) => r.fulfill({ contentType: 'text/html', body: '<html><body>away</body></html>' }));
    await page.setContent(html ?? fs.readFileSync(path.join(dir, file), 'utf8'));
    await fn(page);
  } finally { await page.context().close(); }
}

async function onSite(t, fn) {
  const browser = await requireBrowser(t);
  if (!browser) return;
  t.after(closeBrowser);
  const site = await startParadoxSite({ dir: KB_DIR });
  try { await fn(site.url); } finally { await site.close(); }
}

// ─── 2.4.3 focus after Escape: body alone is not proof; one Tab decides ─────────────────────────────

const LOST = { focused: true, opened: true, closed: true, activeIsTrigger: false, activeTag: 'BODY' };

test('judgement: focus on body is confirmed only when one Tab restarts at the top or lands far from the trigger; near it is likely (paired)', () => {
  assert.equal(judgeFocusReturn({ ...LOST }).verdict, 'likely', 'no Tab measurement: body alone proves nothing');
  assert.equal(judgeFocusReturn({ ...LOST, tab: { idx: 0, trigIdx: 3, total: 12, tag: 'A', label: 'Home' } }).verdict, 'confirmed', 'restarts at the first stop');
  assert.equal(judgeFocusReturn({ ...LOST, tab: { idx: 1, trigIdx: 5, total: 12, tag: 'A', label: 'x' } }).verdict, 'confirmed', 'lands before the trigger');
  assert.equal(judgeFocusReturn({ ...LOST, tab: { idx: 40, trigIdx: 3, total: 60, tag: 'A', label: 'x' } }).verdict, 'confirmed', 'lands far from the trigger');
  assert.equal(judgeFocusReturn({ ...LOST, tab: { idx: 4, trigIdx: 3, total: 12, tag: 'A', label: 'x' } }).verdict, 'likely', 'next stop after the trigger');
  assert.equal(judgeFocusReturn({ ...LOST, tab: { idx: 0, trigIdx: 0, total: 12, tag: 'A', label: 'x' } }).verdict, 'likely', 'the trigger is the first stop itself');
  assert.equal(judgeFocusReturn({ ...LOST, tab: { idx: -1, trigIdx: 3, total: 12, tag: 'BODY', label: '' } }).verdict, 'likely', 'landing not measurable');
  assert.match(judgeFocusReturn({ ...LOST, tab: { idx: 0, trigIdx: 3, total: 12, tag: 'A', label: 'Home' } }).fact, /document\.activeElement is <body>.*Tab.*<a> "Home"/s);
  assert.equal(judgeEscapeInsidePanel({ focusedInside: true, closed: true, activeIsTrigger: false, activeTag: 'BODY' }).verdict, 'likely');
  assert.equal(judgeEscapeInsidePanel({ focusedInside: true, closed: true, activeIsTrigger: false, activeTag: 'BODY', tab: { idx: 0, trigIdx: 3, total: 12, tag: 'A', label: 'Home' } }).verdict, 'confirmed');
});

test('focus return: focus reset to the document start is confirmed with the Tab landing; a blur that leaves the sequence in place is likely (paired)', async (t) => {
  await onPage(t, 'top-restart.html', async (page) => {
    const rows = await scanFocusReturn(page);
    assert.deepEqual(rows.map((r) => [r.rule, r.verdict]), [['focus-lost-after-escape', 'confirmed']]);
    assert.match(rows[0].evidence.proof.fact, /Tab then moved focus to <a> "Home"/);
  });
  await onPage(t, 'blur.html', async (page) => {
    const rows = await scanFocusReturn(page);
    assert.deepEqual(rows.map((r) => [r.rule, r.verdict]), [['focus-lost-after-escape', 'likely']]);
    assert.ok(!rows[0].evidence.proof, 'a likely row carries no proof');
  }, { html: `<!doctype html><html lang="en"><body><a href="#h">Home</a><button id="m" type="button" aria-expanded="false" aria-controls="p">Menu</button><div id="p" hidden><a href="#x">One</a></div><button id="after" type="button">after</button><script>
const b=m,q=p;b.onclick=()=>{q.hidden=!q.hidden;b.setAttribute("aria-expanded",String(!q.hidden))};
document.addEventListener("keydown",e=>{if(e.key==="Escape"&&!q.hidden){q.hidden=true;b.setAttribute("aria-expanded","false");document.activeElement.blur()}})</script></body></html>` });
});

test('menu keyboard: Escape inside the panel that resets focus to the top is confirmed, a plain blur is likely (paired)', async (t) => {
  await onPage(t, 'top-restart.html', async (page) => {
    const rows = (await scanMenuKeyboard(page)).filter((r) => r.rule === 'focus-lost-after-escape');
    assert.deepEqual(rows.map((r) => r.verdict), ['confirmed']);
  });
  await onPage(t, 'escape-focus-lost.html', async (page) => {
    const rows = (await scanMenuKeyboard(page)).filter((r) => r.rule === 'focus-lost-after-escape');
    assert.deepEqual(rows.map((r) => r.verdict), ['likely']);
  }, { dir: MENU_DIR });
});

test('nested submenu: Escape that loses focus inside an opened panel is found on the nested trigger; a restoring submenu raises nothing (paired)', async (t) => {
  await onPage(t, 'nested-lost.html', async (page) => {
    const rows = await scanFocusReturn(page);
    assert.deepEqual(rows.map((r) => [r.rule, r.element.selector, r.verdict]), [['focus-lost-after-escape', '#n', 'confirmed']]);
  });
  await onPage(t, 'nested-restored.html', async (page) => {
    assert.deepEqual(await scanFocusReturn(page), []);
  });
});

test('an Enter press on a trigger that is a real link never navigates the page mid-scan', async (t) => {
  await onPage(t, 'link-trigger.html', async (page) => {
    assert.deepEqual(await scanFocusReturn(page), []);
    assert.equal(page.url(), 'about:blank');
    assert.equal(await page.locator('#stay').count(), 1);
  });
});

// ─── 1.4.10 reflow: wide fixed content is a question, not a skip ─────────────────────────────────────

test('reflow: a fixed bar wider than 320px is needs-review; a fitting fixed bar and an off-canvas drawer raise nothing (paired)', async (t) => {
  assert.equal(judgeReflow({ scrollWidth: 320, clientWidth: 320, offenders: [], exempt: 0, fixedOffenders: [{ selector: 'div.bar', right: 600, width: 600 }] }).verdict, 'needs-review');
  assert.equal(judgeReflow({ scrollWidth: 320, clientWidth: 320, offenders: [], exempt: 0, fixedOffenders: [] }), null);
  await onPage(t, '', async (page) => {
    const rows = await scanReflow(page);
    assert.deepEqual(rows.map((r) => [r.rule, r.verdict]), [['reflow-horizontal-scroll', 'needs-review']]);
    assert.match(rows[0].description, /fixed/i);
  }, { html: '<!doctype html><html lang="en"><body><div class="bar" style="position:fixed;top:0;left:0;width:600px;height:40px">Fixed bar that does not wrap</div><main><p>ok</p></main></body></html>' });
  await onPage(t, '', async (page) => {
    assert.deepEqual(await scanReflow(page), []);
  }, { html: '<!doctype html><html lang="en"><body style="margin:0"><div style="position:fixed;top:0;left:0;width:100%;height:40px">fits</div><aside style="position:fixed;top:0;right:0;width:300px;height:200px;transform:translateX(100%)">drawer</aside><main><p>ok</p></main></body></html>' });
});

// ─── 2.4.7 ────────────────────────────────────────────────────────────────────────────────────────────

test('focus-indicator-removed is a stylesheet guess: needs-review when a replacement lives in another rule, confirmed only when pixel proof backs the matched element (paired)', async (t) => {
  await onSite(t, async (url) => {
    const a = (await scanKeyboardNavigation(`${url}/focus-removed-replaced`)).violations;
    const removed = a.filter((v) => v.rule === 'focus-indicator-removed');
    assert.ok(removed.length >= 1);
    assert.ok(removed.every((v) => v.verdict === 'needs-review'), JSON.stringify(removed.map((v) => v.verdict)));
    assert.deepEqual(a.filter((v) => v.rule === 'focus-not-visible'), []);
    const b = (await scanKeyboardNavigation(`${url}/focus-removed-real`)).violations;
    assert.equal(b.find((v) => v.rule === 'focus-not-visible')?.verdict, 'confirmed');
    const r = b.find((v) => v.rule === 'focus-indicator-removed');
    assert.equal(r?.verdict, 'confirmed');
    assert.match(r.description, /identical focused and blurred/);
  });
});

test('2.4.7 recall: a wrapper style change with identical pixels is confirmed; stacked controls at one spot and stops past 100 are all seen', async (t) => {
  await onSite(t, async (url) => {
    const w = (await scanKeyboardNavigation(`${url}/focus-wrapper-invisible`)).violations.filter((v) => v.rule === 'focus-not-visible');
    assert.equal(w.length, 1);
    assert.equal(w[0].verdict, 'confirmed');
    assert.match(w[0].description, /wrapper or a sibling/);
    const s = (await scanKeyboardNavigation(`${url}/focus-stacked`)).violations.filter((v) => v.rule === 'focus-not-visible');
    assert.equal(s.length, 3, 'three distinct controls with the same text at the same position');
    const l = (await scanKeyboardNavigation(`${url}/focus-long`)).violations.filter((v) => v.rule === 'focus-not-visible');
    assert.equal(l.length, 130, 'no stop dropped by a traversal cap');
  });
});

test('2.4.7 mobile-only toggle: a hamburger with no focus cue is confirmed at the mobile width (pixels identical); one with a focus-visible ring is not (paired)', async (t) => {
  await onSite(t, async (url) => {
    const real = (await scanKeyboardNavigation(`${url}/focus-mobile-toggle-real`)).violations.filter((v) => v.rule === 'focus-not-visible');
    assert.equal(real.length, 1, JSON.stringify(real.map((v) => v.description)));
    assert.equal(real[0].verdict, 'confirmed');
    assert.match(real[0].description, /at viewport 390x844 \(not rendered at 1280x900\)/);
    assert.match(real[0].description, /identical focused and blurred/);
    assert.equal(real[0].element.tag, 'BUTTON');
    assert.deepEqual(real[0].evidence.viewports, [{ name: 'mobile', width: 390, height: 844 }]);
    const ring = (await scanKeyboardNavigation(`${url}/focus-mobile-toggle-ring`)).violations.filter((v) => v.rule === 'focus-not-visible');
    assert.deepEqual(ring, []);
  });
});

test('2.4.7 mobile-only pass: desktop controls whose markup a focus handler mutates are not re-reported as mobile-only (paired with the hamburger-only fixture above)', async (t) => {
  await onSite(t, async (url) => {
    const rows = (await scanKeyboardNavigation(`${url}/focus-class-mutation`)).violations.filter((v) => v.rule === 'focus-not-visible');
    assert.deepEqual(rows.map((v) => [v.element.text, v.evidence?.viewports?.[0]?.width ?? 'desktop']), [['Alpha', 'desktop'], ['Beta', 'desktop']], JSON.stringify(rows.map((v) => v.description)));
    assert.ok(rows.every((v) => !/not rendered at/.test(v.description)));
  });
});

test('2.4.7 mobile-only pass: a resize handler or an autoplay class toggle on a desktop control does not make it mobile-only (paired with the hamburger-only fixture)', async (t) => {
  await onSite(t, async (url) => {
    for (const [page, texts] of [['focus-resize-mutation', ['Alpha', 'Beta']], ['focus-autoplay-mutation', ['One', 'Two']]]) {
      const rows = (await scanKeyboardNavigation(`${url}/${page}`)).violations.filter((v) => v.rule === 'focus-not-visible');
      assert.deepEqual(rows.map((v) => [v.element.text, v.evidence?.viewports?.[0]?.width ?? 'desktop']), texts.map((x) => [x, 'desktop']), `${page}: ${JSON.stringify(rows.map((v) => v.description))}`);
    }
    const ham = (await scanKeyboardNavigation(`${url}/focus-mobile-toggle-real`)).violations.filter((v) => v.rule === 'focus-not-visible' && v.evidence?.viewports);
    assert.ok(ham.length >= 1 && ham.every((v) => v.verdict === 'confirmed'), 'the hamburger-only control still confirms');
  });
});

// ─── round 4 review fixes ─────────────────────────────────────────────────────────────────────────

const R4_HEAD = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>x</title><style>[hidden]{display:none}body{margin:0}</style></head><body>';
const R4_JS = (extra) => `const t=document.getElementById("t"),p=document.getElementById("p");t.onclick=()=>{p.hidden=!p.hidden;t.setAttribute("aria-expanded",String(!p.hidden))};document.addEventListener("keydown",e=>{if(e.key==="Escape"&&!p.hidden){p.hidden=true;t.setAttribute("aria-expanded","false");${extra}}});`;

test('tab landing counts only really tabbable stops: tabindex=-1 links between trigger and next control never make a correct order "restart"', async (t) => {
  const chips = Array.from({ length: 20 }, (_, i) => `<a href="#c${i}" tabindex="-1">chip ${i}</a>`).join(' ');
  await onPage(t, '', async (page) => {
    const rows = await scanFocusReturn(page);
    assert.deepEqual(rows.map((r) => [r.rule, r.verdict]), [['focus-lost-after-escape', 'likely']]);
  }, { html: `${R4_HEAD}<a href="#home">Home</a><nav><button id="t" type="button" aria-expanded="false" aria-controls="p">Menu</button><div id="p" hidden><a href="#a">One</a></div></nav><div>${chips}</div><main><button id="after" type="button">after</button></main><script>${R4_JS('document.activeElement.blur();')}</script></body></html>` });
});

test('a javascript: href disclosure trigger is still driven (Enter does not navigate) and a restart is confirmed', async (t) => {
  await onPage(t, '', async (page) => {
    const rows = await scanFocusReturn(page);
    assert.deepEqual(rows.map((r) => [r.rule, r.verdict]), [['focus-lost-after-escape', 'confirmed']]);
  }, { html: `${R4_HEAD}<a href="#home">Home</a><a href="#news">News</a><nav><a id="t" href="javascript:void(0)" aria-expanded="false" aria-controls="p">Brands</a><div id="p" hidden><a href="#a">One</a></div></nav><main><button>after</button></main><script>${R4_JS('document.body.tabIndex=-1;document.body.focus();')}</script></body></html>` });
});

test('reflow: fixed decorative media (img, svg) wider than the viewport is exempt like non-fixed media', async (t) => {
  await onPage(t, '', async (page) => {
    assert.deepEqual(await scanReflow(page), []);
  }, { html: '<!doctype html><html lang="en"><body style="margin:0"><img alt="" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" width="1920" height="1080" style="position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:-1"><svg width="1200" height="300" style="position:fixed;top:0;left:0;z-index:-1"><rect width="1200" height="300" fill="#eee"/></svg><main><p>ok</p></main></body></html>' });
});

test('tab landing skips controls Tab never visits: a disabled fieldset full of buttons does not inflate the stop index', async (t) => {
  const btns = Array.from({ length: 20 }, (_, i) => `<button type="button">b${i}</button>`).join('');
  await onPage(t, '', async (page) => {
    const rows = await scanFocusReturn(page);
    assert.deepEqual(rows.map((r) => [r.rule, r.verdict]), [['focus-lost-after-escape', 'likely']]);
  }, { html: `${R4_HEAD}<nav><button id="t" type="button" aria-expanded="false" aria-controls="p">Menu</button><div id="p" hidden><a href="#a">One</a></div></nav><fieldset disabled>${btns}</fieldset><main><button id="after" type="button">after</button></main><script>${R4_JS('document.activeElement.blur();')}</script></body></html>` });
});

test('tab landing counts a radio group once: Tab lands on the checked radio even when it is the last of the group', async (t) => {
  const radios = Array.from({ length: 20 }, (_, i) => `<input type="radio" name="r" aria-label="r${i}"${i === 19 ? ' checked' : ''}>`).join('');
  await onPage(t, '', async (page) => {
    const rows = await scanFocusReturn(page);
    assert.deepEqual(rows.map((r) => [r.rule, r.verdict]), [['focus-lost-after-escape', 'likely']]);
  }, { html: `${R4_HEAD}<nav><button id="t" type="button" aria-expanded="false" aria-controls="p">Menu</button><div id="p" hidden><a href="#a">One</a></div></nav><form>${radios}</form><main><button id="after" type="button">after</button></main><script>${R4_JS('document.activeElement.blur();')}</script></body></html>` });
});
