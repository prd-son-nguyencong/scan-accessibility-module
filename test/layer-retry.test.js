import './helpers/hermetic-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFailedLayerRun } from '../src/index.js';
import { derivePageStatus, isTransientLayerError, runLayerWithRetry } from '../src/scanner/page-health.js';
import { validateConfig } from '../src/utils/config.js';

// A layer task shaped like the ones in scanOnePage: it reports its own failure as a scanner run.
const layerThatFails = (errors) => {
  let calls = 0;
  const task = async (violations, scannerRuns) => {
    const err = errors[calls++];
    if (err) scannerRuns.push(buildFailedLayerRun('axe', err));
    else scannerRuns.push({ layer: 'axe', status: 'complete', evidence: {} });
  };
  return { task, calls: () => calls };
};

test('transient layer errors: timeout, closed target, net::ERR_*; not programming errors', () => {
  for (const m of ['axe timed out after 60000ms', 'Target closed', 'page.evaluate: Execution context was destroyed', 'net::ERR_ABORTED at x', 'Target page, context or browser has been closed']) {
    assert.equal(isTransientLayerError(new Error(m)), true, m);
  }
  for (const m of ['x is not a function', 'invalid selector', 'Cannot read properties of undefined']) {
    assert.equal(isTransientLayerError(new Error(m)), false, m);
  }
});

test('layer that times out once is retried in a fresh context and ends ok', async () => {
  const { task, calls } = layerThatFails([new Error('axe timed out after 60000ms')]);
  const seen = [];
  const out = await runLayerWithRetry(async (v, r, isRetry) => { seen.push(isRetry); return task(v, r); });
  assert.equal(calls(), 2);
  assert.deepEqual(seen, [false, true]);
  assert.equal(out.attempts, 2);
  assert.match(out.reason, /timed out/);
  assert.equal(derivePageStatus(null, out.scannerRuns), 'ok');
});

test('layer that always fails transiently is attempted twice, then the page is partial', async () => {
  const e = new Error('Target closed');
  const { task, calls } = layerThatFails([e, e, e]);
  const out = await runLayerWithRetry(task);
  assert.equal(calls(), 2);
  assert.equal(out.attempts, 2);
  assert.equal(out.scannerRuns[0].status, 'error');
  assert.equal(derivePageStatus(null, out.scannerRuns), 'partial');
});

test('deterministic error is not retried', async () => {
  const { task, calls } = layerThatFails([new TypeError('x is not a function'), null]);
  const out = await runLayerWithRetry(task);
  assert.equal(calls(), 1);
  assert.equal(out.attempts, 1);
  assert.equal(derivePageStatus(null, out.scannerRuns), 'partial');
});

test('a thrown transient error is retried, a thrown deterministic one propagates', async () => {
  let n = 0;
  const out = await runLayerWithRetry(async (v, r) => {
    if (n++ === 0) throw new Error('net::ERR_NETWORK_CHANGED');
    r.push({ layer: 'x', status: 'complete', evidence: {} });
  });
  assert.equal(out.attempts, 2);
  await assert.rejects(runLayerWithRetry(async () => { throw new TypeError('bug'); }), /bug/);
});

test('axe.timeoutMs is validated', () => {
  assert.ok(validateConfig({ axe: { timeoutMs: 0 } }).some((e) => /axe\.timeoutMs/.test(e)));
  assert.ok(!validateConfig({ axe: { timeoutMs: 90000 } }).some((e) => /axe\.timeoutMs/.test(e)));
});
