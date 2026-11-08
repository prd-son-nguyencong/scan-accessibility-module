import './helpers/hermetic-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { traceToPartials } from '../src/index.js';
import { scanHtmlValidate, htmlValidateKind } from '../src/scanner/html-validate.js';

// Two pages whose partials hold look-alike markup. Line numbers are hand-counted from the FILES table below.
const HERO = '<section class="hero">\n  <h1 class="hero-title">Join our team</h1>\n  <a class="hero-cta" href="/apply-now">Apply now</a>\n</section>\n';
const page = (name) => `{% layout "layout" %}\n{% block content %}\n<main id="main">\n{% render "${name}/hero" %}\n</main>\n{% endblock %}\n`;
const FILES = {
  'dist/scan-manifest.json': '{}',
  'src/layouts/layout.liquid': '<!doctype html>\n<html lang="en">\n<head><title>t</title></head>\n<body>\n{% block content %}{% endblock %}\n</body></html>\n',
  'src/pages/index.liquid': page('index'),
  'src/pages/careers.liquid': page('careers'),
  'src/pages/dyn.liquid': '{% layout "layout" %}\n{% block content %}\n<main id="main">\n{% assign p = "careers/hero" %}{% render p %}\n</main>\n{% endblock %}\n',
  'src/partials/index/hero.liquid': HERO,
  'src/partials/careers/hero.liquid': HERO,
  'src/partials/unused/hero.liquid': HERO, // look-alike that no page renders
  'src/layouts/alt.liquid': '<!doctype html>\n<html lang="en">\n<body>\n{% render "chrome/nav" %}\n{% block content %}{% endblock %}\n</body></html>\n',
  'src/pages/alt.liquid': '{% layout "alt" %}\n{% block content %}\n<main id="main">x</main>\n{% endblock %}\n',
  'src/partials/chrome/nav.liquid': '<div class="top-menu-wrap">\n  <a class="top-menu-link" href="/a">A</a>\n</div>\n',
  'src/partials/other/nav.liquid': '<div class="top-menu-wrap">\n  <a class="top-menu-link" href="/a">A</a>\n</div>\n',
  'src/partials/careers/hero.liquid.json': '{\n  "cta": {\n    "href": "/apply-now",\n    "label": "Apply now"\n  }\n}\n',
};

async function withSite(fn) {
  const root = mkdtempSync(join(tmpdir(), 'ada-attr-'));
  try {
    for (const [rel, body] of Object.entries(FILES)) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), body);
    }
    return await fn(root);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

const finding = (rule, outerHTML, source) => ({ rule, element: { outerHTML, selector: 'x' }, source: { mode: 'url', confidence: 'medium', ...source } });
const at = (v) => `${v.source.file}:${v.source.line}`;
const H1 = '<h1 class="hero-title">Join our team</h1>';

test('look-alike markup resolves to the partial rendered on the scanned page, whatever a legacy search guessed', async () => {
  await withSite(async (root) => {
    // Wrong guess: the other page's partial (what a global dist/partials search returns).
    const careers = finding('empty-heading', H1, { file: 'src/partials/index/hero.liquid', line: 2, method: 'partial-file-search' });
    const index = finding('empty-heading', H1, { file: 'src/partials/careers/hero.liquid', line: 2, method: 'partial-file-search' });
    await traceToPartials([careers], 'http://127.0.0.1:1/careers', root);
    await traceToPartials([index], 'http://127.0.0.1:1/', root);
    assert.equal(at(careers), 'src/partials/careers/hero.liquid:2');
    assert.equal(at(index), 'src/partials/index/hero.liquid:2');
    // Unattributed: the hint search may only look inside the page's own render.
    const bare = finding('empty-heading', H1, { file: 'unknown', line: null });
    await traceToPartials([bare], 'http://127.0.0.1:1/careers', root);
    assert.equal(bare.source.file, 'src/partials/careers/hero.liquid');
  });
});

test('control: a partial that the page does render is kept', async () => {
  await withSite(async (root) => {
    const v = finding('empty-heading', H1, { file: 'src/partials/careers/hero.liquid', line: 2, method: 'instrumentation-manifest', confidence: 'high' });
    await traceToPartials([v], 'http://127.0.0.1:1/careers', root);
    assert.equal(at(v), 'src/partials/careers/hero.liquid:2');
  });
});

test('page-level defects resolve to the page file; an element that lives in the layout stays there', async () => {
  await withSite(async (root) => {
    const main = finding('landmark-one-main', '<html lang="en">', { file: 'src/layouts/layout.liquid', line: 2, method: 'source-hint-search' });
    const h1 = finding('page-has-heading-one', '', { file: 'unknown', line: null });
    const title = finding('document-title', '<title>t</title>', { file: 'src/layouts/layout.liquid', line: 3, method: 'source-hint-search' });
    await traceToPartials([main, h1, title], 'http://127.0.0.1:1/careers', root);
    assert.equal(at(main), 'src/pages/careers.liquid:3'); // the <main> line of the page
    assert.equal(at(h1), 'src/pages/careers.liquid:3');
    assert.equal(at(title), 'src/layouts/layout.liquid:3'); // <title> is written in the layout
  });
});

test('link findings carry the sidecar line where the href is authored; a value absent from every sidecar gets none', async () => {
  await withSite(async (root) => {
    const link = finding('link-name', '<a class="hero-cta" href="/apply-now">Apply now</a>', { file: 'src/partials/careers/hero.liquid', line: 3, method: 'instrumentation-manifest', confidence: 'high' });
    const other = finding('link-name', '<a class="hero-cta" href="/elsewhere">Elsewhere</a>', { file: 'src/partials/careers/hero.liquid', line: 3, method: 'instrumentation-manifest', confidence: 'high' });
    await traceToPartials([link, other], 'http://127.0.0.1:1/careers', root);
    assert.equal(link.source.dataFile, 'src/partials/careers/hero.liquid.json');
    assert.equal(link.source.dataLine, 3);
    assert.equal(other.source.dataFile, undefined);
  });
});

test('html-validate validates the live DOM it was handed and records that; populated template data is kept', async () => {
  const live = '<!DOCTYPE html>\n<html lang="en"><head><meta charset="utf-8"><title>t</title></head><body>\n<div id="a"><img src="/real-hero.png" alt=""></div>\n<div id="a">y</div>\n</body></html>';
  let reads = 0;
  const r = await scanHtmlValidate('http://127.0.0.1:1/x', {}, { page: { content: async () => { reads += 1; return live; } } });
  assert.equal(reads, 1); // the page's own serialized DOM, not dist/*.html
  assert.equal(r.htmlSource, 'live-dom');
  const dup = r.violations.find((v) => v.rule === 'html-validate:no-dup-id');
  assert.ok(dup, 'duplicate id fires on populated markup');
  assert.equal(dup.line, 4);
});

test('a finding on HTML that is not the live render is never confirmed; verdict ignores trace confidence', () => {
  assert.equal(htmlValidateKind('live-dom', 'error'), undefined); // stays confirmed whatever source.confidence says
  assert.equal(htmlValidateKind('live-dom', 'warning'), 'heuristic');
  assert.equal(htmlValidateKind('built-dist', 'error'), 'heuristic');
});

// Real rule ids per layer: axe + lighthouse 'skip-link' / 'bypass' / 'region', keyboard 'skip-link-missing', access-scan RegionMainContent*.
const SKIP = '<a class="skip" href="#main">Skip to content</a>';
// region / RegionMainContent* report an element outside a landmark; only a document-level report (<body>) is the page's defect.
for (const [rule, html] of [['skip-link', SKIP], ['bypass', SKIP], ['skip-link-missing', SKIP], ['region', '<body class="x">'], ['RegionMainContentSingle', '<body class="x">']]) {
  test(`${rule}: the page defect resolves to the page's <main>, not the layout`, async () => {
    await withSite(async (root) => {
      const v = finding(rule, html, { file: 'src/layouts/layout.liquid', line: 5, method: 'source-hint-search' });
      await traceToPartials([v], 'http://127.0.0.1:1/careers', root);
      assert.equal(at(v), 'src/pages/careers.liquid:3');
    });
  });
}

test('control: a non-structural rule, and a region finding on a layout element, stay in the layout', async () => {
  await withSite(async (root) => {
    const v = finding('link-name', SKIP, { file: 'src/layouts/layout.liquid', line: 5, method: 'instrumentation-manifest', confidence: 'high' });
    await traceToPartials([v], 'http://127.0.0.1:1/careers', root);
    assert.equal(at(v), 'src/layouts/layout.liquid:5');
    const region = finding('region', SKIP, { file: 'src/layouts/layout.liquid', line: 5, method: 'instrumentation-manifest', confidence: 'high' });
    await traceToPartials([region], 'http://127.0.0.1:1/careers', root);
    assert.equal(at(region), 'src/layouts/layout.liquid:5');
  });
});

test('a build-proven partial attribution survives a dynamic render name; a heuristic one outside the static tree does not', async () => {
  await withSite(async (root) => {
    const proven = finding('empty-heading', H1, { file: 'src/partials/careers/hero.liquid', line: 2, method: 'instrumentation-manifest', confidence: 'high' });
    const guessed = finding('empty-heading', H1, { file: 'src/partials/careers/hero.liquid', line: 2, method: 'partial-file-search' });
    await traceToPartials([proven, guessed], 'http://127.0.0.1:1/dyn', root);
    assert.equal(at(proven), 'src/partials/careers/hero.liquid:2');
    assert.equal(proven.source.method, 'instrumentation-manifest');
    assert.notEqual(guessed.source.file, 'src/partials/careers/hero.liquid');
  });
});

test('a manifest owner in a partial no page renders is dropped on a static page, the rendered look-alike wins; a page with a dynamic render keeps it (paired)', async () => {
  await withSite(async (root) => {
    const stat = finding('empty-heading', H1, { file: 'src/partials/unused/hero.liquid', line: 2, method: 'instrumentation-manifest', confidence: 'high' });
    await traceToPartials([stat], 'http://127.0.0.1:1/careers', root);
    assert.equal(at(stat), 'src/partials/careers/hero.liquid:2');
    const dyn = finding('empty-heading', H1, { file: 'src/partials/unused/hero.liquid', line: 2, method: 'instrumentation-manifest', confidence: 'high' });
    await traceToPartials([dyn], 'http://127.0.0.1:1/dyn', root);
    assert.equal(at(dyn), 'src/partials/unused/hero.liquid:2');
  });
});

test("a page that declares its own layout resolves partial candidates from that layout's render set, not the default layout's (paired)", async () => {
  await withSite(async (root) => {
    const NAV = '<div class="top-menu-wrap">';
    const alt = finding('region', NAV, { file: 'unknown', line: null, confidence: 'none', method: 'unresolved' });
    await traceToPartials([alt], 'http://127.0.0.1:1/alt', root);
    assert.equal(at(alt), 'src/partials/chrome/nav.liquid:1');
    // The same markup on a page using the default layout is in no render set: nothing is claimed from another layout's partial.
    const dflt = finding('region', NAV, { file: 'unknown', line: null, confidence: 'none', method: 'unresolved' });
    await traceToPartials([dflt], 'http://127.0.0.1:1/careers', root);
    assert.ok(!/chrome\/nav|other\/nav/.test(dflt.source.file || ''));
  });
});

test('hint search prefers live markup over a commented-out copy; a comment-only hit still resolves', async () => {
  const SHARE = '<!-- <div class="share-list" aria-label="Share this job">\n  <a href="/x">x</a>\n</div> -->\n<section>\n  <div class="share-list" aria-label="Share this job"><a href="/y">y</a></div>\n</section>\n';
  const root = mkdtempSync(join(tmpdir(), 'ada-attr-'));
  try {
    const files = { ...FILES, 'src/partials/careers/hero.liquid': SHARE, 'src/partials/careers/ghost.liquid': '<!-- <p class="only-ghost-copy">gone</p> -->\n' };
    files['src/pages/careers.liquid'] = page('careers').replace('</main>', '{% render "careers/ghost" %}\n</main>');
    for (const [rel, body] of Object.entries(files)) { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), body); }
    const live = finding('aria-prohibited-attr', '<div class="share-list" aria-label="Share this job"><a href="/y">y</a></div>', { file: 'unknown', line: null });
    const ghost = finding('aria-prohibited-attr', '<p class="only-ghost-copy" aria-label="gone">gone</p>', { file: 'unknown', line: null });
    await traceToPartials([live, ghost], 'http://127.0.0.1:1/careers', root);
    assert.equal(at(live), 'src/partials/careers/hero.liquid:5'); // not the commented copy at line 1
    assert.equal(at(ghost), 'src/partials/careers/ghost.liquid:1'); // paired: only a commented copy exists, still located
  } finally { rmSync(root, { recursive: true, force: true }); }
});
