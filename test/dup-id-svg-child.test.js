import './helpers/hermetic-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closeBrowser } from '../src/scanner/browser.js';
import { scanScreenReaderAccessibility } from '../src/scanner/screen-reader.js';
import { applySvgChildOfNamedControl } from '../src/scanner/svg-child-name.js';
import { requireBrowser } from './helpers/require-browser.js';
import { startParadoxSite } from './helpers/paradox-site-server.js';

const html = (body) => (req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html><html lang="en"><head><title>t</title></head><body><main><h1>Page</h1>${body}</main></body></html>`);

async function dupRows(t, body) {
  const browser = await requireBrowser(t);
  if (!browser) return null;
  t.after(closeBrowser);
  const site = await startParadoxSite({ routes: { '/': html(body) } });
  try { return (await scanScreenReaderAccessibility(`${site.url}/`)).violations.filter((v) => v.rule === 'duplicate-id-referenced'); } finally { await site.close(); }
}

// example site header: desktop nav and mobile nav each carry a button and a panel with the same ids; the panels are hidden and toggled by script.
const nav = (cls) => `<nav class="${cls}"><button aria-expanded="false" aria-controls="early-careers-menu">Early careers</button><div id="early-careers-menu" aria-hidden="true" class="menu" style="display:none"><ul><li>Interns</li></ul></div></nav>`;

test('duplicate id: both copies are hidden panels behind aria-controls (example site nav): likely with a reason, not confirmed', async (t) => {
  const dup = await dupRows(t, nav('desktop') + nav('mobile'));
  if (!dup) return;
  assert.equal(dup.length, 1);
  assert.equal(dup[0].verdict, 'likely');
  assert.equal(dup[0].evidence.misresolved, 1);
  assert.equal(dup[0].evidence.shown, 0);
  assert.match(dup[0].evidence.reviewReason, /4\.1\.1/);
});

test('duplicate id: aria-labelledby loop whose first heading names every card keeps confirming; so does aria-controls to a visible panel it does not own', async (t) => {
  const cards = [1, 2, 3].map((n) => `<li role="group" aria-labelledby="ct"><h3 id="ct">Role ${n}</h3></li>`).join('');
  const dup = await dupRows(t, `<ul>${cards}</ul>`);
  if (!dup) return;
  assert.equal(dup[0].verdict, undefined, 'left to the rule default: confirmed');
  assert.equal(dup[0].evidence.shown, 2);
  assert.match(dup[0].evidence.proof.fact, /2 of them with a different name/);
  const ctl = await dupRows(t, '<div><button aria-controls="p">One</button><div id="p">panel one</div></div><div><button aria-controls="p">Two</button><div id="p">panel two</div></div>');
  assert.equal(ctl[0].verdict, undefined);
  assert.equal(ctl[0].evidence.shown, 1);
});

test('duplicate id: aria-labelledby copies with the same text, or a hidden referrer, expose no different name: likely', async (t) => {
  const same = await dupRows(t, '<section aria-labelledby="h"><h2 id="h">News</h2></section><section aria-labelledby="h"><h2 id="h">News</h2></section>');
  if (!same) return;
  assert.equal(same[0].verdict, 'likely');
  const pair = (attr) => `<div ${attr}><section aria-labelledby="h"></section><h2 id="h">A</h2></div><div ${attr}><section aria-labelledby="h"></section><h2 id="h">B</h2></div>`;
  const hiddenRef = await dupRows(t, pair('hidden'));
  assert.equal(hiddenRef[0].evidence.misresolved, 1, 'the second referrer does resolve to the wrong heading');
  assert.equal(hiddenRef[0].verdict, 'likely', 'but a hidden referrer exposes no name');
  assert.equal((await dupRows(t, pair('')))[0].verdict, undefined, 'paired: the same markup rendered is confirmed');
});

const gif = 'data:image/gif;base64,R0lGODlhAQABAAAAACw=';
test('duplicate id: flat siblings (no shared nesting to tell the copies apart) with different names still confirm; same text or a hidden copy stays likely', async (t) => {
  const lf = await dupRows(t, '<label for="q">Search jobs</label><input id="q" type="text"><label for="q">Search locations</label><input id="q" type="text">');
  if (!lf) return;
  assert.equal(lf[0].verdict, undefined, 'the second input has no label of its own: confirmed');
  assert.equal(lf[0].evidence.shown, 1);
  assert.equal((await dupRows(t, '<label for="q">Search jobs</label><input id="q"><label for="q" hidden>Search locations</label><input id="q" hidden>'))[0].verdict, 'likely', 'one rendered referrer: nothing is mislabelled');
  const lb = await dupRows(t, '<h2 id="t">Open roles</h2><section aria-labelledby="t"><p>x</p></section><h2 id="t">Benefits</h2><section aria-labelledby="t"><p>y</p></section>');
  assert.equal(lb[0].verdict, undefined, 'the Benefits region is named Open roles');
  assert.equal((await dupRows(t, '<h2 id="t">Roles</h2><section aria-labelledby="t"><p>x</p></section><h2 id="t">Roles</h2><section aria-labelledby="t"><p>y</p></section>'))[0].verdict, 'likely');
});

test('duplicate id: the name read from img alt, svg title or a child aria-label decides, not textContent', async (t) => {
  const alt = (n) => `<section aria-labelledby="h"><h2 id="h"><img alt="${n}" src="${gif}"></h2></section>`;
  const dup = await dupRows(t, alt('Alpha') + alt('Beta'));
  if (!dup) return;
  assert.equal(dup[0].verdict, undefined, 'section 2 is announced as Alpha');
  assert.equal((await dupRows(t, alt('Same') + alt('Same')))[0].verdict, 'likely');
  const svg = (n) => `<section aria-labelledby="h"><h2 id="h"><svg role="img"><title>${n}</title></svg></h2></section>`;
  assert.equal((await dupRows(t, svg('One') + svg('Two')))[0].verdict, undefined);
  const hid = (n) => `<section aria-labelledby="h"><h2 id="h">Same<span aria-hidden="true">${n}</span></h2></section>`;
  assert.equal((await dupRows(t, hid('x') + hid('y')))[0].verdict, 'likely', 'aria-hidden children do not change the name');
});

test('duplicate id: aria-errormessage and headers duplicates whose text differs confirm (nested and flat); same text or a hidden referrer stays likely', async (t) => {
  const em = (a, b) => `<div><input aria-invalid="true" aria-errormessage="e"><span id="e">${a}</span></div><div><input aria-invalid="true" aria-errormessage="e"><span id="e">${b}</span></div>`;
  const nested = await dupRows(t, em('Name required', 'Email required'));
  if (!nested) return;
  assert.equal(nested[0].verdict, undefined, 'the Email field announces Name required');
  assert.equal(nested[0].evidence.shown, 1);
  assert.equal((await dupRows(t, em('Required', 'Required')))[0].verdict, 'likely');
  assert.equal((await dupRows(t, '<input aria-invalid="true" aria-errormessage="e"><span id="e">Name required</span><input aria-invalid="true" aria-errormessage="e"><span id="e">Email required</span>'))[0].verdict, undefined, 'flat tie');
  const tbl = (h) => `<table><tr><th id="h">${h}</th></tr><tr><td headers="h">a</td></tr></table>`;
  assert.equal((await dupRows(t, tbl('Name') + tbl('Salary')))[0].verdict, undefined, 'the second cell is announced under Name');
  assert.equal((await dupRows(t, tbl('Name') + tbl('Name')))[0].verdict, 'likely');
  assert.equal((await dupRows(t, '<table><tr><th id="h">Name</th><th id="h">Age</th></tr><tr><td headers="h">a</td><td headers="h">b</td></tr></table>'))[0].verdict, undefined, 'flat headers');
  assert.equal((await dupRows(t, '<button aria-controls="p" aria-expanded="false">One</button><div id="p">panel one</div><button aria-controls="p" aria-expanded="false">Two</button><div id="p">panel two</div>'))[0].verdict, undefined, 'flat aria-controls');
  const vh = (n) => `<div><section aria-labelledby="t" style="visibility:hidden"></section><h2 id="t">${n}</h2></div>`;
  assert.equal((await dupRows(t, vh('A') + vh('B')))[0].verdict, 'likely', 'a visibility:hidden referrer exposes no name');
  assert.equal((await dupRows(t, '<label for="q">Name</label><label for="q">(required)</label><input id="q" type="text"><div id="q">anchor</div>'))[0].verdict, 'likely', 'only one labelable copy: both labels reach it');
  assert.equal((await dupRows(t, '<h2 id="t" hidden>Template</h2><h2 id="t">Real</h2><section aria-labelledby="t"><p>x</p></section><section aria-labelledby="t"><p>y</p></section>'))[0].verdict, undefined, 'the hidden first copy names both regions Template');
});

test('duplicate id: label[for] whose id first resolves to a non-labelable element confirms (the visible input is unnamed); a labelable first copy stays likely', async (t) => {
  const hid = await dupRows(t, '<form><input type="hidden" id="email" value="x"><label for="email">Email</label><input id="email" type="email"></form>');
  if (!hid) return;
  assert.equal(hid[0].verdict, undefined, 'label.control is null and the email input has no name');
  assert.equal(hid[0].evidence.shown, 1);
  const div = await dupRows(t, '<div id="q">anchor</div><label for="q">Name</label><input id="q" type="text">');
  assert.equal(div[0].verdict, undefined);
  assert.equal(div[0].evidence.shown, 1);
  assert.equal((await dupRows(t, '<input id="q" type="text"><label for="q">Name</label><div id="q">anchor</div>'))[0].verdict, 'likely', 'the label reaches the only input');
  assert.equal((await dupRows(t, '<input type="hidden" id="e"><label for="e" hidden>Email</label><input id="e" type="email">'))[0].verdict, 'likely', 'a hidden label names nothing');
});

test('duplicate id: label[for] whose id first resolves to a labelable but not rendered input still confirms when a rendered copy follows (the visible input is unnamed)', async (t) => {
  const css = await dupRows(t, '<input id="e" style="display:none"><label for="e">Email</label><input id="e" type="email">');
  if (!css) return;
  assert.equal(css[0].verdict, undefined, 'label.control is the hidden input, the visible one has no name');
  assert.equal(css[0].evidence.shown, 1);
  const wrap = await dupRows(t, '<div aria-hidden="true"><input id="e"></div><label for="e">Email</label><input id="e" type="email">');
  assert.equal(wrap[0].verdict, undefined);
  assert.equal(wrap[0].evidence.shown, 1);
});

const svgPage = (t, body, fn) => requireBrowser(t).then(async (browser) => {
  if (!browser) return;
  t.after(closeBrowser);
  const page = await (await browser.newContext()).newPage();
  try { await page.setContent(`<!doctype html><html lang="en"><head><title>t</title></head><body>${body}</body></html>`); await fn(page); } finally { await page.context().close(); }
});
const svgRow = (selector, layer) => ({ ruleId: 'svg-img-alt', layer, element: { selector, outerHTML: '<svg role="img">' }, verdict: 'confirmed', kind: 'deterministic', evidence: { proof: { type: 'measured-fact', fact: 'x 1' } } });

test('svg-img-alt: an unnamed svg inside a named button or link is needs-review (axe and Lighthouse rows); an svg alone or in an unnamed control stays confirmed', async (t) => {
  await svgPage(t, `
    <button id="named"><span class="in"><svg role="img" id="s1"></svg></span><span>Learn more</span></button>
    <button id="aria" aria-label="Next slide"><svg role="img" id="s2"><use href="#a"></use></svg></button>
    <a id="lnk" href="/x"><svg role="img" id="s3"></svg> Apply</a>
    <button id="hiddentext"><svg role="img" id="s4"></svg><span style="display:none">Hidden label</span></button>
    <button id="ariahidden"><svg role="img" id="s7"></svg><span aria-hidden="true">Close</span></button>
    <button id="icononly"><svg role="img" id="s5"></svg></button>
    <div><svg role="img" id="s6"></svg></div>`, async (page) => {
    const sels = ['#s1', '#s2', '#s3', '#s4', '#s7', '#s5', '#s6'];
    const rows = sels.map((s, i) => svgRow(s, i % 2 ? 'lighthouse' : 'axe'));
    assert.equal(await applySvgChildOfNamedControl(page, rows), 3);
    assert.deepEqual(rows.map((r) => r.verdict), ['needs-review', 'needs-review', 'needs-review', 'confirmed', 'confirmed', 'confirmed', 'confirmed']);
    assert.match(rows[0].evidence.reviewReason, /already named "Learn more"/);
    assert.equal(rows[0].evidence.proof, undefined, 'the stale proof is dropped');
    assert.equal(rows[3].evidence.proof.type, 'measured-fact', 'a confirmed row keeps its proof');
  });
});
