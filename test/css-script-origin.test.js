import './helpers/hermetic-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { traceToPartials } from '../src/index.js';
import { applyCssOrigins, authoredCssCandidates, ensureSourceLine, isGeneratedCss } from '../src/tracer/css-origin.js';
import { closeBrowser } from '../src/scanner/browser.js';
import { requireBrowser } from './helpers/require-browser.js';

const FILES = {
  'dist/scan-manifest.json': '{}',
  'src/layouts/layout.liquid': '<!doctype html>\n<html lang="en">\n<body>\n{% block content %}{% endblock %}\n{% render "footer" %}\n{% render "scripts" %}\n</body></html>\n',
  'src/pages/index.liquid': '{% layout "layout" %}\n{% block content %}\n<main id="main">x</main>\n{% endblock %}\n',
  'src/partials/footer.liquid': '<footer>\n  <ul class="legal">\n    <li><a href="/privacy">Privacy</a></li>\n    <li><a href="/terms">Terms</a></li>\n  </ul>\n  <div class="lang-bar">\n    <div class="lang-options">\n      <a href="https://example.test">EN</a> | <a class="current-lang" href="/">FR</a>\n    </div>\n  </div>\n</footer>\n',
  'src/partials/scripts.liquid': '<script>\n  (function () {\n    var other = document.querySelectorAll(".social-links a");\n    for (var j = 0; j < other.length; j++) { other[j].href += "?utm=1"; }\n    var path = window.location.pathname.slice(1);\n    var buttons = document.querySelectorAll(".lang-options a");\n    for (var i = 0; i < buttons.length; i++) {\n      buttons[i].href += path;\n    }\n  })();\n</script>\n',
  'src/styles/site.css': '.lang-bar a.current-lang {\n  color: #ffbc0d;\n}\n\n.lang-bar a:hover {\n  color: #ffbc0d;\n}\n',
  'src/styles/bundle.css': '/* Synced from Paradox platform - do not edit manually */\n.legal {\n  line-height: 1;\n}\n',
};
async function withSite(fn, extra = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ada-script-origin-'));
  try {
    for (const [rel, body] of Object.entries({ ...FILES, ...extra })) { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), body); }
    return await fn(root);
  } finally { rmSync(root, { recursive: true, force: true }); }
}
const finding = (ruleId, outerHTML, extra = {}) => ({ ruleId, rule: ruleId, layer: 'axe', element: { outerHTML, selector: 'x' }, evidence: {}, source: { mode: 'url', file: 'unknown', line: null, confidence: 'none', method: 'unresolved' }, ...extra });
const at = (v) => `${v.source.file}:${v.source.line}`;
const URL_ = 'http://127.0.0.1:1/';

test('a link whose live href is the served one plus a script suffix is blamed on the script line; the template stays as templateSource (paired)', async () => {
  await withSite(async (root) => {
    const v = finding('dead-link-404', '<a href="https://example.test/careers">EN</a>', { layer: 'links' });
    await traceToPartials([v], URL_, root);
    assert.equal(at(v), 'src/partials/scripts.liquid:8');
    assert.equal(v.source.method, 'script-sets-attribute');
    assert.deepEqual(v.source.templateSource, { file: 'src/partials/footer.liquid', line: 8 });
    // The live href is exactly what the template writes: nothing rewrote it, the markup (not a script) is the source.
    const authored = finding('dead-link-404', '<a href="https://example.test">EN</a>', { layer: 'links' });
    await traceToPartials([authored], URL_, root);
    assert.notEqual(authored.source.method, 'script-sets-attribute');
  });
});

test('a script that rewrites hrefs of other elements is not blamed for a link it does not select (paired)', async () => {
  await withSite(async (root) => {
    const v = finding('dead-link-404', '<a href="/privacy-old">Privacy</a>', { layer: 'links' });
    await traceToPartials([v], URL_, root);
    assert.notEqual(v.source.method, 'script-sets-attribute');
  });
});

test('a class a script adds (classList.add) is the source of a colour finding on that element; a class the template writes is not (paired)', async () => {
  await withSite(async (root) => {
    const extra = { 'src/scripts/menu.js': 'const el = document.querySelector(".lang-options a");\nel.classList.add("is-dimmed");\n' };
    // site.css is replaced so no authored rule declares the colour: the script is the only lead.
    const files = { ...extra, 'src/styles/site.css': '.x { margin: 0; }\n' };
    for (const [rel, body] of Object.entries(files)) { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), body); }
    const v = finding('color-contrast', '<a class="is-dimmed" href="/">FR</a>', { element: { outerHTML: '<a class="is-dimmed" href="/">FR</a>', selector: '.lang-options>a' } });
    await traceToPartials([v], URL_, root);
    assert.equal(at(v), 'src/scripts/menu.js:2');
    const authored = finding('color-contrast', '<a class="current-lang" href="/">FR</a>');
    await traceToPartials([authored], URL_, root);
    assert.notEqual(authored.source.method, 'script-sets-attribute');
  });
});

test('a contrast failure whose colour is declared by one authored rule points at that rule; the hover rule and a generated file never count (paired)', async () => {
  await withSite(async (root) => {
    const fact = 'Element has insufficient color contrast of 3.1 (foreground color: #ffbc0d, background color: #db0007, font size: 9.0pt (12px), font weight: bold). Expected contrast ratio of 4.5:1';
    const v = finding('color-contrast', '<a class="current-lang" href="/">FR</a>', { evidence: { fact } });
    await traceToPartials([v], URL_, root);
    assert.equal(at(v), 'src/styles/site.css:1');
    assert.equal(v.source.method, 'css-rule');
    assert.equal(v.source.cssSelector, '.lang-bar a.current-lang');
    assert.equal(v.source.markupFile, 'src/partials/footer.liquid');
    // Only a hover rule declares the colour: the markup stays.
    const hoverOnly = { 'src/styles/site.css': '.lang-bar a.current-lang:hover {\n  color: #ffbc0d;\n}\n' };
    for (const [rel, body] of Object.entries(hoverOnly)) writeFileSync(join(root, rel), body);
    const w = finding('color-contrast', '<a class="current-lang" href="/">FR</a>', { evidence: { fact } });
    await traceToPartials([w], URL_, root);
    assert.notEqual(w.source.method, 'css-rule');
  });
});

test('a platform-synced bundle is a place to fix; a reset, a synced-named path and a @generated file are not (paired)', async () => {
  await withSite(async (root) => {
    assert.equal(isGeneratedCss(root, 'src/styles/bundle.css'), false);
    writeFileSync(join(root, 'src/styles/gen.css'), '/* @generated, synced from the build */\n.a { width: 1px; }\n');
    assert.equal(isGeneratedCss(root, 'src/styles/gen.css'), true);
    const v = { ruleId: 'target-size', element: { outerHTML: '<a href="/privacy">Privacy</a>' }, source: { file: 'src/partials/footer.liquid', line: 3, confidence: 'medium', method: 'liquid-tag-index' },
      cssRule: { selectorText: '.legal', external: false, props: ['line-height'], inherited: true, candidates: [{ selectorText: '.legal', external: false, props: ['line-height'], inherited: true }] } };
    applyCssOrigins([v], root);
    // Only an inherited line-height is found: the markup line stays primary, the rule is a low-confidence candidate and a note says why.
    assert.deepEqual([v.source.file, v.source.line, v.source.method], ['src/partials/footer.liquid', 3, 'liquid-tag-index']);
    assert.equal(v.source.note, 'size comes from inherited font-size/line-height');
    assert.deepEqual(v.sourceCandidates.map((c) => [c.file, c.line, c.confidence, c.method]), [['src/styles/bundle.css', 2, 'low', 'css-rule-inherited']]);
  });
});

test('target-size: a generic font-size rule on the element class never beats the rule that sets its box (paired)', async () => {
  await withSite(async (root) => {
    writeFileSync(join(root, 'src/styles/layout.css'), '.o-item {\n  font-size: 14px;\n}\n.o-card {\n  padding: 2px;\n}\n');
    const mk = (selectorText, props) => ({ ruleId: 'target-size', element: { outerHTML: '<a class="o-item" href="/p">P</a>' }, source: { file: 'src/partials/footer.liquid', line: 3, confidence: 'medium', method: 'liquid-tag-index' },
      cssRule: { selectorText, external: false, props, candidates: [{ selectorText, external: false, props }] } });
    const fontOnly = mk('.o-item', ['font-size']);
    applyCssOrigins([fontOnly], root);
    assert.equal(fontOnly.source.file, 'src/partials/footer.liquid', 'font-size only: the markup stays primary');
    assert.equal(fontOnly.source.note, 'size comes from inherited font-size/line-height');
    assert.deepEqual(fontOnly.sourceCandidates.map((c) => [c.file, c.line, c.confidence]), [['src/styles/layout.css', 1, 'low']]);
    const boxed = mk('.o-card', ['padding']);
    applyCssOrigins([boxed], root);
    assert.deepEqual([boxed.source.file, boxed.source.line, boxed.source.method, boxed.source.markupFile], ['src/styles/layout.css', 4, 'css-rule', 'src/partials/footer.liquid']);
  });
});

test('size and colour findings always carry a line: a page file with no line is resolved to the footer tag; an unrelated rule is left alone (paired)', async () => {
  await withSite(async (root) => {
    const size = finding('target-size', '<a href="/terms">Terms</a>', { source: { mode: 'url', file: 'src/pages/index.liquid', line: null, confidence: 'low', method: 'url-fallback', page: 'src/pages/index.liquid' } });
    const colour = finding('color-contrast', '<a class="current-lang" href="/">FR</a>', { source: { mode: 'url', file: 'src/pages/index.liquid', line: null, confidence: 'low', method: 'url-fallback' } });
    const other = finding('image-alt', '<a href="/terms">Terms</a>', { source: { mode: 'url', file: 'src/pages/index.liquid', line: null, confidence: 'low', method: 'url-fallback' } });
    ensureSourceLine([size, colour, other], root);
    assert.equal(at(size), 'src/partials/footer.liquid:4');
    assert.equal(at(colour), 'src/partials/footer.liquid:8');
    assert.equal(other.source.line, null);
  });
});

test('collectCssRules / authoredCssCandidates: own size rule first, else the ancestor rule that sets an inherited line-height; any producer can call it with a selector (paired)', async (t) => {
  const browser = await requireBrowser(t);
  if (!browser) return;
  t.after(closeBrowser);
  await withSite(async (root) => {
    const page = await (await browser.newContext()).newPage();
    await page.setContent('<ul class="legal"><li><a id="a1" href="#">One</a></li></ul><div class="btn-wrap"><a id="a2" class="btn" href="#">Two</a></div>');
    await page.addStyleTag({ content: '.legal { line-height: 1; } .btn { padding: 0; }' });
    writeFileSync(join(root, 'src/styles/site.css'), '.btn {\n  padding: 0;\n}\n');
    const inherited = await authoredCssCandidates(page, root, '#a1');
    assert.deepEqual(inherited.map((c) => [c.file, c.line, c.inherited]), [['src/styles/bundle.css', 2, true]]);
    const own = await authoredCssCandidates(page, root, '#a2');
    assert.deepEqual(own.map((c) => [c.file, c.line, c.inherited]), [['src/styles/site.css', 1, false]]);
    // The same entry point answers for another property list (the tool-owned measurement asks for what it measured).
    assert.deepEqual(await authoredCssCandidates(page, root, '#a2', ['margin']), []);
    await page.close();
  });
});

const SLIDES = {
  'src/pages/index.liquid': '{% layout "layout" %}\n{% block content %}\n<main id="main">{% render "slides" %}</main>\n{% endblock %}\n',
  'src/partials/slides.liquid': '<section class="get-to-know">\n  <article class="slide"><h3>One</h3></article>\n  <article class="slide"><h3>Two</h3></article>\n</section>\n',
  'src/scripts/get-to-know-us.js': 'const slides = document.querySelectorAll(".get-to-know article");\nslides.forEach((article, i) => {\n  article.setAttribute("aria-label", `Show slide ${i + 1}`);\n  article.title = "Other " + i;\n});\n',
};
const MISMATCH = 'label-content-name-mismatch';

test('an aria-label a script writes with a template string inside a loop is blamed on the script line; markup stays as templateSource (paired)', async () => {
  await withSite(async (root) => {
    const html = '<article class="slide" aria-label="Show slide 2">';
    const v = finding(MISMATCH, html, { element: { outerHTML: html, selector: '.get-to-know>article:nth-child(2)' }, source: { mode: 'url', file: 'src/partials/slides.liquid', line: 3, confidence: 'low', method: 'liquid-tag-index' } });
    await traceToPartials([v], URL_, root);
    assert.equal(at(v), 'src/scripts/get-to-know-us.js:3');
    assert.equal(v.source.method, 'script-sets-attribute');
    assert.deepEqual(v.source.templateSource, { file: 'src/partials/slides.liquid', line: 3 });
    // A label the script cannot have produced (the live text differs from the template literal) is not blamed on it.
    const other = '<article class="slide" aria-label="Read more about this">';
    const w = finding(MISMATCH, other, { element: { outerHTML: other, selector: '.get-to-know>article:nth-child(2)' } });
    await traceToPartials([w], URL_, root);
    assert.notEqual(w.source.method, 'script-sets-attribute');
  }, SLIDES);
});

test('a title concatenated in a loop matches the live title; the aria-label write on the same element is not blamed for it (paired)', async () => {
  await withSite(async (root) => {
    const html = '<article class="slide" title="Other 1">';
    const v = finding('label-content-name-mismatch', html, { element: { outerHTML: html, selector: '.get-to-know>article' } });
    await traceToPartials([v], URL_, root);
    assert.equal(at(v), 'src/scripts/get-to-know-us.js:4');
  }, SLIDES);
});
