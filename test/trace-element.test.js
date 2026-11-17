import './helpers/hermetic-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { traceElement, traceToSourceFields, applyRemoteHintAttribution } from '../src/tracer/trace-element.js';
import { resolveMissingLines } from '../src/index.js';
import { buildSourcePreimage } from '../src/tracer/preimage.js';

// Expected file:line values are hand-counted in test/fixtures/paradox-site/src (see liquid-tag-index.test.js).
const ROOT = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/paradox-site');
const LOCAL_HTML = readFileSync(join(ROOT, 'pages/index.html'), 'utf8'); // keeps <!-- snippets/x.html --> markers
const PAGE = 'src/pages/index.liquid';
const PREVIEW = { mode: 'preview', attestation: { ok: true } };
const wrap = (name, inner) => `<!-- snippets/${name}.html -->${inner}<!-- /snippets/${name}.html -->`;

const TABLE = [
  // Marker region + unique decisive match => high.
  { name: 'header link inside its marker region',
    el: { outerHTML: '<a href="/benefits">Benefits</a>' },
    want: { confidence: 'high', reason: null, at: ['src/partials/header.liquid:5'] } },
  { name: 'footer link inside its marker region',
    el: { outerHTML: '<a href="/benefits">Benefits overview</a>' },
    want: { confidence: 'high', reason: null, at: ['src/partials/footer.liquid:3'] } },
  // Outside every marker there is no owner evidence: capped at medium even when decisive.
  { name: 'page-level button outside any marker is never high',
    el: { outerHTML: '<button class="defect-icon-button" type="button"><svg></svg></button>' },
    want: { confidence: 'medium', reason: null, at: [`${PAGE}:9`] } },
  { name: 'viewport meta lives in the layout',
    el: { outerHTML: '<meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no">' },
    want: { confidence: 'medium', reason: null, at: ['src/layouts/layout.liquid:6'] } },
  { name: 'empty title is the only title in the tree',
    el: { outerHTML: '<title></title>' },
    want: { confidence: 'medium', reason: null, at: ['src/layouts/layout.liquid:5'] } },
  { name: 'a same-tag element whose classes match no source tag is untraceable, not a guess',
    el: { outerHTML: '<p class="unrelated-class">x</p>' },
    want: { confidence: 'untraceable', reason: 'no-match', at: [] } },
  // Ambiguity.
  { name: 'same snippet rendered twice with identical arguments',
    el: { outerHTML: '<div data-pdk-render="cta" data-pdk-param-label="&quot;Apply&quot;"></div>' },
    want: { confidence: 'ambiguous', reason: 'multiple-candidates', at: [`${PAGE}:15`, `${PAGE}:16`] } },
  { name: 'preview (no markers): link present in header and footer',
    el: { outerHTML: '<a href="/benefits">Benefits</a>', ...PREVIEW, pageHtml: undefined },
    want: { confidence: 'medium', reason: null, at: ['src/partials/header.liquid:5'] } }, // footer.liquid:3 reads "Benefits overview": the text separates them, never `high`
  { name: 'identical markup inside two different marker regions',
    el: { outerHTML: '<a href="/benefits">Benefits</a>',
      pageHtml: wrap('header', '<a href="/benefits">Benefits</a>') + wrap('footer', '<a href="/benefits">Benefits</a>') },
    want: { confidence: 'medium', reason: null, at: ['src/partials/header.liquid:5'] } }, // footer.liquid:3 reads "Benefits overview": the text separates them, never `high`
  // Wrong-high guards.
  { name: 'rendered class the source tag cannot produce is not decisive',
    el: { outerHTML: '<a class="promo" href="/">Acme Careers</a>', pageHtml: wrap('header', '<a class="promo" href="/">Acme Careers</a>') },
    want: { confidence: 'medium', reason: null, at: ['src/partials/header.liquid:2'] } }, // the class is not decisive; the link text "Acme Careers" (line 4 says "Home") is, and caps at medium
  { name: 'marker names footer but no footer tag matches: nothing is guessed',
    el: { outerHTML: '<h3 class="nope">x</h3>', pageHtml: wrap('footer', '<h3 class="nope">x</h3>') },
    want: { confidence: 'untraceable', reason: 'no-match', at: [] } },
  { name: 'lazy-load data-src (a URL) is not a source reference',
    el: { outerHTML: '<img class="defect-img" data-src="/pixel.svg" src="/pixel.svg" width="40" height="40">' },
    want: { confidence: 'medium', reason: null, at: [`${PAGE}:10`] } },
  { name: 'data-src pointing at a missing line is ignored',
    el: { outerHTML: '<div data-src="src/partials/footer.liquid:99"></div>' },
    want: { confidence: 'untraceable', reason: 'no-match', at: [] } },
  // data-src is attacker/third-party controlled in preview and nothing emits it yet (E4.7): never trusted.
  { name: 'data-src naming footer.liquid:2 does not pin the element there (preview: every <p> competes)',
    el: { outerHTML: '<p data-src="src/partials/footer.liquid:2">x</p>', ...PREVIEW, pageHtml: undefined },
    want: { confidence: 'ambiguous', reason: 'multiple-candidates', at: [`${PAGE}:3`, `${PAGE}:6`, 'src/partials/footer.liquid:2'] } },
  { name: 'data-src pointing at a line that holds a different tag is ignored',
    el: { outerHTML: '<a class="cta-button" href="/apply" data-src="src/partials/footer.liquid:2">Apply</a>' },
    want: { confidence: 'medium', reason: null, at: ['src/partials/cta.liquid:1'] } },
  // Same markup also sits outside every marker region: the marker alone cannot prove the owner.
  { name: 'identical markup in page-level <main> and a header marker region is never high',
    el: { outerHTML: '<a href="/benefits">Benefits</a>',
      pageHtml: '<main><a href="/benefits">Benefits</a></main>' + wrap('header', '<a href="/benefits">Benefits</a>') },
    want: { confidence: 'medium', reason: null, at: ['src/partials/header.liquid:5'] } }, // footer.liquid:3 reads "Benefits overview": the text separates them, never `high`
  // Untraceable with a reason.
  { name: 'platform widget',
    el: { outerHTML: '<div data-react-component="JobList"><a href="/jobs">x</a></div>' },
    want: { confidence: 'untraceable', reason: 'platform-owned', at: [] } },
  { name: 'element inside a platform widget (selector)',
    el: { outerHTML: '<a href="/jobs">x</a>', selector: '[data-react-component="JobList"] a' },
    want: { confidence: 'untraceable', reason: 'platform-owned', at: [] } },
  { name: 'unrendered snippet placeholder is site markup with no element to match',
    el: { outerHTML: '{{snippet:0f6b2f3c-1111-2222-3333-444444444444}}' },
    want: { confidence: 'untraceable', reason: 'no-element', at: [] } },
  { name: 'preview without attestation',
    el: { outerHTML: '<a href="/benefits">x</a>', mode: 'preview', attestation: { ok: false, reason: 'MISSING_BUILD_REVISION' } },
    want: { confidence: 'untraceable', reason: 'preview-without-reference', at: [] } },
  { name: 'preview attested for another deployment',
    el: { outerHTML: '<a href="/benefits">x</a>', mode: 'preview', attestation: { ok: false, reason: 'DEPLOYMENT_URL_MISMATCH' } },
    want: { confidence: 'untraceable', reason: 'scope-mismatch', at: [] } },
  { name: 'local scan without manifest or markers',
    el: { outerHTML: '<a href="/benefits">x</a>', hasManifest: false, pageHtml: undefined },
    want: { confidence: 'untraceable', reason: 'no-manifest', at: [] } },
  { name: 'markers present but element not in the source',
    el: { outerHTML: '<section class="brand-new-section"></section>' },
    want: { confidence: 'untraceable', reason: 'no-match', at: [] } },
  { name: 'page html without any marker',
    el: { outerHTML: '<section class="brand-new-section"></section>', pageHtml: '<html><body><section class="brand-new-section"></section></body></html>' },
    want: { confidence: 'untraceable', reason: 'no-marker', at: [] } },
  { name: 'page source file missing',
    el: { outerHTML: '<section class="brand-new-section"></section>', pageFile: 'src/pages/gone.liquid' },
    want: { confidence: 'untraceable', reason: 'page-source-missing', at: [] } },
  { name: 'no element and no rule',
    el: { outerHTML: '' },
    want: { confidence: 'untraceable', reason: 'no-element', at: [] } },
  { name: 'absence finding anchors low at the page h1 area',
    el: { outerHTML: '', ruleId: 'missing-h1' },
    want: { confidence: 'low', reason: null, at: [`${PAGE}:5`] } },
];

for (const { name, el, want } of TABLE) {
  test(`traceElement: ${name}`, () => {
    const result = traceElement({ root: ROOT, pageFile: PAGE, pageHtml: LOCAL_HTML, mode: 'local', ...el });
    assert.equal(result.confidence, want.confidence);
    assert.equal(result.reason, want.reason);
    assert.deepEqual(result.candidates.map((c) => `${c.file}:${c.line}`), want.at);
    for (const c of result.candidates) {
      assert.equal(typeof c.method, 'string');
      assert.ok(Array.isArray(c.evidence) && c.evidence.length > 0);
      assert.ok('score' in c);
    }
  });
}

test('traceElement: the high result cites its marker as evidence', () => {
  const result = traceElement({ root: ROOT, pageFile: PAGE, pageHtml: LOCAL_HTML, outerHTML: '<a href="/benefits">Benefits</a>' });
  assert.ok(result.candidates[0].evidence.includes('marker:snippets/header.html'));
});

test('traceElement: an owner proven by the build manifest allows high without page html', () => {
  const result = traceElement({ root: ROOT, pageFile: PAGE, ownerFile: 'src/partials/footer.liquid', outerHTML: '<a href="/benefits">Benefits overview</a>' });
  assert.deepEqual([result.confidence, result.candidates[0].file, result.candidates[0].line], ['high', 'src/partials/footer.liquid', 3]);
});

test('traceToSourceFields keeps the legacy fields and adds the trace verdict', () => {
  const high = traceToSourceFields(traceElement({ root: ROOT, pageFile: PAGE, pageHtml: LOCAL_HTML, outerHTML: '<a href="/benefits">Benefits overview</a>' }), ROOT);
  const expected = buildSourcePreimage(readFileSync(join(ROOT, 'src/partials/footer.liquid'), 'utf8'), 3);
  assert.deepEqual(high.source, {
    file: 'src/partials/footer.liquid', line: 3, confidence: 'high', method: 'liquid-tag-index',
    preimageSha256: expected.preimageSha256, preimageRange: expected.range,
    traceConfidence: 'high', traceReason: null,
  });
  assert.deepEqual(high.sourceCandidates, []);

  const amb = traceToSourceFields(traceElement({ root: ROOT, pageFile: PAGE, outerHTML: '<div data-pdk-render="cta" data-pdk-param-label="&quot;Apply&quot;"></div>' }), ROOT);
  assert.equal(amb.source.file, null);
  assert.equal(amb.source.line, null);
  assert.equal(amb.source.confidence, 'none');
  assert.equal(amb.source.traceConfidence, 'ambiguous');
  assert.deepEqual(amb.sourceCandidates.map((c) => c.line), [15, 16]);
  assert.ok(amb.sourceCandidates.every((c) => /^sha256:[a-f0-9]{64}$/.test(c.preimageSha256)));
});

test('applyRemoteHintAttribution never invents a path for an untraceable element', () => {
  const violation = { element: { outerHTML: '<div data-react-component="JobList"></div>' }, source: { mode: 'url', confidence: 'none', method: 'unresolved' } };
  const out = applyRemoteHintAttribution(violation, ROOT);
  assert.equal(out.source.file, undefined);
  assert.equal(out.sourceCandidates, undefined);
});

test('traceElement: page-level and partial copies of the same tag are ambiguous, never high', () => {
  const root = mkdtempSync(join(tmpdir(), 'trace-outside-'));
  try {
    mkdirSync(join(root, 'src/pages'), { recursive: true });
    mkdirSync(join(root, 'src/partials'), { recursive: true });
    writeFileSync(join(root, 'src/pages/p.liquid'), '{% render "header" %}\n<main>\n<a href="/x">Go</a>\n</main>\n');
    writeFileSync(join(root, 'src/partials/header.liquid'),
      '<header>\n<nav>\n<a href="/y">Y</a>\n<a href="/y2">Y2</a>\n<a href="/z">Z</a>\n<a href="/x">Go</a>\n</nav>\n</header>\n');
    const link = '<a href="/x">Go</a>';
    const result = traceElement({
      root, pageFile: 'src/pages/p.liquid', mode: 'local', outerHTML: link,
      pageHtml: `<main>${link}</main>${wrap('header', link)}`,
    });
    assert.equal(result.confidence, 'ambiguous');
    assert.deepEqual(result.candidates.map((c) => `${c.file}:${c.line}`).sort(), ['src/pages/p.liquid:3', 'src/partials/header.liquid:6']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolveMissingLines writes ambiguous and untraceable verdicts without inventing a path', () => {
  const finding = (outerHTML, source = { file: 'src/pages/index.liquid', line: null, confidence: 'low' }) => ({ rule: 'x', element: { outerHTML }, source });
  const [amb, none, owned] = [
    finding('<div data-pdk-render="cta" data-pdk-param-label="&quot;Apply&quot;"></div>'),
    finding('<section class="brand-new-section"></section>'),
    finding('<a href="/benefits">Benefits overview</a>', { file: 'src/partials/footer.liquid', line: null, method: 'instrumentation-manifest', confidence: 'high' }),
  ];
  resolveMissingLines([amb, none, owned], PAGE, ROOT);

  assert.equal(amb.source.line, null);
  assert.equal(amb.source.traceConfidence, 'ambiguous');
  assert.equal(amb.source.traceReason, 'multiple-candidates');
  assert.deepEqual(amb.sourceCandidates.map((c) => `${c.file}:${c.line}`), [`${PAGE}:15`, `${PAGE}:16`]);

  assert.equal(none.source.line, null);
  assert.equal(none.source.traceConfidence, 'untraceable');
  assert.equal(none.sourceCandidates, undefined);

  assert.equal(owned.source.line, 3);
  assert.equal(owned.source.confidence, 'high');
  assert.equal(owned.source.traceConfidence, 'high');
  assert.equal(owned.source.partial, 'src/partials/footer.liquid');
});
