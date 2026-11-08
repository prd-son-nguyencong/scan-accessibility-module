import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { parseCliArgs } from '../../src/utils/cli-args.js';
import { fixModeError } from '../../src/fixer/fix-mode.js';

const CLI = path.resolve(import.meta.dirname, '../../bin/ada-scan.js');
const run = (args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout: 60_000 });

test('removed flags are refused with the v2 message', () => {
  for (const flag of ['--legacy-fix', '--ai', '--agent']) {
    assert.throws(() => parseCliArgs(['--fix', flag]), new RegExp(`${flag} was removed in v2; use "ada-scan fix --export" or --fix-mode cis`));
  }
});

test('--fix-mode: cis and absent are fine, writers are removed, anything else is invalid', () => {
  assert.equal(fixModeError(undefined), null);
  assert.equal(fixModeError('cis'), null);
  for (const m of ['claude', 'codex', 'cursor', 'windsurf', 'vscode']) assert.match(fixModeError(m), /removed in v2/);
  assert.match(fixModeError('nope'), /Invalid --fix-mode "nope"/);
});

test('CLI exits 2 for a removed flag or fix mode, for scan and for fix', () => {
  for (const args of [['--fix', '--legacy-fix'], ['--fix', '--ai'], ['--fix', '--fix-mode', 'claude'], ['fix', '--fix-mode', 'codex']]) {
    const res = run(args);
    assert.equal(res.status, 2, args.join(' '));
    assert.match(res.stderr, /removed in v2/);
  }
});
