import './helpers/hermetic-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { traceElement, applyAttestedRemoteTracing } from '../src/tracer/trace-element.js';
import { indexHtml, scoreFingerprint } from '../src/tracer/fingerprint-map.js';
import { measure, summarize, PROFILES } from './helpers/preview-sim.js';

// Expected file:line values are hand-counted in test/fixtures/paradox-site/src (see trace-element.test.js).
const ROOT = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/paradox-site');
const LOCAL = readFileSync(join(ROOT, 'pages/index.html'), 'utf8'); // keeps <!-- snippets/x.html --> markers
const BENEFITS = readFileSync(join(ROOT, 'pages/benefits.html'), 'utf8');
const PAGE = 'src/pages/index.liquid';
const wrap = (name, inner) => `<!-- snippets/${name}.html -->${inner}<!-- /snippets/${name}.html -->`;
const preview = (el) => traceElement({ root: ROOT, pageFile: PAGE, pageHtml: LOCAL, mode: 'preview', attestation: { ok: true }, ...el });
const at = (r) => r.candidates.map((c) => `${c.file}:${c.line}`);

const TABLE = [
  { name: 'header nav link, no marker, selector gives the landmark',
    el: { outerHTML: '<a href="/benefits">Benefits</a>', selector: 'header.site-header > nav > a:nth-child(2)' },
    want: ['high', ['src/partials/header.liquid:5']] },
  { name: 'same markup in a Studio wrapper with reordered attributes and a deploy-hash class',
    el: { outerHTML: '<a class="css-1a9f3c" href="/benefits">Benefits overview</a>', selector: 'div.ps-snippet-wrap > footer.site-footer > a:nth-child(2)' },
    want: ['high', ['src/partials/footer.liquid:3']] },
  { name: 'footer link by text alone (no selector): right file, but one signal is only medium',
    el: { outerHTML: '<a href="/benefits">Benefits overview</a>' },
    want: ['medium', ['src/partials/footer.liquid:3']] },
  { name: 'page-level element has no marker owner: medium at most',
    el: { outerHTML: '<button type="button" class="defect-icon-button"><svg></svg></button>' },
    want: ['medium', [`${PAGE}:9`]] },
  { name: 'title whose text Studio rewrote still resolves to the layout',
    el: { outerHTML: '<title>Careers</title>', selector: 'html > head > title:nth-child(2)' },
    want: ['medium', ['src/layouts/layout.liquid:5']] },
  { name: 'foreign element with a lookalike href and its own classes is not the header link',
    el: { outerHTML: '<a href="/benefits" class="nav-link hover-underline">Benefits</a>' },
    want: ['untraceable', []] },
  { name: 'element absent from the reference never falls back to a source-side guess',
    el: { outerHTML: '<p class="unrelated-class">x</p>' },
    want: ['untraceable', []] },
  { name: 'selector contradicting the only text match (footer path, header text) yields no path',
    el: { outerHTML: '<a href="/benefits">Benefits</a>', selector: 'footer.site-footer > a:nth-child(2)' },
    want: ['untraceable', []] },
];

for (const { name, el, want } of TABLE) {
  test(`preview fingerprint: ${name}`, () => {
    const r = preview(el);
    assert.equal(r.confidence, want[0]);
    assert.deepEqual(at(r), want[1]);
    if (r.candidates.length > 0 && r.confidence !== 'ambiguous') assert.ok(r.candidates[0].evidence.includes('fingerprint'));
    if (r.confidence === 'untraceable') assert.equal(r.reason, 'no-match');
  });
}

test('wrong-high guard: two identical elements in two snippets are ambiguous, never a pick', () => {
  const link = '<a href="/benefits">Benefits</a>';
  const pageHtml = wrap('header', `<header>${link}</header>`) + wrap('footer', `<footer>${link}</footer>`);
  const r = traceElement({ root: ROOT, pageFile: PAGE, pageHtml, mode: 'preview', attestation: { ok: true }, outerHTML: link });
  assert.equal(r.confidence, 'ambiguous');
  assert.equal(r.reason, 'multiple-candidates');
  assert.deepEqual(at(r), ['src/partials/header.liquid:5', 'src/partials/footer.liquid:3']);
  // The selector's landmark is real evidence: it separates them, and high needs the strong score.
  const sel = traceElement({ root: ROOT, pageFile: PAGE, pageHtml, mode: 'preview', attestation: { ok: true }, outerHTML: link, selector: 'footer > a:nth-child(1)' });
  assert.deepEqual([sel.confidence, ...at(sel)], ['high', 'src/partials/footer.liquid:3']);
});

test('wrong-high guard: near-identical elements within one margin tie instead of the higher score winning', () => {
  const pageHtml = wrap('header', '<a class="brand" href="/">Acme Careers</a><a class="brand" href="/">Acme Careers</a>');
  const r = traceElement({ root: ROOT, pageFile: PAGE, pageHtml, mode: 'preview', attestation: { ok: true }, outerHTML: '<a class="brand" href="/">Acme Careers</a>' });
  assert.notEqual(r.confidence, 'high');
});

test('a reference page without any marker is ignored (the old hint search still runs)', () => {
  const r = traceElement({ root: ROOT, pageFile: PAGE, pageHtml: '<html><body><a href="/benefits">Benefits</a></body></html>', mode: 'preview', attestation: { ok: true }, outerHTML: '<a href="/benefits">Benefits</a>' });
  // Both source links match by href; footer.liquid:3 says "Benefits overview", so the element's text picks the header (never high).
  assert.equal(r.confidence, 'medium');
  assert.deepEqual(at(r), ['src/partials/header.liquid:5']);
});

test('preview never trusts a bare tag-name match', () => {
  const r = traceElement({ root: ROOT, pageFile: PAGE, mode: 'preview', attestation: { ok: true }, outerHTML: '<h1 class="whatever">Hi</h1>' });
  assert.notEqual(r.confidence, 'medium');
  assert.equal(r.candidates.length, 0);
});

test('indexHtml: owners, sibling positions and line-free text for a marker region', () => {
  const els = indexHtml(LOCAL);
  const link = els.find((e) => e.tag === 'a' && e.attrs.href === '/benefits' && e.text === 'benefits');
  assert.deepEqual(link.owners, ['header']);
  assert.equal(link.childIndex, 2);
  assert.equal(els.find((e) => e.tag === 'title').owners.length, 0);
  assert.equal(els.filter((e) => e.owners.includes('footer')).length, 3);
});

test('scoreFingerprint rejects another tag or a vanished identifying class', () => {
  const [local] = indexHtml('<button class="defect-icon-button"></button>');
  const probe = (html) => indexHtml(html)[0];
  assert.equal(scoreFingerprint(probe('<a class="defect-icon-button"></a>'), local), -1);
  assert.equal(scoreFingerprint(probe('<button class="other-thing"></button>'), local), -1);
  assert.ok(scoreFingerprint(probe('<button class="defect-icon-button css-1a2b3c9"></button>'), local) > 0);
});

test('applyAttestedRemoteTracing reads the local build page for the scanned route', () => {
  const root = mkdtempSync(join(tmpdir(), 'fp-e2e-'));
  try {
    cpSync(join(ROOT, 'src'), join(root, 'src'), { recursive: true });
    mkdirSync(join(root, 'dist'));
    cpSync(join(ROOT, 'pages/index.html'), join(root, 'dist/index.html'));
    const violation = { rule: 'link-name', element: { outerHTML: '<a href="/benefits">Benefits overview</a>', selector: 'footer > a:nth-child(2)' }, source: { mode: 'url', confidence: 'none', method: 'unresolved' } };
    const [out] = applyAttestedRemoteTracing([{ url: 'https://x.test/', violations: [violation] }], root);
    const [v] = out.violations;
    assert.deepEqual([v.source.file, v.source.line, v.source.confidence, v.source.traceConfidence], ['src/partials/footer.liquid', 3, 'high', 'high']);
    assert.equal(v.source.method, 'fingerprint-map');
    const [other] = applyAttestedRemoteTracing([{ url: 'https://x.test/missing', violations: [violation] }], root);
    assert.notEqual(other.violations[0].source.method, 'fingerprint-map'); // no local page: old path
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Simulated Studio output: markers stripped, attributes reordered, deploy-hash classes, bound text,
// wrapper divs, injected platform elements, rewritten head. Thresholds from docs/trace-spike-E4.2.md.
for (const [name, profile] of Object.entries(PROFILES)) {
  test(`simulated preview (${name}): zero wrong high, no path for new elements, >=80% of traceable traced right`, () => {
    const rows = [
      ...measure({ root: ROOT, pageFile: PAGE, localHtml: LOCAL, profile }).rows,
      ...measure({ root: ROOT, pageFile: 'src/pages/benefits.liquid', localHtml: BENEFITS, profile }).rows,
    ];
    const n = summarize(rows);
    assert.ok(n.traceable >= 30, `traceable set too small: ${n.traceable}`);
    assert.equal(n.wrongHigh, 0);
    assert.equal(n.wrongOther, 0);
    assert.equal(n.newTraced, 0);
    assert.ok(n.correct / n.traceable >= 0.8, `${n.correct}/${n.traceable}`);
  });
}

test('twin trace never grants a bare tag-name medium: a reference element the source lacks stays untraceable', () => {
  // Reference page has two <h2>, the source only one (the Clean twins section was never authored).
  const root = mkdtempSync(join(tmpdir(), 'fp-twin-'));
  try {
    cpSync(join(ROOT, 'src'), join(root, 'src'), { recursive: true });
    const page = join(root, PAGE);
    const lines = readFileSync(page, 'utf8').split('\n');
    writeFileSync(page, [...lines.slice(0, 16), ...lines.slice(24)].join('\n'));
    const r = traceElement({ root, pageFile: PAGE, pageHtml: LOCAL, mode: 'preview', attestation: { ok: true }, outerHTML: '<h2>Clean twins</h2>' });
    assert.equal(r.confidence, 'untraceable');
    assert.deepEqual(at(r), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('clean-section elements trace to their own hand-counted lines in index.liquid', () => {
  const want = [
    ['<img class="clean-img" src="/pixel.svg" width="40" height="40" alt="Acme team photo">', 20],
    ['<p class="clean-contrast tw-ok-contrast">Readable legal notice.</p>', 21],
  ];
  for (const [outerHTML, line] of want) {
    const r = preview({ outerHTML });
    assert.deepEqual([r.confidence, ...at(r)], ['medium', `${PAGE}:${line}`], outerHTML);
  }
  // Two <h2> in source and reference: a bare heading is not enough for a path.
  assert.equal(preview({ outerHTML: '<h2>Clean twins</h2>' }).confidence, 'untraceable');
});
