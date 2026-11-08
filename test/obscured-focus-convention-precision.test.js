import './helpers/hermetic-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { loadBuiltInRuleRegistry } from '../src/scanner/access-scan/engine/builtin-registry.js';
import { runRules } from '../src/scanner/access-scan/engine/runner.js';
import { PROFILES } from '../src/scanner/access-scan/engine/profiles.js';
import { createScanSession } from '../src/scanner/access-scan/runtime/index.js';
import { toViolation } from '../src/scanner/access-scan/engine/finding.js';
import { buildScanReportV2 } from '../src/reporter/report-v2.js';
import { annotateOrigins } from '../src/scanner/origin.js';
import { closeBrowser } from '../src/scanner/browser.js';
import { scanKeyboardNavigation } from '../src/scanner/keyboard.js';
import { scanFocusTraps } from '../src/scanner/focus-trap.js';
import { carryMeasurement } from '../src/index.js';
import { createViolation } from '../src/schema.js';
import { requireBrowser } from './helpers/require-browser.js';
import { startParadoxSite } from './helpers/paradox-site-server.js';

const RUN = { layer: 'axe', engine: { name: 'axe-core', version: '4.12.1' }, status: 'complete' };
const report = (violations) => buildScanReportV2([{ page: 'p', url: 'https://example.test/', scannerRuns: [RUN], violations }], { producer: { version: '0.0.0' }, agreementPolicy: 'off' }).pages[0].findings;

async function scanRule(html, ruleId) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await (await browser.newContext({ viewport: { width: 1000, height: 600 } })).newPage();
    await page.setContent(html, { waitUntil: 'domcontentloaded' });
    const session = await createScanSession(page);
    const registry = await loadBuiltInRuleRegistry({ enforceCatalogContract: true });
    const { findings } = await runRules({ registry, profile: PROFILES.STANDARDS, context: { snapshot: session.snapshot, session }, skipRules: registry.getActiveRuleIds().filter((id) => id !== ruleId) });
    const violations = findings.map((f) => toViolation(f, { rule: registry.getRule(ruleId) }));
    await annotateOrigins(page, violations, { servedHtml: html });
    return report(violations).filter((f) => f.nativeRuleId === ruleId);
  } finally { await browser.close(); }
}

// Obscured focus: who owns the obscuring element decides who owns the finding.
const TALL = '<div style="height:2000px"></div>';
const bar = (attrs) => `<div ${attrs} style="position:fixed;left:0;right:0;bottom:0;height:80px;background:#222;z-index:10">bar</div>`;
for (const [name, attrs, owner] of [
  ['vendor consent banner covers the last link: vendor-script, outside the gate, serious at most', 'id="onetrust-banner-sdk"', 'third-party'],
  ['the site\'s own sticky bar covers the last link: stays site-owned and confirmed (true positive)', 'id="site-bar"', 'site'],
]) {
  test(`FocusNotObscuredFooter ownership: ${name}`, async () => {
    const found = await scanRule(`<main>${TALL}<a id="last" href="#x">Last</a></main>${bar(attrs)}`, 'FocusNotObscuredFooter');
    assert.equal(found.length, 1);
    assert.equal(found[0].origin.owner, owner);
    if (owner === 'third-party') {
      assert.equal(found[0].origin.kind, 'vendor-script');
      assert.equal(found[0].origin.vendor, 'onetrust');
      assert.match(found[0].origin.label, /overlay/);
      assert.notEqual(found[0].impact, 'critical');
    } else {
      assert.equal(found[0].verdict, 'confirmed');
      assert.equal(found[0].impact, 'serious');
    }
    assert.match(found[0].evidence.proof?.fact ?? found[0].evidence.observations?.[0]?.evidence?.proof?.fact ?? '', /viewport \d+x\d+px/);
  });
}

// Convention rule: ol/li is recommended markup, not a WCAG failure.
const nav = (inner) => `<main><nav aria-label="Breadcrumb">${inner}</nav></main>`;
for (const [name, html, expected] of [
  ['labelled nav with a Home link and aria-current but no ol: needs-review minor', nav('<a href="/">Home</a> <span aria-hidden="true">/</span> <a href="/jobs" aria-current="page">Jobs</a>'), { verdict: 'needs-review', impact: 'minor' }],
  ['no ol and no current-page indication (true positive): stays confirmed with proof', nav('<a href="/">Home</a> <a href="/jobs">Jobs</a>'), { verdict: 'confirmed', impact: 'moderate' }],
  ['ol markup: no finding', nav('<ol><li><a href="/">Home</a></li><li><a href="/jobs" aria-current="page">Jobs</a></li></ol>'), null],
]) {
  test(`BreadcrumbsNav: ${name}`, async () => {
    const found = await scanRule(html, 'BreadcrumbsNav');
    if (!expected) return assert.equal(found.length, 0);
    assert.equal(found.length, 1);
    assert.equal(found[0].verdict, expected.verdict);
    assert.equal(found[0].impact, expected.impact);
    if (expected.verdict === 'confirmed') assert.match(JSON.stringify(found[0].evidence), /current page is not indicated/);
  });
}

// Behaviour heuristics: a focus trap that only a CDN script would add is not measured when that script never loaded.
const DIALOG = (modal, extra = '') => `<button aria-haspopup="dialog" onclick="const d=document.getElementById('d');d.hidden=false;d.querySelector('button').focus()">Open</button>
  <div role="dialog" ${modal ? 'aria-modal="true"' : ''} aria-label="Share" id="d" hidden style="position:fixed;top:20px;left:20px;background:#fff"><button>Inside</button></div>
  <a href="#a">after 1</a><a href="#b">after 2</a>${extra}`;
const pageOf = (body) => (req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html><html lang="en"><head><title>t</title></head><body>${body}</body></html>`);

async function trapFindings(t, body, extraRoutes = {}) {
  const browser = await requireBrowser(t);
  if (!browser) return null;
  t.after(closeBrowser);
  const site = await startParadoxSite({ routes: { '/': pageOf(body), ...extraRoutes } });
  try {
    const result = await scanFocusTraps(`${site.url}/`);
    const vs = result.violations.map((v) => carryMeasurement(createViolation({
      ruleId: v.rule, layer: 'focusTrap', impact: 'critical', priority: 1, element: { outerHTML: '', selector: v.element?.selector || '' }, source: { mode: 'url' }, fix: { hint: v.description },
    }), v, result.blockedScripts));
    return { result, findings: report(vs).filter((f) => f.nativeRuleId === 'modal-focus-escapes') };
  } finally { await site.close(); }
}

test('modal-focus-escapes: a real modal opened by the scanner with no trap stays confirmed, with the Tab count and dialog attributes in proof (true positive)', async (t) => {
  const out = await trapFindings(t, DIALOG(true));
  if (!out) return;
  assert.equal(out.findings.length, 1);
  // Leaving a modal is 2.4.3 advice (APG), not a 2.1.2 keyboard trap: the measured escape is likely at most, impact serious.
  assert.equal(out.findings[0].verdict, 'likely');
  assert.equal(out.findings[0].impact, 'serious');
  // The proof is kept for confirmed findings only; a likely one carries the measured count in its description.
  assert.match(out.findings[0].fix.hint, /Focus escaped the modal dialog \d+ time\(s\)/);
});

test('modal-focus-escapes: a non-modal popup (no aria-modal) is needs-review, not confirmed', async (t) => {
  const out = await trapFindings(t, DIALOG(false));
  if (!out) return;
  assert.equal(out.findings.length, 1);
  assert.equal(out.findings[0].verdict, 'needs-review');
  assert.equal(out.findings[0].impact, 'moderate');
  assert.match(JSON.stringify(out.findings[0].evidence), /dialog not opened \/ behaviour script not loaded/);
});

test('modal-focus-escapes: the page\'s focus-trap script did not load (CDN 404): needs-review, and the blocked script is recorded in run metadata', async (t) => {
  const out = await trapFindings(t, DIALOG(true, '<script src="/cdn/focus-trap.js"></script>'), { '/cdn/focus-trap.js': (req, res) => res.writeHead(404).end('gone') });
  if (!out) return;
  assert.equal(out.findings.length, 1);
  assert.equal(out.findings[0].verdict, 'needs-review');
  assert.match(JSON.stringify(out.findings[0].evidence), /behaviour script not loaded during the scan/);
  assert.equal(out.result.blockedScripts.length, 1);
  assert.match(out.result.blockedScripts[0].url, /focus-trap\.js$/);
  assert.equal(out.result.blockedScripts[0].reason, 'HTTP 404');
});

test('carryMeasurement: a carousel finding is needs-review when a page script was blocked, and untouched when none was', () => {
  const mk = () => createViolation({ ruleId: 'carousel-next-not-functional', layer: 'dynamicContent', impact: 'moderate', source: { mode: 'url' } });
  assert.equal(carryMeasurement(mk(), {}, [{ url: 'https://cdn.example/embla.js', reason: 'net::ERR_BLOCKED' }]).verdict, 'needs-review');
  assert.equal(carryMeasurement(mk(), {}, []).verdict, undefined);
});

// Keyboard layer (heuristic, needs-review): same guards as the accessScan check.
const KB_BAR = '<div id="onetrust-banner-sdk" style="position:fixed;left:0;right:0;bottom:0;height:120px;background:#222;color:#fff">banner</div>';
async function keyboardObscured(t, body) {
  const browser = await requireBrowser(t);
  if (!browser) return null;
  t.after(closeBrowser);
  const site = await startParadoxSite({ routes: { '/': pageOf(body) } });
  try { return (await scanKeyboardNavigation(`${site.url}/`)).violations.filter((v) => v.rule === 'focus-obscured-by-sticky'); } finally { await site.close(); }
}
test('focus-obscured-by-sticky: a non-scrollable shell reports nothing; a scrollable page whose last link stays covered reports it with the viewport (true positive)', async (t) => {
  const shell = await keyboardObscured(t, `<a href="#a">Only link</a><div style="height:640px"></div>${KB_BAR.replace('height:120px', 'height:900px')}`);
  if (!shell) return;
  assert.equal(shell.length, 0);
  const tall = await keyboardObscured(t, `<div style="height:2400px"></div><a href="#a">Last link</a>${KB_BAR}`);
  assert.equal(tall.length, 1);
  assert.match(tall[0].description, /viewport \d+x\d+px/);
});

// Obscured focus, real keyboard behaviour: the banner is never the victim, scrolling clear is no finding, Tab decides confirmed.
const links = (n) => Array.from({ length: n }, (_, i) => `<a href="#l${i}">link ${i}</a> `).join('');
test('FocusNotObscuredFooter: a focusable banner root and its buttons are never the obscured element; the covered link is', async () => {
  const banner = '<div id="onetrust-banner-sdk" tabindex="0" style="position:fixed;left:0;right:0;bottom:0;height:80px;background:#222;z-index:10"><button id="accept">Accept</button></div>';
  const found = await scanRule(`<main>${TALL}<a id="last" href="#x">Last</a></main>${banner}`, 'FocusNotObscuredFooter');
  assert.equal(found.length, 1);
  assert.match(found[0].element.outerHTML, /id="last"/);
  assert.equal(found[0].origin.owner, 'third-party');
  assert.match(found[0].siteFix?.note ?? '', /scroll-padding-bottom/, 'a third-party cover still carries the site-side mitigation');
});

test('FocusNotObscuredFooter: when focus scrolling brings the link clear of the bar there is no finding; without that clearance it is found', async () => {
  const cleared = await scanRule(`<main style="padding-bottom:200px">${TALL}<a id="last" href="#x">Last</a></main>${bar('id="site-bar"')}`, 'FocusNotObscuredFooter');
  assert.equal(cleared.length, 0);
  const covered = await scanRule(`<main>${TALL}<a id="last" href="#x">Last</a></main>${bar('id="site-bar"')}`, 'FocusNotObscuredFooter');
  assert.equal(covered.length, 1);
});

test('FocusNotObscuredFooter: real Tab reaching the covered link confirms it; a link beyond the first 60 Tab stops stays needs-review', async () => {
  const reached = await scanRule(`<main>${links(5)}${TALL}<a id="last" href="#x">Last</a></main>${bar('id="site-bar"')}`, 'FocusNotObscuredFooter');
  assert.equal(reached.length, 1);
  assert.equal(reached[0].verdict, 'confirmed');
  const far = await scanRule(`<main>${links(70)}${TALL}<a id="last" href="#x">Last</a></main>${bar('id="site-bar"')}`, 'FocusNotObscuredFooter');
  assert.equal(far.length, 1);
  assert.equal(far[0].verdict, 'needs-review');
});
