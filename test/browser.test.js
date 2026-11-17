import { test, mock } from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { newPage, getBrowser, closeBrowser } from '../src/scanner/browser.js';

test('newPage applies the requested viewport without changing the scanner user agent', async () => {
  let contextOptions;
  const page = {
    on() {},
  };
  const browser = {
    async newContext(options) {
      contextOptions = options;
      return {
        setDefaultTimeout() {},
        async newPage() {
          return page;
        },
      };
    },
  };

  const result = await newPage(browser, {
    viewport: { width: 390, height: 844 },
  });

  assert.equal(result, page);
  assert.deepEqual(contextOptions.viewport, { width: 390, height: 844 });
  assert.match(contextOptions.userAgent, /ADA-Scanner\/1\.0/);
});

test('newPage closes its context when the page cannot be created', async () => {
  let closed = false;
  const browser = {
    async newContext() {
      return { setDefaultTimeout() {}, newPage: async () => { throw new Error('boom'); }, close: async () => { closed = true; } };
    },
  };
  await assert.rejects(newPage(browser), /boom/);
  assert.equal(closed, true);
});

test('closeBrowser kills the Chromium children when close() never returns', async () => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)', '--', 'headless-fake'], { stdio: 'ignore' });
  const exited = once(child, 'exit');
  const launch = mock.method(chromium, 'launch', async () => ({ on() {}, close: () => new Promise(() => {}) }));
  try {
    await once(child, 'spawn');
    await getBrowser();
    await closeBrowser({ timeoutMs: 100 });
    const [, signal] = await exited;
    assert.equal(signal, 'SIGKILL');
  } finally {
    launch.mock.restore();
    child.kill('SIGKILL');
  }
});

test('closeBrowser leaves other processes alone when close() returns in time', async () => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)', '--', 'headless-fake'], { stdio: 'ignore' });
  const launch = mock.method(chromium, 'launch', async () => ({ on() {}, close: async () => {} }));
  try {
    await once(child, 'spawn');
    await getBrowser();
    await closeBrowser({ timeoutMs: 100 });
    assert.equal(child.exitCode, null);
    assert.equal(child.signalCode, null);
  } finally {
    launch.mock.restore();
    child.kill('SIGKILL');
  }
});
