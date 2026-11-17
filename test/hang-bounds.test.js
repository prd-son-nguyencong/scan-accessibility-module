import './helpers/hermetic-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withTimeout } from '../src/utils/with-timeout.js';
import { newPage } from '../src/scanner/browser.js';
import { createScanContext, openScanPage } from '../src/scanner/session.js';

const never = () => new Promise(() => {});

// Stand-ins for a wedged Chromium: the protocol calls below never settle.
const stubContext = (over = {}) => {
  const ctx = { closed: 0, setDefaultTimeout() {}, close: () => { ctx.closed += 1; return never(); }, newPage: async () => stubPage(ctx), ...over };
  return ctx;
};
const stubPage = (ctx) => ({ on() {}, context: () => ctx, addInitScript: async () => {}, evaluate: async () => {}, exposeBinding: async () => {}, goto: async () => ({ status: () => 200 }), waitForLoadState: async () => {}, title: never, content: async () => '' });

test('withTimeout rejects a never-settling promise with a named TimeoutError and passes results through', async () => {
  await assert.rejects(withTimeout(never(), 40, 'x'), { name: 'TimeoutError', message: 'x timed out after 40ms' });
  assert.equal(await withTimeout(Promise.resolve(7), 40, 'x'), 7);
  await assert.rejects(withTimeout(Promise.reject(new Error('boom')), 40, 'x'), /boom/);
});

test('newPage fails fast when newContext never answers, and closes a context that opens late', async () => {
  let release;
  const late = stubContext({ close: async () => { late.closed += 1; } });
  const browser = { newContext: () => new Promise((r) => { release = () => r(late); }) };
  await assert.rejects(newPage(browser, { opTimeoutMs: 40 }), /browser\.newContext timed out after 40ms/);
  release();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(late.closed, 1, 'late context must be closed');
});

test('newPage fails fast when newPage never answers and still tries to close the context', async () => {
  const ctx = stubContext({ newPage: never });
  await assert.rejects(newPage({ newContext: async () => ctx }, { opTimeoutMs: 40 }), /context\.newPage timed out after 40ms/);
  assert.equal(ctx.closed, 1);
});

test('closing a scan context whose close() never returns resolves instead of hanging', async () => {
  const ctx = stubContext();
  const { close } = await createScanContext({ newContext: async () => ctx }, { opTimeoutMs: 40 });
  await close();
  assert.equal(ctx.closed, 1);
});

test('openScanPage reports a hung renderer (title never answers) as a timeout and closes the context', async () => {
  const ctx = stubContext();
  await assert.rejects(openScanPage({ newContext: async () => ctx }, 'http://x.test/', { opTimeoutMs: 40, probeTimeoutMs: 40 }), /page\.title timed out after 40ms/);
  assert.equal(ctx.closed, 1);
});

test('createScanContext fails fast when the runtime-hook evaluate never answers', async () => {
  const ctx = stubContext({ newPage: async () => ({ ...stubPage(ctx), evaluate: never }) });
  await assert.rejects(createScanContext({ newContext: async () => ctx }, { opTimeoutMs: 40 }), /installRuntimeHooks timed out after 40ms/);
  assert.equal(ctx.closed, 1);
});
