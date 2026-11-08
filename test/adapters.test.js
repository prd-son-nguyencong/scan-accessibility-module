import './helpers/hermetic-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectFramework, getAdapter, listAdapters, registerAdapter, resolveAdapter } from '../src/tracer/adapters/index.js';
import { traceElement } from '../src/tracer/trace-element.js';
import { validateConfig } from '../src/utils/config.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/paradox-site');

function project(files) {
  const root = mkdtempSync(join(tmpdir(), 'ada-adapter-'));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), typeof body === 'string' ? body : JSON.stringify(body));
  }
  return root;
}
const pkg = (deps) => ({ 'package.json': { dependencies: deps } });

const CASES = [
  ['liquid pages without package.json', { 'src/pages/a.liquid': '<p></p>' }, 'paradox-liquid'],
  ['liquidjs dependency', pkg({ liquidjs: '^10' }), 'paradox-liquid'],
  ['next dependency', pkg({ next: '15', react: '19' }), 'next'],
  ['next config file', { 'next.config.mjs': 'export default {}' }, 'next'],
  ['react without next', pkg({ react: '19', 'react-dom': '19' }), 'react'],
  ['plain html files', { 'index.html': '<p></p>' }, 'html'],
  ['nuxt', pkg({ nuxt: '3', vue: '3' }), 'unsupported-deferred'],
  ['vue', pkg({ vue: '3' }), 'unsupported-deferred'],
  ['stencil config file', { 'stencil.config.ts': '' }, 'unsupported-deferred'],
  ['nothing recognisable', pkg({ lodash: '4' }), 'unknown'],
];

for (const [name, files, id] of CASES) {
  test(`detectFramework: ${name} is ${id}`, () => {
    const root = project(files);
    try { assert.equal(detectFramework(root).id, id); } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test('detectFramework: deferred frameworks say which one and why nothing is traced', () => {
  const root = project(pkg({ nuxt: '3' }));
  try {
    const found = detectFramework(root);
    assert.equal(found.framework, 'nuxt');
    assert.match(found.message, /nuxt.*deferred/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the fixture site resolves to the paradox-liquid adapter', () => {
  const found = resolveAdapter(FIXTURE);
  assert.equal(found.id, 'paradox-liquid');
  assert.equal(found.adapter, getAdapter('paradox-liquid'));
  assert.equal(found.adapter.detect(FIXTURE), true);
  assert.deepEqual(found.adapter.supports, { local: true, preview: true });
});

test('paradox-liquid index lists elements with hand-counted lines', () => {
  const index = getAdapter('paradox-liquid').index(FIXTURE);
  // src/partials/header.liquid:5 is <a href="/benefits">; src/layouts/layout.liquid:5 is <title> (see trace-element.test.js).
  assert.ok(index.some((e) => e.file === 'src/partials/header.liquid' && e.line === 5 && e.tagName === 'a'));
  assert.ok(index.some((e) => e.file === 'src/layouts/layout.liquid' && e.line === 5 && e.tagName === 'title'));
});

test('paradox-liquid locate is what traceElement returns for the fixture', () => {
  const el = { outerHTML: '<title></title>', mode: 'local', pageFile: 'src/pages/index.liquid', root: FIXTURE, hasManifest: true };
  const viaAdapter = getAdapter('paradox-liquid').locate(el);
  assert.deepEqual(traceElement(el), viaAdapter);
  assert.equal(viaAdapter.candidates[0].file, 'src/layouts/layout.liquid');
  assert.equal(viaAdapter.candidates[0].line, 5);
});

test('unknown project: findings are untraceable with unknown-framework, never a guessed path', () => {
  const root = project(pkg({ lodash: '4' }));
  try {
    const result = traceElement({ outerHTML: '<a href="/x">x</a>', mode: 'local', root, hasManifest: true });
    assert.deepEqual(result, { confidence: 'untraceable', candidates: [], reason: 'unknown-framework' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('deferred and not-yet-implemented frameworks are untraceable with unsupported-framework', () => {
  for (const files of [pkg({ nuxt: '3' }), pkg({ next: '15' })]) {
    const root = project(files);
    try {
      const result = traceElement({ outerHTML: '<a href="/x">x</a>', mode: 'local', root, hasManifest: true });
      assert.equal(result.confidence, 'untraceable');
      assert.equal(result.reason, 'unsupported-framework');
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test('platform-owned still wins over an unknown framework', () => {
  const root = project(pkg({ lodash: '4' }));
  try {
    const result = traceElement({ outerHTML: '<div data-react-component="x"></div>', mode: 'local', root });
    assert.equal(result.reason, 'platform-owned');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('tracer.adapter in .scan-config.json overrides detection; an explicit adapter beats the config', () => {
  const root = project({ ...pkg({ lodash: '4' }), '.scan-config.json': { tracer: { adapter: 'paradox-liquid' } } });
  try {
    assert.equal(resolveAdapter(root).id, 'paradox-liquid');
    assert.equal(resolveAdapter(root, 'auto').id, 'unknown');
    assert.equal(resolveAdapter(root, 'nope').reason, 'unsupported-framework');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('config validation: tracer must be an object with a string adapter', () => {
  assert.deepEqual(validateConfig({ tracer: { adapter: 'next' } }), []);
  assert.deepEqual(validateConfig({ tracer: 'next' }), ['tracer must be an object']);
  assert.deepEqual(validateConfig({ tracer: { adapter: 3 } }), ['tracer.adapter must be a string']);
});

test('registerAdapter rejects an object that breaks the contract', () => {
  assert.throws(() => registerAdapter({ id: 'x' }), /adapter must be/);
  assert.deepEqual(listAdapters().map((a) => a.id), ['paradox-liquid', 'html', 'react']);
});

test('detectFramework honours source.pagesRoot and source.roots for custom-layout projects', () => {
  const cfg = (source) => ({ '.scan-config.json': { source } });
  const a = project({ 'site/pages/a.liquid': '<p></p>', ...cfg({ pagesRoot: 'site/pages' }) });
  const b = project({ 'tpl/x/a.liquid': '<p></p>', ...cfg({ roots: ['tpl/x'] }) });
  const c = project({ 'site/pages/a.liquid': '<p></p>' }); // same layout without config is not recognised
  try {
    assert.equal(detectFramework(a).id, 'paradox-liquid');
    assert.deepEqual(getAdapter('paradox-liquid').index(a), [{ file: 'site/pages/a.liquid', line: 1, tagName: 'p' }]);
    assert.equal(detectFramework(b).id, 'paradox-liquid');
    assert.equal(detectFramework(c).id, 'unknown');
  } finally { for (const r of [a, b, c]) rmSync(r, { recursive: true, force: true }); }
});

test('importing only adapters/index.js registers paradox-liquid, html and react', () => {
  const idx = join(dirname(fileURLToPath(import.meta.url)), '../src/tracer/adapters/index.js');
  const out = spawnSync(process.execPath, ['--input-type=module', '-e', `import(${JSON.stringify(idx)}).then((m) => console.log(m.listAdapters().map((a) => a.id)))`], { encoding: 'utf8' });
  assert.equal(out.stdout.trim(), "[ 'paradox-liquid', 'html', 'react' ]", out.stderr);
});
