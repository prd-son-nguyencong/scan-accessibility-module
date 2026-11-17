import './helpers/hermetic-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCliArgs, CliError } from '../src/utils/cli-args.js';
import {
  validateConfig, loadConfig, resetConfigCache, mergeConfig, derivePageName, DEFAULT_CONFIG, ConfigError,
} from '../src/utils/config.js';
import { selectChangedPages } from '../src/index.js';
import { createViolation } from '../src/schema.js';
import { loadHostScanConfig } from '../vite/scan-instrumentation.js';

const BIN = fileURLToPath(new URL('../bin/ada-scan.js', import.meta.url));
const ROOT = fileURLToPath(new URL('..', import.meta.url));

function tmpRoot(configText) {
  const dir = mkdtempSync(path.join(tmpdir(), 'ada-cfg-'));
  if (configText !== undefined) writeFileSync(path.join(dir, '.scan-config.json'), configText);
  return dir;
}
function runBin(args, env = {}) {
  return spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    timeout: 60000,
    env: { ...process.env, ADA_SCAN_ROOT: ROOT, ADA_SCAN_NO_DOTENV: '1', ADA_SCAN_DEPLOYMENT_URL: '', ...env },
  });
}

test('argv: --flag=value, short -h and booleans parse', () => {
  const v = parseCliArgs(['--layers=axe,w3c', '--page=/about', '-h', '--verbose']);
  assert.equal(v.layers, 'axe,w3c');
  assert.equal(v.page, '/about');
  assert.equal(v.help, true);
  assert.equal(v.verbose, true);
});

test('argv: unknown flag, missing value, flag as value, positional and conflicts are CliErrors (exit 2)', () => {
  for (const args of [
    ['--bogus'], ['--page'], ['--page', '--verbose'], ['stray'],
    ['--include-third-party', '--exclude-third-party'], ['--psi', '--no-psi'], ['--url', 'http://x', '--page', 'a'],
  ]) {
    assert.throws(() => parseCliArgs(args), (e) => e instanceof CliError && e.exitCode === 2, args.join(' '));
  }
});

test('bin: --help exits 0 and prints usage without scanning', () => {
  const r = runBin(['--help']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Usage:/);
  assert.doesNotMatch(r.stdout, /ADA & Performance Scanner/);
});

test('bin: unknown --layers name exits 2', () => {
  const r = runBin(['--layers', 'acessScan']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Unknown --layers value: acessScan/);
});

test('bin: unknown flag exits 2', () => {
  assert.equal(runBin(['--nope']).status, 2);
});

test('bin: broken .scan-config.json exits 2 with a clear message', () => {
  const dir = tmpRoot('{ not json');
  try {
    const r = runBin(['--no-server'], { ADA_SCAN_ROOT: dir });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /Cannot read .*\.scan-config\.json/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('validateConfig accepts the defaults and reports each bad known key', () => {
  assert.deepEqual(validateConfig(DEFAULT_CONFIG), []);
  const errs = validateConfig({
    concurrency: -1,
    thresholds: { wcag: 'x', performance: 150 },
    layers: { w3c: 'no', typo: true },
    pages: [{ name: 'a' }, { path: '/a' }, { path: '/a/' }],
    thirdParty: { preset: 'wat' },
    baseUrl: 5,
  });
  for (const frag of ['concurrency', 'thresholds.wcag', 'thresholds.performance', 'layers.w3c', 'layers.typo', 'pages[0]', 'duplicate page name', 'thirdParty.preset', 'baseUrl']) {
    assert.ok(errs.some((e) => e.includes(frag)), `${frag} in ${JSON.stringify(errs)}`);
  }
  assert.deepEqual(validateConfig([]), ['config must be a JSON object']);
});

test('loadConfig throws ConfigError on invalid JSON and invalid values, warns on missing file', () => {
  const bad = tmpRoot('{');
  const invalid = tmpRoot('{"concurrency":0}');
  const missing = tmpRoot();
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.throws(() => loadConfig(bad), ConfigError);
    assert.throws(() => loadConfig(invalid), /concurrency must be an integer/);
    assert.equal(loadConfig(missing).concurrency, DEFAULT_CONFIG.concurrency);
  } finally {
    console.warn = warn;
    resetConfigCache();
    for (const d of [bad, invalid, missing]) rmSync(d, { recursive: true, force: true });
  }
});

test('loadConfig reads once per root, returns copies and defaults page names from the path', () => {
  const dir = tmpRoot('{"pages":[{"path":"/"},{"path":"/about/team"},{"path":"/x","name":"custom"}]}');
  try {
    const a = loadConfig(dir);
    assert.deepEqual(a.pages.map((p) => p.name), ['homepage', 'about-team', 'custom']);
    writeFileSync(path.join(dir, '.scan-config.json'), '{');
    const b = loadConfig(dir); // cached: the later breakage is not re-read
    b.pages.length = 0;
    assert.equal(loadConfig(dir).pages.length, 3);
  } finally {
    resetConfigCache();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('derivePageName', () => {
  assert.equal(derivePageName('/'), 'homepage');
  assert.equal(derivePageName('/jobs/'), 'jobs');
  assert.equal(derivePageName('https://example.com/a/b'), 'example.com-a-b');
});

test('thirdParty: array/null/false/none disable the Paradox preset; unset or paradox keep it', () => {
  for (const value of [[], null, false, { preset: 'none' }]) {
    const tp = mergeConfig(DEFAULT_CONFIG, { thirdParty: value }).thirdParty;
    assert.deepEqual([tp.selectors, tp.devArtifactTokens, tp.chatbotSelector], [[], [], ''], JSON.stringify(value));
  }
  assert.deepEqual(mergeConfig(DEFAULT_CONFIG, { thirdParty: ['.x'] }).thirdParty.selectors, ['.x']);
  assert.ok(mergeConfig(DEFAULT_CONFIG, {}).thirdParty.selectors.includes('.d3afa4'));
  assert.ok(mergeConfig(DEFAULT_CONFIG, { thirdParty: { preset: 'paradox' } }).thirdParty.selectors.includes('.d3afa4'));
  const custom = mergeConfig(DEFAULT_CONFIG, { thirdParty: { selectors: ['.y'] } }).thirdParty;
  assert.deepEqual(custom.selectors, ['.y']);
  assert.equal(custom.chatbotSelector, '.oliviaButton');
});

test('selectChangedPages maps page files to pages and falls back to all for shared templates', () => {
  const pages = [{ path: '/', name: 'homepage' }, { path: '/about', name: 'about' }, { path: '/about-us', name: 'about-us' }];
  assert.deepEqual(selectChangedPages(pages, ['src/pages/about.liquid.json']).pages.map((p) => p.name), ['about']);
  assert.deepEqual(selectChangedPages(pages, ['src/pages/index.liquid']).pages.map((p) => p.name), ['homepage']);
  assert.equal(selectChangedPages(pages, ['src/partials/header.liquid']).pages, pages);
  assert.match(selectChangedPages(pages, ['src/partials/header.liquid']).reason, /shared/);
  assert.match(selectChangedPages(pages, ['README.md']).reason, /no template changes/);
});

test('createViolation coerces an invalid impact to moderate', () => {
  assert.equal(createViolation({ ruleId: 'r', layer: 'axe', impact: 'bogus' }).impact, 'moderate');
  assert.equal(createViolation({ ruleId: 'r', layer: 'axe', impact: 'critical' }).impact, 'critical');
});

test('vite plugin config loader fails loudly on broken JSON', () => {
  const dir = tmpRoot('{ nope');
  const warn = console.warn;
  const warned = [];
  console.warn = (m) => warned.push(m);
  try {
    assert.throws(() => loadHostScanConfig(dir), /invalid \.scan-config\.json/);
    assert.equal(warned.length, 1);
  } finally {
    console.warn = warn;
    rmSync(dir, { recursive: true, force: true });
  }
});
