import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { classifyOwnership } from '../src/tracer/ownership.js';
import { traceElement } from '../src/tracer/trace-element.js';
import { detectSourceDrift } from '../src/tracer/source-drift.js';
import { buildScanReportV2 } from '../src/reporter/report-v2.js';
import { buildOwnershipSection } from '../src/reporter/html.js';
import { markNodeOwnership } from '../src/scanner/axe.js';
import { deriveScanTargetAndTrace } from '../src/tracer/scan-target.js';
import { axeToUnified } from '../src/index.js';
import { closeBrowser, getBrowser } from '../src/scanner/browser.js';
import { requireBrowser } from './helpers/require-browser.js';

const CASES = [
  ['widget root', { outerHTML: '<div data-react-component="JobList"></div>' }, 'platform'],
  ['inside a widget (selector)', { outerHTML: '<a href="/jobs">x</a>', selector: '[data-react-component="JobList"] a' }, 'platform'],
  ['component_data output', { outerHTML: '<div component_data="x"></div>' }, 'platform'],
  ['bare component tag is the site\'s own PDK markup', { outerHTML: '{{component:jobs-search}}' }, 'source'],
  ['placeholder in a root attribute is the site\'s own PDK markup', { outerHTML: '<div data-x="{{snippet:abc}}"></div>' }, 'source'],
  ['wrapper that contains a component tag', { outerHTML: '<section class="x"><h2></h2>{{component:jobs}}</section>' }, 'source'],
  ['wrapper that contains a snippet tag', { outerHTML: '<header><img src="/a.png">{{snippet:abc}}</header>' }, 'source'],
  ['id that only starts with chat-widget', { outerHTML: '<div id="chat-widget-wrap"></div>', selector: '#chat-widget-wrap > a' }, 'source'],
  ['selector under #chat-widget', { outerHTML: '<a href="/x">x</a>', selector: '#chat-widget > a' }, 'platform'],
  ['chat widget root', { outerHTML: '<div id="chat-widget"></div>' }, 'platform'],
  ['chat launcher', { outerHTML: '<button class="x apply-messenger-launcher">Chat</button>' }, 'platform'],
  ['locked page flag', { outerHTML: '<p>x</p>', platformOwned: true }, 'platform'],
  ['content inside a foreign iframe (from the scanner)', { outerHTML: '<p>x</p>', ownership: 'third-party' }, 'third-party'],
  ['source embed missing a title', { outerHTML: '<iframe src="https://www.youtube.com/embed/x"></iframe>' }, 'source'],
  ['relative iframe', { outerHTML: '<iframe src="/embed/x"></iframe>' }, 'source'],
  ['plain source element', { outerHTML: '<a class="cta-button" href="/apply">Apply</a>' }, 'source'],
  ['source wrapper that contains a widget', { outerHTML: '<main><div data-react-component="JobList"></div></main>' }, 'source'],
  ['the widget host element the loader injects', { outerHTML: '<apply-widget vce-ready=""></apply-widget><div id="chat-widget"></div>' }, 'platform'],
  ['the widget runtime script', { outerHTML: '<script src="https://cdn.stg.paradox.ai/static/widget/js/runtime~widget-main.7ea6b08.js" type="text/javascript" async="true">' }, 'platform'],
  ['the widget client script', { outerHTML: '<script type="text/javascript" async="" src="https://d25zu39ynyitwy.cloudfront.net/static/site/js/widget-client.js"></script>' }, 'platform'],
  ['a recaptcha script', { outerHTML: '<script type="text/javascript" async="" charset="utf-8" src="https://www.gstatic.com/recaptcha/releases/x/recaptcha__en.js">' }, 'platform'],
  ['a site script stays source', { outerHTML: '<script src="https://site-001.sites.stg.paradox.ai/common-libraries/gsap/gsap.min.js" type="text/javascript"></script>' }, 'source'],
  ['the chat launcher avatar inside #apply-widget', { outerHTML: '<img class="el-avatar" src="x.png">', selector: '#apply-widget > div.el-avatar > img' }, 'platform'],
  ['a chat message text node', { outerHTML: '<span>hi</span>', selector: 'div.ol-text-message > span' }, 'platform'],
  ['a source element with a similar class stays source', { outerHTML: '<p class="text-message">x</p>', selector: 'main > p.text-message' }, 'source'],
  ['explicit ownership wins', { outerHTML: '<div data-react-component="x"></div>', ownership: 'source' }, 'source'],
];
for (const [name, el, want] of CASES) {
  test(`ownership: ${name} is ${want}`, () => assert.equal(classifyOwnership(el), want));
}

test('a widget is untraceable with reason platform-owned, a source iframe is still traced', () => {
  assert.deepEqual(traceElement({ outerHTML: '<div data-react-component="JobList"></div>' }),
    { confidence: 'untraceable', candidates: [], reason: 'platform-owned' });
  assert.notEqual(traceElement({ outerHTML: '<iframe src="https://www.youtube.com/embed/x"></iframe>' }).reason, 'platform-owned');
});

const RUNS = [{ layer: 'axe', engine: { version: '4.12.1' } }];
const CTX = { producer: { version: '1.0.0' } };
const violation = (ruleId, outerHTML, selector, count = 1) => ({
  ruleId, nativeRuleId: ruleId, layer: 'axe', impact: 'serious', count, element: { selector, outerHTML },
  source: { mode: 'url', confidence: 'none', method: 'unresolved' },
});

test('report: findings carry ownership, platform findings still count in the totals', () => {
  const report = buildScanReportV2([{
    page: 'home', url: 'http://127.0.0.1:1234/', scannerRuns: RUNS,
    violations: [
      violation('image-alt', '<img class="defect-img" src="/pixel.svg">', 'img.defect-img'),
      violation('link-name', '<a href="/jobs"></a>', '[data-react-component="JobList"] a', 2),
      { ...violation('color-contrast', '<p>x</p>', 'p'), ownership: 'third-party' },
    ],
  }], CTX);
  const byRule = Object.fromEntries(report.pages[0].findings.map((f) => [f.nativeRuleId, f.ownership]));
  assert.deepEqual(byRule, { 'image-alt': 'source', 'link-name': 'platform', 'color-contrast': 'third-party' });
  assert.equal(report.summary.occurrenceCount, 4);
  assert.deepEqual(report.summary.ownershipCounts, { source: 1, platform: 2, thirdParty: 1 });
});

test('report: no ownershipCounts when everything is source-owned', () => {
  const report = buildScanReportV2([{ page: 'home', url: 'http://127.0.0.1:1234/', scannerRuns: RUNS,
    violations: [violation('image-alt', '<img src="/pixel.svg">', 'img')] }], CTX);
  assert.equal(report.summary.ownershipCounts, undefined);
});

test('html: platform findings are listed in their own section, source ones are not', () => {
  const html = buildOwnershipSection([
    violation('image-alt', '<img src="/pixel.svg">', 'img'),
    violation('link-name', '<a href="/jobs"></a>', '[data-react-component="JobList"] a'),
  ]);
  assert.match(html, /link-name/);
  assert.doesNotMatch(html, /image-alt/);
  assert.equal(buildOwnershipSection([violation('image-alt', '<img src="/pixel.svg">', 'img')]), '');
});

test('scanner: nodes under a widget or in a cross-origin iframe are marked, others stay source', async (t) => {
  const browser = await requireBrowser(t);
  if (!browser) return;
  const page = await (await browser.newContext()).newPage();
  try {
    await page.route('https://widget.example.com/**', (route) => route.abort());
    await page.setContent(`<main><div data-react-component="JobList"><ul><li><a id="deep" href="/j"></a></li></ul></div>
      <div id="chat-widget-wrap"><a id="wrap" href="/w"></a></div><div id="chat-widget"><button id="chat"></button></div>
      <a id="own" href="/o"></a><iframe id="fr" src="https://widget.example.com/x"></iframe></main>`);
    const results = { violations: [{ nodes: ['#deep', '#wrap', '#chat', '#own'].map((t) => ({ target: [t] })).concat([{ target: ['#fr', 'p'] }]) }], incomplete: [] };
    await markNodeOwnership(page, results);
    assert.deepEqual(results.violations[0].nodes.map((n) => n.ownership), ['platform', undefined, 'platform', undefined, 'third-party']);
  } finally {
    await page.context().close();
    await closeBrowser();
  }
});

test('axeToUnified carries the scanner ownership onto the finding', () => {
  const [v] = axeToUnified({ violations: [{ id: 'link-name', impact: 'serious', tags: [], nodes: [{ target: ['#deep'], html: '<a id="deep"></a>', ownership: 'platform' }] }] }, 'http://127.0.0.1:1234/');
  assert.equal(classifyOwnership({ ...v, outerHTML: v.element.outerHTML, selector: v.element.selector }), 'platform');
});

function writeExport(file, elements) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ elements_data: elements.map(([p, content]) => ({ type: 'snippet', path: p, content })) }));
}

test('drift: names only the snippets whose normalized content differs from the pushed export', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ada-drift-'));
  try {
    writeExport(path.join(root, 'dist/paradox-export.json'), [
      ['snippets/header.html', '<header>\n  <a href="/">Home</a>\n</header>\n'],
      ['snippets/footer.html', '<footer>new copy</footer>'],
      ['snippets/local-only.html', '<p>not pushed yet</p>'],
    ]);
    writeExport(path.join(root, 'JSON_for_pushed_data/site_2026-10-01.json'), [['snippets/footer.html', '<footer>old</footer>']]);
    writeExport(path.join(root, 'JSON_for_pushed_data/site_2026-10-05.json'), [
      ['snippets/header.html', '<header> <a href="/">Home</a> </header>'],
      ['snippets/footer.html', '<footer>old copy</footer>'],
    ]);
    const drift = detectSourceDrift(root);
    assert.equal(drift.pushedFile, 'site_2026-10-05.json');
    assert.equal(drift.compared, 2);
    assert.deepEqual(drift.drifted.map((d) => d.path), ['snippets/footer.html']);
    assert.deepEqual(drift.warnings, ['local source differs from pushed version for snippets/footer.html']);
    // sha256 of the normalized pushed content "<footer>old copy</footer>" (checked with `shasum -a 256`)
    assert.equal(drift.drifted[0].pushedSha256, 'aa37880e8e477772c6b2c717c8ddeb6255d64a3f9d6e68b42e8784d77dd50de5');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('drift: missing or broken exports give null, never an error', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ada-drift-'));
  try {
    assert.equal(detectSourceDrift(root), null);
    mkdirSync(path.join(root, 'dist'));
    writeFileSync(path.join(root, 'dist/paradox-export.json'), '{not json');
    assert.equal(detectSourceDrift(root, { pushedPath: path.join(root, 'dist/paradox-export.json') }), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('drift wiring: a url-mode scan with a source root reports drift read from <outDir>/paradox-export.json', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ada-drift-wire-'));
  try {
    writeExport(path.join(root, 'dist/paradox-export.json'), [['snippets/footer.html', '<footer>new</footer>']]);
    writeExport(path.join(root, 'JSON_for_pushed_data/site_2026-10-05.json'), [['snippets/footer.html', '<footer>old</footer>']]);
    const run = (config) => deriveScanTargetAndTrace({
      isUrlMode: true, sourceRoot: root, config, pages: [{ url: 'https://site.example/' }],
      pageResults: [{ url: 'https://site.example/', violations: [], pageAttestation: { ok: false, reason: 'MISSING_BUILD_REVISION' } }],
      loadLocalAttestation: () => ({ ok: false, reason: 'LOCAL_ATTESTATION_MISSING' }),
    }).sourceDrift;
    assert.deepEqual(run({ outDir: 'dist' })?.warnings, ['local source differs from pushed version for snippets/footer.html']);
    assert.equal(run({ outDir: 'build' })?.compared, 1, 'the Vite plugin always writes dist/, whatever outDir says');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
