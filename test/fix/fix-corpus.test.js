// The seeded-fault corpus itself: manifest accuracy (file:line, anchors, edits), required coverage, and static properties of the
// good and the tempting wrong fixes. The gates are exercised live by `node scripts/fix-benchmark.js --runner foundation`.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CORPUS_DIR, applyManifestEdits, loadManifest, renderCorpusSite } from '../../scripts/lib/fix-corpus.js';

const work = mkdtempSync(join(tmpdir(), 'fix-corpus-'));
after(() => rmSync(work, { recursive: true, force: true }));
const manifest = loadManifest();
const copy = (s) => { const d = mkdtempSync(join(work, 'c-')); cpSync(join(CORPUS_DIR, s.dir), d, { recursive: true }); return d; };
const render = (root) => { const out = mkdtempSync(join(work, 'r-')); renderCorpusSite(join(root, 'src'), out); return readFileSync(join(out, 'index.html'), 'utf8'); };
const all = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? all(join(dir, e.name)) : [join(dir, e.name)]));

test('corpus has at least 6 sites and covers the required rules and wrong-fix kinds', () => {
  assert.ok(manifest.sites.length >= 6);
  const rules = new Set(manifest.sites.flatMap((s) => s.defects.map((d) => d.rule)));
  for (const r of ['button-name', 'meta-viewport', 'landmark-unique', 'skip-link-missing', 'disclosure-missing-aria-expanded', 'duplicate-id-referenced', 'label-content-name-mismatch', 'image-alt', 'label', 'heading-order', 'target-size', 'focus-indicator-removed']) assert.ok(rules.has(r), `rule ${r}`);
  const kinds = new Set(manifest.sites.flatMap((s) => s.wrongFixes.map((w) => w.kind)));
  for (const k of ['change-colour', 'remove-element', 'hard-code-id-in-loop', 'strip-data-pdk', 'aria-hidden-focusable', 'skip-link-display-none', 'padding-layout-shift', 'heavy-script']) assert.ok(kinds.has(k), `wrong fix ${k}`);
  for (const w of manifest.sites.flatMap((s) => s.wrongFixes)) assert.ok(w.expect.length && w.why);
});

test('every defect points at its file:line, and every good and wrong edit applies exactly once', () => {
  for (const s of manifest.sites) {
    const files = readdirSync(join(CORPUS_DIR, s.dir, 'src/pages')).filter((f) => f.endsWith('.liquid'));
    assert.ok(files.length && files.every((f) => statSync(join(CORPUS_DIR, s.dir, 'src/pages', `${f}.json`)).isFile()), `${s.id}: page sidecar`);
    for (const d of s.defects) {
      const lines = readFileSync(join(CORPUS_DIR, s.dir, d.file), 'utf8').split('\n');
      assert.ok(lines[d.line - 1].includes(d.anchor), `${d.id}: line ${d.line}`);
      assert.ok(d.scope.file === d.file && (d.scope.startLine == null || (d.scope.startLine <= d.line && d.scope.endLine >= d.line)), d.id);
      assert.ok(d.expectedFix ? d.expectedFix.edits.length > 0 : d.remaining === 'needs_design_decision', d.id);
      if (d.expectedFix) applyManifestEdits(copy(s), d.expectedFix.edits);
    }
    for (const w of s.wrongFixes) {
      assert.ok(s.defects.some((d) => d.id === w.defect), w.id);
      applyManifestEdits(copy(s), w.edits);
    }
  }
});

test('corpus text is neutral and free of em and en dashes', () => {
  for (const f of [join(CORPUS_DIR, 'manifest.json'), ...all(join(CORPUS_DIR, 'sites'))]) assert.ok(!/[\u2013\u2014]/.test(readFileSync(f, 'utf8')), f);
});

test('every site renders with the static tooling; backend tags stay literal and loops expand', () => {
  for (const s of manifest.sites) {
    const html = render(join(CORPUS_DIR, s.dir));
    assert.ok(/<h1>/.test(html), s.id);
    assert.ok(!/\{%/.test(html), `${s.id}: unexpanded liquid tag`);
    assert.ok(!/\{\{\s*[\w.]+\s*\}\}/.test(html), `${s.id}: unexpanded variable`);
  }
  assert.match(render(join(CORPUS_DIR, 'sites/orchard-nav')), /\{\{data:site\.name\}\}/);
});

test('duplicate-id defect: the loop renders duplicate ids; the good fix makes them unique; the tempting fix does not', () => {
  const s = manifest.sites.find((x) => x.id === 'meadow-loops');
  const ids = (html) => [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
  const dup = (a) => a.length !== new Set(a).size;
  assert.ok(dup(ids(render(join(CORPUS_DIR, s.dir)))), 'seeded defect');
  const good = copy(s); applyManifestEdits(good, s.defects[0].expectedFix.edits);
  assert.ok(!dup(ids(render(good))));
  const bad = copy(s); applyManifestEdits(bad, s.wrongFixes[0].edits);
  assert.ok(dup(ids(render(bad))), 'hard-coded id in a loop stays duplicated');
});

test('tempting fixes do what they claim (static view)', () => {
  const find = (id) => manifest.sites.flatMap((s) => s.wrongFixes.map((w) => [s, w])).find(([, w]) => w.id === id);
  const apply = (id) => { const [s, w] = find(id); const r = copy(s); const files = applyManifestEdits(r, w.edits); return [r, files]; };
  let [, files] = apply('orchard-remove-button');
  assert.ok(!/menu-btn/.test(files['src/partials/header.liquid'].split('\n').filter((l) => l.includes('<button')).join('')));
  [, files] = apply('orchard-aria-hidden-button');
  assert.match(files['src/partials/header.liquid'], /<button[^>]*aria-hidden="true"/);
  [, files] = apply('lantern-strip-pdk');
  assert.ok(!/data-pdk-field/.test(files['src/pages/index.liquid']) && /data-pdk-form/.test(files['src/pages/index.liquid']));
  [, files] = apply('willow-skip-display-none');
  assert.match(files['src/styles/site.css'], /\.skip-link \{[^}]*display: none/);
  [, files] = apply('willow-colour-change');
  assert.match(files['src/styles/site.css'], /color: #555/);
  [, files] = apply('orchard-heavy-script');
  assert.match(files['src/partials/header.liquid'], /<script>for \(var t = Date\.now\(\)/);
  [, files] = apply('quarry-widen-padding');
  assert.match(files['src/styles/site.css'], /\.social-link \{[^}]*padding: 12px/);
});
