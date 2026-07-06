import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runInit } from '../src/init/index.js';
import { resetProjectRootCache } from '../src/utils/paths.js';

function countOccurrences(str, needle) {
  return str.split(needle).length - 1;
}

function makeHost() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'ada-host-')));
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'host', scripts: { dev: 'vite' } }, null, 2));
  writeFileSync(
    path.join(root, 'vite.config.ts'),
    "import { defineConfig } from 'vite';\nexport default defineConfig({\n  plugins: [],\n});\n"
  );
  return root;
}

test('ada-scan init is idempotent and wires the host', async () => {
  const root = makeHost();
  const prevEnv = process.env.ADA_SCAN_ROOT;
  process.env.ADA_SCAN_ROOT = root;
  resetProjectRootCache();

  try {
    await runInit(['--no-browsers', '--yes']);

    // config scaffolded
    assert.ok(existsSync(path.join(root, '.scan-config.json')), 'config created');

    // scripts added
    const pkg1 = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
    assert.equal(pkg1.scripts.scan, 'ada-scan');
    assert.equal(pkg1.scripts.dev, 'vite'); // pre-existing preserved
    const scriptCount1 = Object.keys(pkg1.scripts).length;

    // vite plugin registered exactly once
    const vite1 = readFileSync(path.join(root, 'vite.config.ts'), 'utf8');
    assert.equal(countOccurrences(vite1, 'ada-scan/vite'), 1);
    assert.equal(countOccurrences(vite1, 'scanInstrumentationPlugin()'), 1);

    // second run — no duplicate edits
    await runInit(['--no-browsers', '--yes']);
    const pkg2 = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
    assert.equal(Object.keys(pkg2.scripts).length, scriptCount1);
    const vite2 = readFileSync(path.join(root, 'vite.config.ts'), 'utf8');
    assert.equal(countOccurrences(vite2, 'ada-scan/vite'), 1);
    assert.equal(countOccurrences(vite2, 'scanInstrumentationPlugin()'), 1);
  } finally {
    if (prevEnv === undefined) delete process.env.ADA_SCAN_ROOT;
    else process.env.ADA_SCAN_ROOT = prevEnv;
    resetProjectRootCache();
  }
});
