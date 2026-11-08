import './helpers/hermetic-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanInstrumentationPlugin } from '../vite/scan-instrumentation.js';
import { getLocalBuildRevision, resolveScanAttestation } from '../src/tracer/build-instrumented.js';
import { computeSourcePreimage, buildSourcePreimage, findChangedSources, hashSourceFiles } from '../src/tracer/preimage.js';
import { loadTrustedLocalAttestation } from '../src/fix/controller/local-attestation.js';
import { markStaleTraces } from '../src/tracer/trace-element.js';
import { deriveScanTargetAndTrace } from '../src/tracer/scan-target.js';
import { ATTESTATION_REASONS, sanitizeAttestationReason } from '../src/tracer/attestation-reasons.js';
import { TRACE_REASONS } from '../src/tracer/trace-reasons.js';
import { canonicalizeDeploymentUrl, isUrlWithinDeploymentScope } from '../src/tracer/deployment-url.js';
import {
  ATTESTATION_META,
  deriveRemoteScanTarget,
  extractPageAttestationFromPage,
  injectAttestationMetaTags,
  validatePageAttestationMetaContents,
} from '../src/tracer/page-attestation.js';
import { resolveFixCapability } from '../src/fix/controller/mode-gate.js';
import { findPageLevelAnchor } from '../src/tracer/liquid-tag-index.js';
import { resolveMissingLines } from '../src/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const FIXTURE = join(HERE, 'fixtures/paradox-site');
const REVISION = 'git:abc123def4567890123456789012345678901234';
const sha = (text) => `sha256:${createHash('sha256').update(text).digest('hex')}`;
const tmp = (name) => mkdtempSync(join(tmpdir(), `ada-${name}-`));

async function buildProject(root, { sources }) {
  mkdirSync(join(root, 'dist', 'pages'), { recursive: true });
  mkdirSync(join(root, 'dist', 'partials'), { recursive: true });
  mkdirSync(join(root, 'src', 'pages'), { recursive: true });
  mkdirSync(join(root, 'src', 'partials'), { recursive: true });
  writeFileSync(join(root, '.scan-config.json'), JSON.stringify({
    outDir: 'dist',
    deploymentUrl: 'https://example.test',
    distMap: [
      { dist: 'dist/pages/', src: 'src/pages/', ext: '.liquid' },
      { dist: 'dist/partials/', src: 'src/partials/', ext: '.liquid' },
    ],
  }));
  for (const [file, content] of Object.entries(sources)) writeFileSync(join(root, file), content);
  writeFileSync(join(root, 'dist/pages/index.html'), '<html><head><title>Page</title></head><body></body></html>');
  writeFileSync(join(root, 'dist/partials/card.html'), '<article>Card</article>');
  const before = { cwd: process.cwd(), mode: process.env.SCAN_MODE, rev: process.env.ADA_SCAN_BUILD_REVISION };
  try {
    process.chdir(root);
    process.env.SCAN_MODE = 'true';
    process.env.ADA_SCAN_BUILD_REVISION = REVISION;
    await scanInstrumentationPlugin().closeBundle.handler();
  } finally {
    process.chdir(before.cwd);
    if (before.mode === undefined) delete process.env.SCAN_MODE; else process.env.SCAN_MODE = before.mode;
    if (before.rev === undefined) delete process.env.ADA_SCAN_BUILD_REVISION; else process.env.ADA_SCAN_BUILD_REVISION = before.rev;
  }
}

const PAGE_SRC = '<main>page</main>\n';
const CARD_SRC = '<article>Card</article>\n';

test('plugin records build-time sha256 of sources and instrumented pages, and the digest commits to them', async () => {
  const root = tmp('hash');
  try {
    await buildProject(root, { sources: { 'src/pages/index.liquid': PAGE_SRC, 'src/partials/card.liquid': CARD_SRC } });
    const sidecar = JSON.parse(readFileSync(join(root, 'dist/scan-attestation.json'), 'utf8'));
    const manifest = JSON.parse(readFileSync(join(root, 'dist/scan-manifest.json'), 'utf8'));

    assert.deepEqual(sidecar.sourceHashes, {
      'src/pages/index.liquid': sha(PAGE_SRC),
      'src/partials/card.liquid': sha(CARD_SRC),
    });
    // Rendered hashes are taken after the attestation meta tags are injected.
    assert.equal(sidecar.renderedHashes['dist/pages/index.html'], sha(readFileSync(join(root, 'dist/pages/index.html'))));
    assert.equal(sidecar.renderedHashes['dist/partials/card.html'], sha('<article>Card</article>'));
    // Same names, different content: different digest.
    assert.notEqual(
      sidecar.instrumentationDigest,
      resolveScanAttestation(manifest, { sourceHashes: { ...sidecar.sourceHashes, 'src/pages/index.liquid': sha('other') } }).instrumentationDigest,
    );
    assert.equal(resolveScanAttestation(manifest, sidecar).status, 'verified');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('report-time verification lists sources edited after the build and the loader exposes them', async () => {
  const root = tmp('stale');
  const before = process.env.ADA_SCAN_BUILD_REVISION;
  try {
    await buildProject(root, { sources: { 'src/pages/index.liquid': PAGE_SRC, 'src/partials/card.liquid': CARD_SRC } });
    process.env.ADA_SCAN_BUILD_REVISION = REVISION;
    assert.deepEqual(loadTrustedLocalAttestation(root).attestation.changedSources, []);

    writeFileSync(join(root, 'src/partials/card.liquid'), `${CARD_SRC}<p>added after build</p>\n`);
    const loaded = loadTrustedLocalAttestation(root);
    assert.equal(loaded.ok, true);
    assert.deepEqual(loaded.attestation.changedSources, ['src/partials/card.liquid']);
    assert.equal(loaded.attestation.status, 'verified'); // the build itself is still consistent

    rmSync(join(root, 'src/pages/index.liquid'));
    assert.deepEqual(loadTrustedLocalAttestation(root).attestation.changedSources, ['src/pages/index.liquid', 'src/partials/card.liquid']);
  } finally {
    if (before === undefined) delete process.env.ADA_SCAN_BUILD_REVISION; else process.env.ADA_SCAN_BUILD_REVISION = before;
    rmSync(root, { recursive: true, force: true });
  }
});

test('a legacy sidecar without hashes keeps the name-only digest and reports nothing stale', () => {
  const manifest = { 'dist/pages/index.html': 'src/pages/index.liquid' };
  const legacy = resolveScanAttestation(manifest, {}, REVISION, null, FIXTURE);
  const again = resolveScanAttestation(manifest, { instrumentationDigest: legacy.instrumentationDigest }, REVISION, null, FIXTURE);
  assert.equal(again.status, 'verified');
  assert.deepEqual(again.changedSources, []);
  assert.deepEqual(findChangedSources(FIXTURE, null), []);
});

test('markStaleTraces demotes traces into changed files and leaves others alone', () => {
  const fresh = { file: 'src/pages/index.liquid', line: 9, confidence: 'high', preimageSha256: sha('x'), preimageRange: { start: 7, end: 11 }, traceConfidence: 'high' };
  const page = [{
    name: 'home',
    violations: [
      { id: 'a', source: { file: 'src/partials/card.liquid', line: 3, confidence: 'high', preimageSha256: sha('y'), preimageRange: { start: 1, end: 5 }, traceConfidence: 'high', traceReason: null } },
      { id: 'b', source: { ...fresh } },
      { id: 'c', source: { file: null, confidence: 'none', traceConfidence: 'untraceable', traceReason: 'no-match' }, sourceCandidates: [{ file: 'src/partials/card.liquid', line: 4, preimageSha256: sha('z') }] },
    ],
  }];
  const [out] = markStaleTraces(page, ['src/partials/card.liquid']);
  const [a, b, c] = out.violations;
  assert.deepEqual(
    [a.source.confidence, a.source.traceConfidence, a.source.traceReason, a.source.preimageSha256, a.source.preimageRange, a.source.line],
    ['low', 'stale', 'source-changed-since-build', null, null, 3],
  );
  assert.deepEqual(b.source, fresh);
  assert.equal(c.source.traceConfidence, 'untraceable');
  assert.equal(c.sourceCandidates[0].preimageSha256, null);
  assert.ok(TRACE_REASONS.has('source-changed-since-build'));
  assert.equal(page[0].violations[0].source.traceConfidence, 'high', 'input is not mutated');
  assert.equal(markStaleTraces(page, []), page);
});

test('local report derives staleness from hashes recomputed at report time', () => {
  const violation = () => ({ source: { file: 'package.json', line: 1, confidence: 'high', preimageSha256: sha('p'), traceConfidence: 'high' } });
  const run = (sourceHashes) => deriveScanTargetAndTrace({
    pageResults: [{ url: 'http://127.0.0.1:1234/', violations: [violation()] }],
    pages: [{ url: 'http://127.0.0.1:1234/' }],
    scanAttestation: { buildRevision: REVISION, instrumentationDigest: sha('d'), sourceHashes },
  }).pageResults[0].violations[0].source;

  assert.equal(run({ 'package.json': sha(readFileSync(join(REPO, 'package.json'))) }).traceConfidence, 'high');
  const stale = run({ 'package.json': sha('what the build saw') });
  assert.equal(stale.traceConfidence, 'stale');
  assert.equal(stale.traceReason, 'source-changed-since-build');
});

test('hashSourceFiles skips paths outside the root and findChangedSources ignores malformed hashes', () => {
  const hashes = hashSourceFiles(FIXTURE, ['src/pages/index.liquid', '../../package.json', 'missing.liquid']);
  assert.deepEqual(Object.keys(hashes), ['src/pages/index.liquid']);
  assert.equal(hashes['src/pages/index.liquid'], sha(readFileSync(join(FIXTURE, 'src/pages/index.liquid'))));
  assert.deepEqual(findChangedSources(FIXTURE, { 'src/pages/index.liquid': 'not-a-hash' }), []);
});

// ---- scope check (TRC-1) ----------------------------------------------------

test('scope ignores query and hash of the scanned URL, consistently, and still enforces origin and base path', () => {
  const dep = 'https://site.example/careers';
  for (const url of [
    'https://site.example/careers', 'https://site.example/careers/', 'https://site.example/careers?x=1', 'https://site.example/careers#top',
    'https://site.example/careers/jobs?q=a&page=2#results', 'https://SITE.example:443/careers/jobs',
    `https://site.example/careers/jobs?q=${'a'.repeat(4000)}`,
  ]) assert.equal(isUrlWithinDeploymentScope(url, dep), true, url);
  for (const url of [
    'https://site.example/careersx', 'https://site.example/other?next=/careers', 'https://site.example/#/careers',
    'http://site.example/careers', 'https://evil.example/careers', 'https://user:pw@site.example/careers', 'not a url', null,
  ]) assert.equal(isUrlWithinDeploymentScope(url, dep), false, String(url));
  // The deployment URL itself stays strict: a query or hash is not a deployment, it is a malformed one.
  assert.equal(canonicalizeDeploymentUrl('https://site.example/careers?x=1'), null);
  assert.equal(canonicalizeDeploymentUrl('https://site.example/careers#x'), null);
  assert.equal(isUrlWithinDeploymentScope('https://site.example/careers', 'https://site.example/careers?x=1'), false);
});

test('attestation scope is the same for every page of a scan whatever query or hash it carries', () => {
  const attestation = { ok: true, attestation: { buildRevision: REVISION, instrumentationDigest: sha('d'), deploymentUrl: 'https://site.example' } };
  const target = (urls) => deriveRemoteScanTarget({
    scannedUrl: urls[0],
    sourceRoot: FIXTURE,
    pageEntries: urls.map((pageUrl) => ({ attestationResult: attestation, pageUrl })),
  });
  assert.equal(target(['https://site.example/?utm=1', 'https://site.example/jobs#a', 'https://site.example/jobs?p=2']).mode, 'hybrid');
  const out = target(['https://site.example/?utm=1', 'https://elsewhere.example/jobs?x=https://site.example']);
  assert.equal(out.mode, 'url-only');
  assert.equal(out.attestationReason, 'DEPLOYMENT_URL_MISMATCH');
});

// ---- reason enum contract (TRC-4) -------------------------------------------

test('every attestation reason emitted by the code is in the exported enum', () => {
  const files = [
    'src/tracer/page-attestation.js', 'src/tracer/trusted-deployment-url.js', 'src/tracer/scan-target.js',
    'src/fix/controller/local-attestation.js', 'src/fix/controller/mode-gate.js',
  ];
  const emitted = new Set();
  for (const file of files) {
    const text = readFileSync(join(REPO, file), 'utf8');
    for (const m of text.matchAll(/reason: '([A-Z][A-Z_]+)'|(?:missingReason|malformedReason)\b[^\n]*'([A-Z][A-Z_]+)'|^\s*'([A-Z][A-Z_]+)',$/gm)) emitted.add(m[1] || m[2] || m[3]);
  }
  // 'MISSING_BUILD_REVISION' etc. appear as call arguments too.
  for (const m of readFileSync(join(REPO, 'src/fix/controller/local-attestation.js'), 'utf8').matchAll(/'((?:LOCAL|MALFORMED|MISSING)_[A-Z_]+)'/g)) emitted.add(m[1]);
  assert.ok(emitted.size >= 15, `scanned too little: ${[...emitted]}`);
  const unknown = [...emitted].filter((reason) => !ATTESTATION_REASONS.has(reason));
  assert.deepEqual(unknown, []);
  // The retired ad-hoc spellings must not come back, and nothing falls through to the catch-all by accident.
  for (const old of ['DEPLOYMENT_URL_MISSING', 'BUILD_REVISION_MISSING', 'INSTRUMENTATION_DIGEST_MISSING']) {
    assert.equal(ATTESTATION_REASONS.has(old), false);
    assert.equal(sanitizeAttestationReason(old), 'REMOTE_ATTESTATION_INVALID');
  }
});

test('the mode gate reports missing attestation inputs with enum reasons', () => {
  const base = {
    targetMode: 'hybrid', url: 'https://x.test/', localRoot: REPO, scannedUrl: 'https://x.test/', attestationStatus: 'complete',
    remoteRevision: REVISION, localRevision: REVISION, remoteInstrumentationDigest: sha('d'), localInstrumentationDigest: sha('d'),
    remoteDeploymentUrl: 'https://x.test', localDeploymentUrl: 'https://x.test',
  };
  for (const [patch, want] of [
    [{ remoteRevision: null }, 'MISSING_BUILD_REVISION'],
    [{ localInstrumentationDigest: null }, 'MISSING_INSTRUMENTATION_DIGEST'],
    [{ localDeploymentUrl: null }, 'MISSING_DEPLOYMENT_URL'],
  ]) {
    const { reason } = resolveFixCapability({ ...base, ...patch });
    assert.equal(reason, want);
    assert.ok(ATTESTATION_REASONS.has(reason));
  }
});

// ---- TRC-17 dirty detection -------------------------------------------------

test('only tracked changes make a build revision dirty, untracked files (dist, new notes) do not', () => {
  const root = tmp('git');
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd: root, stdio: 'ignore' });
  try {
    git('init', '-q');
    writeFileSync(join(root, 'a.txt'), 'one\n');
    git('add', 'a.txt');
    git('commit', '-q', '-m', 'init');
    writeFileSync(join(root, 'untracked.txt'), 'new\n');
    assert.match(getLocalBuildRevision(root), /^git:[0-9a-f]{40}$/);
    writeFileSync(join(root, 'a.txt'), 'two\n');
    assert.match(getLocalBuildRevision(root), /^git:[0-9a-f]{40}:dirty$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- TRC-20 / TRC-21 head handling -----------------------------------------

const ATT = { buildRevision: REVISION, instrumentationDigest: sha('d'), deploymentUrl: 'https://x.test' };

test('meta injection targets the real head end, not a </head> in a comment or script', () => {
  const html = '<!doctype html><html><head><!-- old </head> note --><script>var s = "</head>";</script><title>T</title></head><body><meta name="ada-scan-build-revision" content="ugc"></body></html>';
  const out = injectAttestationMetaTags(html, ATT);
  const headEnd = out.indexOf('</head><body>');
  assert.ok(headEnd > 0);
  assert.ok(out.indexOf(ATTESTATION_META.BUILD_REVISION) < headEnd, 'meta tags sit inside the real head');
  assert.ok(out.includes('<!-- old </head> note -->') && out.includes('var s = "</head>";'), 'comment and script untouched');
  assert.ok(out.includes('content="ugc"'), 'a body meta is not ours to remove');
  assert.equal(out.match(/ada-scan-build-revision/g).length, 2);
  assert.equal(injectAttestationMetaTags('<html><body>no head</body></html>', ATT), '<html><body>no head</body></html>');
  // Idempotent: re-injecting replaces, never duplicates.
  assert.equal(injectAttestationMetaTags(out, ATT).match(/name="ada-scan-instrumentation-digest"/g).length, 1);
});

test('page attestation is read from the head only, so body or UGC metas cannot cause DUPLICATE_META', async () => {
  const meta = (name, content) => ({ getAttribute: (k) => (k === 'content' ? content : name) });
  const headMetas = { 'ada-scan-build-revision': [meta('ada-scan-build-revision', REVISION)] };
  const bodyMeta = meta('ada-scan-build-revision', 'ugc');
  const previous = globalThis.document;
  globalThis.document = {
    head: { querySelectorAll: (selector) => headMetas[/"(.+)"/.exec(selector)[1]] || [] },
    querySelectorAll: (selector) => [...(headMetas[/"(.+)"/.exec(selector)[1]] || []), bodyMeta],
  };
  try {
    const metaContents = await extractPageAttestationFromPage(null, { evaluate: async (fn, arg) => fn(arg) });
    // Revision seen once (head), the other two metas are absent: missing, not duplicate.
    assert.equal(metaContents.ok, false);
    assert.equal(metaContents.reason, 'MISSING_INSTRUMENTATION_DIGEST');
  } finally {
    if (previous === undefined) delete globalThis.document; else globalThis.document = previous;
  }
  assert.equal(validatePageAttestationMetaContents({ 'ada-scan-build-revision': [REVISION, 'ugc'] }).reason, 'DUPLICATE_META');
});

// ---- TRC-22 preimage containment -------------------------------------------

test('preimage refuses symlink escapes but accepts a file whose name starts with two dots', () => {
  const root = tmp('pre');
  const outside = tmp('pre-out');
  try {
    mkdirSync(join(root, 'src'));
    writeFileSync(join(outside, 'secret.liquid'), 'a\nb\nc\n');
    symlinkSync(join(outside, 'secret.liquid'), join(root, 'src/link.liquid'));
    symlinkSync(outside, join(root, 'src/dir'));
    writeFileSync(join(root, 'src/..dots.liquid'), 'a\nb\nc\n');
    assert.equal(computeSourcePreimage('src/link.liquid', 2, root), null);
    assert.equal(computeSourcePreimage('src/dir/secret.liquid', 2, root), null);
    assert.equal(computeSourcePreimage('../x.liquid', 2, root), null);
    assert.equal(computeSourcePreimage('src/..dots.liquid', 2, root).preimageSha256, buildSourcePreimage('a\nb\nc\n', 2).preimageSha256);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

// ---- TRC-24 page-level rule allow-list -------------------------------------

test('page-level anchors are chosen by exact rule id, not by substring', () => {
  const at = (rule) => findPageLevelAnchor('src/pages/index.liquid', rule, FIXTURE);
  // index.liquid: <main> on line 4, <h1> on line 5 (hand-counted).
  assert.deepEqual(at('missing-h1'), { file: 'src/pages/index.liquid', line: 5, confidence: 'low', method: 'page-level-anchor' });
  assert.equal(at('MISSING-H1').line, 5);
  assert.equal(at('missing-main-landmark').line, 4);
  // "heading" is only a substring of this id; it used to be sent to the <h1> probe.
  assert.equal(at('subheading-color-check').line, 4);
});

// ---- TRC-16 ---------------------------------------------------------------

test('a re-traced line replaces the old preimage and a legacy high is capped by the new verdict', () => {
  const stalePreimage = sha('preimage of some earlier line');
  const finding = {
    rule: 'x',
    element: { outerHTML: '<button class="defect-icon-button" type="button"><svg></svg></button>' },
    source: { file: 'src/pages/index.liquid', line: null, confidence: 'high', method: 'legacy-source-attribution', preimageSha256: stalePreimage, preimageRange: { start: 1, end: 3 } },
  };
  resolveMissingLines([finding], 'src/pages/index.liquid', FIXTURE);
  assert.equal(finding.source.line, 9); // hand-counted in the fixture
  assert.equal(finding.source.confidence, 'medium'); // outside every marker: never high
  const text = readFileSync(join(FIXTURE, 'src/pages/index.liquid'), 'utf8');
  assert.equal(finding.source.preimageSha256, buildSourcePreimage(text, 9).preimageSha256);
  assert.deepEqual(finding.source.preimageRange, { start: 7, end: 11 });
});
