import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createViolation } from '../src/schema.js';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  computeInstrumentationDigest,
  resolveScanAttestation,
} from '../src/tracer/build-instrumented.js';
import { buildSourcePreimage } from '../src/tracer/preimage.js';
import {
  confidenceForPartialMatch,
  normalizeTraceAttestation,
} from '../src/tracer/partial-map.js';
import { resolveSourceViolation } from '../src/tracer/resolve-source.js';
import {
  injectScanAttestation,
  scanInstrumentationPlugin,
} from '../vite/scan-instrumentation.js';

test('source preimage hashes only the attested source block', () => {
  const original = [
    '<header>outside</header>',
    '<main>',
    '  <select id="sort"></select>  ',
    '</main>',
    '<footer>outside</footer>',
  ].join('\n');
  const outsideChange = original.replace('<header>outside</header>', '<header>changed</header>');
  const insideChange = original.replace('id="sort"', 'id="sort-by"');

  const first = buildSourcePreimage(original, 3, 1);
  assert.equal(first.preimageSha256, buildSourcePreimage(outsideChange, 3, 1).preimageSha256);
  assert.notEqual(first.preimageSha256, buildSourcePreimage(insideChange, 3, 1).preimageSha256);
  assert.deepEqual(first.range, { start: 2, end: 4 });
});

test('createViolation preserves trace attestation fields', () => {
  const violation = createViolation({
    ruleId: 'select-name',
    layer: 'axe',
    source: {
      mode: 'local',
      file: 'src/partials/jobs/sort.liquid',
      line: 12,
      confidence: 'high',
      method: 'instrumentation-manifest',
      preimageSha256: 'sha256:source',
      preimageRange: { start: 10, end: 14 },
      partial: 'jobs/sort',
      page: 'src/pages/index.liquid',
      routeDependencies: ['/'],
    },
  });

  assert.equal(violation.source.confidence, 'high');
  assert.equal(violation.source.method, 'instrumentation-manifest');
  assert.equal(violation.source.preimageSha256, 'sha256:source');
  assert.deepEqual(violation.source.preimageRange, { start: 10, end: 14 });
  assert.deepEqual(violation.source.routeDependencies, ['/']);
});

test('manifest attribution without a source line cannot claim high confidence', () => {
  const source = normalizeTraceAttestation({
    file: 'src/partials/missing.liquid',
    line: null,
    confidence: 'high',
    method: 'instrumentation-manifest',
    preimageSha256: 'sha256:stale',
    preimageRange: { start: 1, end: 2 },
  }, '/missing-root');

  assert.equal(source.confidence, 'medium');
  assert.equal(source.preimageSha256, null);
  assert.equal(source.preimageRange, null);
});

test('path-derived partial matches remain medium confidence without a manifest', () => {
  assert.equal(
    confidenceForPartialMatch({ line: 12, manifestMatched: false }),
    'medium',
  );
  assert.equal(
    confidenceForPartialMatch({ line: 12, manifestMatched: true }),
    'high',
  );
});

test('PDK partial ownership resolves the innermost source boundary', () => {
  const rendered = [
    '<main>',
    '  <section data-pdk-partial="jobs/list">',
    '    <div data-pdk-partial="jobs/sort">',
    '      <select id="sort"></select>',
    '    </div>',
    '  </section>',
    '</main>',
  ].join('\n');
  const resolved = resolveSourceViolation(
    { html: '<select id="sort"></select>' },
    rendered,
  );

  assert.equal(resolved.originFile, 'src/partials/jobs/sort.liquid');
  assert.equal(resolved.snippetId, 'jobs/sort');
  assert.equal(resolved.confidence, 'medium');
  assert.equal(resolved.method, 'pdk-partial-boundary');
});

test('instrumentation digest is independent of manifest key order', () => {
  const first = computeInstrumentationDigest({
    'dist/pages/index.html': 'src/pages/index.liquid',
    'dist/partials/jobs/sort.html': 'src/partials/jobs/sort.liquid',
  });
  const second = computeInstrumentationDigest({
    'dist/partials/jobs/sort.html': 'src/partials/jobs/sort.liquid',
    'dist/pages/index.html': 'src/pages/index.liquid',
  });
  const windows = computeInstrumentationDigest({
    'dist\\pages\\index.html': 'src\\pages\\index.liquid',
    'dist\\partials\\jobs\\sort.html': 'src\\partials\\jobs\\sort.liquid',
  });

  assert.equal(first, second);
  assert.equal(first, windows);
  assert.match(first, /^sha256:[a-f0-9]{64}$/);
});

test('an empty manifest is reported as unattested instead of hashing an empty map', () => {
  assert.deepEqual(
    resolveScanAttestation({}, {
      buildRevision: 'stale-revision',
      instrumentationDigest: computeInstrumentationDigest({}),
    }, 'git:current'),
    {
      buildRevision: 'git:current',
      instrumentationDigest: null,
      deploymentUrl: null,
      entryCount: 0,
      status: 'missing-instrumentation',
    },
  );
});

test('instrumented HTML carries revision digest and deployment URL attestation', () => {
  const attestation = {
    buildRevision: 'git:abc123def4567890123456789012345678901234',
    instrumentationDigest: 'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
    deploymentUrl: 'https://example.test',
  };
  const html = injectScanAttestation(
    '<!doctype html><html><head><title>Page</title></head><body></body></html>',
    attestation,
  );

  assert.match(html, /name="ada-scan-build-revision" content="git:abc123def4567890123456789012345678901234"/);
  assert.match(html, /name="ada-scan-instrumentation-digest" content="sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"/);
  assert.match(html, /name="ada-scan-deployment-url" content="https:\/\/example\.test"/);
  for (const name of ['ada-scan-build-revision', 'ada-scan-instrumentation-digest', 'ada-scan-deployment-url']) {
    assert.equal((html.match(new RegExp(`name="${name}"`, 'g')) || []).length, 1);
    assert.equal((injectScanAttestation(html, attestation).match(new RegExp(`name="${name}"`, 'g')) || []).length, 1);
  }
  assert.equal(
    injectScanAttestation('<section>Partial</section>', attestation),
    '<section>Partial</section>',
  );
  assert.equal(
    injectScanAttestation('<html><head></head></html>', {
      buildRevision: attestation.buildRevision,
      instrumentationDigest: attestation.instrumentationDigest,
    }),
    '<html><head></head></html>',
  );
});

test('Vite instrumentation emits matching sidecar and HTML attestation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-scan-attestation-'));
  const previousCwd = process.cwd();
  const previousScanMode = process.env.SCAN_MODE;
  const previousRevision = process.env.ADA_SCAN_BUILD_REVISION;
  try {
    mkdirSync(join(root, 'dist', 'pages'), { recursive: true });
    mkdirSync(join(root, 'dist', 'partials'), { recursive: true });
    writeFileSync(
      join(root, '.scan-config.json'),
      JSON.stringify({
        outDir: 'dist',
        deploymentUrl: 'https://example.test',
        distMap: [
          { dist: 'dist/pages/', src: 'src/pages/', ext: '.liquid' },
          { dist: 'dist/partials/', src: 'src/partials/', ext: '.liquid' },
        ],
      }),
    );
    writeFileSync(
      join(root, 'dist', 'pages', 'index.html'),
      '<html><head><title>Page</title></head><body></body></html>',
    );
    writeFileSync(
      join(root, 'dist', 'partials', 'card.html'),
      '<article>Card</article>',
    );
    process.chdir(root);
    process.env.SCAN_MODE = 'true';
    process.env.ADA_SCAN_BUILD_REVISION = 'git:abc123def4567890123456789012345678901234';

    await scanInstrumentationPlugin().closeBundle();

    const manifest = JSON.parse(
      readFileSync(join(root, 'dist', 'scan-manifest.json'), 'utf8')
    );
    const attestation = JSON.parse(
      readFileSync(join(root, 'dist', 'scan-attestation.json'), 'utf8')
    );
    const pageHtml = readFileSync(join(root, 'dist', 'pages', 'index.html'), 'utf8');
    const partialHtml = readFileSync(join(root, 'dist', 'partials', 'card.html'), 'utf8');

    assert.equal(attestation.instrumentationDigest, computeInstrumentationDigest(manifest));
    assert.equal(attestation.deploymentUrl, 'https://example.test');
    assert.match(pageHtml, new RegExp(attestation.instrumentationDigest));
    assert.match(pageHtml, /content="git:abc123def4567890123456789012345678901234"/);
    assert.equal(partialHtml, '<article>Card</article>');
  } finally {
    process.chdir(previousCwd);
    if (previousScanMode === undefined) delete process.env.SCAN_MODE;
    else process.env.SCAN_MODE = previousScanMode;
    if (previousRevision === undefined) delete process.env.ADA_SCAN_BUILD_REVISION;
    else process.env.ADA_SCAN_BUILD_REVISION = previousRevision;
    rmSync(root, { recursive: true, force: true });
  }
});
