import './helpers/hermetic-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAdapter, resolveAdapter } from '../src/tracer/adapters/index.js';
import { transformJsx } from '../src/tracer/adapters/react-transform.js';
import { hashSourceFiles } from '../src/tracer/preimage.js';
import { reactSourceAttrPlugin } from '../vite/react-source-attr.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/trace-react');
const read = (f) => readFileSync(join(ROOT, f), 'utf8');
const react = getAdapter('react');
const summary = (f) => transformJsx(read(f), { file: f }).elements.map((e) => `${e.tag}:${e.line}`);

// Lines read off the fixture files by hand.
test('transform: host elements get data-ada-src, fragments, components, regex, generics and comments are skipped', () => {
  assert.deepEqual(summary('src/App.jsx'), ['main:10', 'h1:11', 'img:12', 'button:16', 'p:19', 'span:19']);
  assert.deepEqual(summary('src/Card.jsx'), ['section:3', 'h2:4', 'a:5']);
  assert.deepEqual(summary('src/Typed.tsx'), []); // its only element already carries the attribute
  const { code } = transformJsx(read('src/App.jsx'), { file: 'src/App.jsx' });
  assert.ok(code.includes('<main data-ada-src="src/App.jsx:10" className="app">'));
  assert.ok(code.includes('<img data-ada-src="src/App.jsx:12" src="/hero.png" alt="" />'));
  assert.ok(code.includes('<Card key={i} title={i} />'));
  assert.ok(code.includes('<>fragment</>'));
  assert.ok(transformJsx(read('src/Card.jsx'), { file: 'c.jsx' }).code.includes('/<div>/g'));
  assert.equal(code.split('\n').length, read('src/App.jsx').split('\n').length);
  assert.equal(transformJsx(code, { file: 'src/App.jsx' }).code, code, 'running it twice adds nothing');
});

test('transform: unbalanced markup is left untouched, never half-edited', () => {
  const src = 'const a = <div><span>oops</div>;\nconst b = <p>ok</p>;\n';
  const { code, elements } = transformJsx(src, { file: 'x.jsx' });
  assert.deepEqual(elements.map((e) => `${e.tag}:${e.line}`), ['p:2']);
  assert.ok(code.includes('<div><span>oops</div>'));
});

// Rendered HTML below is what react-dom/server prints for the transformed fixtures (react is not installed here).
const rendered = {
  h1: '<h1 data-ada-src="src/App.jsx:11" id="title">Careers Count: few</h1>',
  card: '<a data-ada-src="src/Card.jsx:5" href="/apply">Apply</a>',
};

function withBuild(fn) {
  const root = mkdtempSync(join(tmpdir(), 'ada-react-'));
  try {
    cpSync(ROOT, root, { recursive: true });
    const sourceHashes = hashSourceFiles(root, ['src/App.jsx', 'src/Card.jsx']);
    fn({ root, sourceHashes });
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test('detect: a react project resolves to the react adapter', () => {
  assert.equal(resolveAdapter(ROOT).id, 'react');
});

test('locate: data-ada-src with a matching build hash is high', () => {
  withBuild(({ root, sourceHashes }) => {
    writeFileSync(join(root, 'm.json'), JSON.stringify({ sourceHashes }));
    const r = react.locate({ outerHTML: rendered.h1, root, reactManifest: 'm.json' });
    assert.equal(r.confidence, 'high');
    assert.deepEqual(r.candidates.map((c) => `${c.file}:${c.line}`), ['src/App.jsx:11']);
    assert.equal(r.reason, null);
  });
});

test('locate: without a manifest the same verified line is medium, not high', () => {
  const r = react.locate({ outerHTML: rendered.card, root: ROOT });
  assert.equal(r.confidence, 'medium');
  assert.deepEqual(r.candidates.map((c) => `${c.file}:${c.line}`), ['src/Card.jsx:5']);
});

test('locate: a malformed manifest hash is never verified', () => {
  withBuild(({ root }) => {
    for (const hash of ['garbage', '', 0, null, 'sha256:abc', {}]) {
      writeFileSync(join(root, 'm.json'), JSON.stringify({ sourceHashes: { 'src/App.jsx': hash } }));
      const r = react.locate({ outerHTML: rendered.h1, root, reactManifest: 'm.json' });
      assert.deepEqual(r, { confidence: 'untraceable', candidates: [], reason: 'manifest-invalid' }, JSON.stringify(hash));
    }
    // a manifest that lacks this file behaves like no manifest: medium, with the unrecorded evidence
    writeFileSync(join(root, 'm.json'), JSON.stringify({ sourceHashes: {} }));
    assert.equal(react.locate({ outerHTML: rendered.h1, root, reactManifest: 'm.json' }).confidence, 'medium');
  });
});

test('export map: ada-scan/vite/react resolves to the plugin file and its types', async () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, '../../../package.json'), 'utf8'));
  assert.deepEqual(pkg.exports['./vite/react'], { types: './vite/index.d.ts', default: './vite/react-source-attr.js' });
  const mod = await import('ada-scan/vite/react');
  assert.equal(typeof mod.reactSourceAttrPlugin, 'function');
  assert.match(readFileSync(join(ROOT, '../../../vite/index.d.ts'), 'utf8'), /reactSourceAttrPlugin/);
});

test('locate: a file edited after the build is untraceable (source-changed-since-build)', () => {
  withBuild(({ root, sourceHashes }) => {
    writeFileSync(join(root, 'm.json'), JSON.stringify({ sourceHashes }));
    writeFileSync(join(root, 'src/Card.jsx'), `// new first line\n${read('src/Card.jsx')}`);
    const r = react.locate({ outerHTML: rendered.card, root, reactManifest: 'm.json' });
    assert.deepEqual(r, { confidence: 'untraceable', candidates: [], reason: 'source-changed-since-build' });
  });
});

test('locate: wrong tag at that line, missing marker, hostile path and platform widgets never get a path', () => {
  const untraceable = (outerHTML, reason) => assert.deepEqual(react.locate({ outerHTML, root: ROOT }), { confidence: 'untraceable', candidates: [], reason });
  untraceable('<h2 data-ada-src="src/App.jsx:11">x</h2>', 'no-match'); // line 11 is an h1
  untraceable('<h1 data-ada-src="src/App.jsx:99">x</h1>', 'no-match');
  untraceable('<h1 id="title">no attribute (platform markup)</h1>', 'no-marker');
  untraceable('<h1 data-ada-src="../../etc/passwd:1">x</h1>', 'no-match');
  untraceable('<h1 data-ada-src="/etc/passwd:1">x</h1>', 'no-match');
  untraceable('<h1 data-ada-src="src/Gone.jsx:1">x</h1>', 'page-source-missing');
  untraceable('<div data-react-component="jobs" data-ada-src="src/App.jsx:10"></div>', 'platform-owned');
});

test('index lists every host element with its line', () => {
  const idx = react.index(ROOT).filter((e) => e.file === 'src/Card.jsx');
  assert.deepEqual(idx.map((e) => `${e.tagName}:${e.line}`), ['section:3', 'h2:4', 'a:5']);
});

test('vite plugin: transforms only under SCAN_MODE, emits hashes of the transformed files', () => {
  const plugin = reactSourceAttrPlugin();
  plugin.configResolved({ root: ROOT });
  const file = join(ROOT, 'src/Card.jsx');
  const prev = process.env.SCAN_MODE;
  try {
    process.env.SCAN_MODE = 'false';
    assert.equal(plugin.transform(read('src/Card.jsx'), file), null);
    process.env.SCAN_MODE = 'true';
    assert.equal(plugin.transform('const a = 1;', join(ROOT, 'src/x.js')), null);
    const out = plugin.transform(read('src/Card.jsx'), `${file}?v=1`);
    assert.ok(out.code.includes('<section data-ada-src="src/Card.jsx:3" className="card">'));
    const emitted = [];
    plugin.generateBundle.call({ emitFile: (f) => emitted.push(f) });
    assert.equal(emitted[0].fileName, 'ada-react-src.json');
    assert.deepEqual(JSON.parse(emitted[0].source).sourceHashes, hashSourceFiles(ROOT, ['src/Card.jsx']));
  } finally {
    if (prev === undefined) delete process.env.SCAN_MODE; else process.env.SCAN_MODE = prev;
  }
});
