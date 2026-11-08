import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runChecks, runDoctor } from '../src/doctor/index.js';

const tmp = () => mkdtempSync(path.join(tmpdir(), 'doctor-'));
const hdrs = (o = {}) => ({ get: (k) => o[k.toLowerCase()] ?? null });
const cfg = { baseUrl: 'http://localhost:1234', devCommand: 'pnpm dev', buildCommand: 'pnpm build:vite' };

/** Healthy baseline: host root with a build script, module outside any workspace. */
function setup(over = {}) {
  const root = tmp();
  const pkgRoot = tmp();
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { 'build:vite': 'vite build' } }));
  writeFileSync(path.join(root, 'vite.config.mjs'), "import { scanInstrumentationPlugin } from 'ada-scan/vite';\nexport default { plugins: [scanInstrumentationPlugin()] };\n");
  writeFileSync(path.join(pkgRoot, 'package.json'), JSON.stringify({ engines: { node: '>=20.18.1' } }));
  const deps = {
    root, pkgRoot, env: {}, nodeVersion: '24.1.0', config: async () => cfg,
    exec: () => null, launchChromium: async () => {}, fetch: async () => ({ status: 200, headers: hdrs() }),
    statfs: () => 50 * 1024 ** 3, ...over,
  };
  return { root, pkgRoot, deps, done: () => { rmSync(root, { recursive: true, force: true }); rmSync(pkgRoot, { recursive: true, force: true }); } };
}
const by = (results, name) => results.find((x) => x.name === name);

test('healthy environment passes every check and exits 0', async () => {
  const s = setup({ env: { CIS_MODEL: 'm' } });
  const lines = [];
  const code = await runDoctor([], s.deps, (l) => lines.push(l));
  const results = await runChecks({}, s.deps);
  assert.equal(code, 0);
  assert.deepEqual(results.map((x) => x.status), Array(9).fill('PASS'));
  assert.ok(lines.some((l) => l.startsWith('PASS  node')));
  s.done();
});

test('node older than engines fails with an install hint', async () => {
  const s = setup({ nodeVersion: '18.19.0' });
  const n = by(await runChecks({}, s.deps), 'node');
  assert.equal(n.status, 'FAIL');
  assert.match(n.hint, /20\.18\.1/);
  assert.equal(await runDoctor([], s.deps, () => {}), 1);
  s.done();
});

test('node major differing from .nvmrc warns', async () => {
  const s = setup();
  writeFileSync(path.join(s.root, '.nvmrc'), '22.1.0\n');
  assert.equal(by(await runChecks({}, s.deps), 'node').status, 'WARN');
  s.done();
});

test('chromium launch failure fails with an install hint', async () => {
  const s = setup({ launchChromium: async () => { throw new Error("Executable doesn't exist\nmore"); } });
  const c = by(await runChecks({}, s.deps), 'chromium');
  assert.equal(c.status, 'FAIL');
  assert.match(c.detail, /Executable doesn't exist$/);
  assert.match(c.hint, /playwright install/);
  s.done();
});

test('chromium launch hang is bounded at 20s', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const s = setup({ launchChromium: () => new Promise(() => {}) });
  const p = runChecks({}, s.deps);
  await new Promise((res) => setImmediate(res));
  t.mock.timers.tick(20_000);
  const c = by(await p, 'chromium');
  assert.equal(c.status, 'FAIL');
  assert.match(c.detail, /within 20s/);
  s.done();
});

test('pnpm 11 with a pnpm lockfile warns and names the env variable; setting it silences the warning', async () => {
  const s = setup({ exec: (cmd) => (cmd === 'pnpm' ? '11.26.0' : null) });
  writeFileSync(path.join(s.root, 'pnpm-lock.yaml'), '');
  const w = by(await runChecks({}, s.deps), 'package-manager');
  assert.equal(w.status, 'WARN');
  assert.match(w.detail, /implicit "pnpm install"/);
  assert.match(w.hint, /pnpm_config_verify_deps_before_run=false/);
  s.deps.env = { pnpm_config_verify_deps_before_run: 'false' };
  assert.equal(by(await runChecks({}, s.deps), 'package-manager').status, 'PASS');
  s.deps.exec = () => '10.4.0';
  s.deps.env = {};
  assert.equal(by(await runChecks({}, s.deps), 'package-manager').status, 'PASS');
  s.done();
});

test('lockfile older than package.json and duplicate lockfiles warn', async () => {
  const s = setup();
  for (const f of ['pnpm-lock.yaml', 'package-lock.json']) writeFileSync(path.join(s.root, f), '');
  const old = new Date(Date.now() - 3600_000);
  utimesSync(path.join(s.root, 'pnpm-lock.yaml'), old, old);
  const w = by(await runChecks({}, s.deps), 'package-manager');
  assert.equal(w.status, 'WARN');
  assert.match(w.detail, /several lockfiles \(pnpm-lock.yaml, package-lock.json\)/);
  assert.match(w.detail, /pnpm-lock.yaml is older than package.json/);
  s.done();
});

test('module nested inside another pnpm workspace warns', async () => {
  const s = setup();
  const nested = path.join(s.pkgRoot, 'inner');
  mkdirSync(nested);
  writeFileSync(path.join(s.pkgRoot, 'pnpm-workspace.yaml'), 'packages: []\n');
  s.deps.pkgRoot = nested;
  const w = by(await runChecks({}, s.deps), 'package-manager');
  assert.equal(w.status, 'WARN');
  assert.ok(w.detail.includes(`pnpm workspace at ${s.pkgRoot}`));
  s.done();
});

test('dev server: loopback baseUrl down warns, remote baseUrl is not probed', async () => {
  const calls = [];
  const s = setup({ fetch: async (u) => { calls.push(u); throw new Error('ECONNREFUSED'); } });
  const w = by(await runChecks({}, s.deps), 'dev-server');
  assert.equal(w.status, 'WARN');
  assert.match(w.hint, /pnpm dev/);
  assert.deepEqual(calls, ['http://localhost:1234']);
  s.deps.config = async () => ({ ...cfg, baseUrl: 'https://example.test/' });
  calls.length = 0;
  assert.equal(by(await runChecks({}, s.deps), 'dev-server').status, 'PASS');
  assert.deepEqual(calls, []);
  s.done();
});

test('build script missing warns; custom command passes; npm run names the script', async () => {
  const s = setup();
  writeFileSync(path.join(s.root, 'package.json'), JSON.stringify({ scripts: {} }));
  assert.equal(by(await runChecks({}, s.deps), 'build-script').status, 'WARN');
  s.deps.config = async () => ({ ...cfg, buildCommand: 'node build.js' });
  assert.equal(by(await runChecks({}, s.deps), 'build-script').status, 'PASS');
  s.deps.config = async () => ({ ...cfg, buildCommand: 'npm run site' });
  assert.match(by(await runChecks({}, s.deps), 'build-script').detail, /"site"/);
  s.done();
});

test('CIS env reports names only, never values', async () => {
  const s = setup({ env: { CIS_AUTH_TOKEN: 'sekret-value-123', CIS_MODEL: 'm' } });
  const out = by(await runChecks({}, s.deps), 'cis-env');
  assert.equal(out.status, 'PASS');
  assert.equal(out.detail, 'set: CIS_AUTH_TOKEN, CIS_MODEL');
  const lines = [];
  await runDoctor(['--json'], s.deps, (l) => lines.push(l));
  assert.ok(!lines.join('').includes('sekret-value-123'));
  s.deps.env = {};
  assert.equal(by(await runChecks({}, s.deps), 'cis-env').status, 'WARN');
  s.done();
});

test('output dir: probe leaves nothing behind; unwritable fails', async () => {
  const s = setup();
  const out = path.join(s.root, '.ada-scan');
  mkdirSync(out);
  assert.equal(by(await runChecks({ outDir: out }, s.deps), 'out-dir').status, 'PASS');
  assert.deepEqual(readdirSync(out), []);
  assert.deepEqual(readdirSync(s.root).sort(), ['.ada-scan', 'package.json', 'vite.config.mjs']);
  const missing = path.join(s.root, 'nope');
  assert.equal(by(await runChecks({ outDir: missing }, s.deps), 'out-dir').status, 'PASS');
  assert.equal(readdirSync(s.root).includes('nope'), false);
  s.deps.root = path.join(s.root, 'does-not-exist');
  assert.equal(by(await runChecks({ outDir: path.join(s.deps.root, 'x') }, s.deps), 'out-dir').status, 'FAIL');
  s.done();
});

test('disk space thresholds: 150 MiB fails, 500 MiB warns, 2 GiB passes', async () => {
  const s = setup();
  for (const [bytes, status] of [[150 * 1024 ** 2, 'FAIL'], [500 * 1024 ** 2, 'WARN'], [2 * 1024 ** 3, 'PASS']]) {
    s.deps.statfs = () => bytes;
    assert.equal(by(await runChecks({}, s.deps), 'disk-space').status, status);
  }
  s.done();
});

test('--url follows redirects, shows the chain and flags noindex; no --url means no url check', async () => {
  const pages = {
    'https://a.test/': { status: 301, headers: hdrs({ location: '/b' }) },
    'https://a.test/b': { status: 200, headers: hdrs({ 'x-robots-tag': 'noindex, nofollow' }) },
  };
  const s = setup({ fetch: async (u) => pages[u] ?? { status: 200, headers: hdrs() } });
  assert.equal(by(await runChecks({}, s.deps), 'url'), undefined);
  const u = by(await runChecks({ url: 'https://a.test/' }, s.deps), 'url');
  assert.equal(u.status, 'PASS');
  assert.match(u.detail, /^301 https:\/\/a\.test\/ -> 200 https:\/\/a\.test\/b .*noindex/);
  s.done();
});

test('--url: 404, network error, redirect loop fail; HEAD 405 falls back to GET', async () => {
  const s = setup({ fetch: async () => ({ status: 404, headers: hdrs() }) });
  assert.equal(by(await runChecks({ url: 'https://a.test/' }, s.deps), 'url').status, 'FAIL');
  s.deps.fetch = async () => { throw Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } }); };
  assert.match(by(await runChecks({ url: 'https://a.test/' }, s.deps), 'url').detail, /ENOTFOUND/);
  s.deps.fetch = async () => ({ status: 302, headers: hdrs({ location: '/again' }) });
  assert.match(by(await runChecks({ url: 'https://a.test/' }, s.deps), 'url').detail, /more than 5 redirects/);
  const methods = [];
  s.deps.config = async () => ({ ...cfg, baseUrl: 'https://example.test/' });
  s.deps.fetch = async (_u, init) => { methods.push(init.method); return { status: init.method === 'HEAD' ? 405 : 200, headers: hdrs() }; };
  assert.equal(by(await runChecks({ url: 'https://a.test/' }, s.deps), 'url').status, 'PASS');
  assert.deepEqual(methods, ['HEAD', 'GET']);
  s.done();
});

test('--json output is machine readable; config error is a FAIL; non-http --url is rejected', async () => {
  const s = setup();
  const lines = [];
  assert.equal(await runDoctor(['--json'], s.deps, (l) => lines.push(l)), 0);
  const parsed = JSON.parse(lines.join(''));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.checks.length, 9);
  s.deps.config = async () => { throw new Error('bad json'); };
  assert.equal(await runDoctor([], s.deps, () => {}), 1);
  await assert.rejects(runDoctor(['--url', 'ftp://x'], s.deps, () => {}), /http/);
  s.done();
});

test('tracing-ready: wrapped when the config lacks the plugin and vite is local, warns with a remedy when it cannot be wrapped', async () => {
  const s = setup();
  writeFileSync(path.join(s.root, 'vite.config.mjs'), 'export default {};\n');
  const t1 = by(await runChecks({}, s.deps), 'tracing-ready');
  assert.equal(t1.status, 'WARN');
  assert.match(t1.detail, /local vite binary not found/);
  assert.match(t1.hint, /Install the project dependencies/);
  mkdirSync(path.join(s.root, 'node_modules/vite/bin'), { recursive: true });
  writeFileSync(path.join(s.root, 'node_modules/vite/bin/vite.js'), '');
  const t2 = by(await runChecks({}, s.deps), 'tracing-ready');
  assert.equal(t2.status, 'PASS');
  assert.match(t2.detail, /temporary config/);
  writeFileSync(path.join(s.root, 'package.json'), JSON.stringify({ scripts: { 'build:vite': 'node prep.js && vite build' } }));
  const t3 = by(await runChecks({}, s.deps), 'tracing-ready');
  assert.equal(t3.status, 'WARN');
  assert.match(t3.detail, /not a plain "vite build"/);
  s.done();
});
