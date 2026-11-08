import './helpers/hermetic-env.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { scanPages } from '../src/index.js';
import { isTransientFailure } from '../src/scanner/page-health.js';
import { buildScanReportV2 } from '../src/reporter/report-v2.js';
import { closeBrowser } from '../src/scanner/browser.js';
import { requireBrowser } from './helpers/require-browser.js';
import { startParadoxSite } from './helpers/paradox-site-server.js';

after(() => closeBrowser());

test('isTransientFailure: timeouts, 5xx and resets retry; DNS and 4xx do not', () => {
  assert.equal(isTransientFailure({ reason: 'timeout' }), true);
  assert.equal(isTransientFailure({ reason: 'http-status', httpStatus: 503 }), true);
  assert.equal(isTransientFailure({ reason: 'navigation-error', message: 'net::ERR_CONNECTION_RESET at x' }), true);
  assert.equal(isTransientFailure({ reason: 'navigation-error', message: 'net::ERR_NAME_NOT_RESOLVED at x' }), false);
  assert.equal(isTransientFailure({ reason: 'http-status', httpStatus: 404 }), false);
  assert.equal(isTransientFailure(null), false);
});

test('scanPages: flaky page retried once, 404 not retried, slow page does not reorder, --max-time skips', async (t) => {
  if (!await requireBrowser(t)) return;
  let flakyHits = 0;
  const html = '<!doctype html><html lang="en"><title>T</title><main><h1>Hi</h1></main></html>';
  const site = await startParadoxSite({
    routes: {
      '/flaky': (req, res) => {
        if (flakyHits++ === 0) return res.writeHead(503).end('<title>busy</title>');
        res.writeHead(200, { 'content-type': 'text/html' }).end(html);
      },
      '/slow': (req, res) => setTimeout(() => res.writeHead(200, { 'content-type': 'text/html' }).end(html), 600),
    },
  });
  const page = (p) => ({ name: p.slice(1) || 'home', path: p, url: `${site.url}${p}` });
  const config = { layers: {}, concurrency: 2 };
  const errLines = [];
  const origError = console.error;
  console.error = (...a) => errLines.push(a.join(' '));
  try {
    // /slow first: it completes last, yet results keep input order
    const pages = [page('/slow'), page('/flaky'), page('/missing'), page('/jobs')];
    const { pageResults, pageRuns } = await scanPages(pages, config, { isUrlMode: false });
    assert.deepEqual(pageResults.map((r) => r.name), ['slow', 'flaky', 'missing', 'jobs']);
    assert.deepEqual(pageResults.map((r) => r.status), ['ok', 'ok', 'failed', 'ok']);
    assert.deepEqual(pageRuns.map((r) => r.attempts), [1, 2, 1, 1]);
    assert.equal(flakyHits, 2);
    assert.ok(pageRuns.every((r) => r.durationMs >= 0));
    assert.equal(errLines.filter((l) => /^\[\d\/4\] /.test(l)).length, 4);
    assert.ok(errLines.some((l) => /^\[4\/4\] \//.test(l)));

    // budget already spent: nothing starts, every page is skipped and counts as incomplete
    const skipped = await scanPages([page('/jobs'), page('/')], config, { isUrlMode: false, maxTimeSec: 1e-9 });
    assert.deepEqual(skipped.pageResults.map((r) => r.failure.reason), ['skipped', 'skipped']);
    const report = buildScanReportV2(
      skipped.pageResults.map((r) => ({ page: r.name, url: r.url, violations: [], scannerRuns: r.scannerRuns, status: r.status, failure: r.failure })),
      { producer: { version: '0.0.0' }, scan: { concurrency: 2, retries: 0, pages: skipped.pageRuns } },
    );
    assert.equal(report.summary.pagesFailed, 2);
    assert.equal(report.runMetadata.scan.pages.length, 2);
  } finally {
    console.error = origError;
    await site.close();
  }
});

test('scanPages flags a noindex target by robots meta and by X-Robots-Tag header', async (t) => {
  if (!await requireBrowser(t)) return;
  const body = (head) => `<!doctype html><html lang="en"><head><title>T</title>${head}</head><body><main><h1>Hi</h1></main></body></html>`;
  const site = await startParadoxSite({
    routes: {
      '/meta': (req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(body('<meta name="robots" content="noindex, nofollow">')),
      '/header': (req, res) => res.writeHead(200, { 'content-type': 'text/html', 'x-robots-tag': 'noindex' }).end(body('')),
      '/open': (req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(body('<meta name="robots" content="index,follow">')),
    },
  });
  const origError = console.error;
  console.error = () => {};
  try {
    const pages = ['/meta', '/header', '/open'].map((p) => ({ name: p.slice(1), path: p, url: `${site.url}${p}` }));
    const { pageResults } = await scanPages(pages, { layers: {}, concurrency: 2 }, { isUrlMode: false });
    assert.deepEqual(pageResults.map((r) => r.noindex), [true, true, false]);
  } finally {
    console.error = origError;
    await site.close();
  }
});
