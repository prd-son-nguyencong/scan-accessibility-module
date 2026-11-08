import './helpers/hermetic-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { liveBrowserChildren } from './helpers/browser-leak-guard.mjs';

// A stand-in for Chromium: a child whose command line contains "headless".
const fakeBrowser = () => spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)', '--', 'headless-fake'], { stdio: 'ignore' });

test('liveBrowserChildren finds a headless child of this process and ignores others', async () => {
  assert.deepEqual(liveBrowserChildren(), []);
  const child = fakeBrowser();
  try {
    await once(child, 'spawn');
    assert.deepEqual(liveBrowserChildren().map((r) => r.pid), [child.pid]);
  } finally {
    child.kill('SIGKILL');
  }
});

test('a test file that leaves a browser running fails instead of hanging', () => {
  const script = `
    import { test } from 'node:test';
    import { spawn } from 'node:child_process';
    test('leaks', () => { spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)', '--', 'headless-fake'], { stdio: 'ignore' }); });
  `;
  const run = spawnSync(process.execPath, ['--import', new URL('./helpers/browser-leak-guard.mjs', import.meta.url).href, '--input-type=module', '-e', script], {
    env: { ...process.env, ADA_SCAN_TEST_LEAK_GRACE_MS: '300' }, encoding: 'utf8', timeout: 30_000,
  });
  assert.notEqual(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stderr, /browser-leak-guard: 1 headless browser process/);
});
