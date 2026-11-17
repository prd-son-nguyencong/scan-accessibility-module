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
import { hasProof } from '../src/utils/verdict.js';

const RUN = { layer: 'axe', engine: { name: 'axe-core', version: '4.12.1' }, status: 'complete' };
const FOOTER = '<footer id="foot" style="position:fixed;left:0;right:0;bottom:0;height:80px;background:#222;z-index:10">Footer</footer>';
const TALL = '<div style="height:2000px"></div>'; // a page with scrollable overflow: focus can scroll, so a bar that still covers the control is real
const FIXTURES = {
  'sticky footer covers a focusable at the bottom (true positive)': {
    html: `<main>${TALL}<button id="b">Go</button></main>${FOOTER}`, expectFooter: true,
  },
  'the focused element is the fixed bar itself (a consent banner that takes focus): nothing obscures it': {
    html: `<main>${TALL}</main>${FOOTER.replace('<footer id="foot"', '<footer id="foot" tabindex="0"')}`, expectFooter: false,
  },
  'a fixed focusable is not moved by scrolling: not an obscured-by-scroll finding': {
    html: `<main>${TALL}<button id="b" style="position:fixed;left:10px;bottom:10px;width:60px;height:30px">Go</button></main>${FOOTER}`, expectFooter: false,
  },
  'short page: the fixed bar does not reach the focusable': {
    html: `<main><button id="b">Go</button></main>${FOOTER.replace('height:80px', 'height:600px')}`, expectFooter: false,
  },
  'sticky footer, focusable well above it': {
    html: `<main><button id="b">Go</button></main>${FOOTER}`, expectFooter: false,
  },
  'static footer, focusable at the bottom': {
    html: '<main><button id="b">Go</button></main><footer style="height:80px">Footer</footer>', expectFooter: false,
  },
  'sticky footer far below a long page: focus scrolls the button clear of it': {
    html: `<main><div style="height:3000px"></div><button id="b">Go</button><div style="height:200px"></div></main>${FOOTER}`, expectFooter: false,
  },
  'invisible (opacity 0) fixed footer still wins elementFromPoint': {
    html: `<main>${TALL}<button id="b">Go</button></main>${FOOTER.replace('z-index:10', 'z-index:10;opacity:0')}`, expectFooter: false,
  },
  'no footer': { html: '<main><button id="b" style="position:fixed;bottom:0">Go</button></main>', expectFooter: false },
};

async function scan(html, ruleId = 'FocusNotObscuredFooter') {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await (await browser.newContext({ viewport: { width: 1000, height: 600 } })).newPage();
    await page.setContent(html, { waitUntil: 'domcontentloaded' });
    const session = await createScanSession(page);
    const registry = await loadBuiltInRuleRegistry({ enforceCatalogContract: true });
    const skip = registry.getActiveRuleIds().filter((id) => id !== ruleId);
    const { findings } = await runRules({ registry, profile: PROFILES.STANDARDS, context: { snapshot: session.snapshot, session }, skipRules: skip });
    const rule = registry.getRule(ruleId);
    const violations = findings.map((f) => toViolation(f, { rule }));
    const report = buildScanReportV2([{ page: 'p', url: 'https://example.test/', scannerRuns: [RUN], violations }], { producer: { version: '0.0.0' }, agreementPolicy: 'off' });
    return report.pages[0].findings.filter((f) => f.nativeRuleId === ruleId);
  } finally { await browser.close(); }
}

for (const [name, { html, expectFooter }] of Object.entries(FIXTURES)) {
  test(`FocusNotObscuredFooter: ${name}`, async () => {
    const found = (await scan(html)).filter((f) => f.verdict === 'confirmed');
    if (!expectFooter) return assert.equal(found.length, 0);
    assert.equal(found.length, 1);
    assert.equal(found[0].evidence.proof.type, 'element-from-point');
    assert.match(found[0].evidence.proof.fact, /elementFromPoint returned the fixed\/sticky footer .* element y \d+-\d+px, footer y \d+-\d+px, viewport \d+x\d+px/);
  });
}

const HEADER = '<header id="head" style="position:fixed;left:0;right:0;top:0;height:80px;background:#222;z-index:10">Header</header>';
const HEADER_FIXTURES = {
  'sticky header covers a link that cannot scroll clear (true positive)': {
    html: `<main><a id="b" href="#x" style="display:block;margin-top:10px">Go</a>${TALL}</main>${HEADER}`, expect: true,
  },
  'scroll-padding-top present and the link is scrolled below the header': {
    html: `<style>html{scroll-padding-top:100px}</style><main>${TALL}<a id="b" href="#x">Go</a>${TALL}</main>${HEADER}`, expect: false,
  },
  'the focused element is the fixed header itself': {
    html: `<main>${TALL}</main>${HEADER.replace('<header id="head"', '<header id="head" tabindex="0"')}`, expect: false,
  },
  'non-scrollable page: a fixed header over the first link is measured (it cannot be scrolled clear)': {
    html: `<main><a id="b" href="#x" style="display:block;margin-top:10px">Go</a></main>${HEADER}`, expect: true,
  },
  'sticky header, focusable below it': { html: `<main><div style="height:200px"></div><button id="b">Go</button></main>${HEADER}`, expect: false },
  'invisible (opacity 0) fixed header': {
    html: `<main><a id="b" href="#x" style="display:block;margin-top:10px">Go</a>${TALL}</main>${HEADER.replace('z-index:10', 'z-index:10;opacity:0')}`, expect: false,
  },
  'no header': { html: '<main><button id="b" style="position:fixed;top:0">Go</button></main>', expect: false },
};
for (const [name, { html, expect }] of Object.entries(HEADER_FIXTURES)) {
  test(`StickyHeaderObscuresFocus: ${name}`, async () => {
    const found = (await scan(html, 'StickyHeaderObscuresFocus')).filter((f) => f.verdict === 'confirmed');
    assert.equal(found.length, expect ? 1 : 0);
    if (expect) {
      assert.equal(found[0].evidence.proof.type, 'element-from-point');
      assert.match(found[0].evidence.proof.fact, /viewport \d+x\d+px/, 'the viewport the cover was measured in is recorded');
      assert.equal(found[0].impact, 'serious', 'impact is capped at serious');
    }
  });
}

// Table: every rule that measures a rendered state (automation 'behavioral') needs a check-recorded measurement, whatever the rule says.
test('a behavioural accessScan rule never gets the generic rationale as proof; a structural rule still does', async () => {
  const registry = await loadBuiltInRuleRegistry();
  const mk = (id) => {
    const rule = registry.getRule(id);
    const finding = { ruleId: id, violationType: 'confirmed', severity: { impact: 'critical', priority: 1, wcagRef: 'WCAG 2.2 AA 2.4.11' }, element: { outerHTML: '<i></i>', selector: 'i', framePath: [], shadowPath: [] }, recommendation: 'r', evidence: {} };
    return toViolation(finding, { rule });
  };
  const behavioural = registry.listRules().filter((r) => r.kind === 'deterministic' && r.automation === 'behavioral').map((r) => r.id);
  assert.deepEqual(behavioural.sort(), ['FocusNotObscuredFooter', 'StickyHeaderObscuresFocus']);
  for (const id of behavioural) assert.equal(hasProof(mk(id).evidence.proof), false, `${id}: no measurement, no proof`);
  assert.equal(hasProof(mk('HtmlLang').evidence.proof), true);
});

test('no accessScan or behavioural-layer finding is confirmed without an instance-specific proof', () => {
  const v = (over) => ({ ruleId: 'x', layer: 'keyboard', impact: 'serious', element: { selector: 'a', outerHTML: '<a></a>' }, source: {}, fix: { hint: '' }, ...over });
  const report = buildScanReportV2([{ page: 'p', url: 'https://example.test/', scannerRuns: [RUN], violations: [
    v({ ruleId: 'modal-focus-escapes', description: 'Focus escaped the modal dialog 3 time(s) during keyboard navigation' }),
    v({ ruleId: 'page-missing-title', layer: 'screenReader', description: 'Page has 2 <main> elements "Apply"' }),
    v({ ruleId: 'modal-focus-not-trapped', fix: { hint: '' } }),
    v({ ruleId: 'FocusNotObscuredFooter', layer: 'accessScan', kind: 'deterministic', verdict: 'confirmed' }),
  ] }], { producer: { version: '0.0.0' }, agreementPolicy: 'off' });
  const by = Object.fromEntries(report.pages[0].findings.map((f) => [f.nativeRuleId, f]));
  // A description (digits, a quoted id) is wording, not a measurement: a behavioural row confirms only on a proof its check recorded, and a modal escape is 2.4.3 advice (likely).
  assert.notEqual(by['modal-focus-escapes'].verdict, 'confirmed');
  assert.notEqual(by['page-missing-title'].verdict, 'confirmed');
  assert.equal(by['modal-focus-not-trapped'].verdict, 'likely');
  assert.equal(by.FocusNotObscuredFooter.verdict, 'likely');
  for (const f of report.pages[0].findings) if (f.verdict === 'confirmed') assert.ok(hasProof(f.evidence.proof));
});
