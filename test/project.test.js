import './helpers/hermetic-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveProject } from '../src/utils/project.js';
import { urlToPageFile } from '../src/utils/paths.js';
import { DEFAULT_CONFIG } from '../src/utils/config.js';
import { scanInstrumentationPlugin } from '../vite/scan-instrumentation.js';

const tmp = () => realpathSync(mkdtempSync(path.join(tmpdir(), 'ada-project-')));
const write = (file, text) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
};

test('resolveProject follows outDir and source, and rebases the default distMap', () => {
  const p = resolveProject({ ...DEFAULT_CONFIG, outDir: 'build/site/', source: { pagesRoot: 'app/pages' } }, '/r');
  assert.equal(p.outDir, 'build/site');
  assert.equal(p.distDir, '/r/build/site');
  assert.equal(p.manifestPath, '/r/build/site/scan-manifest.json');
  assert.equal(p.pagesDir, '/r/app/pages');
  assert.equal(p.srcDir, '/r/app');
  assert.equal(p.extension, '.liquid');
  assert.equal(p.distMap[0].dist, 'build/site/partials/');
  const custom = [{ dist: 'x/', src: 'y/' }];
  assert.deepEqual(resolveProject({ outDir: 'build', distMap: custom }, '/r').distMap, custom);
  assert.equal(resolveProject({}, '/r').outDir, 'dist');
});

test('urlToPageFile ignores trailing slashes', () => {
  assert.equal(urlToPageFile('/jobs/'), 'src/pages/jobs.liquid');
  assert.equal(urlToPageFile('/jobs/detail/'), 'src/pages/jobs/detail.liquid');
  assert.equal(urlToPageFile('/'), 'src/pages/index.liquid');
  assert.equal(urlToPageFile('/jobs', { pagesRoot: 'app/pages/' }), 'app/pages/jobs.liquid');
});

test('tracing works with a non-default outDir', () => {
  const root = tmp();
  write(path.join(root, '.scan-config.json'), JSON.stringify({ outDir: 'build' }));
  write(path.join(root, 'build/partials/layout/header.html'), '<header><a href="/x" class="nav-link-unique">Go</a></header>');
  write(path.join(root, 'build/scan-manifest.json'), JSON.stringify({ 'build/partials/layout/header.html': 'src/partials/layout/header.liquid' }));
  write(path.join(root, 'src/partials/layout/header.liquid'), '<header>\n<a href="/x" class="nav-link-unique">Go</a></header>');
  const script = `
    const { mapViolationToSource } = await import(${JSON.stringify(path.resolve('src/tracer/partial-map.js'))});
    const a = await mapViolationToSource({ html: '<a href="/x" class="nav-link-unique">Go</a>' }, 'http://localhost/jobs/');
    const b = await mapViolationToSource({ html: '<b>nothing matches this snippet</b>' }, 'http://localhost/jobs/');
    console.log(JSON.stringify([a, b]));`;
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, ADA_SCAN_ROOT: root, ADA_SCAN_NO_DOTENV: '1' },
    encoding: 'utf8',
  });
  assert.equal(res.status, 0, res.stderr);
  const [a, b] = JSON.parse(res.stdout.trim().split('\n').pop());
  assert.equal(a.file, 'src/partials/layout/header.liquid');
  assert.equal(a.method, 'instrumentation-manifest');
  assert.equal(b.file, 'src/pages/jobs.liquid');
});

test('keyboard and screen-reader resolvers never report above medium (no element markup for traceElement to confirm)', () => {
  const root = tmp();
  write(path.join(root, 'dist/index.html'), '<main><!-- scan:begin:src/partials/nav.liquid --><a href="/only-here">Go somewhere</a><!-- scan:end:src/partials/nav.liquid --></main>');
  write(path.join(root, 'src/partials/nav.liquid'), '<nav>\n<a href="/only-here">Go somewhere</a>\n</nav>');
  const script = `
    const m = await import(${JSON.stringify(path.resolve('src/tracer/resolve-source.js'))});
    const a = await m.resolveFromElementText('A', 'Go somewhere', 'http://localhost/');
    const b = await m.resolveFromHref('/only-here', 'http://localhost/');
    console.log(JSON.stringify([a, b]));`;
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, ADA_SCAN_ROOT: root, ADA_SCAN_NO_DOTENV: '1' },
    encoding: 'utf8',
  });
  assert.equal(res.status, 0, res.stderr);
  const [a, b] = JSON.parse(res.stdout.trim().split('\n').pop());
  for (const r of [a, b]) {
    assert.equal(r.originFile, 'src/partials/nav.liquid');
    assert.equal(r.originLine, 2, 'hand-checked: the link is on line 2 of the partial');
    assert.equal(r.confidence, 'medium');
  }
});

test('vite plugin reads outDir from the resolved config and skips failed builds', async () => {
  const root = tmp();
  write(path.join(root, 'out/pages/index.html'), '<html><head></head><body></body></html>');
  const prev = process.env.SCAN_MODE;
  process.env.SCAN_MODE = 'true';
  try {
    const failed = scanInstrumentationPlugin();
    failed.configResolved({ root, build: { outDir: 'out' } });
    failed.buildEnd(new Error('boom'));
    await failed.closeBundle.handler();
    assert.equal(existsSync(path.join(root, 'out/scan-manifest.json')), false);

    const plugin = scanInstrumentationPlugin();
    assert.equal(plugin.closeBundle.order, 'post');
    plugin.configResolved({ root, build: { outDir: 'out' } });
    plugin.buildEnd();
    await plugin.closeBundle.handler();
    const manifest = JSON.parse(readFileSync(path.join(root, 'out/scan-manifest.json'), 'utf8'));
    assert.deepEqual(manifest, { 'out/pages/index.html': 'src/pages/index.liquid' });
    assert.ok(!readdirSync(path.join(root, 'out')).some((f) => f.endsWith('.tmp')));
  } finally {
    if (prev === undefined) delete process.env.SCAN_MODE; else process.env.SCAN_MODE = prev;
  }
});

test('without a source project nothing guesses a src/pages path', () => {
  const root = tmp(); // no src/pages, no manifest: a remote scan from a bare cwd
  const script = `
    const m = await import(${JSON.stringify(path.resolve('src/tracer/partial-map.js'))});
    const a = await m.mapViolationToSource({ html: '<b>nothing matches this snippet</b>' }, 'https://example.test/jobs/');
    const b = await m.mapDescriptionToSource('https://example.test/');
    console.log(JSON.stringify([a, b]));`;
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, ADA_SCAN_ROOT: root, ADA_SCAN_NO_DOTENV: '1' },
    encoding: 'utf8',
  });
  assert.equal(res.status, 0, res.stderr);
  for (const s of JSON.parse(res.stdout.trim().split('\n').pop())) {
    assert.deepEqual([s.file, s.confidence, s.method], ['unknown', 'none', 'no-source-project']);
  }
});
