import { chmodSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DemoPackageManagerError, resolvePackageManager } from '../../src/fix/demo/package-manager.js';

test('resolvePackageManager returns absolute real path for absolute executable input', () => {
  const resolved = resolvePackageManager(process.execPath);
  assert.match(resolved, /^\//);
  assert.equal(resolved, realpathSync(process.execPath));
  const stat = lstatSync(resolved);
  assert.equal(stat.isFile(), true);
  assert.equal(stat.isSymbolicLink(), false);
});

test('resolvePackageManager finds executable on PATH without shell', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-demo-pm-path-'));
  try {
    const binDir = join(root, 'bin');
    mkdirSync(binDir, { recursive: true });
    const pnpmPath = join(binDir, 'pnpm');
    writeFileSync(pnpmPath, '#!/usr/bin/env node\n');
    chmodSync(pnpmPath, 0o755);
    const resolved = resolvePackageManager('pnpm', { PATH: binDir });
    assert.match(resolved, /pnpm$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolvePackageManager rejects missing manager on empty PATH', () => {
  assert.throws(
    () => resolvePackageManager('pnpm-not-installed', { PATH: '' }),
    (error) => error instanceof DemoPackageManagerError && error.code === 'PACKAGE_MANAGER_NOT_FOUND',
  );
});

test('resolvePackageManager rejects non-executable absolute path', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-demo-pm-bad-'));
  try {
    const filePath = join(root, 'pnpm');
    writeFileSync(filePath, 'not executable\n');
    assert.throws(
      () => resolvePackageManager(filePath),
      (error) => error instanceof DemoPackageManagerError && error.code === 'PACKAGE_MANAGER_NOT_EXECUTABLE',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
