import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, realpathSync, readdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runInit } from '../src/init/index.js';
import { resetProjectRootCache } from '../src/utils/paths.js';
import { validateConfig } from '../src/utils/config.js';

const VITE = "import { defineConfig } from 'vite';\nexport default defineConfig({ plugins: [] });\n";
const PKG = '{"name":"host","scripts":{"dev":"vite"}}';

/** Runs init in a fresh host; returns the root and everything init printed. */
async function init(argv, setup = () => {}) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'ada-init-')));
  writeFileSync(path.join(root, 'package.json'), PKG);
  writeFileSync(path.join(root, 'vite.config.ts'), VITE);
  setup(root);
  const prev = process.env.ADA_SCAN_ROOT;
  process.env.ADA_SCAN_ROOT = root;
  resetProjectRootCache();
  const lines = [];
  const log = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try {
    await runInit(argv);
  } finally {
    console.log = log;
    if (prev === undefined) delete process.env.ADA_SCAN_ROOT; else process.env.ADA_SCAN_ROOT = prev;
    resetProjectRootCache();
  }
  return { root, out: lines.join('\n') };
}

const cfgPath = (root) => path.join(root, '.scan-config.json');

test('init creates only .scan-config.json with the seeded thresholds and touches nothing else', async () => {
  const { root, out } = await init([]);
  assert.deepEqual(readdirSync(root).sort(), ['.scan-config.json', 'package.json', 'vite.config.ts']);
  assert.equal(readFileSync(path.join(root, 'package.json'), 'utf8'), PKG);
  assert.equal(readFileSync(path.join(root, 'vite.config.ts'), 'utf8'), VITE);
  const cfg = JSON.parse(readFileSync(cfgPath(root), 'utf8'));
  assert.deepEqual(validateConfig(cfg), []);
  assert.deepEqual(
    [cfg.thresholds.lighthouse.mobile.performance, cfg.thresholds.lighthouse.desktop.performance],
    [80, 90],
  );
  assert.deepEqual([cfg.thresholds.a11y.critical, cfg.thresholds.a11y.serious, cfg.thresholds.w3c.errors], [0, 0, 0]);
  assert.equal(cfg.profile, 'standards');
  assert.deepEqual(cfg.pages, [{ path: '/', name: 'homepage' }]);
  assert.match(out, /scanInstrumentationPlugin/); // instructions, not edits
  assert.match(out, /npx playwright install chromium/);
});

test('init never overwrites an existing config; --force replaces it', async () => {
  const keep = (root) => writeFileSync(cfgPath(root), '{"mine":true}');
  const kept = await init([], keep);
  assert.equal(readFileSync(cfgPath(kept.root), 'utf8'), '{"mine":true}');
  assert.match(kept.out, /already exists/);
  const forced = await init(['--force'], keep);
  assert.equal(JSON.parse(readFileSync(cfgPath(forced.root), 'utf8')).profile, 'standards');
});

test('init --dry-run prints the file and writes nothing, even with --force', async () => {
  const fresh = await init(['--dry-run']);
  assert.equal(existsSync(cfgPath(fresh.root)), false);
  assert.match(fresh.out, /"thresholds"/);
  const existing = await init(['--dry-run', '--force'], (root) => writeFileSync(cfgPath(root), '{"mine":true}'));
  assert.equal(readFileSync(cfgPath(existing.root), 'utf8'), '{"mine":true}');
});

test('init rejects arguments it does not support', async () => {
  await assert.rejects(() => init(['--yes']), /unknown argument --yes/);
});

test('init --force replaces a symlinked config without writing through it', async () => {
  let target;
  const r = await init(['--force'], (root) => {
    target = path.join(root, 'elsewhere.json');
    writeFileSync(target, '{"keep":true}');
    symlinkSync(target, cfgPath(root));
  });
  assert.equal(readFileSync(target, 'utf8'), '{"keep":true}');
  assert.equal(JSON.parse(readFileSync(cfgPath(r.root), 'utf8')).profile, 'standards');
});
