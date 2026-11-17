import './helpers/hermetic-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const MODULES = ['src/utils/config.js'];
const REPO = path.resolve(import.meta.dirname, '..');

for (const mod of MODULES) {
  test(`ADA_SCAN_NO_DOTENV keeps a module-root .env out of ${mod}`, () => {
    const root = mkdtempSync(path.join(tmpdir(), 'ada-dotenv-'));
    try {
      writeFileSync(path.join(root, '.env'), 'ADA_DOTENV_PROBE=leaked\n');
      const code = `await import(${JSON.stringify(path.join(REPO, mod))}); console.log(process.env.ADA_DOTENV_PROBE ?? 'unset');`;
      const run = (extra) => spawnSync(process.execPath, ['--input-type=module', '-e', code], {
        env: { ...process.env, ADA_SCAN_ROOT: root, ...extra }, encoding: 'utf8',
      });
      assert.equal(run({ ADA_SCAN_NO_DOTENV: '1' }).stdout.trim(), 'unset');
      assert.equal(run({ ADA_SCAN_NO_DOTENV: '' }).stdout.trim(), 'leaked'); // control: the .env is otherwise read
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
