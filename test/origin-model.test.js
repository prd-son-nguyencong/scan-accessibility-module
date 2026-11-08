import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { classifyOrigin, classifyOwnership, loadVendors } from '../src/tracer/ownership.js';
import { annotateOrigins } from '../src/scanner/origin.js';
import { buildScanReportV2 } from '../src/reporter/report-v2.js';
import { buildTaskSet, writeTaskSet } from '../src/fix/export/tasks.js';
import { evaluateGate } from '../src/utils/thresholds.js';
import { computeExitCode } from '../src/index.js';
import { validateConfig } from '../src/utils/config.js';
import { closeBrowser } from '../src/scanner/browser.js';
import { requireBrowser } from './helpers/require-browser.js';

const node = (tag, attrs = {}) => ({ tag, attrs });

test('PDK markup is the site\'s own: data-pdk-*, {{data:}}, {{component:}}, {{snippet:}} never make a node platform or third-party (unbound ones are site-owned unbound-data)', () => {
  for (const outerHTML of ['<div data-pdk-bind="job.title" class="x">Title</div>', '<a data-pdk-link="apply" href="/apply">Apply</a>']) {
    const o = classifyOrigin({ outerHTML, selector: 'main > a' });
    assert.deepEqual([o.owner, o.kind], ['site', 'site-source'], outerHTML);
  }
  for (const outerHTML of [
    '<h1>{{data:job.title}}</h1>', '{{component:jobs-search}}', '<header>{{snippet:0f3c}}</header>',
    '<a data-pdk-link="apply" href="{{data:job.apply_url}}">Apply</a>', '<ul data-pdk-for="jobs"></ul>', '<h2 data-pdk-var="title"></h2>',
    '<div data-pdk-bind="job.title" class="x"></div>',
  ]) {
    const o = classifyOrigin({ outerHTML, selector: 'main > a' });
    assert.deepEqual([o.owner, o.kind], ['site', 'unbound-data'], outerHTML);
    assert.ok(o.evidence.includes('platform data not bound in local render'));
  }
});

test('offline (no live probe) never assigns a vendor from selector or markup: BEM-style site classes stay site-owned', () => {
  for (const [outerHTML, selector] of [
    ['<h2></h2>', '.cmp-hero > h2'], ['<button></button>', '.ot-card button'], ['<a class="cc-btn"></a>', 'a.cc-btn'],
    ['<a class="cc-btn cc-dismiss"></a>', 'body>div.cc-window>div.cc-compliance>a.cc-btn'],
    ['<script type="text/javascript" id="" charset="">var a=1</script>', 'html>body>script:nth-child(28)'],
  ]) assert.deepEqual(['site', 'site-source'], [classifyOrigin({ outerHTML, selector }).owner, classifyOrigin({ outerHTML, selector }).kind], selector);
  // the same tag authored in a template with an id is the site's
  assert.equal(classifyOrigin({ outerHTML: '<script type="text/javascript" id="site-init">var a=1</script>', selector: 'script' }).owner, 'site');
  // offline, an element's own src proves nothing (a template can embed a vendor's script or iframe itself)
  assert.equal(classifyOrigin({ outerHTML: '<iframe src="https://www.youtube.com/embed/x"></iframe>', selector: 'main>iframe' }).owner, 'site');
  const vendors = loadVendors([{ id: 'vendor-a', name: 'Vendor A', category: 'chat', patterns: { class: ['^va-'] } }]);
  // probe evidence (injected, not in the served HTML) plus a user-extended vendor pattern gives third-party
  const o = classifyOrigin({ outerHTML: '<button class="va-launcher"></button>' }, { vendors, hints: { chain: [node('button', { class: 'va-launcher' })], servedSelf: false, injectedRoot: 0 } });
  assert.deepEqual([o.owner, o.vendor, o.label], ['third-party', 'vendor-a', 'Chat widget (vendor-script: vendor-a)']);
});

test('probe hints: widget mount point and served skeleton are site-owned, runtime widget DOM is platform, injected DOM follows vendor/host/unknown', () => {
  const widget = node('div', { 'data-react-component': 'JobList' });
  const at = (chain, extra) => classifyOrigin({ outerHTML: '<x>' }, { hints: { chain, servedSelf: null, injectedRoot: null, pageOrigin: 'http://127.0.0.1:1234', ...extra } });
  assert.equal(at([widget, node('main')]).owner, 'site', 'the mount node is authored in the template');
  const inside = at([node('button'), node('li'), widget]);
  assert.deepEqual([inside.owner, inside.kind, inside.label], ['platform', 'react-widget', 'Paradox React widget: JobList']);
  assert.equal(at([node('h2', { id: 'jobs-title' }), widget], { servedSelf: true }).owner, 'site', 'served skeleton inside a mount is authored');
  const cc = at([node('a', { class: 'cc-btn' }), node('div', { class: 'cc-window' })], { injectedRoot: 1 });
  assert.deepEqual([cc.owner, cc.kind, cc.vendor], ['third-party', 'vendor-script', 'cookieconsent']);
  assert.match(cc.evidence[0], /not in the served HTML/);
  const ext = at([node('script', { src: 'https://cdn.vendor-a.example/p.js' }), node('div', { id: 'x' })], { injectedRoot: 1 });
  assert.deepEqual([ext.owner, ext.vendor], ['third-party', 'cdn.vendor-a.example']);
  // an injected cross-origin link or image is not a vendor resource: still the site's, never confirmed
  for (const bad of [node('a', { href: 'https://example.org/x' }), node('img', { src: 'https://cdn.vendor-a.example/a.png' })]) {
    const o = at([bad], { servedSelf: false, injectedRoot: 0 });
    assert.deepEqual([o.owner, o.kind], ['site', 'injected-runtime'], bad.tag);
  }
  const unknown = at([node('span'), node('div', { id: 'mystery' })], { injectedRoot: 1 });
  assert.deepEqual([unknown.owner, unknown.kind], ['site', 'injected-runtime']);
  assert.equal(classifyOwnership({ origin: unknown }), 'source');
  assert.equal(at([node('a', { href: '#main' })]).owner, 'site');
  assert.equal(classifyOrigin({ outerHTML: '<p>x</p>', ownership: 'third-party' }).kind, 'iframe');
});

const FIXTURE = `<!doctype html><html><head><title>t</title></head><body>
<a id="skip" class="skip-link" href="#main">Skip</a>
<main id="main"><h1>Jobs</h1><div class="jobs-mount" data-react-component="JobList" data-pdk-bind="jobs"></div>
<a id="own" class="site-link" href="/x"></a><a class="btn" href="/y">Y</a><div class="wrap"></div><iframe id="fr" title="" src="http://127.0.0.1:1/x"></iframe></main>
<script>
  var b = document.createElement('div'); b.className = 'cc-window'; b.innerHTML = '<div><a class="cc-btn" href="#">ok</a></div>'; document.body.appendChild(b);
  document.querySelector('.jobs-mount').innerHTML = '<ul><li><button id="wbtn"></button><a class="btn" id="wb" href="#"></a></li></ul>';
  var s = document.createElement('script'); s.setAttribute('id', ''); s.setAttribute('charset', ''); s.text = '/*tag*/'; document.head.appendChild(s);
  var t = document.createElement('div'); t.id = 'tracker-box'; t.innerHTML = '<img id="trk" alt="" src="https://cdn.vendor-a.example/p.png">'; document.body.appendChild(t);
  var w = document.createElement('div'); w.className = 'wrap cc-window'; w.innerHTML = '<a class="btn" id="bb" href="#"></a>'; document.body.appendChild(w);
  var vs = document.createElement('script'); vs.id = 'vsrc'; vs.src = 'https://cdn.vendor-a.example/v.js'; document.body.appendChild(vs);
  var u = document.createElement('div'); u.id = 'mystery'; u.innerHTML = '<span id="m1"></span>'; document.body.appendChild(u);
</script></body></html>`;

test('annotateOrigins on a live page: injected banner, tag-manager script, runtime widget DOM and a vendor pixel are not the site\'s; its own nodes beside them are', async (t) => {
  const browser = await requireBrowser(t);
  if (!browser) return;
  const page = await (await browser.newContext()).newPage();
  try {
    await page.route('https://cdn.vendor-a.example/**', (route) => route.abort());
    await page.route('http://127.0.0.1:1234/', (route) => route.fulfill({ contentType: 'text/html', body: FIXTURE }));
    await page.goto('http://127.0.0.1:1234/');
    const vs = [
      ['#skip', 'critical'], ['#own', 'critical'], ['.jobs-mount', 'serious'], ['#wbtn', 'critical'], ['.cc-btn', 'critical'],
      ['script[charset]', 'serious'], ['#trk', 'critical'], ['#wb', 'critical'], ['#bb', 'critical'], ['#vsrc', 'serious'], ['a[href="/y"]', 'critical'], ['#m1', 'serious'], ['#fr p', 'serious', 'third-party'], ['.gone', 'minor'],
    ].map(([selector, impact, ownership]) => ({ ruleId: 'r', layer: 'axe', impact, ownership, element: { selector, outerHTML: '' } }));
    await annotateOrigins(page, vs, { servedHtml: FIXTURE });
    const by = Object.fromEntries(vs.map((v) => [v.element.selector, v]));
    const summary = (sel) => [by[sel].origin.owner, by[sel].origin.kind, by[sel].origin.vendor, by[sel].impact];
    assert.deepEqual(summary('#skip'), ['site', 'site-source', undefined, 'critical']);
    assert.deepEqual(summary('#own'), ['site', 'site-source', undefined, 'critical']);
    assert.deepEqual(summary('.jobs-mount'), ['site', 'site-source', undefined, 'serious']);
    assert.deepEqual(summary('#wbtn'), ['platform', 'react-widget', undefined, 'moderate']);
    assert.equal(by['#wbtn'].origin.label, 'Paradox React widget: JobList');
    assert.deepEqual(summary('.cc-btn'), ['third-party', 'vendor-script', 'cookieconsent', 'moderate']);
    assert.deepEqual(summary('script[charset]'), ['third-party', 'vendor-script', 'google-tag-manager', 'moderate']);
    assert.deepEqual(summary('#trk'), ['site', 'injected-runtime', undefined, 'critical'], 'an injected cross-origin img is not a vendor resource');
    assert.deepEqual(summary('#vsrc'), ['third-party', 'vendor-script', 'cdn.vendor-a.example', 'moderate']);
    // injected nodes sharing a generic class (btn, wrap) with served ones are not served
    assert.deepEqual(summary('#wb'), ['platform', 'react-widget', undefined, 'moderate']);
    assert.deepEqual(summary('#bb'), ['third-party', 'vendor-script', 'cookieconsent', 'moderate']);
    assert.deepEqual(summary('a[href="/y"]'), ['site', 'site-source', undefined, 'critical'], 'the served .btn stays the site\'s');
    assert.deepEqual(summary('#m1'), ['site', 'injected-runtime', undefined, 'serious']);
    assert.deepEqual(summary('#fr p'), ['third-party', 'iframe', undefined, 'moderate']);
    assert.equal(by['.gone'].origin.owner, 'site');
    await annotateOrigins(page, [by['.cc-btn']], { servedHtml: FIXTURE, foreignImpactCap: null });
    assert.equal(by['.cc-btn'].impact, 'moderate', 'already capped once; a lifted cap never raises');
    const lifted = [{ ruleId: 'r', layer: 'axe', impact: 'critical', element: { selector: '.cc-btn', outerHTML: '' } }];
    await annotateOrigins(page, lifted, { servedHtml: FIXTURE, foreignImpactCap: null });
    assert.equal(lifted[0].impact, 'critical');
    // without the served HTML nothing can be called injected: only the widget (an ancestor attribute) still is
    const blind = [{ ruleId: 'r', layer: 'axe', impact: 'critical', element: { selector: '.cc-btn', outerHTML: '<a class="cc-btn"></a>' } }, { ruleId: 'r', layer: 'axe', impact: 'critical', element: { selector: '#wbtn', outerHTML: '' } }];
    await annotateOrigins(page, blind, {});
    assert.deepEqual(blind.map((v) => v.origin.owner), ['site', 'platform']);
  } finally {
    await page.context().close();
    await closeBrowser();
  }
});

const RUNS = [{ layer: 'axe', engine: { version: '4.12.1' } }];
const CTX = { producer: { version: '1.0.0' } };
const viol = (ruleId, selector, outerHTML, extra = {}) => ({
  ruleId, nativeRuleId: ruleId, layer: 'axe', impact: 'moderate', count: 1, element: { selector, outerHTML },
  source: { mode: 'url', file: 'src/pages/home.liquid', confidence: 'low', method: 'url-fallback' }, evidence: MEASURED, ...extra,
});
// Every owner's rows are confirmed only with a fact measured on the live DOM (settleFinding): fixtures that mean "confirmed" carry one.
const MEASURED = { proof: { type: 'attribute-value', fact: 'aria-label="" on a.cc-btn' } };
const BANNER = { owner: 'third-party', kind: 'vendor-script', vendor: 'cookieconsent', label: 'Cookie consent (vendor-script: cookieconsent)', evidence: ['class "cc-window"'] };
const pages = ['/', '/about'].map((url) => ({
  page: url, url: `http://127.0.0.1:1234${url}`, scannerRuns: RUNS,
  violations: [
    viol('button-name', 'div.cc-window > a.cc-btn', '<a class="cc-btn"></a>', { origin: BANNER, impact: 'serious', evidence: MEASURED }),
    viol('button-name', 'a.site-btn', '<a class="site-btn"></a>', { impact: 'serious' }),
    viol('region', '#m1', '<span id="m1"></span>', { origin: { owner: 'site', kind: 'injected-runtime', label: 'Runtime-injected DOM (injecting script unknown)', evidence: [] }, verdict: 'confirmed' }),
  ],
}));

test('report: origin on every finding, third-party findings have no file, unknown injected DOM is never confirmed, one notYourCode row per site', () => {
  const report = buildScanReportV2(pages, CTX);
  const f = report.pages[0].findings;
  const banner = f.find((x) => x.origin.owner === 'third-party');
  assert.deepEqual([banner.ownership, banner.source.file, banner.source.line, banner.source.traceReason], ['third-party', null, null, 'third-party: cookieconsent']);
  const site = f.find((x) => x.element.selector === 'a.site-btn');
  assert.deepEqual([site.origin.owner, site.source.file], ['site', 'src/pages/home.liquid']);
  assert.equal(f.find((x) => x.element.selector === '#m1').verdict, 'needs-review');
  assert.equal(report.notYourCode.length, 1);
  const [g] = report.notYourCode;
  assert.deepEqual([g.vendor, g.rule, g.pages, g.findings, g.occurrences, g.impact], ['cookieconsent', 'button-name', ['/', '/about'], 2, 2, 'serious']);
  assert.match(g.suggestedAction, /Report to the vendor \(cookieconsent\)/);
});

test('gate and exit code: platform and third-party findings stay out unless gate.countPlatform / countThirdParty', () => {
  const report = buildScanReportV2([{ ...pages[0], violations: [
    viol('a', 'a.s', '<a class="s"></a>', { impact: 'critical' }),
    viol('b', 'a.p', '<a></a>', { impact: 'critical', evidence: MEASURED, origin: { owner: 'platform', kind: 'react-widget', label: 'Paradox React widget: X', evidence: [] } }),
    viol('c', 'a.t', '<a></a>', { impact: 'critical', origin: BANNER, evidence: MEASURED }),
  ] }], CTX);
  const gate = (o) => evaluateGate([{ name: 'p', url: 'u', findings: report.pages[0].findings, lighthouseScores: {} }], {}, { layers: { axe: true }, ...o });
  const critical = (g) => g.pages[0].metrics.find((m) => m.id === 'a11y.critical').actual;
  assert.equal(critical(gate({})), 1);
  assert.equal(critical(gate({ countPlatform: true })), 2);
  assert.equal(critical(gate({ countPlatform: true, countThirdParty: true })), 2, 'vendor DOM is never confirmed, so it never reaches the gate');
  assert.equal(report.summary.platformConfirmed, 1);
  assert.equal(report.summary.thirdPartyConfirmed, undefined);
  assert.equal(computeExitCode(report.summary, { failOnViolations: true }), 1, 'the site finding remains');
  const onlyForeign = { occurrenceCount: 2, verdictCounts: { confirmed: 2, likely: 0, needsReview: 0 }, thirdPartyConfirmed: 1, platformConfirmed: 1 };
  assert.equal(computeExitCode(onlyForeign, { failOnViolations: true }), 0);
  assert.equal(computeExitCode(onlyForeign, { failOnViolations: true, countPlatform: true }), 1);
});

test('fix --export: not-your-code.md names the vendor and action, and no task is written for it', () => {
  const report = buildScanReportV2(pages, CTX);
  const set = buildTaskSet(report, {});
  assert.deepEqual(set.tasks.map((t) => t.element.selector), ['a.site-btn']);
  assert.equal(set.notActionable.length, 1);
  const dir = mkdtempSync(path.join(tmpdir(), 'ada-nyc-'));
  try {
    const { dir: out, files } = writeTaskSet(set, dir);
    assert.ok(files.includes('not-your-code.md'));
    const md = readFileSync(path.join(out, 'not-your-code.md'), 'utf8');
    assert.match(md, /Cookie consent \(vendor-script: cookieconsent\)/);
    assert.match(md, /Action: Report to the vendor \(cookieconsent\)/);
    assert.doesNotMatch(readFileSync(path.join(out, 'INDEX.md'), 'utf8'), /Prompt[\s\S]*cc-btn/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('config: tracing.vendors and gate.countPlatform are validated', () => {
  assert.deepEqual(validateConfig({ tracing: { vendors: [{ id: 'v', name: 'V', patterns: { class: ['^v-'] } }], foreignImpactCap: null }, gate: { countPlatform: true } }), []);
  assert.match(validateConfig({ tracing: { vendors: [{ id: 'v' }] } })[0], /tracing\.vendors/);
  assert.match(validateConfig({ tracing: { foreignImpactCap: 'huge' } })[0], /foreignImpactCap/);
  assert.match(validateConfig({ gate: { countPlatform: 'yes' } })[0], /gate\.countPlatform/);
});

test('unbound-data: a node inside a data-pdk-for/var ancestor or a tag-bearing attribute; a widget stays platform; findings are needs-review in the report', () => {
  const at = (chain, outerHTML = '<li></li>') => classifyOrigin({ outerHTML }, { hints: { chain, servedSelf: false, injectedRoot: null } });
  assert.equal(at([node('li'), node('ul', { 'data-pdk-for': 'job in jobs' })]).kind, 'unbound-data');
  assert.equal(at([node('li'), node('ul', { 'aria-label': '{{attribute:list_label}}' })]).kind, 'unbound-data');
  assert.equal(at([node('li'), node('ul', { class: 'plain' })]).kind, 'site-source');
  assert.equal(at([node('button'), node('li'), node('div', { 'data-react-component': 'JobList', 'data-pdk-var': 'x' })]).owner, 'platform');
  const f = buildScanReportV2([{ page: '/', url: 'http://127.0.0.1:1234/', scannerRuns: RUNS, violations: [
    viol('ListEmpty', 'ul.jobs', '<ul class="jobs" data-pdk-for="job in jobs"></ul>', { verdict: 'confirmed' }),
    viol('ListEmpty', 'ul.static', '<ul class="static"></ul>', { verdict: 'confirmed' }),
  ] }], CTX).pages[0].findings;
  assert.deepEqual(f.map((x) => [x.element.selector, x.verdict, x.origin.kind, x.origin.owner]).sort(),
    [['ul.jobs', 'needs-review', 'unbound-data', 'site'], ['ul.static', 'needs-review', 'site-source', 'site']]); // ListEmpty is advisory: needs-review either way, the origin kind is what differs
});

test('unbound-data is scoped to rules that depend on bound content: static defects keep site-source in containers and loops', () => {
  const chainLoop = [node('img'), node('li'), node('ul', { 'data-pdk-for': 'job in jobs' })];
  const kind = (rule, outerHTML, chain = []) => classifyOrigin({ ruleId: rule, outerHTML }, { hints: { chain, servedSelf: false, injectedRoot: null } }).kind;
  // container with a bound child, real container defect: stays site-source (confirmed)
  assert.equal(kind('landmark-unique', '<main><h1>Hi</h1><p>{{data:job.title}}</p></main>'), 'site-source');
  assert.equal(kind('html-has-lang', '<html lang=""><head><title>{{data:seo.title}}</title></head><body></body></html>'), 'site-source');
  assert.equal(kind('aria-allowed-role', '<section role="button"><p>{{component:x}}</p></section>'), 'site-source');
  // literal <img> without alt inside a loop: static defect
  assert.equal(kind('image-alt', '<img src="/a.png">', chainLoop), 'site-source');
  // paired: content-dependent rules and the node's own tag/text still cap
  assert.equal(kind('empty-heading', '<h2></h2>', chainLoop), 'unbound-data');
  assert.equal(kind('link-name', '<a href="/x"></a>', [node('a'), node('div', { 'data-pdk-for': 'x' })]), 'unbound-data');
  assert.equal(kind('link-name', '<a href="{{data:job.url}}"></a>'), 'unbound-data');
  assert.equal(kind('heading-order', '<h3>{{data:job.title}}</h3>'), 'unbound-data');
  assert.equal(kind('ListEmpty', '<ul data-pdk-for="job in jobs"></ul>'), 'unbound-data');
  assert.equal(kind('ListEmpty', '<ul><li data-pdk-for="j in js">{{data:j.t}}</li></ul>'), 'unbound-data');
  assert.equal(kind('ListEmpty', '<ul class="static"></ul>'), 'site-source');
});

test('unbound PDK output does not hide static defects: behaviour-only PDK attributes, void elements and static rules stay confirmed', () => {
  const kind = (rule, outerHTML) => classifyOrigin({ ruleId: rule, outerHTML }, { hints: { chain: [], servedSelf: false, injectedRoot: null } }).kind;
  // true positives: the site authors the alt, label and accessible name itself
  assert.equal(kind('image-alt', '<img src="a.jpg" data-pdk-src="x">'), 'site-source');
  assert.equal(kind('image-alt', '<img src="a.jpg" data-pdk-lazy>'), 'site-source');
  assert.equal(kind('image-alt', '<img data-pdk-out="a" src="x.png">'), 'site-source');
  assert.equal(kind('label', '<input type="text" data-pdk-bind="q">'), 'site-source');
  assert.equal(kind('label', '<input data-pdk-param-q="x">'), 'site-source');
  assert.equal(kind('button-name', '<button type="button" data-pdk-click="open"><i class="fa"></i></button>'), 'site-source');
  assert.equal(kind('button-name', '<button data-pdk-if="a"><svg></svg></button>'), 'site-source');
  assert.equal(kind('button-name', '<button data-pdk-event="click"></button>'), 'site-source');
  assert.equal(kind('link-name', '<a href="/x" data-pdk-track="1"><svg></svg></a>'), 'site-source');
  assert.equal(kind('button-name', '<div role="button" data-pdk-if="a" tabindex="0"></div>'), 'site-source');
  // text with a placeholder href: static rules and contrast keep their verdict
  assert.equal(kind('color-contrast', '<a href="#" data-pdk-out="x">Read more</a>'), 'site-source');
  assert.equal(kind('link-name', '<a href="#" data-pdk-out="x">Read more</a>'), 'site-source');
  assert.equal(kind('html-has-lang', '<html data-pdk-out="x"></html>'), 'site-source');
  // paired: an output binding that is empty, or a bound placeholder href on the dead-link rule, is still unbound
  assert.equal(kind('button-name', '<button data-pdk-out="b.label"></button>'), 'unbound-data');
  assert.equal(kind('dead-link-empty-href', '<a href="#" data-pdk-out="x">More</a>'), 'unbound-data');
  assert.equal(kind('dead-link-empty-href', '<a href="#">More</a>'), 'site-source');
});

test('annotateOrigins live probe: an aria-labelledby ref that is an empty data-pdk-out node makes the section unbound, a static empty heading does not', async (t) => {
  const browser = await requireBrowser(t);
  if (!browser) return;
  const html = `<!doctype html><html><head><title>t</title></head><body><main>
<section id="a" aria-labelledby="ha"><h2 id="ha" data-pdk-out="x.h"></h2></section>
<section id="b" aria-labelledby="hb"><h2 id="hb"></h2></section>
<section id="c" aria-labelledby="hc"><h2 id="hc" data-pdk-out="x.h">Hello</h2></section>
<a id="d" href="#" data-pdk-out="x.u"></a></main></body></html>`;
  const page = await (await browser.newContext()).newPage();
  try {
    await page.route('http://127.0.0.1:1234/', (route) => route.fulfill({ contentType: 'text/html', body: html }));
    await page.goto('http://127.0.0.1:1234/');
    const vs = [['#a', 'aria-prohibited-attr'], ['#b', 'aria-prohibited-attr'], ['#c', 'aria-prohibited-attr'], ['#d', 'dead-link-empty-href']]
      .map(([selector, ruleId]) => ({ ruleId, layer: 'axe', impact: 'serious', element: { selector, outerHTML: selector === '#d' ? '<a id="d" href="#" data-pdk-out="x.u"></a>' : '' } }));
    await annotateOrigins(page, vs, { servedHtml: html });
    assert.deepEqual(vs.map((v) => v.origin.kind), ['unbound-data', 'site-source', 'site-source', 'unbound-data']);
  } finally {
    await page.context().close();
    await closeBrowser();
  }
});

test('axe and screenReader scanner runs record htmlSource live-dom', async () => {
  const { buildAxeScannerRuns } = await import('../src/index.js');
  assert.equal(buildAxeScannerRuns({ summary: { viewports: [{ name: 'd', width: 1, height: 1 }] } })[0].htmlSource, 'live-dom');
});

test('unbound PDK output: empty data-pdk-out nodes and the labelled-by container are needs-review; static empties and bound text keep their verdict', () => {
  const kind = (rule, outerHTML, hints = { chain: [], servedSelf: false, injectedRoot: null }) => classifyOrigin({ ruleId: rule, outerHTML }, { hints }).kind;
  const sec = (h) => `<section aria-labelledby="t">${h}</section>`;
  assert.equal(kind('empty-heading', '<h2 data-pdk-out="intro.heading" id="t"></h2>'), 'unbound-data');
  assert.equal(kind('link-name', '<a data-pdk-out="x.url" href="#"><span></span></a>'), 'unbound-data');
  assert.equal(kind('aria-prohibited-attr', sec('<h2 data-pdk-out="intro.heading" id="t"></h2>')), 'unbound-data');
  assert.equal(kind('aria-prohibited-attr', '<section aria-labelledby="t"></section>', { chain: [], refs: [{ id: 't', open: '<h2 data-pdk-out="a" id="t">', empty: true }] }), 'unbound-data');
  // paired true positives: no PDK marker means the empty heading and its labelled section are real defects
  assert.equal(kind('empty-heading', '<h2 id="t"></h2>'), 'site-source');
  assert.equal(kind('aria-prohibited-attr', sec('<h2 id="t"></h2>')), 'site-source');
  assert.equal(kind('aria-prohibited-attr', '<section aria-labelledby="t"></section>', { chain: [], refs: [{ id: 't', open: '<h2 id="t">', empty: true }] }), 'site-source');
  // bound with text: the name exists, the node is not unbound
  assert.equal(kind('empty-heading', '<h2 data-pdk-out="a">Hello</h2>'), 'site-source');
  assert.equal(kind('aria-prohibited-attr', sec('<h2 data-pdk-out="a" id="t">Hello</h2>')), 'site-source');
});

test('any owner: confirmed only with a measured proof; without it needs-review', () => {
  const platform = { owner: 'platform', kind: 'react-widget', label: 'Paradox React widget: X', evidence: [] };
  const build = (extra, origin) => buildScanReportV2([{ ...pages[0], violations: [viol('button-name', 'a.x', '<a class="x"></a>', { impact: 'serious', verdict: 'confirmed', origin, ...extra })] }], CTX);
  const run = (extra, origin) => { const r = build(extra, origin); return [r.pages[0].findings[0].verdict, r.summary]; };
  assert.equal(run({ evidence: MEASURED }, BANNER)[0], 'needs-review', 'vendor DOM is never confirmed, even with a measured proof');
  for (const origin of [platform]) {
    const key = 'platformConfirmed';
    const [good, goodSummary] = run({ evidence: MEASURED }, origin);
    assert.equal(good, 'confirmed'); assert.equal(goodSummary[key], 1);
    for (const proof of [{ type: 'validator-rule', fact: 'lighthouse:button-name' }, { type: 'dom-structure', fact: 'Fix any of the following' }, { type: 'rule-fact', fact: 'x' }]) {
      const [bad, badSummary] = run({ evidence: { proof } }, origin);
      assert.equal(bad, 'needs-review', proof.type); assert.equal(badSummary[key], undefined); assert.equal(badSummary.verdictCounts.needsReview, 1);
    }
  }
  assert.equal(run({ evidence: MEASURED }, undefined)[0], 'confirmed', 'site-owned with a measured proof keeps its verdict');
  assert.equal(run({ evidence: { proof: { type: 'dom-structure', fact: 'generic' } } }, undefined)[0], 'needs-review', 'site-owned needs a measurement too');
});

test('label-in-name: visible text and accessible name captured in evidence become the proof, so a site defect with captured text stays confirmed', () => {
  const ev = { visibleText: 'Accept all', accessibleName: 'Consent' };
  const r = buildScanReportV2([{ ...pages[0], violations: [viol('VisibleTextPartOfAccessibleName', 'a.x', '<a class="x" aria-label="Consent">Accept all</a>', { verdict: 'confirmed', evidence: ev })] }], CTX);
  const f = r.pages[0].findings[0];
  assert.deepEqual([f.verdict, f.evidence.proof.type], ['confirmed', 'name-vs-text']);
  assert.match(f.evidence.proof.fact, /"Accept all".*"Consent"/);
  const none = buildScanReportV2([{ ...pages[0], violations: [viol('label-content-name-mismatch', 'a.x', '<a class="x"></a>', { verdict: 'confirmed', evidence: {} })] }], CTX);
  assert.equal(none.pages[0].findings[0].verdict, 'needs-review', 'visible text not captured: nothing measured');
});

// A node a vendor injected must get the same origin whether the live probe resolved it, could not run, timed out or found it gone (a banner dismissed meanwhile).
const BANNER_HTML = '<a aria-label="dismiss cookie message" role="button" class="cc-btn cc-dismiss">';
const SERVED = '<html><body><main><a class="mine" href="/">x</a></main></body></html>';
const probeSet = () => [
  { ruleId: 'label-content-name-mismatch', layer: 'lighthouse', impact: 'serious', evidence: MEASURED, element: { selector: 'body>div.cc-window>div.cc-compliance>a.cc-btn', outerHTML: BANNER_HTML } },
  { ruleId: 'label-content-name-mismatch', layer: 'lighthouse', impact: 'serious', evidence: MEASURED, element: { selector: 'main>a.mine', outerHTML: '<a class="mine" aria-label="x">' } },
];
const LIVE = { evaluate: async (_fn, { selectors }) => ({
  [selectors[0]]: { refs: [], servedSelf: false, injectedRoot: 2, pageOrigin: 'http://127.0.0.1:1', chain: [{ tag: 'a', attrs: { class: 'cc-btn cc-dismiss' } }, { tag: 'div', attrs: { class: 'cc-compliance' } }, { tag: 'div', attrs: { class: 'cc-window' } }, { tag: 'body', attrs: {} }] },
}) };

test('origin does not depend on the probe: vendor DOM is third-party whether the live probe resolved it, failed, timed out or found it gone; unprovable nodes are unknown, never confirmed', async () => {
  const pages = {
    live: LIVE,
    rejected: { evaluate: async () => { throw new Error('Target closed'); } },
    gone: { evaluate: async () => ({}) },
    hung: { evaluate: () => new Promise(() => {}) },
  };
  for (const [name, page] of Object.entries(pages)) {
    const vs = probeSet();
    await annotateOrigins(page, vs, { servedHtml: SERVED, probeTimeoutMs: 30 });
    assert.deepEqual([vs[0].origin.owner, vs[0].origin.kind, vs[0].origin.vendor], ['third-party', 'vendor-script', 'cookieconsent'], name);
    if (name !== 'live') assert.deepEqual([vs[1].origin.owner, vs[1].origin.kind], ['site', 'unknown-probe-failed'], name);
    const report = buildScanReportV2([{ ...pages0(), violations: vs }], CTX);
    assert.equal(report.pages[0].findings.find((f) => f.origin.vendor).verdict, 'needs-review', `${name}: vendor DOM is never confirmed, whatever the probe saw`);
    if (name !== 'live') assert.equal(report.pages[0].findings.find((f) => !f.origin.vendor).verdict, 'needs-review', `${name}: never confirmed on an unknown origin`);
  }
  // the vendor token is in the served HTML (the site itself ships it): cannot be called injected offline
  const own = probeSet();
  await annotateOrigins(pages.gone, [own[0]], { servedHtml: '<div class="cc-window"><a class="cc-btn"></a></div>' });
  assert.equal(own[0].origin.kind, 'unknown-probe-failed');
  // no live page at all: the offline classifier alone, as before
  const offline = probeSet();
  await annotateOrigins(null, offline, { servedHtml: SERVED });
  assert.equal(offline[1].origin.kind, 'site-source');
});
function pages0() { return { page: '/', url: 'http://127.0.0.1:1/', scannerRuns: RUNS }; }

test('matchVendor: an anchor href to a vendor domain is site navigation, a vendor src or link href is a resource', () => {
  const at = (n) => classifyOrigin({ outerHTML: '<x>' }, { hints: { chain: [n], servedSelf: false, injectedRoot: 0 } });
  for (const tag of ['a', 'area']) {
    const o = at(node(tag, { href: 'https://www.iubenda.com/privacy-policy/123' }));
    assert.deepEqual([o.owner, o.kind], ['site', 'injected-runtime'], tag);
  }
  assert.equal(at(node('script', { src: 'https://cdn.iubenda.com/cs/iubenda_cs.js' })).owner, 'third-party');
  assert.equal(at(node('link', { href: 'https://cdn.iubenda.com/cs/x.css' })).owner, 'third-party');
  assert.equal(at(node('div', { 'data-src': 'https://cdn.iubenda.com/cs/x.js' })).owner, 'third-party');
});
