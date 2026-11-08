import './helpers/hermetic-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { traceElement } from '../src/tracer/trace-element.js';

const BASE = {
  'src/layouts/layout.liquid': '<!doctype html>\n<html lang="en">\n<body>\n{% render "layout/header" %}\n{% block content %}{% endblock %}\n</body></html>\n',
  'src/layouts/job.liquid': '<!doctype html>\n<html lang="en">\n<body>\n{% render "layout/header" %}\n{% block content %}{% endblock %}\n</body></html>\n',
  'src/partials/layout/header.liquid': '<header class="site-header">\n  <a href="/">Home</a>\n</header>\n',
  'src/pages/index.liquid': '{% layout "layout" %}\n{% block content %}\n<main id="main">x</main>\n{% endblock %}\n',
  'src/pages/about.liquid': '{% layout "layout" %}\n{% block content %}\n<main id="main">a</main>\n{% endblock %}\n',
  'src/pages/job.liquid': '{% layout "job" %}\n{% block content %}\n<main id="main">j</main>\n{% endblock %}\n',
};
function withSite(files, fn) {
  const root = mkdtempSync(join(tmpdir(), 'ada-skip-home-'));
  try {
    for (const [rel, body] of Object.entries(files)) { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), body); }
    return fn(root);
  } finally { rmSync(root, { recursive: true, force: true }); }
}
const trace = (root, ruleId, pageFile = 'src/pages/index.liquid') => traceElement({ root, pageFile, mode: 'local', outerHTML: '', ruleId });
const at = (c) => `${c.file}:${c.line}`;

test('skip-link-missing: the fix belongs in the header every page layout renders; the page <main> stays a secondary candidate', () => {
  withSite(BASE, (root) => {
    const r = trace(root, 'skip-link-missing');
    assert.deepEqual(r.candidates.map(at), ['src/partials/layout/header.liquid:1', 'src/pages/index.liquid:3']);
  });
});

test('skip-link-missing: a layout that does not render the header, or a rule with an element, keeps the page anchor only (paired)', () => {
  withSite({ ...BASE, 'src/layouts/job.liquid': '<!doctype html>\n<html lang="en">\n<body>\n{% block content %}{% endblock %}\n</body></html>\n' }, (root) => {
    assert.deepEqual(trace(root, 'skip-link-missing').candidates.map(at), ['src/pages/index.liquid:3']);
  });
  withSite(BASE, (root) => {
    assert.deepEqual(trace(root, 'skip-link-target-missing').candidates.map(at), ['src/pages/index.liquid:3'], 'a skip link that exists but has no target is a page defect');
  });
});

test('skip-link-missing: no header partial but one layout for every page points at the layout body', () => {
  const files = { ...BASE };
  delete files['src/partials/layout/header.liquid'];
  delete files['src/pages/job.liquid'];
  withSite(files, (root) => {
    assert.equal(at(trace(root, 'skip-link-missing').candidates[0]), 'src/layouts/layout.liquid:3');
  });
});

test('/404 and /500 shells keep the skip-link finding, as needs-review with the error-page note; a normal route keeps its verdict (paired)', async () => {
  const { downgradeErrorPage, ERROR_PAGE_NOTE } = await import('../src/scanner/origin.js');
  const mk = () => [{ ruleId: 'skip-link-missing', layer: 'keyboard', verdict: 'confirmed', fix: { hint: 'No skip navigation link' } }, { ruleId: 'bypass', layer: 'axe', verdict: 'confirmed', fix: { hint: 'x' } }];
  for (const route of ['/404', '/500']) {
    const rows = downgradeErrorPage(mk(), `http://127.0.0.1:1${route}`, ['/404', '/500']);
    assert.equal(rows.length, 2, 'findings are kept, not dropped');
    for (const r of rows) { assert.equal(r.verdict, 'needs-review', route); assert.ok(r.fix.hint.includes(ERROR_PAGE_NOTE), route); }
  }
  assert.deepEqual(downgradeErrorPage(mk(), 'http://127.0.0.1:1/about', ['/404', '/500']).map((r) => r.verdict), ['confirmed', 'confirmed']);
});
