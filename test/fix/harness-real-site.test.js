// Harness on a real-site shape: a Paradox build emits fragments only, so the harness must serve the dev composition, answer clean URLs,
// share node_modules into the shadow and say so when a build cannot find its modules. Fixture: test/fixtures/harness-paradox-fragments (no customer code).
import '../helpers/hermetic-env.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runHarness, siteAdapterFor, HarnessError } from '../../src/fix/harness/index.js';
import { createStaticSiteAdapter } from '../../src/fix/verify/site.js';
import { execFileSync } from 'node:child_process';

const FRAGMENTS = new URL('../fixtures/harness-paradox-fragments', import.meta.url).pathname;
const SITE = new URL('../fixtures/harness-site', import.meta.url).pathname;
const work = mkdtempSync(join(tmpdir(), 'harness-real-'));
after(() => rmSync(work, { recursive: true, force: true }));

function fragmentProject(name) {
  const dir = join(work, name);
  cpSync(FRAGMENTS, dir, { recursive: true });
  execFileSync('node', ['build.mjs'], { cwd: dir });
  return dir;
}
const get = async (url, path) => { const r = await fetch(new URL(path, url)); return { status: r.status, type: r.headers.get('content-type'), body: await r.text() }; };

test('site adapter choice: vite when the project has a vite config, static otherwise, harness.site overrides, bad value refused', () => {
  const vite = fragmentProject('choice');
  assert.equal(siteAdapterFor({ outDir: 'dist' }, vite).kind, 'vite');
  assert.equal(siteAdapterFor({ outDir: 'dist', site: 'auto' }, vite).kind, 'vite');
  assert.equal(siteAdapterFor({ outDir: 'dist', site: 'static' }, vite).kind, 'static');
  assert.equal(siteAdapterFor({ outDir: 'dist' }, SITE).kind, 'static', 'the fixture corpus has no vite config');
  assert.equal(siteAdapterFor({ outDir: 'dist', site: 'vite' }, SITE).kind, 'vite');
  const own = createStaticSiteAdapter();
  assert.equal(siteAdapterFor({ outDir: 'dist', site: own }, vite), own, 'an adapter object passes through');
  assert.throws(() => siteAdapterFor({ outDir: 'dist', site: 'nope' }, vite), { code: 'CONFIG_INVALID' });
});

test('static adapter on fragments: clean URLs answer, but the page is a bare fragment; the vite adapter serves the composed document', async () => {
  const dir = fragmentProject('serve');
  const stat = await createStaticSiteAdapter({ outDir: 'dist' }).start(dir);
  try {
    const about = await get(stat.url, '/about');
    assert.equal(about.status, 200, 'clean URL /about falls back to about.html');
    assert.match(about.type, /text\/html/);
    assert.doesNotMatch(about.body, /<title>/, 'a Paradox dist is only fragments: no head, so a static scan is meaningless');
    assert.equal((await get(stat.url, '/')).status, 200);
    assert.equal((await get(stat.url, '/about.html')).status, 200);
    assert.equal((await get(stat.url, '/404')).status, 404, 'a route that is not in the build still answers 404');
    assert.notEqual((await get(stat.url, '/..%2f..%2fbuild.mjs')).status, 200, 'containment is unchanged: the project file next to dist is not served');
  } finally { await stat.stop(); }

  const { createViteSiteAdapter } = await import('../../src/fix/verify/site.js');
  const vite = await createViteSiteAdapter().start(dir);
  try {
    const home = await get(vite.url, '/about');
    assert.equal(home.status, 200);
    assert.match(home.body, /<title>Fragment site<\/title>[\s\S]*<h1>About<\/h1>/, 'layout and fragment composed');
  } finally { await vite.stop(); }
});

test('a shadow build that needs node_modules works by default and fails with an actionable hint when sharing is off', async () => {
  const dir = join(work, 'deps');
  mkdirSync(join(dir, 'node_modules/dep'), { recursive: true });
  writeFileSync(join(dir, 'node_modules/dep/package.json'), '{"name":"dep","version":"1.0.0","main":"index.js"}');
  writeFileSync(join(dir, 'node_modules/dep/index.js'), 'module.exports = 1;');
  writeFileSync(join(dir, 'build.cjs'), "require('dep'); require('fs').mkdirSync('dist', { recursive: true });");
  const base = { build: { command: 'node', args: ['build.cjs'] }, routes: ['/'], runDir: join(work, 'deps-run') };
  const stopHere = { async start() { throw new Error('site stub reached'); } }; // the build passed: nothing after it is under test
  await assert.rejects(() => runHarness({ projectDir: dir, fixer: { propose() {} }, config: { ...base, site: stopHere } }), /site stub reached/);
  await assert.rejects(
    () => runHarness({ projectDir: dir, fixer: { propose() {} }, config: { ...base, runDir: join(work, 'deps-run2'), shareNodeModules: false, site: stopHere } }),
    (e) => e instanceof HarnessError && e.code === 'BASELINE_BUILD_FAILED' && /Hint: .*shareNodeModules/.test(e.message),
  );
  // No node_modules in the project: the hint says to install, and an unrelated failure gets no hint.
  rmSync(join(dir, 'node_modules'), { recursive: true });
  await assert.rejects(() => runHarness({ projectDir: dir, fixer: { propose() {} }, config: { ...base, runDir: join(work, 'deps-run3'), site: stopHere } }), /Hint: the project has no node_modules/);
  writeFileSync(join(dir, 'build.cjs'), 'process.exit(3);');
  await assert.rejects(() => runHarness({ projectDir: dir, fixer: { propose() {} }, config: { ...base, runDir: join(work, 'deps-run4'), site: stopHere } }), (e) => e.code === 'BASELINE_BUILD_FAILED' && !/Hint/.test(e.message));
});

test('an install run inside the shadow never writes through to the project node_modules', async () => {
  const dir = join(work, 'prep');
  mkdirSync(join(dir, 'node_modules/dep'), { recursive: true });
  writeFileSync(join(dir, 'node_modules/dep/package.json'), '{"name":"dep","version":"1.0.0"}');
  writeFileSync(join(dir, 'prep.cjs'), "require('fs').mkdirSync('node_modules/dep', { recursive: true }); require('fs').writeFileSync('node_modules/dep/INSTALLED_BY_PREPARE', 'x');");
  writeFileSync(join(dir, 'build.cjs'), "require('fs').mkdirSync('dist', { recursive: true });");
  const stopHere = { async start() { throw new Error('site stub reached'); } };
  const base = { build: { command: 'node', args: ['build.cjs'] }, prepare: { command: 'node', args: ['prep.cjs'] }, routes: ['/'], site: stopHere };
  await assert.rejects(() => runHarness({ projectDir: dir, fixer: { propose() {} }, config: { ...base, runDir: join(work, 'prep-run') } }), /site stub reached/);
  assert.equal(existsSync(join(dir, 'node_modules/dep/INSTALLED_BY_PREPARE')), false, 'the project node_modules stays untouched');
  // An explicit shareNodeModules: true still links (the user accepted the write-through).
  await assert.rejects(() => runHarness({ projectDir: dir, fixer: { propose() {} }, config: { ...base, runDir: join(work, 'prep-run2'), shareNodeModules: true } }), /site stub reached/);
  assert.equal(existsSync(join(dir, 'node_modules/dep/INSTALLED_BY_PREPARE')), true);
});

test('fix looks up .scan-config.json in --source, not in the working directory', async () => {
  const { runFixSubcommand } = await import('../../src/index.js');
  const withCfg = join(work, 'cfg-yes'), without = join(work, 'cfg-no');
  mkdirSync(withCfg, { recursive: true });
  mkdirSync(without, { recursive: true });
  writeFileSync(join(withCfg, '.scan-config.json'), JSON.stringify({ verifyBuildCommand: 'node build.mjs' }));
  const warnings = [];
  const orig = console.warn;
  console.warn = (...a) => warnings.push(a.join(' '));
  try {
    for (const src of [withCfg, without]) await assert.rejects(() => runFixSubcommand(['--harness', '--source', src, '--report', join(src, 'missing.json'), '--out-dir', join(src, 'out')]), { code: 'REPORT_NOT_FOUND' });
  } finally { console.warn = orig; }
  assert.equal(warnings.length, 1, warnings.join('\n'));
  assert.match(warnings[0], /\.scan-config\.json not found/);
});

test('a harness run on --source reads .scan-config.json from --source all the way through the scan: no warning, thirdParty honoured', async () => {
  const { runFixSubcommand } = await import('../../src/index.js');
  const { buildScanReportV2 } = await import('../../src/reporter/report-v2.js');
  const { getThirdPartyConfig } = await import('../../src/utils/third-party.js');
  const dir = fragmentProject('src-cfg');
  writeFileSync(join(dir, '.scan-config.json'), JSON.stringify({ verifyBuildCommand: 'node build.mjs', thirdParty: { chatbotSelector: '.fromSourceConfig' } }));
  const run = { layer: 'axe', engine: { name: 'axe-core', version: '4.12.1' }, status: 'complete' };
  const report = buildScanReportV2([{ name: '/', page: '/', url: 'http://localhost:1234/', scannerRuns: [run], violations: [] }], {
    generatedAt: '2026-10-27T00:00:00.000Z', producer: { name: 'ada-scan', version: '1.0.1' }, target: { mode: 'local-only', url: 'http://localhost:1234/' },
  });
  const reportPath = join(dir, 'latest.json');
  writeFileSync(reportPath, JSON.stringify(report));
  const warnings = [];
  const orig = console.warn;
  console.warn = (...a) => warnings.push(a.join(' '));
  try {
    const out = await runFixSubcommand(['--harness', '--source', dir, '--report', reportPath, '--out-dir', join(dir, 'out'), '--dry-run']);
    assert.ok(out, 'the harness ran past the baseline scan');
    assert.equal(getThirdPartyConfig().chatbotSelector, '.fromSourceConfig');
  } finally { console.warn = orig; }
  assert.deepEqual(warnings.filter((w) => /scan-config/.test(w)), []);
});
