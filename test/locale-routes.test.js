import './helpers/hermetic-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { selectChangedPages, traceToPartials } from '../src/index.js';
import { urlToPageFile } from '../src/utils/paths.js';
import { loadProjectRoutes } from '../src/scanner/links.js';

// A site with a locale dir: pages/ and pages/xx/ share the layout and its footer partial; xx text is translated at run time.
const FOOTER = '<footer class="c-foot">\n  <ul class="c-foot__links">\n    <li><a href="https://example.org/history" target="_blank" rel="noopener noreferrer" aria-label=\'_translate("History opens in a new tab")\'>_translate("History")</a></li>\n    <li><a href="https://example.org/team" target="_blank" aria-label=\'_translate("Team opens in a new tab")\'>_translate("Team")</a></li>\n    <li><a href="https://example.org/team" target="_blank" aria-label=\'_translate("Team page opens in a new tab")\'>_translate("Team page")</a></li>\n  </ul>\n</footer>\n';
const page = (name) => `{% layout "layout" %}\n{% block content %}\n<main id="main">\n{% render "${name}/hero" %}\n</main>\n{% endblock %}\n`;
const FILES = {
  'dist/scan-manifest.json': '{}',
  'src/layouts/layout.liquid': '<!doctype html>\n<html lang="en">\n<head><title>t</title></head>\n<body>\n{% block content %}{% endblock %}\n{% render "layout/footer" %}\n</body></html>\n',
  'src/partials/layout/footer.liquid': FOOTER,
  'src/pages/index.liquid': page('index'),
  'src/pages/about.liquid': page('about'),
  'src/pages/xx/index.liquid': page('xx'),
  'src/pages/xx/about.liquid': page('xx-about'),
  'src/partials/index/hero.liquid': '<h1 class="hero-title">Join</h1>\n',
  'src/partials/xx/hero.liquid': '<h1 class="hero-title">Unisciti</h1>\n',
  'src/partials/xx-about/hero.liquid': '<h1 class="hero-title">Chi siamo</h1>\n',
  'src/partials/about/hero.liquid': '<h1 class="hero-title">About</h1>\n',
};
async function withSite(fn) {
  const root = mkdtempSync(join(tmpdir(), 'ada-locale-'));
  try {
    for (const [rel, body] of Object.entries(FILES)) { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), body); }
    return await fn(root);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test('route to template: index.liquid in a subdir is the dir route, subdir/x.liquid is /subdir/x', async () => {
  await withSite(async (root) => {
    const f = (p) => urlToPageFile(p, { root });
    assert.equal(f('/'), 'src/pages/index.liquid');
    assert.equal(f('/xx'), 'src/pages/xx/index.liquid');
    assert.equal(f('/xx/'), 'src/pages/xx/index.liquid');
    assert.equal(f('/xx/index'), 'src/pages/xx/index.liquid');
    assert.equal(f('/xx/about'), 'src/pages/xx/about.liquid');
    assert.equal(f('/about'), 'src/pages/about.liquid');
    assert.equal(f('/nope'), 'src/pages/nope.liquid', 'unknown routes keep the flat guess');
    assert.deepEqual([...loadProjectRoutes(root)].sort(), ['/', '/about', '/xx', '/xx/about']);
    const pages = [{ path: '/' }, { path: '/xx' }, { path: '/xx/about' }];
    assert.deepEqual(selectChangedPages(pages, ['src/pages/xx/index.liquid']).pages, [{ path: '/xx' }]);
  });
});

const a = (label, text, href = 'https://example.org/history') => ({ rule: 'label-content-name-mismatch', layer: 'lighthouse', element: { outerHTML: `<a href="${href}" target="_blank" rel="noopener noreferrer" aria-label="${label}">${text}</a>`, selector: 'x' }, source: { mode: 'url', confidence: 'none', method: 'unresolved' } });
const at = (v) => `${v.source.file}:${v.source.line}`;

test('a shared partial resolves on every locale route, in the template language and in the live (translated) one', async () => {
  await withSite(async (root) => {
    for (const route of ['/', '/about', '/xx', '/xx/about']) {
      for (const [label, text] of [['History opens in a new tab', 'History'], ['Storia si apre in una nuova scheda', 'Storia']]) {
        const v = a(label, text);
        await traceToPartials([v], `http://127.0.0.1:1${route}`, root);
        assert.equal(at(v), 'src/partials/layout/footer.liquid:3', `${route} ${text}`);
      }
      // the same href on two lines: the shared file is named, no line is invented
      const dup = a('Squadra si apre in una nuova scheda', 'Squadra', 'https://example.org/team');
      await traceToPartials([dup], `http://127.0.0.1:1${route}`, root);
      assert.equal(dup.source.file, 'src/partials/layout/footer.liquid', route);
    }
  });
});

test('page-level fallback names the real template of a locale route', async () => {
  await withSite(async (root) => {
    const v = { rule: 'html-lang-valid', element: { outerHTML: '<html lang="it">', selector: 'html' }, source: { mode: 'url', confidence: 'none', file: 'unknown', line: null, method: 'unresolved' } };
    await traceToPartials([v], 'http://127.0.0.1:1/xx', root);
    const root0 = { ...v, source: { ...v.source, file: 'unknown', line: null }, element: { ...v.element } };
    await traceToPartials([root0], 'http://127.0.0.1:1/', root);
    assert.equal(v.source.page, 'src/pages/xx/index.liquid', 'the page is the real template, not src/pages/xx.liquid');
    assert.equal(v.source.file, root0.source.file, 'resolved like the root route (the layout that holds <html>)');
  });
});
