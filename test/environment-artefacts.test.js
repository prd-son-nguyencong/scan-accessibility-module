import './helpers/hermetic-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { applyEnvironmentArtefacts, PLATFORM_ASSET_REASON } from '../src/scanner/unresolved-text.js';

function project() {
  const root = mkdtempSync(path.join(tmpdir(), 'env-art-'));
  spawnSync('git', ['init', '-q'], { cwd: root });
  writeFileSync(path.join(root, '.gitignore'), 'public/\n');
  mkdirSync(path.join(root, 'src/partials'), { recursive: true });
  writeFileSync(path.join(root, 'src/partials/nav.liquid'), '{% for child in item.children %}\n<a href="{{ child.link }}">{{ child.label }}</a>\n<a href="index.html">Home</a>\n{% endfor %}\n');
  mkdirSync(path.join(root, 'src/assets'));
  return root;
}
const link = (href, rule = 'broken-link', line = 2) => ({
  ruleId: rule, layer: 'links', verdict: 'confirmed', kind: 'deterministic', origin: { owner: 'site', kind: 'site-source', label: 'Site source', evidence: [] },
  element: { outerHTML: `<a href="${href}">`, selector: `a[href="${href}"]` }, source: { file: 'src/partials/nav.liquid', line },
  evidence: { proof: { type: 'http-status', fact: 'HTTP 404' } },
});
const asset = (p) => ({
  ruleId: 'dead-link-404', layer: 'links', verdict: 'confirmed', kind: 'deterministic', origin: { owner: 'site', kind: 'site-source', label: 'Site source', evidence: [] },
  element: { outerHTML: `<img src="${p}" alt="">`, selector: 'img' }, linkTarget: { url: `http://127.0.0.1:6215${p}`, status: 404, reason: null },
});

test('a href that is a template binding printed at the traced line is unbound-data needs-review; a real file-like href is untouched', () => {
  const root = project();
  try {
    const bound = link('child.link');
    const residue = { ...link('{{ x }}', 'empty-link'), layer: 'htmlValidate' };
    const real = link('index.html', 'broken-link', 3);
    assert.equal(applyEnvironmentArtefacts([bound, residue, real], { root }), 2);
    for (const v of [bound, residue]) assert.deepEqual([v.verdict, v.origin.kind], ['needs-review', 'unbound-data']);
    assert.equal(real.verdict, 'confirmed');
    const far = link('child.link', 'broken-link', 40);
    assert.equal(applyEnvironmentArtefacts([far], { root }), 0, 'binding not printed near the traced line');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('404 on a gitignored absent asset is platform-owned needs-review; a tracked or non-ignored path stays confirmed', () => {
  const root = project();
  try {
    const hosted = asset('/brand-logo.webp');
    const missing = asset('/src-missing.png');
    // not ignored: neither public/ nor the root-relative path matches in a repo that ignores only public/ ... but "/x.png" maps to public/x.png, which is ignored
    assert.equal(applyEnvironmentArtefacts([hosted], { root }), 1);
    assert.deepEqual([hosted.verdict, hosted.origin.owner, hosted.linkTarget.reason], ['needs-review', 'platform', PLATFORM_ASSET_REASON]);
    writeFileSync(path.join(root, '.gitignore'), 'nothing-ignored\n');
    assert.equal(applyEnvironmentArtefacts([missing], { root }), 0);
    assert.equal(missing.verdict, 'confirmed');
    const outside = mkdtempSync(path.join(tmpdir(), 'env-nogit-'));
    try { assert.equal(applyEnvironmentArtefacts([asset('/a.png')], { root: outside }), 0, 'not a git repo: unknown, kept'); } finally { rmSync(outside, { recursive: true, force: true }); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('label-in-name row whose visible text is the alt of a gitignored broken image is needs-review; a loaded image keeps it', () => {
  const root = project();
  try {
    const row = (src) => ({
      ruleId: 'VisibleTextPartOfAccessibleName', layer: 'accessScan', verdict: 'confirmed', kind: 'deterministic',
      element: { outerHTML: `<a href="/" aria-label="Home"><img src="${src}" alt="Acme University"></a>` }, evidence: { visibleText: 'Acme University', accessibleName: 'Home', proof: { type: 'name-vs-text', fact: 'x' } },
    });
    const broken = row('/logo.webp');
    assert.equal(applyEnvironmentArtefacts([broken], { root }), 1);
    assert.equal(broken.verdict, 'needs-review');
    writeFileSync(path.join(root, 'src/assets/logo2.webp'), 'x');
    writeFileSync(path.join(root, '.gitignore'), 'nothing\n');
    const kept = row('/logo2.webp');
    assert.equal(applyEnvironmentArtefacts([kept], { root }), 0);
    assert.equal(kept.verdict, 'confirmed');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a dead anchor to a page path stays confirmed even when public/ is gitignored', () => {
  const root = project();
  try {
    const a = { ...asset('/old-page'), element: { outerHTML: '<a href="/old-page">x</a>', selector: 'a' } };
    assert.equal(applyEnvironmentArtefacts([a], { root }), 0);
    assert.equal(a.verdict, 'confirmed');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
