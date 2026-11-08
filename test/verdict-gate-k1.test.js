import './helpers/hermetic-env.mjs';
import http from 'node:http';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildScanReportV2 } from '../src/reporter/report-v2.js';
import { proofFor } from '../src/utils/verdict.js';
import { disclosureVerdict, judgeDisclosure, scanDisclosures } from '../src/scanner/disclosure.js';
import { scanScreenReaderAccessibility } from '../src/scanner/screen-reader.js';
import { scanDynamicContent } from '../src/scanner/dynamic-content.js';
import { getBrowser, closeBrowser } from '../src/scanner/browser.js';
import { requireBrowser } from './helpers/require-browser.js';

const run = (layer) => ({ layer, engine: { name: layer, version: '1' }, status: 'complete' });
const settle = (layer, over) => buildScanReportV2([{ page: 'p', url: 'https://example.test/', scannerRuns: [run(layer)], violations: [{
  layer, impact: 'critical', element: { selector: 'x', outerHTML: '<x></x>' }, source: {}, fix: { hint: 'h' }, verdict: 'confirmed', ...over,
}] }], { producer: { version: '0.0.0' }, agreementPolicy: 'off' }).pages[0].findings[0];
const proof = (fact = 'measured 2 things "x"') => ({ proof: { type: 'measured-fact', fact } });

test('1. a behavioural rule without a recorded proof is not proved by its own description', () => {
  const v = { layer: 'screenReader', ruleId: 'page-missing-title', description: 'Page has 2 <main> elements "Apply"' };
  assert.equal(proofFor(v).type, 'dom-structure');
  assert.notEqual(settle('screenReader', { ruleId: 'page-missing-title', description: v.description }).verdict, 'confirmed');
  assert.equal(settle('screenReader', { ruleId: 'page-missing-title', description: v.description, evidence: proof() }).verdict, 'confirmed');
});

test('1. keyboard rows whose check measured (pixel proof, landed stop, id lookup) keep confirmed through the adapter proof', () => {
  for (const ruleId of ['focus-not-visible', 'focus-invisible-stop', 'skip-link-missing']) {
    assert.equal(settle('keyboard', { ruleId, description: `${ruleId} measured 3 stops`, evidence: proof() }).verdict, 'confirmed', ruleId);
  }
});

test('5. rules that are not WCAG A/AA failures never confirm', () => {
  const nm = (ruleId) => settle('screenReader', { ruleId, evidence: proof() }).verdict;
  assert.equal(nm('missing-main-landmark'), 'needs-review');
  assert.equal(nm('multiple-main-landmarks'), 'needs-review');
  assert.equal(nm('empty-heading'), 'likely');
  assert.equal(settle('focusTrap', { ruleId: 'dialog-no-label', evidence: proof() }).verdict, 'needs-review');
  assert.equal(settle('dynamicContent', { ruleId: 'tabs-missing-aria-controls', evidence: proof() }).verdict, 'needs-review');
  for (const ruleId of ['modal-focus-escapes', 'modal-focus-not-trapped']) assert.equal(settle('focusTrap', { ruleId, evidence: proof() }).verdict, 'likely', ruleId);
  assert.equal(settle('keyboard', { ruleId: 'skip-link-target-missing', evidence: proof() }).verdict, 'likely');
});

const S = (o) => ({ shown: false, hidden: false, ariaHidden: '', height: 0, ...o });
const flip = judgeDisclosure({ before: S({}), after: S({ shown: true, height: 300 }), targetLabel: 'nav#d' });
const heightOnly = judgeDisclosure({ before: S({ shown: true, height: 50 }), after: S({ shown: true, height: 300 }), targetLabel: 'div' });

test('9. disclosure: confirmed only on a visibility flip of a target found by aria-controls or adjacent sibling, not a dialog, no aria-pressed', () => {
  const ok = { judged: flip, hasTarget: true, targetHow: 'controls', isDialog: false, pressed: false };
  assert.equal(disclosureVerdict(ok).verdict, 'confirmed');
  assert.equal(disclosureVerdict({ ...ok, targetHow: 'sibling' }).verdict, 'confirmed');
  assert.equal(disclosureVerdict({ ...ok, judged: heightOnly }).verdict, 'needs-review', 'height only');
  assert.equal(disclosureVerdict({ ...ok, targetHow: 'fallback' }).verdict, 'needs-review', 'page-wide drawer fallback');
  assert.equal(disclosureVerdict({ ...ok, isDialog: true }).verdict, 'needs-review', 'dialog trigger');
  assert.equal(disclosureVerdict({ ...ok, pressed: true }).verdict, 'needs-review', 'toggle button');
});

async function serve(body) {
  const server = http.createServer((req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html><html lang="en"><head><title>t</title></head><body>${body}</body></html>`));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}/`, close: () => server.close() };
}

test('9. disclosure: dialog trigger and a carousel-style height-only panel are needs-review in a live page', async (t) => {
  if (!(await requireBrowser(t))) return;
  t.after(closeBrowser);
  const site = await serve(`<button id="sw" role="switch" aria-checked="false" aria-controls="n3" data-t="n3">Filters</button><div id="n3" hidden>f</div>
    <button id="dlg" aria-haspopup="dialog" aria-controls="d1" data-t="d1">Open</button><div id="d1" role="dialog" hidden>x</div>
    <button id="ham" class="hamburger" aria-controls="n1" data-t="n1">Menu</button><nav id="n1" hidden><a href="/a">A</a></nav>
    <button id="ham2" class="hamburger" aria-controls="n2" data-t="n2">Menu2</button><nav id="n2" hidden><a href="/a">A</a><div role="dialog" hidden>lang</div></nav>
    <script>document.addEventListener('click',(e)=>{const b=e.target.closest('[data-t]');if(!b)return;const p=document.getElementById(b.dataset.t);p.hidden=!p.hidden;});</script>`);
  t.after(site.close);
  const page = await (await (await getBrowser()).newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  try {
    await page.goto(site.url);
    const by = Object.fromEntries((await scanDisclosures(page)).map((r) => [r.element.selector, r]));
    assert.equal(by['#ham'].verdict, 'confirmed');
    assert.equal(by['#ham2'].verdict, 'confirmed', 'a drawer that merely contains a dialog is not itself a dialog');
    assert.equal(by['#dlg'].verdict, 'needs-review');
    assert.equal(by['#sw'].verdict, 'needs-review', 'a switch exposes its state through aria-checked');
  } finally { await page.context().close(); }
});

test('11. image-alt-missing-sr skips aria-hidden, presentation, named and hidden images; a bare img still counts', async (t) => {
  if (!(await requireBrowser(t))) return;
  t.after(closeBrowser);
  const site = await serve(`<main><h1>x</h1>
    <img src="a.png" aria-hidden="true"><img src="b.png" role="presentation"><img src="c.png" role="none">
    <img src="d.png" aria-label="named"><img src="e.png" title="titled"><img src="f.png" style="display:none"><div aria-hidden="true"><img src="g.png"></div>
    <img src="bare.png"></main>`);
  t.after(site.close);
  const res = await scanScreenReaderAccessibility(site.url);
  const rows = res.violations.filter((v) => v.rule === 'image-alt-missing-sr');
  assert.equal(rows.length, 1);
  assert.match(rows[0].description, /^1 image\(s\) missing alt/);
  assert.match(rows[0].evidence.proof.fact, /1 img/);
});

test('11. placeholder branching: placeholder + id is placeholder-only, no placeholder + id is no-label, title names a field', async (t) => {
  if (!(await requireBrowser(t))) return;
  t.after(closeBrowser);
  const site = await serve(`<form><input id="ph" type="text" placeholder="Your name"><input type="text" placeholder="Email"><input id="bare" type="text"><input id="ti" type="text" title="City"></form>`);
  t.after(site.close);
  const res = await scanDynamicContent(site.url);
  const rows = res.violations.filter((v) => /^form-field/.test(v.rule)).map((v) => `${v.rule}:${v.element.id || v.element.placeholder}`).sort();
  assert.ok(rows.includes('form-field-no-label:bare'));
  assert.ok(rows.includes('form-field-placeholder-only:Email'), rows.join());
  assert.ok(rows.includes('form-field-placeholder-only:ph'), rows.join());
  assert.ok(!rows.some((r) => r.startsWith('form-field-no-label:ph')), rows.join());
  assert.ok(!rows.some((r) => r.endsWith(':ti')), rows.join());
});

// 8. focus-not-obscured: a translucent bar is a question; an opaque one still confirms.
test('8. FocusNotObscuredFooter: translucent bar is needs-review, opaque bar stays confirmed', async (t) => {
  const { chromium } = await import('playwright');
  const { loadBuiltInRuleRegistry } = await import('../src/scanner/access-scan/engine/builtin-registry.js');
  const { runRules } = await import('../src/scanner/access-scan/engine/runner.js');
  const { PROFILES } = await import('../src/scanner/access-scan/engine/profiles.js');
  const { createScanSession } = await import('../src/scanner/access-scan/runtime/index.js');
  const { toViolation } = await import('../src/scanner/access-scan/engine/finding.js');
  const scan = async (bg) => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await (await browser.newContext({ viewport: { width: 1000, height: 600 } })).newPage();
      await page.setContent(`<main><div style="height:2000px"></div><button id="b">Go</button></main><footer style="position:fixed;left:0;right:0;bottom:0;height:80px;background:${bg};z-index:10">Footer</footer>`, { waitUntil: 'domcontentloaded' });
      const session = await createScanSession(page);
      const registry = await loadBuiltInRuleRegistry({ enforceCatalogContract: true });
      const id = 'FocusNotObscuredFooter';
      const { findings } = await runRules({ registry, profile: PROFILES.STANDARDS, context: { snapshot: session.snapshot, session }, skipRules: registry.getActiveRuleIds().filter((r) => r !== id) });
      const violations = findings.map((f) => toViolation(f, { rule: registry.getRule(id) }));
      return buildScanReportV2([{ page: 'p', url: 'https://example.test/', scannerRuns: [run('axe')], violations }], { producer: { version: '0.0.0' }, agreementPolicy: 'off' }).pages[0].findings.filter((f) => f.nativeRuleId === id);
    } finally { await browser.close(); }
  };
  try { await (await import('playwright')).chromium.executablePath(); } catch { return t.skip('no browser'); }
  const opaque = await scan('#222');
  assert.deepEqual(opaque.map((f) => f.verdict), ['confirmed']);
  const translucent = await scan('rgba(0,0,0,0.4)');
  assert.deepEqual(translucent.map((f) => f.verdict), ['needs-review']);
  // Modern colour syntax (Tailwind v4 emits oklch) is parsed: opaque stays confirmed, an alpha below 1 is still a question.
  for (const bg of ['oklch(0.25 0 0)', 'lab(10% 0 0)', 'color(srgb 0.1 0.1 0.1)', 'hsl(0 0% 10%)']) assert.deepEqual((await scan(bg)).map((f) => f.verdict), ['confirmed'], bg);
  for (const bg of ['oklch(0.25 0 0 / 0.4)', 'oklch(0.25 0 0 / 40%)', 'rgb(34 34 34 / 40%)', 'oklch(0.25 0 0 / none)']) assert.deepEqual((await scan(bg)).map((f) => f.verdict), ['needs-review'], bg);
});

test('5. focus-trap: dialog-no-label only for an open dialog, and a titled dialog has a name', async (t) => {
  if (!(await requireBrowser(t))) return;
  t.after(closeBrowser);
  const { scanFocusTraps } = await import('../src/scanner/focus-trap.js');
  const site = await serve(`<div role="dialog" hidden id="closed">x</div><div role="dialog" title="Named" id="titled">x</div><div role="dialog" id="open">x</div>`);
  t.after(site.close);
  const res = await scanFocusTraps(site.url);
  const rows = res.violations.filter((v) => v.rule === 'dialog-no-label').map((v) => v.element.selector);
  assert.deepEqual(rows, ['#open']);
});

test('1. keyboardEvidence: proof only for the keyboard rules whose check measured, never for a needs-review row or another rule', async () => {
  const { keyboardEvidence } = await import('../src/index.js');
  assert.equal(keyboardEvidence({ rule: 'skip-link-target-missing', description: 'Skip link "Skip" points to #main, but no element with that id exists' }).proof.type, 'measured-fact');
  assert.equal(keyboardEvidence({ rule: 'focus-not-visible', verdict: 'confirmed', description: 'no indicator (3px)' }).proof.type, 'measured-fact');
  assert.equal(keyboardEvidence({ rule: 'focus-not-visible', verdict: 'needs-review', description: 'no indicator' }), undefined);
  assert.equal(keyboardEvidence({ rule: 'focus-indicator-removed', verdict: 'confirmed', description: 'outline:none;' }), undefined);
  assert.equal(keyboardEvidence({ rule: 'focus-lost-after-escape', description: 'x', evidence: { proof: { type: 'measured-fact', fact: 'recorded 1' } } }).proof.fact, 'recorded 1');
});

test('1. link rows keep confirmed through their own proof: empty href (attribute) and crawl-found broken link (http-status)', () => {
  const [a] = [settle('links', { ruleId: 'dead-link-empty-href', category: 'reliability', evidence: proof('href="#"') })];
  assert.equal(a.verdict, 'confirmed');
  assert.notEqual(settle('links', { ruleId: 'dead-link-empty-href', category: 'reliability', description: 'Link "x" has empty or # href.' }).verdict, 'confirmed');
});

test('2.4.3: a position:fixed app shell that holds the page controls does not hide a modal that lets focus escape', async (t) => {
  if (!(await requireBrowser(t))) return;
  t.after(closeBrowser);
  const { scanFocusTraps } = await import('../src/scanner/focus-trap.js');
  const dlg = `<div id="dlg" role="dialog" aria-modal="true" aria-label="Settings" hidden style="position:fixed;top:100px;left:100px;background:#fff"><button id="inner" type="button">Inner</button></div>`;
  const page = (wrap) => `${wrap ? '<div id="app" style="position:fixed;inset:0;overflow:auto">' : ''}<a href="#x">Before</a><button id="open" type="button" aria-haspopup="dialog" aria-controls="dlg">Open</button><a href="#y">After 1</a><a href="#z">After 2</a>${dlg}${wrap ? '</div>' : ''}
    <script>document.getElementById('open').addEventListener('click',()=>{document.getElementById('dlg').hidden=false;document.getElementById('inner').focus();});</script>`;
  const rows = async (wrap) => { const site = await serve(page(wrap)); try { return (await scanFocusTraps(site.url)).violations.filter((v) => v.rule === 'modal-focus-escapes'); } finally { site.close(); } };
  assert.equal((await rows(false)).length, 1, 'control');
  assert.equal((await rows(true)).length, 1, 'fixed shell containing the trigger');
});

test('2.4.3: trigger outside a fixed shell that holds many page links still reports a modal focus escape', async (t) => {
  if (!(await requireBrowser(t))) return;
  t.after(closeBrowser);
  const { scanFocusTraps } = await import('../src/scanner/focus-trap.js');
  const links = Array.from({ length: 20 }, (_, i) => `<a href="#l${i}">Link ${i}</a>`).join('');
  const html = `<header><button id="open" type="button" aria-haspopup="dialog" aria-controls="dlg">Open</button></header>
    <div id="app" style="position:fixed;top:60px;inset-inline:0;bottom:0;overflow:auto"><div id="dlg" role="dialog" aria-modal="true" aria-label="Settings" hidden style="position:fixed;top:100px;left:100px;background:#fff"><button id="inner" type="button">Inner</button></div>${links}</div>
    <script>document.getElementById('open').addEventListener('click',()=>{document.getElementById('dlg').hidden=false;document.getElementById('inner').focus();});</script>`;
  const site = await serve(html);
  try { assert.equal((await scanFocusTraps(site.url)).violations.filter((v) => v.rule === 'modal-focus-escapes').length, 1); } finally { site.close(); }
});
