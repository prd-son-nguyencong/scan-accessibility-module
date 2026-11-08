import './helpers/hermetic-env.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { traceToPartials } from '../src/index.js';
import { validateHtml } from '../src/scanner/html-validate.js';
import { buildScanReportV2 } from '../src/reporter/report-v2.js';
import { collectCssRules, locateCssRule, applyCssOrigins, isSizeRule } from '../src/tracer/css-origin.js';
import { getBrowser, newPage, closeBrowser } from '../src/scanner/browser.js';
import { startParadoxSite } from './helpers/paradox-site-server.js';

after(() => closeBrowser());

// Layout + partials + a component. Line numbers are hand-counted from this table.
const FILES = {
  'dist/scan-manifest.json': '{}',
  'src/layouts/layout.liquid': '<!doctype html>\n<html lang="en">\n<head><title>t</title></head>\n<body>\n{% render "layout/header" %}\n{% block content %}{% endblock %}\n{% render "layout/footer" %}\n</body></html>\n',
  'src/pages/index.liquid': '{% layout "layout" %}\n{% block content %}\n<main id="main">\n{% render "components/button", label: "Go" %}\n</main>\n{% endblock %}\n',
  'src/pages/about.liquid': '{% layout "layout" %}\n{% block content %}\n<main id="main">\n<p>About</p>\n</main>\n{% endblock %}\n',
  'src/pages/jobs.liquid': '{% layout "layout" %}\n{% block content %}\n<main id="main">\n<p>Jobs</p>\n</main>\n{% endblock %}\n',
  'src/partials/layout/header.liquid': '<header>\n<ul role="list" class="nav-list">\n<li><a href="/a">A</a></li>\n</ul>\n</header>\n',
  'src/partials/layout/footer.liquid': '<footer>\n<p class="legal-note">x</p>\n</footer>\n',
  'src/components/button.liquid': '<button class="btn-primary" type="button">\n  <span id="dup">{{ label }}</span>\n  <span id="dup">x</span>\n</button>\n',
  'src/styles/site.css': '.hero { color: red; }\n\n.icon-link,\n.icon-link-alt {\n  width: 10px;\n  height: 10px;\n}\n',
  'src/styles/other.css': '.icon-link-alt { width: 12px; }\n',
};

async function withSite(fn) {
  const root = mkdtempSync(join(tmpdir(), 'ada-render-'));
  try {
    for (const [rel, body] of Object.entries(FILES)) { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), body); }
    return await fn(root);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

// A one-line live DOM, as a built Paradox page is served: layout markers do not survive, only the elements.
const LIVE = '<!doctype html><html lang="en"><head><title>t</title></head><body><header><ul role="list" class="nav-list"><li><a href="/a">A</a></li></ul></header><main id="main"><button class="btn-primary" type="button"><span id="dup">Go</span><span id="dup">x</span></button></main><footer><p class="legal-note">x</p></footer></body></html>';

const unified = (v) => ({ ruleId: v.rule, layer: 'htmlValidate', impact: 'minor', element: { outerHTML: v.html, selector: v.selector }, fix: { hint: v.description }, source: { mode: 'url', file: 'src/pages/index.liquid', line: null, confidence: 'low', method: 'url-fallback' } });
const at = (v) => `${v.source.file}:${v.source.line}`;

test('html-validate on a one-line live DOM reports the element start tag, not the whole line', async () => {
  const found = await validateHtml(LIVE);
  const role = found.find((v) => v.rule === 'html-validate:no-redundant-role');
  assert.equal(role.html, '<ul role="list" class="nav-list">');
  assert.equal(found.find((v) => v.rule === 'html-validate:no-dup-id').html, '<span id="dup">');
});

test('html-validate rows trace to the layout partial and the component that rendered the element, not src/pages/<page>.liquid', async () => {
  await withSite(async (root) => {
    const found = (await validateHtml(LIVE)).map(unified);
    const role = found.find((v) => v.ruleId === 'html-validate:no-redundant-role');
    const dup = found.find((v) => v.ruleId === 'html-validate:no-dup-id');
    await traceToPartials([role, dup], 'http://127.0.0.1:1/', root);
    assert.equal(at(role), 'src/partials/layout/header.liquid:2');
    // the validator reports the second duplicate (`span:nth-child(2)`): the component's second span, not the first tied one
    assert.equal(at(dup), 'src/components/button.liquid:3');
  });
});

test('shared layout root cause: the same header defect on three pages is one sharedSource group at the partial line', async () => {
  await withSite(async (root) => {
    const pages = [];
    for (const route of ['/', '/about', '/jobs']) {
      const role = unified((await validateHtml(LIVE)).find((v) => v.rule === 'html-validate:no-redundant-role'));
      await traceToPartials([role], `http://127.0.0.1:1${route}`, root);
      pages.push({ page: route, url: `https://example.test${route}`, scannerRuns: [{ layer: 'htmlValidate', engine: { name: 'html-validate', version: '1' }, status: 'complete' }], violations: [role] });
    }
    const report = buildScanReportV2(pages, { generatedAt: '2026-07-15T00:00:00.000Z', producer: { name: 'ada-scan', version: '1.0.1' }, target: { mode: 'url-only', url: 'https://example.test/' } });
    const findings = report.pages.flatMap((p) => p.findings);
    assert.deepEqual(findings.map((f) => `${f.source.file}:${f.source.line}`), Array(3).fill('src/partials/layout/header.liquid:2'));
    assert.equal(new Set(findings.map((f) => f.sharedSource?.id)).size, 1);
    assert.ok(findings.every((f) => f.sharedSource.pages === 3));
  });
});

test('locateCssRule finds the single source rule for a selector, also inside a selector list; ambiguous or absent selectors stay unlocated', async () => {
  await withSite(async (root) => {
    assert.deepEqual(locateCssRule(root, '.icon-link'), { file: 'src/styles/site.css', line: 3 });
    assert.equal(locateCssRule(root, '.icon-link-alt'), null, 'declared in two files: ambiguous');
    assert.equal(locateCssRule(root, '.p-1'), null, 'utility class: no source rule');
  });
});

test('applyCssOrigins re-points a target-size finding at the CSS rule and keeps the markup location; no rule keeps the markup', async () => {
  await withSite(async (root) => {
    const mk = (cssRule) => ({ ruleId: 'target-size', cssRule, source: { file: 'src/partials/layout/header.liquid', line: 3, confidence: 'medium', method: 'source-hint-search' } });
    const hit = mk({ selectorText: '.icon-link' });
    const miss = mk({ selectorText: '.p-1' });
    applyCssOrigins([hit, miss], root);
    assert.deepEqual([hit.source.file, hit.source.line, hit.source.method, hit.source.markupFile, hit.source.markupLine], ['src/styles/site.css', 3, 'css-rule', 'src/partials/layout/header.liquid', 3]);
    assert.deepEqual([miss.source.file, miss.source.line], ['src/partials/layout/header.liquid', 3]);
    assert.ok(isSizeRule('target-size') && isSizeRule('TargetSize') && !isSizeRule('color-contrast'));
  });
});

test('applyCssOrigins: a src rule with only a colour override or a vendor-sheet winner stays on the markup; a src rule declaring width still re-points', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-render-'));
  try {
    mkdirSync(join(root, 'src/styles'), { recursive: true });
    writeFileSync(join(root, 'src/styles/site.css'), '.btn { color: red; }\n\n.wide {\n  width: 40px;\n}\n');
    const markup = { file: 'src/partials/layout/header.liquid', line: 3, confidence: 'medium', method: 'source-hint-search' };
    const mk = (cssRule) => ({ ruleId: 'target-size', cssRule, source: { ...markup } });
    const vendor = mk({ selectorText: '.btn', href: 'http://x/vendor/bootstrap.css', external: true });
    const nearMiss = mk({ selectorText: '.btn', href: null });
    const external = mk({ selectorText: '.wide', href: 'http://x/vendor/bootstrap.css', external: true });
    const own = mk({ selectorText: '.wide', href: null });
    applyCssOrigins([vendor, nearMiss, external, own], root);
    for (const v of [vendor, nearMiss, external]) assert.deepEqual([v.source.file, v.source.line, v.source.method], [markup.file, 3, 'source-hint-search']);
    assert.deepEqual([own.source.file, own.source.line, own.source.method], ['src/styles/site.css', 3, 'css-rule']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('collectCssRules reads the winning size rule from the live page (higher specificity wins; a rule without size props is ignored)', { timeout: 120_000 }, async () => {
  const css = '.icon-link { width: 10px; height: 10px; }\nnav .icon-link { width: 12px; }\n.icon-link { color: red; }\n.other { width: 99px; }\n';
  const site = await startParadoxSite({ routes: {
    '/p': (req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><html lang="en"><title>t</title><link rel="stylesheet" href="/s.css"><nav><a class="icon-link" href="/x" aria-label="x"></a></nav><a class="plain" href="/y">y</a>'),
    '/s.css': (req, res) => res.writeHead(200, { 'content-type': 'text/css' }).end(css),
  } });
  try {
    const browser = await getBrowser();
    const { page, close } = await newPage(browser).then((p) => ({ page: p.page || p, close: async () => (p.context || p).close?.() }));
    try {
      await page.goto(`${site.url}/p`);
      const [hit, none] = await collectCssRules(page, ['a.icon-link', 'a.plain']);
      assert.equal(hit.selectorText, 'nav .icon-link');
      assert.deepEqual(hit.candidates.map((c) => c.selectorText), ['nav .icon-link', '.icon-link'], 'every size-declaring rule, cascade order');
      assert.ok(hit.href.endsWith('/s.css'));
      assert.equal(none, null);
    } finally { await close(); }
  } finally { await site.close(); }
});
