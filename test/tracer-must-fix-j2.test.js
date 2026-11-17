import './helpers/hermetic-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { attachBehaviorScripts, traceToPartials } from '../src/index.js';
import { buildScanReportV2 } from '../src/reporter/report-v2.js';

const LAYOUT = '<!doctype html>\n<html lang="en">\n<head><title>t</title></head>\n<body>\n{% block content %}{% endblock %}\n</body></html>\n';
function site(files, fn) {
  const root = mkdtempSync(join(tmpdir(), 'j2-'));
  for (const [rel, body] of Object.entries({ 'src/layouts/layout.liquid': LAYOUT, ...files })) { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), body); }
  return Promise.resolve(fn(root)).finally(() => rmSync(root, { recursive: true, force: true }));
}
const page = (body) => `{% layout "layout" %}\n{% block content %}\n<main>\n${body}\n</main>\n{% endblock %}\n`;
const live = (rule, html, selector, extra = {}) => ({ rule, ruleId: rule, element: { outerHTML: html, selector }, source: { mode: 'url', method: 'unavailable' }, ...extra });
const RUNS = [{ layer: 'axe', engine: { name: 'axe-core', version: '4.12.1' }, status: 'complete' }];
const report = (violations) => buildScanReportV2([{ page: 'home', url: 'http://127.0.0.1:1/', scannerRuns: RUNS, violations }], {
  generatedAt: '2026-10-30T00:00:00.000Z', producer: { name: 'ada-scan', version: '1.1.0' }, target: { mode: 'local-only', url: 'http://127.0.0.1:1/' }, sourceTracing: { framework: 'paradox-liquid', requireSource: true },
}).pages[0].findings;
const finding = (v, extra = {}) => ({ ruleId: v.rule, nativeRuleId: v.rule, layer: 'axe', impact: 'serious', count: 1, verdict: 'confirmed', evidence: { proof: { type: 'measured-fact', fact: 'measured' } }, element: v.element, source: v.source, ...extra });

test('a defect located at a template line stays confirmed when the script match is ambiguous (templateSource, medium trace)', () => site({
  'src/pages/index.liquid': page('{% render "index/a" %}'),
  'src/partials/index/a.liquid': '<div class="wrap">\n  <span class="thing-one">Menu</span>\n</div>\n',
  'src/scripts/one.js': 'export function one(el){ el.setAttribute("role", "menu"); }\n',
  'src/scripts/two.js': 'export function two(el){ el.setAttribute("role", "menu"); }\n',
}, async (root) => {
  const v = live('aria-allowed-role', '<span class="thing-one" role="menu">Menu</span>', '.wrap>.thing-one');
  await traceToPartials([v], 'http://127.0.0.1:1/', root);
  assert.equal(v.source.templateSource?.file, 'src/partials/index/a.liquid');
  const [f] = report([finding(v)]);
  assert.equal(f.verdict, 'confirmed');
  assert.notEqual(f.untraced, true);
}));

test('a link re-pointed at its unique sidecar line stays confirmed; an untraced row never says unresolved when a line is known', () => site({
  'src/pages/index.liquid': page('{% render "index/one" %}\n{% render "index/two" %}'),
  'src/pages/index.liquid.json': '{\n  "links": [\n    { "label": "Careers", "url": "/gone-page" },\n    { "label": "Other", "url": "/ok" }\n  ]\n}\n',
  'src/partials/index/one.liquid': '<ul>{% for l in links %}\n<li><a class="lnk" href="{{ l.url }}">{{ l.label }}</a></li>{% endfor %}\n</ul>\n',
  'src/partials/index/two.liquid': '<ul>{% for l in links %}\n<li><a class="lnk" href="{{ l.url }}">{{ l.label }}</a></li>{% endfor %}\n</ul>\n',
}, async (root) => {
  const v = live('broken-link', '<a class="lnk" href="/gone-page">Careers</a>', 'ul>li:nth-child(1)>a.lnk', { layer: 'links', linkTarget: '/gone-page' });
  await traceToPartials([v], 'http://127.0.0.1:1/', root);
  assert.equal(v.source.method, 'data-sidecar');
  const [f] = report([finding(v, { linkTarget: '/gone-page' })]);
  assert.equal(f.verdict, 'confirmed');
  assert.notEqual(f.untraced, true);
  const [g] = report([finding({ rule: 'x', element: v.element, source: { file: 'src/a.liquid', line: 3, confidence: 'low', method: 'liquid-tag-index' } })]);
  assert.equal(g.untraced, true);
  assert.equal(g.source.traceReason, 'multiple-candidates');
}));

test('own-text narrowing keeps a candidate whose text is dynamic Liquid; the selector chain then picks the right one', () => site({
  'src/pages/index.liquid': page('{% render "home/a" %}\n{% render "home/b" %}'),
  'src/partials/home/a.liquid': '<section>\n<a href="/apply" class="cta-link underline">Apply</a>\n</section>\n',
  'src/partials/home/b.liquid': '<section>\n{% for it in items %}<a href="/apply" class="cta-link underline">{{ it.label }}</a>{% endfor %}\n</section>\n',
  'src/partials/home/b.liquid.json': '{"items":[{"label":"Apply"}]}',
}, async (root) => {
  const v = live('link-name', '<a href="/apply" class="cta-link underline">Apply</a>', 'main>section:nth-child(2)>a');
  await traceToPartials([v], 'http://127.0.0.1:1/', root);
  // never the literal one at medium by text alone
  assert.ok(!(v.source.file === 'src/partials/home/a.liquid' && v.source.confidence === 'medium'), JSON.stringify(v.source));
}));

test('a shared component that only shares a utility class is not promoted over the traced partial; the component the template renders still is', () => site({
  'src/pages/index.liquid': page('{% render "button", text: "Go" %}\n{% render "home/tiles" %}'),
  'src/partials/home/tiles.liquid': '<div>\n<div role="button" tabindex="0" class="tile-wide rounded-full flex">Tile</div>\n</div>\n',
  'src/components/button.liquid': '<a role="button" tabindex="0" class="rounded-full btn-x">{{ text }}</a>\n',
  'src/scripts/tiles.js': 'export function initTiles() {\n  document.querySelectorAll(".tile-wide").forEach((el) => {\n    el.addEventListener("click", () => open());\n  });\n}\n',
}, (root) => {
  const v = { rule: 'role-button-not-keyboard-operable', ruleId: 'role-button-not-keyboard-operable', element: { outerHTML: '<div role="button" tabindex="0" class="tile-wide rounded-full flex">Tile</div>', selector: 'main>div>div' }, origin: { owner: 'site' }, source: { file: 'src/partials/home/tiles.liquid', line: 2, method: 'liquid-tag-index', confidence: 'high' } };
  attachBehaviorScripts([v], 'src/pages/index.liquid', root);
  assert.notEqual(v.source.file, 'src/components/button.liquid');
  assert.notEqual(v.source.method, 'component-markup');
}));

test('narrowing by selector chain reads the candidate tag, not the first tag on a shared source line', () => site({
  'src/pages/index.liquid': page('{% render "index/one" %}\n{% render "index/two" %}'),
  'src/partials/index/one.liquid': '<ul class="menu-a">\n<li class="item"><a class="link" href="/x"><img src="a.png"></a></li>\n</ul>\n',
  'src/partials/index/two.liquid': '<ul class="menu-b">\n<li class="item">\n<a class="link" href="/x"><img src="a.png"></a>\n</li>\n</ul>\n',
}, async (root) => {
  const a = live('link-name', '<a class="link" href="/x"><img src="a.png"></a>', '.menu-a>.item>.link');
  const b = live('link-name', '<a class="link" href="/x"><img src="a.png"></a>', '.menu-b>.item>.link');
  await traceToPartials([a, b], 'http://127.0.0.1:1/', root);
  assert.equal(`${a.source.file}:${a.source.line}`, 'src/partials/index/one.liquid:2');
  assert.equal(`${b.source.file}:${b.source.line}`, 'src/partials/index/two.liquid:3');
}));

// ─── file:line gaps of the fresh blind sites ────────────────────────────────

test('a candidate that writes no aria-label cannot be the element that carries a literal one (label-in-name cited a sibling nav link)', () => site({
  'src/pages/index.liquid': page('{% render "layout/header" %}'),
  'src/partials/layout/header.liquid': [
    '<nav>',
    '  {% for link in links %}',
    '  <a href="{{ link.url }}"',
    '    class="hidden lg:flex nav-link items-center gap-1 px-4 text-white hocus:text-teal"',
    '    data-nav-link>',
    '    {{ link.text }}',
    '  </a>',
    '  {% endfor %}',
    '  <a href="/jobs"',
    '    class="hidden lg:flex nav-link items-center gap-1 px-4 text-white hocus:text-teal"',
    '    aria-label="Search jobs" data-nav-link>',
    '    <span>What are you looking for?</span>',
    '  </a>',
    '</nav>',
  ].join('\n') + '\n',
}, async (root) => {
  const v = live('VisibleTextPartOfAccessibleName', '<a href="/jobs" class="hidden lg:flex nav-link items-center gap-1 px-4 text-white hocus:text-teal" aria-label="Search jobs" data-nav-link=""><span>What are you looking for?</span></a>', 'nav>a:nth-of-type(2)');
  await traceToPartials([v], 'http://127.0.0.1:1/', root);
  assert.equal(`${v.source.file}:${v.source.line}`, 'src/partials/layout/header.liquid:9');
}));

import { applyColorOrigin } from '../src/tracer/color-origin.js';
import { widgetSnapshotAt } from '../src/tracer/structural-source.js';

const colorSite = (files, fn) => site(files, async (root) => fn(root));
const colorFinding = (chain) => ({ ruleId: 'color-contrast', rule: 'color-contrast', layer: 'axe', verdict: 'confirmed', element: { outerHTML: '<a>', selector: 'a' }, evidence: { proof: { type: 'measured-fact', fact: 'contrast' } }, source: { file: 'src/partials/layout/footer.liquid', line: 41, confidence: 'medium', method: 'liquid-tag-index' }, colorChain: chain });
const decl = (prop, selectorText, value, chain = []) => ({ prop, selectorText, value, external: false, chain });

test('white text on a background no authored rule declares keeps the markup trace instead of blaming the white token', () => colorSite({
  'src/styles/tailwind.css': ':root {\n  --color-white: #ffffff;\n}\n.text-white { color: var(--color-white); }\n',
}, (root) => {
  const v = colorFinding({
    color: decl('color', '.text-white', 'var(--color-white)', [{ name: '--color-white', selectorText: ':root', value: '#ffffff', external: false }]),
    background: decl('background-color', '.bg-deep-teal\\/50', 'color-mix(in srgb, #0c4c5c 50%, transparent)'),
    computed: { color: '#ffffff', background: '#879091' },
  });
  assert.equal(applyColorOrigin(v, root), false);
  assert.equal(v.source.method, 'liquid-tag-index');
}));

test('a token also used as a background and outline is not the fix of one foreground use: the rule that applies it is', () => colorSite({
  'src/styles/tailwind.css': ':root {\n  --color-pb-cyan: #00aff0;\n}\n.band {\n  background-color: var(--color-pb-cyan);\n}\n.footer-nav-link {\n  color: var(--color-pb-cyan);\n}\n',
}, (root) => {
  const v = colorFinding({
    color: decl('color', '.footer-nav-link', 'var(--color-pb-cyan)', [{ name: '--color-pb-cyan', selectorText: ':root', value: '#00aff0', external: false }]),
    background: null,
    computed: { color: '#00aff0', background: '#ffffff' },
  });
  assert.equal(applyColorOrigin(v, root), true);
  assert.equal(`${v.source.file}:${v.source.line}`, 'src/styles/tailwind.css:8');
  assert.equal(v.source.method, 'css-rule');
  assert.deepEqual(v.source.tokenSource, { file: 'src/styles/tailwind.css', line: 2, token: '--color-pb-cyan' });
  assert.ok(v.sourceCandidates.some((c) => c.line === 2));
}));

test('a token used for this role only stays the primary source', () => colorSite({
  'src/styles/tailwind.css': ':root {\n  --color-pb-cyan: #00aff0;\n}\n.footer-nav-link {\n  color: var(--color-pb-cyan);\n}\n',
}, (root) => {
  const v = colorFinding({
    color: decl('color', '.footer-nav-link', 'var(--color-pb-cyan)', [{ name: '--color-pb-cyan', selectorText: ':root', value: '#00aff0', external: false }]),
    background: null,
    computed: { color: '#00aff0', background: '#ffffff' },
  });
  assert.equal(applyColorOrigin(v, root), true);
  assert.equal(`${v.source.file}:${v.source.line}`, 'src/styles/tailwind.css:2');
  assert.equal(v.source.method, 'css-token');
}));

test('an element on the same template line as its widget mount is the widget snapshot; an own line inside a mount stays the site skeleton', () => site({
  'src/pages/index.liquid': page('{% render "index/jobs" %}'),
  'src/partials/index/jobs.liquid': [
    '<div class="wrap" data-react-component="jobs-pagination"><div class="c"><select class="page-size" id="page-size-select" aria-labelledby="page-size-select"></select></div></div>',
    '<div data-react-component="jobs-list">',
    '  <h2 id="jobs-title">Jobs</h2>',
    '</div>',
  ].join('\n') + '\n',
}, async (root) => {
  const sel = '<select class="page-size" id="page-size-select" aria-labelledby="page-size-select"></select>';
  assert.equal(widgetSnapshotAt('src/partials/index/jobs.liquid', 1, sel, root), 'jobs-pagination');
  assert.equal(widgetSnapshotAt('src/partials/index/jobs.liquid', 3, '<h2 id="jobs-title">Jobs</h2>', root), null);
  assert.equal(widgetSnapshotAt('src/partials/index/jobs.liquid', 1, '<div class="wrap" data-react-component="jobs-pagination">', root), null);
  const v = live('select-name', sel, '#page-size-select', { origin: { owner: 'site', kind: 'site-source', label: 'Site source', evidence: [] } });
  await traceToPartials([v], 'http://127.0.0.1:1/', root);
  assert.equal(v.origin.owner, 'platform');
  const [f] = report([finding(v, { origin: v.origin })]);
  assert.equal(f.ownership, 'platform');
  assert.equal(f.source.file, null);
}));

test('a focused control covered by a sticky bar whose own rule sets a z-index is fixed in that rule', () => site({
  'src/pages/index.liquid': page('<a class="skip-link" href="#x">Skip</a>\n<header class="site-header"></header>'),
  'src/styles/styles.css': '.skip-link {\n  position: absolute;\n  z-index: var(--z-skip);\n}\n.skip-link:focus {\n  top: 0;\n}\n.site-header {\n  position: sticky;\n  z-index: 50;\n}\n',
}, async (root) => {
  const v = live('FocusNotObscuredHeader', '<a class="skip-link" href="#x">Skip</a>', 'main>a', { origin: { owner: 'site', kind: 'site-source', label: 'Site source', evidence: [] } });
  await traceToPartials([v], 'http://127.0.0.1:1/', root);
  assert.equal(`${v.source.file}:${v.source.line}`, 'src/styles/styles.css:3');
  assert.equal(v.source.markupFile, 'src/pages/index.liquid');
  assert.equal(v.source.method, 'css-rule');
}));

test('an element traced into the shared component itself keeps the component as its markup owner', () => site({
  'src/pages/index.liquid': page('{% render "button", text: "Go" %}'),
  'src/components/button.liquid': '<a role="button" tabindex="0" class="btn-x oliviaButton">{{ text }}</a>\n',
  'src/scripts/i.js': 'document.querySelectorAll(".oliviaButton").forEach((el) => {\n  el.addEventListener("click", () => chat());\n});\n',
}, (root) => {
  const v = { rule: 'role-button-not-keyboard-operable', ruleId: 'role-button-not-keyboard-operable', element: { outerHTML: '<a role="button" tabindex="0" class="btn-x oliviaButton">Go</a>', selector: 'main>a' }, origin: { owner: 'site' }, source: { file: 'src/components/button.liquid', line: 1, method: 'liquid-tag-index', confidence: 'high' } };
  attachBehaviorScripts([v], 'src/pages/index.liquid', root);
  assert.equal(v.source.file, 'src/components/button.liquid');
  assert.equal(v.source.method, 'component-markup');
}));

import { findLineForRenderedHtml } from '../src/tracer/liquid-tag-index.js';

test('a root-relative authored href matches the absolute form the browser serializes, so the real tag outscores a look-alike loop link', () => site({
  'src/partials/layout/header.liquid': [
    '<nav>',
    '  {% for link in links %}',
    '  <a href="{{ link.url }}" class="nav-link flex px-4" aria-label="{{ link.text }}">{{ link.text }}</a>',
    '  {% endfor %}',
    '  <a href="/jobs"',
    '    class="nav-link flex px-4"',
    '    aria-label="Search jobs"><span>What are you looking for?</span></a>',
    '</nav>',
  ].join('\n') + '\n',
}, (root) => {
  const hit = findLineForRenderedHtml('src/partials/layout/header.liquid', '<a href="http://127.0.0.1:6212/jobs" class="nav-link flex px-4" aria-label="Search jobs"><span>x</span></a>', root);
  assert.equal(hit.line, 5);
}));
