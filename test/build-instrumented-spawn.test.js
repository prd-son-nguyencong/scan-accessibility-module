import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { buildInstrumented, resolveBuildSpawn } from '../src/tracer/build-instrumented.js';

const probe = fileURLToPath(new URL('./helpers/build-probe.mjs', import.meta.url));
const probeConfig = { buildCommand: `${process.execPath} ${probe}` };

test('build env disables pnpm implicit install by default', () => {
  const { env } = resolveBuildSpawn({}, {});
  assert.equal(env.pnpm_config_verify_deps_before_run, 'false');
  assert.equal(env.SCAN_MODE, 'true');
});

test('caller env and config.buildEnv can override the pnpm install check', () => {
  const fromCaller = resolveBuildSpawn({}, { pnpm_config_verify_deps_before_run: 'install' });
  assert.equal(fromCaller.env.pnpm_config_verify_deps_before_run, 'install');
  const fromConfig = resolveBuildSpawn(
    { buildEnv: { pnpm_config_verify_deps_before_run: 'error' } },
    {}
  );
  assert.equal(fromConfig.env.pnpm_config_verify_deps_before_run, 'error');
});

test('build timeout defaults to 10 minutes and honors config.buildTimeoutMs', () => {
  assert.equal(resolveBuildSpawn({}, {}).timeoutMs, 10 * 60 * 1000);
  assert.equal(resolveBuildSpawn({ buildTimeoutMs: 1234 }, {}).timeoutMs, 1234);
});

test('buildInstrumented passes the env to the real child process', async () => {
  const key = 'pnpm_config_verify_deps_before_run';
  const prev = process.env[key];
  delete process.env[key]; // ambient value would mask the default
  try {
    await buildInstrumented(true, probeConfig);
  } finally {
    if (prev !== undefined) process.env[key] = prev;
  }
});

test('buildInstrumented fails fast with a timeout message when the build hangs', async () => {
  const prev = process.env.BUILD_PROBE;
  process.env.BUILD_PROBE = 'hang';
  try {
    await assert.rejects(
      buildInstrumented(true, { ...probeConfig, buildTimeoutMs: 300 }),
      /timed out after 300ms/
    );
  } finally {
    if (prev === undefined) delete process.env.BUILD_PROBE;
    else process.env.BUILD_PROBE = prev;
  }
});
