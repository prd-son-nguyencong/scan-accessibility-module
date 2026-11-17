import './helpers/hermetic-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildScanReportV2, validateScanReportV2 } from '../src/reporter/report-v2.js';
import { buildQaModel } from '../src/reporter/qa-report.js';

const ctx = { generatedAt: '2026-07-15T00:00:00.000Z', producer: { name: 'ada-scan', version: '1.0.1' }, target: { mode: 'url-only', url: 'https://example.test/' } };
const run = (layer) => ({ layer, engine: { name: layer, version: '1' }, status: 'complete', ...(layer === 'accessScan' ? { evidence: { profile: 'standards', comparatorVersion: '1' } } : {}) });
const v = (ruleId, layer, selector, html, extra = {}) => ({ ruleId, layer, impact: 'serious', element: { selector, outerHTML: html }, fix: { hint: 'h' }, ...extra });
const build = (pages) => buildScanReportV2(pages.map(({ route, violations }) => ({
  page: route, url: `https://example.test${route}`, scannerRuns: [...new Set(violations.map((x) => x.layer))].map(run), violations,
})), ctx);
const one = (violations) => build([{ route: '/', violations }]).pages[0].findings;

const SKIP = '<a class="sr-only" href="#main-content">Skip</a>';

// Each row: the same defect under different engine ids (expected merged count is written by hand, not computed).
const MERGES = [
  ['skip link', [v('skip-link', 'axe', 'a.sr-only', SKIP), v('skip-link', 'lighthouse', 'body > a', SKIP), v('skip-link-target-missing', 'keyboard', '.sr-only', SKIP)], 3],
  ['skip link + derived region', [v('skip-link', 'axe', 'a.sr-only', SKIP), v('region', 'axe', 'a.sr-only', SKIP)], 1],
  ['html lang', [v('html-has-lang', 'axe', 'html', '<html>'), v('html-missing-lang', 'screenReader', 'html', '<html>'), v('HtmlLang', 'accessScan', 'html', '<html>'),
    v('html-validate:element-required-attributes', 'htmlValidate', 'html', '<html>', { fix: { hint: 'lang attribute is required' } })], 4],
  ['page title', [v('document-title', 'axe', 'html', '<html>'), v('page-missing-title', 'screenReader', 'html', '<html>'),
    v('html-validate:element-required-content', 'htmlValidate', 'head', '<head>', { fix: { hint: 'title is required content' } })], 3],
  ['main landmark', [v('landmark-one-main', 'axe', 'html', '<html>'), v('missing-main-landmark', 'screenReader', 'html', '<html>')], 2],
  ['h1', [v('page-has-heading-one', 'axe', 'html', '<html>'), v('no-headings', 'screenReader', 'html', '<html>')], 2],
  ['aria-label misuse', [v('aria-prohibited-attr', 'axe', 'div.marquee', '<div class="marquee" aria-label="x">'), v('html-validate:aria-label-misuse', 'htmlValidate', 'html > body > div', '<div class="marquee" aria-label="x">')], 2],
];
for (const [name, violations] of MERGES) {
  test(`root cause merge: ${name} is ONE finding with every layer`, () => {
    const report = build([{ route: '/', violations }]);
    const f = report.pages[0].findings;
    assert.equal(f.length, 1);
    assert.deepEqual(f[0].layers, [...new Set(violations.map((x) => x.layer))].sort());
    assert.deepEqual(f[0].nativeRuleIds, [...new Set(violations.map((x) => x.ruleId))].sort());
    assert.equal(report.summary.findingCount, 1);
    assert.equal(report.summary.occurrenceCount, 1);
  });
}

test('no merge: same family on a different element, other page state, or unrelated generic html-validate rule', () => {
  assert.equal(one([v('skip-link', 'axe', 'a.a', '<a class="a" href="#x">'), v('skip-link', 'lighthouse', 'a.b', '<a class="b" href="#y">')]).length, 2);
  assert.equal(one([v('region', 'axe', 'p.x', '<p class="x">'), v('skip-link', 'axe', 'a.s', SKIP)]).length, 2); // region elsewhere is not derived
  assert.equal(one([
    v('html-validate:element-required-attributes', 'htmlValidate', 'img', '<img>', { fix: { hint: 'src is required' } }),
    v('html-has-lang', 'axe', 'html', '<html>'),
  ]).length, 2);
  // Two elements with the same opening tag from one layer each: the second axe element must not be swallowed by the first one's bucket.
  assert.equal(one([v('image-alt', 'axe', 'img.a', '<img src="a.png">'), v('image-alt', 'axe', 'img.b', '<img src="a.png">'), v('image-alt', 'lighthouse', 'p > img', '<img src="a.png">')]).length, 2);
});

test('generic opening tag: same tag, different selectors, different layers stays 2; same element under two selectors still merges', () => {
  const A = '<a href="#"></a>';
  const two = one([v('link-name', 'axe', 'nav a', A), v('LinkNavigationDiscernible', 'accessScan', 'footer a', A), v('link-name', 'axe', 'main a', A)]);
  assert.equal(two.length, 3);
  assert.equal(one([v('link-name', 'axe', 'nav a', A), v('link-name', 'axe', 'footer a', A), v('LinkNavigationDiscernible', 'accessScan', 'footer a', A)]).length, 2);
  // Ambiguity is per layer: one element each from two layers cannot be told apart by a generic tag, but selectors differ -> kept apart only when more than one candidate exists.
  assert.equal(one([v('link-name', 'axe', 'nav a', A), v('LinkNavigationDiscernible', 'accessScan', 'html > body > nav > a', A)]).length, 1);
  assert.equal(one([v('image-alt', 'axe', 'img.a', '<img src="a.png">'), v('ImageDiscernible', 'accessScan', 'body > img', '<img src="a.png">')]).length, 1);
});

test('merged findings keep the stableId of the highest-priority candidate, stable across input order and runs', () => {
  const vs = [v('skip-link', 'axe', 'a.sr-only', SKIP), v('skip-link', 'lighthouse', 'body > a', SKIP)];
  const alone = one([vs[0]])[0].stableId;
  const a = one(vs)[0].stableId;
  const b = one([...vs].reverse())[0].stableId;
  assert.equal(a, b);
  assert.equal(a, alone); // axe and lighthouse tie on impact and confidence; 'axe' sorts first
});

test('highest-confidence source wins the merge', () => {
  const [f] = one([
    v('html-has-lang', 'axe', 'html', '<html>', { source: { file: 'src/layout.liquid', line: 2, confidence: 'low' } }),
    v('html-missing-lang', 'screenReader', 'html', '<html>', { source: { file: 'src/pages/home.liquid', line: 1, confidence: 'medium' } }),
  ]);
  assert.equal(f.source.file, 'src/pages/home.liquid');
});

test('sharedSource: one source line and rule on many pages (and repeated on one page) gets one group id; per-page findings are kept', () => {
  const src = { file: 'src/partials/card.liquid', line: 27, confidence: 'medium' };
  const mk = (sel) => v('prefer-native-element', 'htmlValidate', sel, `<a role="button" id="${sel}">`, { source: src, ...{ impact: 'minor' } });
  const report = build([
    { route: '/a', violations: [mk('s1'), mk('s2'), mk('s3'), mk('s4')] },
    { route: '/b', violations: [mk('s1')] },
    { route: '/c', violations: [v('prefer-native-element', 'htmlValidate', 'x', '<a role="button" id="x">', { source: { file: 'src/partials/other.liquid', line: 1, confidence: 'medium' } })] },
  ]);
  const all = report.pages.flatMap((p) => p.findings);
  // Changed deliberately: the 4 elements of one line on /a are one loop-repeat finding (count 4); the line is still shared with /b.
  assert.equal(all.length, 3);
  assert.equal(all.find((f) => f.route === '/a').count, 4);
  const shared = all.filter((f) => f.sharedSource);
  assert.equal(shared.length, 2);
  assert.equal(new Set(shared.map((f) => f.sharedSource.id)).size, 1);
  assert.deepEqual({ ...shared[0].sharedSource, id: undefined }, { id: undefined, findings: 2, pages: 2 });
  assert.equal(all.find((f) => f.source.file.endsWith('other.liquid')).sharedSource, undefined);
  assert.equal(report.summary.sharedSourceGroups, 1);
  assert.equal(report.summary.findingCount, 3); // one finding per page and line; the shared line is grouped across pages
  const qa = buildQaModel(report);
  assert.ok(JSON.stringify(qa).includes(shared[0].sharedSource.id));
});

test('root cause merge: a void element serialized as "<img ...>" and "<img ... />" is the same element; a different src is not', () => {
  const dom = '<img class="hero" src="/a.svg" width="40">';
  const src = '<img class="hero" src="/a.svg" width="40" />';
  assert.equal(one([v('image-alt', 'axe', '.hero', dom), v('ImageDiscernible', 'accessScan', 'section>img:nth-of-type(1)', src)]).length, 1);
  const abs = '<img class="hero" src="http://site-001.test:8080/a.svg" width="40" />'; // resolved src, same element
  assert.equal(one([v('image-alt', 'axe', '.hero', dom), v('ImageDiscernible', 'accessScan', 'section>img:nth-of-type(3)', abs)]).length, 1);
  assert.equal(one([v('image-alt', 'axe', '.hero', dom), v('ImageDiscernible', 'accessScan', 'section>img:nth-of-type(2)', '<img class="hero" src="/b.svg" width="40" />')]).length, 2);
});

test('root cause merge: a merged finding whose best source comes from another layer still validates (ids hash the merged content)', () => {
  const html = '<img class="hero" src="/a.svg">';
  const report = build([{ route: '/', violations: [
    v('image-alt', 'axe', '.hero', html),
    v('ImageDiscernible', 'accessScan', 'section>img', html, { source: { file: 'src/pages/home.liquid', line: 4, confidence: 'high', preimageSha256: 'a'.repeat(64) } }),
  ] }]);
  assert.equal(report.pages[0].findings.length, 1);
  assert.equal(report.pages[0].findings[0].source.file, 'src/pages/home.liquid');
  assert.doesNotThrow(() => validateScanReportV2(report));
});

// ─── missed true positives: value-keyed root causes (duplicate referenced id, skip link, heading skip, list structure) ───

const LOOP = { file: 'src/pages/home.liquid', line: 29, confidence: 'medium' };
const dupIdRows = (ids = ['card-title']) => ids.flatMap((id) => [
  // what each engine says about ONE hard-coded id rendered by 4 loop items (hand-written, not produced by the code under test)
  v('duplicate-id-referenced', 'screenReader', `#${id}`, `<h3 id="${id}">Call Center</h3>`, { count: 4, source: LOOP, fix: { hint: `id "${id}" is on 4 elements and is referenced by aria-labelledby on 4 elements` }, evidence: { id, occurrences: 4, proof: { type: 'measured-fact', fact: `id "${id}" is on 4 elements; 4 of 4 referrers resolve to the first element` } } }),
  v('duplicate-id-aria', 'axe', `#${id}`, `<h3 id="${id}">Call Center</h3>`, { source: LOOP }),
  ...[2, 3, 4].map((n) => v('html-validate:no-dup-id', 'htmlValidate', `ul > li:nth-child(${n}) > h3`, `<li><h3 id="${id}">Item ${n}</h3></li>`, { impact: 'serious', source: LOOP, fix: { hint: `Duplicate ID "${id}"` } })),
]);

test('duplicate id referenced by ARIA: engine rows of one id are ONE finding at the loop line with the true occurrence count', () => {
  const f = one(dupIdRows());
  assert.equal(f.length, 1);
  assert.deepEqual(f[0].layers, ['axe', 'htmlValidate', 'screenReader']);
  assert.equal(f[0].count, 4); // 4 elements carry the id (not 1 per row, not 3 + 1 added up)
  assert.equal(f[0].verdict, 'confirmed');
  assert.equal(f[0].impact, 'serious');
  assert.equal(`${f[0].source.file}:${f[0].source.line}`, 'src/pages/home.liquid:29');
  assert.match(f[0].evidence.message, /referenced by aria-labelledby on 4 elements/); // the root-cause rule speaks for the merge
});

test('duplicate ids: two different ids stay two findings; the same id on another page state is not merged', () => {
  assert.equal(one(dupIdRows(['a-title', 'b-title'])).length, 2);
  const rows = dupIdRows();
  const [a, b] = [rows[0], { ...rows[0], pageState: 'menu-open' }];
  assert.equal(one([a, b]).length, 2);
});

test('skip link absent: axe bypass and keyboard skip-link-missing are one finding; a present skip link on another element is not swallowed', () => {
  assert.equal(one([v('bypass', 'axe', 'html', '<html>'), { ...v('skip-link-missing', 'keyboard', '', ''), element: null }]).length, 1);
  assert.equal(one([v('skip-link', 'axe', 'a.sr-only', SKIP), v('skip-link-missing', 'keyboard', '', '')]).length, 2);
});

test('heading skip h1 -> h3 seen by axe, lighthouse and the screen-reader layer is ONE finding; another skipped heading is its own', () => {
  const h3 = '<h3 class="t">Open roles</h3>';
  const rows = [
    v('heading-order', 'axe', 'section > h3', h3),
    v('heading-order', 'lighthouse', 'body > main > section > h3', h3),
    v('heading-level-skipped', 'screenReader', '', '', { fix: { hint: 'Heading level skipped: h1 → h3 ("Open roles") — screen reader heading outline has a gap' }, element: { selector: '', outerHTML: '' } }),
  ];
  assert.equal(one(rows).length, 1);
  assert.equal(one([...rows, v('heading-order', 'axe', 'section > h4', '<h4>Benefits</h4>')]).length, 2);
});

test('two skipped headings with identical text are two findings; the same heading seen by two layers stays one', () => {
  const h3 = '<h3>Open roles</h3>';
  const rows = [v('heading-order', 'axe', 'section.a > h3', h3), v('heading-order', 'axe', 'section.b > h3', h3)];
  assert.equal(one(rows).length, 2);
  assert.equal(one([...rows, v('heading-order', 'lighthouse', 'body > section.a > h3', h3)]).length, 2);
  assert.equal(one([rows[0], v('heading-order', 'lighthouse', 'body > section.a > h3', h3)]).length, 1);
});

test('li[role=group] in ul[role=list]: aria-allowed-role on each item and aria-required-children on the list are one root cause', () => {
  const li = (n) => v('aria-allowed-role', 'axe', `.cards > li:nth-child(${n})`, '<li role="group" class="card">x</li>', { impact: 'minor' });
  const ul = v('aria-required-children', 'axe', '.cards', '<ul role="list" class="cards">', { impact: 'critical' });
  assert.equal(one([li(1), li(2), li(3), ul]).length, 1);
  // control: a different list is another root cause
  const other = v('aria-required-children', 'axe', '.other', '<ul role="list" class="other">');
  assert.equal(one([li(1), ul, other]).length, 2);
  // control: aria-allowed-role on something that is not a grouped list item keeps merging by element only
  assert.equal(one([v('aria-allowed-role', 'axe', 'main > div', '<div role="banner">'), ul]).length, 2);
});

// R3B1: shapes copied from round-2 rescans (selectors and markup quoting differ per engine; markup truncated by each).
const LONG = '<a href="#main-content" class="sr-only focus:not-sr-only focus:fixed focus:top-[1rem] focus:left-[1rem] focus:z-[200] focus:bg-white';
const withSrc = (file, line) => ({ source: { file, line, confidence: 'high' } });

test('r3b1: skip link seen by keyboard (selector "<a>", markup cut without ">"), lighthouse (ellipsis) and derived axe region is ONE finding with all layers', () => {
  const f = one([
    v('skip-link-target-missing', 'keyboard', '<a>', LONG),
    v('skip-link', 'lighthouse', 'body>a.sr-only', `${LONG.slice(0, 80)}…">`),
    v('region', 'axe', '.sr-only', '<a href="#main-content" class="sr-only focus:not-sr...">'),
  ]);
  assert.equal(f.length, 1);
  assert.deepEqual(f[0].layers, ['axe', 'keyboard', 'lighthouse']);
  assert.deepEqual(f[0].enginesAgreeing, ['axe', 'keyboard', 'lighthouse']);
});

test('r3b1: a complete tag is not a prefix of the same tag with an extra attribute (two elements stay two); a cut tag still merges', () => {
  const full = '<input type="text" name="search-query" id="a">';
  const more = '<input type="text" name="search-query" id="a" class="big">';
  assert.equal(one([v('label', 'axe', '#a', full), v('label', 'lighthouse', 'form>input.big', more)]).length, 2);
  assert.equal(one([v('label', 'axe', '#a', more), v('label', 'lighthouse', 'form>input.big', '<input type="text" name="search-query" id="a" cla…">')]).length, 1);
});

test('r3b1: region is derived only from a skip link, or from a missing main; another skip link or a present main does not absorb it', () => {
  // no main on the page: content outside landmarks is the landmark-main root cause
  const noMain = one([v('landmark-one-main', 'axe', 'html', '<html>'), v('region', 'axe', 'div.hero', '<div class="hero">')]);
  assert.equal(noMain.length, 1);
  assert.deepEqual(noMain[0].nativeRuleIds, ['landmark-one-main', 'region']);
  // main exists: region on a plain element stays its own finding next to the skip link
  assert.equal(one([v('skip-link', 'axe', 'a.s', LONG), v('region', 'axe', 'div.hero', '<div class="hero">')]).length, 2);
});

test('r3b1: empty heading seen by axe and the screen-reader layer under different selectors is ONE finding; two different headings stay two', () => {
  const h = (id) => `<h2 data-pdk-out="${id}" id="${id}-heading" class="type-h2"></h2>`;
  const f = one([
    v('empty-heading', 'axe', '#a-heading', h('a')), v('empty-heading', 'screenReader', 'body>main:nth-of-type(1)>h2:nth-of-type(1)', h('a')),
    v('empty-heading', 'axe', '#b-heading', h('b')), v('empty-heading', 'screenReader', 'body>main:nth-of-type(1)>h2:nth-of-type(2)', h('b')),
  ]);
  assert.equal(f.length, 2);
  f.forEach((x) => assert.deepEqual(x.layers, ['axe', 'screenReader']));
  // negative: different heading, same rule, one layer each, distinct markup
  assert.equal(one([v('empty-heading', 'axe', '#a-heading', h('a')), v('empty-heading', 'screenReader', 'h2.x', h('b'))]).length, 2);
});

test('r3b1: heading-order from axe + screen reader (text) and lighthouse (markup without text) is ONE finding', () => {
  const f = one([
    v('heading-order', 'axe', '#sim', '<h3 id="sim" class="similar__heading">Similar Jobs</h3>', withSrc('src/pages/job-details.liquid', 85)),
    v('heading-level-skipped', 'screenReader', '', '', { fix: { hint: 'Heading level skipped: h1 → h3 ("Similar Jobs") — gap' } }),
    v('heading-order', 'lighthouse', 'div>section>h3#sim', '<h3 id="sim" class="similar__heading">', withSrc('src/pages/job-details.liquid', 85)),
  ]);
  assert.equal(f.length, 1);
  assert.deepEqual(f[0].layers, ['axe', 'lighthouse', 'screenReader']);
});

test('r3b1: aria-allowed-role on li[role=group] items (selectors without a parent) is one root cause per source line; another line stays apart', () => {
  const li = (n) => `<li class="slide" role="group" aria-label="Slide ${n}">`;
  const items = [1, 2, 3].map((n) => v('aria-allowed-role', 'axe', `li[aria-label="Slide ${n}"]`, li(n), withSrc('src/pages/x.liquid', 116)));
  const merged = one(items);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].count, 3);
  assert.equal(one([...items, v('aria-allowed-role', 'axe', 'li[aria-label="Other"]', li('o'), withSrc('src/pages/x.liquid', 200))]).length, 2);
});

test('r3b1: same source line + family from two layers with unrelated selectors/markup is one element; two elements per layer on that line are not guessed', () => {
  const at = withSrc('src/partials/header.liquid', 12);
  assert.equal(one([v('link-name', 'axe', '#nav-a', '<a href="/x"></a>', at), v('LinkNavigationDiscernible', 'accessScan', 'body>header>a', '<a href="/y" data-x></a>', at)]).length, 1);
  // Changed deliberately: the two axe elements of one line are a loop repeat (one finding, count 2); the single accessScan row is not guessed onto either.
  const mixed = one([
    v('link-name', 'axe', '#p', '<a href="/x"></a>', at), v('link-name', 'axe', '#q', '<a href="/y"></a>', at),
    v('LinkNavigationDiscernible', 'accessScan', 'body>a', '<a href="/z"></a>', at),
  ]);
  assert.deepEqual(mixed.map((f) => [f.layers.join(), f.count]).sort(), [['accessScan', 1], ['axe', 2]]);
});

test('skip link + derived region: the merged source is the root cause row (the page <main>), not the layout line the derived row points at; verdict stays', () => {
  const page = { file: 'src/pages/p.liquid', line: 2, confidence: 'low', method: 'page-level-anchor' };
  const layout = { file: 'src/layouts/layout.liquid', line: 8, confidence: 'medium', method: 'liquid-tag-index' };
  const [f] = one([
    v('skip-link-target-missing', 'keyboard', 'a.sr-only', SKIP, { source: page, verdict: 'confirmed', evidence: { proof: { type: 'measured-fact', fact: 'Skip link points to #main, no element with that id exists' } } }),
    v('region', 'axe', 'a.sr-only', SKIP, { source: layout, verdict: 'confirmed' }),
  ]);
  // the root-cause row is skip-link-target-missing: likely at most (a main landmark or headings already bypass the blocks)
  assert.deepEqual([f.source.file, f.source.line, f.verdict], ['src/pages/p.liquid', 2, 'likely']);
  // region alone (no skip-link row) keeps its own source
  assert.equal(one([v('region', 'axe', 'p.x', '<p class="x">', { source: layout })])[0].source.file, 'src/layouts/layout.liquid');
});

test('no <main> + region on a header element: the merged source is the partial that writes the element, the page anchor stays a candidate; a derived row on a layout line keeps the anchor (paired)', () => {
  const page = { file: 'src/pages/p.liquid', line: 2, confidence: 'low', method: 'page-level-anchor' };
  const header = { file: 'src/partials/header.liquid', line: 154, confidence: 'medium', method: 'liquid-tag-index' };
  const rows = (derivedSource) => [
    v('landmark-one-main', 'axe', 'html', '<html>', { source: page }),
    v('region', 'axe', '.menu', '<div class="menu">', { source: derivedSource }),
  ];
  const [f] = one(rows(header));
  assert.deepEqual([f.source.file, f.source.line], ['src/partials/header.liquid', 154]);
  assert.ok(f.sourceCandidates.some((c) => c.file === 'src/pages/p.liquid' && c.method === 'page-level-anchor'));
  const [w] = one(rows({ ...header, file: 'src/layouts/layout.liquid' }));
  assert.deepEqual([w.source.file, w.source.line], ['src/pages/p.liquid', 2]);
});

test('dangling aria-labelledby: axe aria-valid-attr-value and accessScan AriaLabelledByHasReference on one element are ONE finding; on different elements they stay two', () => {
  const ASIDE = '<aside class="side" aria-labelledby="gone">';
  const f = one([v('aria-valid-attr-value', 'axe', 'aside.side', ASIDE), v('AriaLabelledByHasReference', 'accessScan', 'aside.side', ASIDE)]);
  assert.equal(f.length, 1);
  assert.deepEqual(f[0].layers, ['accessScan', 'axe']);
  assert.equal(one([v('aria-valid-attr-value', 'axe', 'aside.a', '<aside class="a" aria-labelledby="x">'), v('AriaLabelledByHasReference', 'accessScan', 'aside.b', '<aside class="b" aria-labelledby="y">')]).length, 2);
});

// One authoring line rendered N times by a template loop is one root cause; different lines stay apart.
const panel = (i, line, extra = {}) => v('TabpanelLabelledBy', 'accessScan', `div#panel-${i}`, `<div id="panel-${i}" role="tabpanel"></div>`,
  { impact: 'moderate', source: { mode: 'project', file: 'src/partials/story/journey.liquid', line, confidence: 'high', method: 'hint' }, ...extra });

test('loop repeats: 4 tabpanels from one template line are one finding with 4 occurrences and 4 elements; two lines stay two', () => {
  const f = one([0, 1, 2, 3].map((i) => panel(i, 42)));
  assert.equal(f.length, 1);
  assert.equal(f[0].count, 4);
  assert.equal(f[0].evidence.observations.length, 4);
  assert.equal(f[0].source.line, 42);
  const report = build([{ route: '/', violations: [0, 1, 2, 3].map((i) => panel(i, 42)) }]);
  assert.deepEqual([report.summary.findingCount, report.summary.occurrenceCount], [1, 4]);
  const two = one([panel(0, 42), panel(1, 42), panel(2, 57), panel(3, 57)]);
  assert.deepEqual(two.map((x) => [x.source.line, x.count]).sort(), [[42, 2], [57, 2]]);
  // stable: the merged id does not depend on input order
  assert.equal(one([3, 2, 1, 0].map((i) => panel(i, 42)))[0].stableId, f[0].stableId);
});

test('loop repeats: no merge across routes, other rules, unresolved or low-confidence sources', () => {
  assert.equal(build([{ route: '/a', violations: [panel(0, 42)] }, { route: '/b', violations: [panel(1, 42)] }]).pages.flatMap((p) => p.findings).length, 2);
  assert.equal(one([panel(0, 42), panel(1, 42, { ruleId: 'TabNameAvailable' })]).length, 2);
  assert.equal(one([panel(0, 42, { source: {} }), panel(1, 42, { source: {} })]).length, 2);
  const low = { source: { mode: 'project', file: 'a.liquid', line: 3, confidence: 'low', method: 'url-fallback' } };
  assert.equal(one([panel(0, 3, low), panel(1, 3, low)]).length, 2);
});

test('one element per finding: rows that share a source line but quote different elements stay apart; the same element still merges', () => {
  const src = { file: 'src/partials/footer.liquid', line: 7, confidence: 'high', method: 'structural' };
  const a = v('link-name', 'axe', 'footer a.one', '<a class="one" id="one" href="/a"></a>', { source: src });
  const sameLineOtherTag = v('LinkNavigationDiscernible', 'accessScan', 'footer .two', '<button class="two" id="two"></button>', { source: src });
  assert.equal(one([a, sameLineOtherTag]).length, 2, 'different tags and ids are never one element');
  const sameEl = v('LinkNavigationDiscernible', 'accessScan', 'html > body > footer > a', '<a class="one" id="one" href="/a"></a>', { source: src });
  assert.equal(one([a, sameEl]).length, 1, 'the same element from another engine merges');
});

test('one element per finding: the EN and FR links of one language switch (one authoring line, different visible text) stay two findings; the same link from two engines merges', () => {
  const line = { file: 'src/partials/footer.liquid', line: 222, confidence: 'medium', method: 'liquid-tag-index' };
  const fr = v('TargetSize', 'accessScan', 'footer>div>a:nth-of-type(2)', '<a href="https://emplois.example.ca/">FR</a>', { source: line });
  const findJobs = v('target-size', 'axe', 'span>a[href="/"]', '<a href="/" target="_blank" rel="noopener noreferrer">Find Jobs</a>', { source: line });
  assert.equal(one([fr, findJobs]).length, 2, 'a confirmed FR row must not become evidence of the Find Jobs link');
  const sameFr = v('target-size', 'axe', '.c-language a[href="https://emplois.example.ca/"]', '<a href="https://emplois.example.ca/">FR</a>', { source: line });
  assert.equal(one([fr, sameFr]).length, 1, 'the same link seen by two engines still merges');
});

test('one element per finding: a duplicate-id finding takes its element from the row that supplied the source', () => {
  const first = v('duplicate-id', 'axe', '#dup', '<div id="dup" class="header-one">', { source: { file: 'src/partials/header.liquid', line: 3, confidence: 'low', method: 'hint' }, fix: { hint: 'Duplicate ID "dup"' } });
  const second = v('duplicate-id', 'lighthouse', 'footer > #dup', '<span id="dup2" class="footer-one">', { source: { file: 'src/partials/footer.liquid', line: 9, confidence: 'high', method: 'structural' }, fix: { hint: 'Duplicate ID "dup"' } });
  const f = one([first, second]);
  assert.equal(f.length, 1);
  assert.equal(f[0].source.file, 'src/partials/footer.liquid');
  assert.match(f[0].element.outerHTML, /footer-one/, 'markup follows the row that owns the source line');
});
