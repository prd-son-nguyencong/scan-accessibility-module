import http from 'node:http';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

import { getBrowser, closeBrowser, resilientGoto } from '../src/scanner/browser.js';
import { scanAriaLiveRegions } from '../src/scanner/aria-live.js';
import { openScanPage } from '../src/scanner/session.js';
import { scanDynamicContent } from '../src/scanner/dynamic-content.js';
import { scanDeadLinks } from '../src/scanner/links.js';
import { buildScanReportV2 } from '../src/reporter/report-v2.js';
import { writeReport } from '../src/reporter/scan-report.js';
import { setReportsDir } from '../src/utils/paths.js';
import { resolveFromElementText, toSource } from '../src/tracer/resolve-source.js';
import { redactSensitiveHtml } from '../src/scanner/access-scan/signals/semantics.js';
import { collectSignalBundle } from '../src/scanner/access-scan/signals/index.js';
import { createScanSession } from '../src/scanner/access-scan/runtime/index.js';
import { MODE_METRIC_KEYS } from '../src/scanner/access-scan/policies/index.js';
import { requireBrowser } from './helpers/require-browser.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/fix/report-v2.json', import.meta.url), 'utf8'));

async function serve(routes) {
  const server = http.createServer((req, res) => {
    const route = routes[new URL(req.url, 'http://x').pathname] ?? routes['*'];
    if (typeof route === 'function') return route(req, res);
    res.writeHead(route?.status ?? 404, { 'content-type': 'text/html' }).end(route?.body ?? '');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

test('getBrowser memoizes concurrent launches and relaunches after a crash', async () => {
  const realLaunch = chromium.launch;
  let launches = 0;
  const fakes = [];
  chromium.launch = async () => {
    launches += 1;
    await new Promise((r) => setTimeout(r, 20));
    const handlers = {};
    const fake = { on: (evt, fn) => { handlers[evt] = fn; }, close: async () => {}, crash: () => handlers.disconnected() };
    fakes.push(fake);
    return fake;
  };
  try {
    await closeBrowser();
    const [a, b] = await Promise.all([getBrowser(), getBrowser()]);
    assert.equal(a, b);
    assert.equal(launches, 1);
    fakes[0].crash();
    const c = await getBrowser();
    assert.notEqual(c, a);
    assert.equal(launches, 2);
  } finally {
    chromium.launch = realLaunch;
    await closeBrowser();
  }
});

test('resilientGoto waits for load, bounds the idle wait and never navigates twice', async () => {
  const calls = [];
  const page = {
    goto: async (url, opts) => { calls.push(['goto', opts.waitUntil]); },
    waitForLoadState: async (state, opts) => { calls.push(['idle', state, opts.timeout]); throw new Error('Timeout'); },
  };
  await resilientGoto(page, 'http://x');
  assert.deepEqual(calls, [['goto', 'load'], ['idle', 'networkidle', 5000]]);
});

test('resilientGoto keeps a document whose load event never fires and still fails when none arrived', async () => {
  const doc = { request: () => ({ isNavigationRequest: () => true }), frame: () => 'main' };
  const handlers = {};
  const mk = (emit) => ({
    on: (ev, fn) => { handlers[ev] = fn; },
    off: () => {},
    mainFrame: () => 'main',
    goto: async () => { if (emit) handlers.response(doc); throw new Error('page.goto: Timeout 30000ms exceeded.'); },
    waitForLoadState: async () => {},
  });
  const kept = mk(true);
  assert.equal(await resilientGoto(kept, 'http://x'), doc);
  assert.equal(kept.adaLoadTimedOut, true);
  await assert.rejects(resilientGoto(mk(false), 'http://x'), /Timeout/);
});

test('aria-live scan survives SVG className objects', async (t) => {
  if (!(await requireBrowser(t))) return;
  const site = await serve({
    '/': { status: 200, body: '<html><body><svg class="error-icon"></svg><div class="error-box"></div><div role="alert" aria-live="polite" id="a"></div></body></html>' },
  });
  try {
    const result = await scanAriaLiveRegions(`${site.url}/`);
    assert.ok(result.violations.some((v) => v.rule === 'aria-live-alert-not-assertive'));
  } finally {
    site.close();
    await closeBrowser();
  }
});

test('dynamic-content keeps sibling results when one interaction cannot complete', async (t) => {
  if (!(await requireBrowser(t))) return;
  const site = await serve({
    '/': {
      status: 200,
      body: `<html><body>
        <div class="accordion"><button style="pointer-events:none" aria-expanded="false">Open</button></div>
        <form><input id="unlabeled" type="text"><input type="submit" id="go" value="Go"></form>
      </body></html>`,
    },
  });
  try {
    // Launch, context and navigation are CPU-load dependent and bounded elsewhere; time only the interactions.
    const scan = await openScanPage(await getBrowser(), `${site.url}/`);
    let result;
    let elapsed;
    try {
      const started = Date.now();
      result = await scanDynamicContent(`${site.url}/`, { page: scan.page });
      elapsed = Date.now() - started;
    } finally {
      await scan.close();
    }
    assert.ok(elapsed < 20000, `click must be bounded to a few seconds (took ${elapsed}ms)`);
    const rules = result.violations.map((v) => v.rule);
    assert.ok(rules.includes('form-field-no-label'));
    assert.equal(result.violations.filter((v) => v.rule === 'form-field-no-label').length, 1, 'submit button is not flagged');
  } finally {
    site.close();
    await closeBrowser();
  }
});

test('links layer retries HEAD-rejected URLs with GET before reporting dead', async () => {
  const seen = [];
  const site = await serve({
    '*': (req, res) => {
      seen.push(req.method + ' ' + req.url);
      if (req.url === '/blocks-head') return res.writeHead(req.method === 'HEAD' ? 405 : 200).end('ok');
      res.writeHead(404).end();
    },
  });
  const fakePage = {
    $$eval: async (selector) => selector.startsWith('a[href], link')
      ? [
        { tag: 'a', url: `${site.url}/blocks-head`, text: 'ok', html: '<a>', selector: 'a', linkRel: '' },
        { tag: 'a', url: `${site.url}/gone`, text: 'gone', html: '<a>', selector: 'a', linkRel: '' },
      ]
      : [],
  };
  try {
    const violations = await scanDeadLinks(fakePage, `${site.url}/`); // a loopback page may probe loopback links
    assert.deepEqual(violations.map((v) => v.ruleId), ['dead-link-404']);
    assert.ok(seen.includes('GET /blocks-head'));
  } finally {
    site.close();
  }
});

test('invalid findings downgrade with a validation warning instead of aborting the report', () => {
  const scanResults = structuredClone(fixture.scanResults);
  const good = scanResults[0].violations[0];
  scanResults[0].violations = [
    good,
    { ...good, ruleId: 'bad-impact', impact: 'layerCounts', element: { selector: '#x', outerHTML: '<b id="x"></b>' }, source: { file: '../../etc/passwd', line: 3, confidence: 'high', preimageSha256: 'nope' } },
    { ...good, ruleId: 'high-without-preimage', element: { selector: '#y', outerHTML: '<b id="y"></b>' }, source: { file: 'src/a.liquid', line: 3, confidence: 'high' } },
    null,
  ];
  const report = buildScanReportV2(scanResults, fixture.context);
  const byRule = Object.fromEntries(report.pages[0].findings.map((f) => [f.nativeRuleId, f]));
  assert.equal(byRule['bad-impact'].impact, 'moderate');
  assert.equal(byRule['bad-impact'].source.file, null);
  assert.equal(byRule['high-without-preimage'].source.confidence, 'medium');
  assert.ok(report.warnings.length >= 3);
  assert.ok(report.warnings.every((w) => w.type === 'validation'));
});

test('resolveFromElementText tolerates regex metacharacters and long text', async () => {
  const text = `${'a'.repeat(59)}(` + ' tail';
  await assert.doesNotReject(resolveFromElementText('a', text, 'http://localhost/'));
  assert.deepEqual(toSource({ originFile: 'src/p.liquid', originLine: 4, confidence: 'medium' }), { confidence: 'medium', file: 'src/p.liquid', line: 4 });
  assert.equal(toSource(null), null);
});

test('history directories are unique and reports are written atomically', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ada-hist-'));
  try {
    setReportsDir(dir);
    const dirs = new Set();
    for (let i = 0; i < 3; i += 1) dirs.add(writeReport(fixture.scanResults, fixture.context).histDir);
    assert.equal(dirs.size, 3);
    assert.equal(readdirSync(dir).filter((f) => f.endsWith('.tmp')).length, 0);
    assert.equal(JSON.parse(readFileSync(path.join(dir, 'latest.json'), 'utf8')).schemaVersion, '2.0.0');
  } finally {
    setReportsDir(null);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('redactSensitiveHtml keeps the snippet intact when the sensitive value is empty', () => {
  const html = redactSensitiveHtml({
    outerHTML: '<input type="password" value="" name="pw">',
    attributes: { type: 'password', value: '' },
  });
  assert.equal(html, '<input type="password" value="[redacted]" name="pw">');
});

test('signal metrics expose every key used by the accessScan policy', async (t) => {
  const browser = await requireBrowser(t);
  if (!browser) return;
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.setContent('<html><body><footer style="position:fixed;bottom:0">f</footer><main>m</main></body></html>');
    const session = await createScanSession(page);
    const bundle = collectSignalBundle({ snapshot: session.snapshot, session });
    for (const key of new Set(Object.values(MODE_METRIC_KEYS))) {
      assert.equal(typeof bundle.metrics[key], 'number', key);
    }
  } finally {
    await context.close();
    await closeBrowser();
  }
});
