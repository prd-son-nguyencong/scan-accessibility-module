import './helpers/hermetic-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { planTracingBuild, writeWrapperConfig, findViteConfig } from '../src/tracer/vite-wrapper.js';

const MODULE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Neutral project: a vite config WITHOUT the instrumentation plugin and a stand-in local vite binary.
function project(configName, configSource, script = 'vite build') {
  const root = mkdtempSync(path.join(tmpdir(), 'trace-wrap-'));
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { 'build:vite': script } }));
  writeFileSync(path.join(root, configName), configSource);
  mkdirSync(path.join(root, 'node_modules/vite/bin'), { recursive: true });
  // Stand-in for `vite build --config <file>`: resolve the config like vite does, run the plugin hooks, emit one page.
  writeFileSync(path.join(root, 'node_modules/vite/bin/vite.js'), `
import path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
const argv = process.argv.slice(2);
const cfgFile = path.resolve(argv[argv.indexOf('--config') + 1]);
const mod = await import(cfgFile);
let cfg = mod.default; cfg = typeof cfg === 'function' ? await cfg({ command: 'build', mode: 'production' }) : await cfg;
const plugin = (cfg.plugins || []).flat().find((p) => p && p.name === 'scan-instrumentation');
if (!plugin) { console.error('NO_PLUGIN'); process.exit(7); }
plugin.configResolved({ root: process.cwd(), build: { outDir: cfg.build?.outDir || 'dist' } });
const out = path.join(process.cwd(), cfg.build?.outDir || 'dist');
mkdirSync(path.join(out, 'pages'), { recursive: true });
writeFileSync(path.join(out, 'pages/index.html'), '<html><body>x</body></html>');
await plugin.closeBundle.handler();
`);
  mkdirSync(path.join(root, 'src/pages'), { recursive: true });
  writeFileSync(path.join(root, 'src/pages/index.liquid'), '<p>x</p>');
  return root;
}
const rm = (d) => rmSync(d, { recursive: true, force: true });

const CONFIG_FORMS = {
  'vite.config.mjs object': ['vite.config.mjs', 'export default { build: { outDir: "dist" }, plugins: [] };'],
  'vite.config.js function': ['vite.config.js', 'export default ({ mode }) => ({ build: { outDir: "dist" }, define: { M: mode } });'],
  'vite.config.mjs async function': ['vite.config.mjs', 'export default async () => { await 0; return { plugins: [[{ name: "other" }]] }; };'],
  'vite.config.mjs promise': ['vite.config.mjs', 'export default Promise.resolve({ build: { outDir: "dist" } });'],
};

for (const [label, [name, src]] of Object.entries(CONFIG_FORMS)) {
  test(`zero-config tracing builds a manifest through a temporary wrapper: ${label}`, () => {
    const root = project(name, src);
    try {
      const before = readFileSync(path.join(root, name), 'utf8');
      const plan = planTracingBuild(root, {});
      assert.equal(plan.mode, 'wrapped');
      const w = writeWrapperConfig(root, plan.configFile);
      assert.ok(w.file.startsWith(path.join(root, '.ada-scan', 'tmp')));
      const res = spawnSync(plan.cmd, [...plan.args, '--config', w.file], {
        cwd: root, encoding: 'utf8', env: { ...process.env, SCAN_MODE: 'true', ADA_SCAN_ROOT: root },
      });
      assert.equal(res.status, 0, res.stderr);
      assert.deepEqual(JSON.parse(readFileSync(path.join(root, 'dist/scan-manifest.json'), 'utf8')), { 'dist/pages/index.html': 'src/pages/index.liquid' });
      w.cleanup();
      assert.deepEqual(readdirSync(path.join(root, '.ada-scan/tmp')), []);
      assert.equal(readFileSync(path.join(root, name), 'utf8'), before, 'project config untouched');
    } finally { rm(root); }
  });
}

test('a config that already registers the plugin is not wrapped (paired true case)', () => {
  const root = project('vite.config.mjs', "import { scanInstrumentationPlugin } from 'ada-scan/vite';\nexport default { plugins: [scanInstrumentationPlugin()] };");
  try { assert.equal(planTracingBuild(root, {}).mode, 'native'); } finally { rm(root); }
});

test('the wrapper does not add a second plugin when the config builds one dynamically', () => {
  const root = project('vite.config.mjs', 'export default { plugins: [{ name: "scan-instrumentation" }] };');
  try {
    const w = writeWrapperConfig(root, path.join(root, 'vite.config.mjs'));
    const out = spawnSync(process.execPath, ['--input-type=module', '-e', `const c = await (await import(${JSON.stringify(pathToFileURL(w.file).href)})).default({}); console.log(c.plugins.length)`], { encoding: 'utf8', cwd: MODULE_ROOT });
    assert.equal(out.stdout.trim(), '1', out.stderr);
  } finally { rm(root); }
});

test('unavailable plans carry a precise reason and remedy', () => {
  const complex = project('vite.config.mjs', 'export default {};', 'node prep.js && vite build');
  const noVite = project('vite.config.mjs', 'export default {};');
  const noConfig = project('vite.config.mjs', 'export default {};');
  try {
    const a = planTracingBuild(complex, {});
    assert.equal(a.mode, 'unavailable');
    assert.match(a.reason, /not a plain "vite build"/);
    assert.match(a.remedy, /ada-scan\/vite/);
    rmSync(path.join(noVite, 'node_modules'), { recursive: true });
    assert.match(planTracingBuild(noVite, {}).reason, /local vite binary not found/);
    rmSync(path.join(noConfig, 'vite.config.mjs'));
    assert.equal(findViteConfig(noConfig), null);
    assert.match(planTracingBuild(noConfig, {}).reason, /no vite config found/);
  } finally { [complex, noVite, noConfig].forEach(rm); }
});

test('flags of the build script are kept and --config in the script selects the config; custom commands and opt-out are left alone', () => {
  const root = project('vite.config.mjs', 'export default {};', 'vite build --mode staging -c conf/site.mjs');
  try {
    mkdirSync(path.join(root, 'conf'));
    writeFileSync(path.join(root, 'conf/site.mjs'), 'export default {};');
    const plan = planTracingBuild(root, {});
    assert.equal(plan.mode, 'wrapped');
    assert.equal(plan.configFile, path.join(root, 'conf/site.mjs'));
    assert.deepEqual(plan.args.slice(1), ['build', '--mode', 'staging']);
    assert.equal(planTracingBuild(root, { buildCommand: 'node build.js' }).mode, 'native');
    assert.equal(planTracingBuild(root, { autoInstrument: false }).mode, 'native');
  } finally { rm(root); }
});

test('buildInstrumented end to end: no plugin in the config still yields a manifest, and the wrapper is cleaned up', () => {
  const root = project('vite.config.mjs', 'export default { build: { outDir: "dist" } };');
  try {
    const script = `import('${pathToFileURL(path.join(MODULE_ROOT, 'src/tracer/build-instrumented.js')).href}').then(async (m) => { const a = await m.buildInstrumented(true, {}); console.log(JSON.stringify(a)); })`;
    const res = spawnSync(process.execPath, ['-e', script], { cwd: root, encoding: 'utf8', env: { ...process.env, ADA_SCAN_ROOT: root, ADA_SCAN_NO_DOTENV: '1' } });
    assert.equal(res.status, 0, res.stderr + res.stdout);
    const att = JSON.parse(res.stdout.trim().split('\n').pop());
    assert.equal(att.entryCount, 1);
    assert.doesNotMatch(res.stdout + res.stderr, /produced no scan manifest/);
    assert.equal(existsSync(path.join(root, '.ada-scan/tmp')) ? readdirSync(path.join(root, '.ada-scan/tmp')).length : 0, 0);
  } finally { rm(root); }
});
