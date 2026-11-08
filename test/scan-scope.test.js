import './helpers/hermetic-env.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { runBounded, runInScope } from '../src/utils/scan-scope.js';
import { newPage, getBrowser, closeBrowser } from '../src/scanner/browser.js';
import { startParadoxSite } from './helpers/paradox-site-server.js';
import { DEFAULT_CONFIG } from '../src/utils/config.js';
import { scanOnePage } from '../src/index.js';

after(closeBrowser);

const never = () => new Promise(() => {});
const stubContext = () => {
  const ctx = { closed: 0, setDefaultTimeout() {}, close: async () => { ctx.closed += 1; }, newPage: async () => ({ on() {} }) };
  return ctx;
};

test('a layer past its deadline is a TimeoutError, its contexts are closed, and the next layer is unaffected', async () => {
  const ctx = stubContext();
  await assert.rejects(runBounded(async () => { await newPage({ newContext: async () => ctx }); await never(); }, 40, 'layer x'), { name: 'TimeoutError', message: 'layer x timed out after 40ms' });
  assert.equal(ctx.closed, 1, 'abandoned layer context must be closed');

  const next = stubContext();
  assert.equal(await runBounded(async () => { await newPage({ newContext: async () => next }); return 'ok'; }, 1000, 'layer y'), 'ok');
  assert.equal(next.closed, 0, 'the next layer keeps its context');
});

test('a context an abandoned layer opens after the deadline is closed at once and the layer is stopped', async () => {
  const late = stubContext();
  let release;
  const slow = { newContext: () => new Promise((r) => { release = () => r(late); }) };
  let stopped;
  await assert.rejects(runBounded(() => newPage(slow).catch((e) => { stopped = e; throw e; }), 40, 'layer z'), { name: 'TimeoutError' });
  release();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(late.closed, 1);
  assert.equal(stopped?.name, 'CancelledError');
});

test('work still running when closeBrowser is called cannot relaunch Chromium (it would hold the process open forever)', async () => {
  let go;
  const gate = new Promise((r) => { go = r; });
  const abandoned = runInScope(async () => { await gate; return getBrowser(); });
  await closeBrowser();
  go();
  await assert.rejects(abandoned, { name: 'CancelledError' });
  assert.equal(await runInScope(async () => 5), 5, 'a scope started after closeBrowser is not cancelled');
});

test('scanOnePage: every layer past a 1 ms deadline reports timeout, the scan completes, and no context stays open', { timeout: 120_000 }, async () => {
  const site = await startParadoxSite();
  try {
    const layers = ['axe', 'keyboard', 'focusTrap', 'dynamicContent'];
    const cfg = { ...structuredClone(DEFAULT_CONFIG), layers: Object.fromEntries(Object.keys(DEFAULT_CONFIG.layers).map((k) => [k, layers.includes(k)])) };
    const result = await scanOnePage({ name: 'home', url: site.url }, cfg, { isUrlMode: true, reverify: false, layerDeadlineMs: 1 });
    const status = Object.fromEntries(result.scannerRuns.map((r) => [r.layer ?? r.id ?? r.name, r.status]));
    for (const l of layers) assert.equal(status[l], 'timeout', l);
    await new Promise((r) => setTimeout(r, 1500)); // abandoned work may still be unwinding
    assert.equal((await getBrowser()).contexts().length, 0, 'no leaked context');
  } finally {
    await site.close();
  }
});
