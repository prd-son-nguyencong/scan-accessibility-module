import './helpers/hermetic-env.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanOnePage, computeExitCode } from '../src/index.js';
import { classifyNavigation, derivePageStatus } from '../src/scanner/page-health.js';
import { buildReportBundle, printConsoleSummary } from '../src/reporter/scan-report.js';
import { buildHtml } from '../src/reporter/html.js';
import { closeBrowser } from '../src/scanner/browser.js';
import { requireBrowser } from './helpers/require-browser.js';
import { startParadoxSite } from './helpers/paradox-site-server.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
after(() => closeBrowser());

test('classifyNavigation: status, allowStatus and challenge pages', () => {
  assert.equal(classifyNavigation({ status: 200, title: 'Careers' }), null);
  assert.equal(classifyNavigation({ status: 404 }).reason, 'http-status');
  assert.equal(classifyNavigation({ status: 404, allowStatus: [404] }), null);
  assert.equal(classifyNavigation({ status: 500 }).httpStatus, 500);
  assert.equal(classifyNavigation({ status: 403, title: 'Just a moment...' }).reason, 'bot-challenge');
  // markers win over allowStatus and over a 200
  assert.equal(classifyNavigation({ status: 200, html: '<script>window._cf_chl_opt={}</script>' }).reason, 'bot-challenge');
  assert.equal(classifyNavigation({ status: 403, allowStatus: [403], title: 'Attention Required! | Cloudflare' }).reason, 'bot-challenge');
});

test('computeExitCode: 2 beats 1, --no-fail keeps 2, --allow-incomplete drops it', () => {
  const flags = { failOnViolations: true };
  assert.equal(computeExitCode({ occurrenceCount: 0 }, flags), 0);
  assert.equal(computeExitCode({ occurrenceCount: 3 }, flags), 1);
  assert.equal(computeExitCode({ occurrenceCount: 3 }, { ...flags, noFail: true }), 0);
  assert.equal(computeExitCode({ occurrenceCount: 3, pagesFailed: 1 }, flags), 2);
  assert.equal(computeExitCode({ pagesFailed: 1 }, { noFail: true }), 2);
  assert.equal(computeExitCode({ pagesPartial: 1 }, {}), 2);
  assert.equal(computeExitCode({ pagesFailed: 1 }, { allowIncomplete: true }), 0);
  assert.equal(computeExitCode({ pagesFailed: 1, occurrenceCount: 2 }, { ...flags, allowIncomplete: true }), 1);
});

test('derivePageStatus', () => {
  assert.equal(derivePageStatus(null, [{ status: 'complete' }, { status: 'fallback' }]), 'ok');
  assert.equal(derivePageStatus(null, [{ status: 'complete' }, { status: 'timeout' }]), 'partial');
  assert.equal(derivePageStatus({ reason: 'x' }, []), 'failed');
});

const run = (layer, status) => ({ layer, engine: { name: layer, version: '1' }, status, evidence: {} });

test('report: failed/partial pages reach the summary, console and HTML without a pass message', () => {
  const failure = { reason: 'http-status', httpStatus: 404, message: 'HTTP 404' };
  const { report, legacyReport } = buildReportBundle([
    { name: 'gone', url: 'http://x.test/gone', violations: [], scannerRuns: [run('orchestrator', 'error')], status: 'failed', failure },
    { name: 'half', url: 'http://x.test/half', violations: [], scannerRuns: [run('w3c', 'error'), run('lighthouse', 'error')], status: 'partial' },
  ], { allowIncomplete: true, producer: { name: 'ada-scan', version: '0.0.0-test' } });
  assert.equal(report.summary.pagesFailed, 1);
  assert.equal(report.summary.pagesPartial, 1);
  assert.equal(report.summary.scannerErrors, 3);
  assert.deepEqual(report.summary.lighthouse, { error: 1 });
  assert.equal(legacyReport.summary.pagesFailed, 1);
  assert.equal(computeExitCode(report.summary, { noFail: true }), 2);

  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try { printConsoleSummary(report); } finally { console.log = orig; }
  assert.match(lines.join('\n'), /INCOMPLETE SCAN: 1 page\(s\) failed, 1 partial/);
  assert.match(lines.join('\n'), /--allow-incomplete/);

  const html = buildHtml({ ...legacyReport, lighthouse: {} });
  assert.match(html, /Incomplete scan\.<\/strong>/);
  assert.match(html, /HTTP 404/);
  assert.doesNotMatch(html, /Great job|&#x2713; Compliant|All clear/);
});

test('scanOnePage: 404/500/403-challenge fail, allowStatus passes, dead ports fail', async (t) => {
  if (!await requireBrowser(t)) return;
  const server = http.createServer((req, res) => {
    const route = req.url;
    if (route === '/ok' || route === '/allowed') {
      res.writeHead(route === '/allowed' ? 404 : 200, { 'content-type': 'text/html' });
      return res.end('<!doctype html><html lang="en"><title>Page</title><main><h1>Hi</h1></main></html>');
    }
    if (route === '/boom') { res.writeHead(500); return res.end('<title>Oops</title>'); }
    if (route === '/challenge') { res.writeHead(403, { 'content-type': 'text/html' }); return res.end('<title>Just a moment...</title>'); }
    res.writeHead(404, { 'content-type': 'text/html' }); res.end('<!doctype html><html lang="en"><title>Not found</title><main><h1>Not found</h1></main></html>'); // non-empty body: an empty one is skipped-empty
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const closed = await new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => r(port)); }); });
  const config = { layers: {} };
  const scan = (url, extra = {}) => scanOnePage({ name: 'p', url, ...extra }, config, { isUrlMode: true });
  try {
    assert.equal((await scan(`${base}/ok`)).status, 'ok');
    const missing = await scan(`${base}/missing`);
    assert.equal(missing.status, 'failed');
    assert.equal(missing.failure.httpStatus, 404);
    assert.equal((await scan(`${base}/missing`, { allowStatus: [404] })).status, 'ok');
    assert.equal((await scan(`${base}/allowed`, { allowStatus: [404] })).status, 'ok');
    assert.equal((await scan(`${base}/boom`)).failure.httpStatus, 500);
    assert.equal((await scan(`${base}/challenge`)).failure.reason, 'bot-challenge');
    const dead = await scan(`http://127.0.0.1:${closed}/`);
    assert.equal(dead.status, 'failed');
    assert.equal(dead.failure.reason, 'navigation-error');
    assert.equal(dead.scannerRuns[0].status, 'error');
    const invalid = await scan('http://does-not-exist.invalid/');
    assert.equal(invalid.status, 'failed');
  } finally {
    server.close();
    server.closeAllConnections?.();
  }
});

test('scanOnePage: fixture site 404 route is failed', async (t) => {
  if (!await requireBrowser(t)) return;
  const site = await startParadoxSite();
  try {
    const res = await scanOnePage({ name: 'nope', url: `${site.url}/nope` }, { layers: {} }, { isUrlMode: true });
    assert.equal(res.status, 'failed');
    assert.equal(res.failure.httpStatus, 404);
  } finally {
    await site.close();
  }
});

test('scanOnePage: crawl-found broken links become a deterministic broken-link finding and the page is ok', async (t) => {
  if (!await requireBrowser(t)) return;
  const site = await startParadoxSite();
  try {
    const brokenLinks = [{ route: '/gone', url: `${site.url}/gone`, status: 404 }];
    const res = await scanOnePage({ name: 'home', path: '/', url: `${site.url}/`, brokenLinks }, { layers: { links: true } }, { isUrlMode: true });
    assert.equal(res.status, 'ok');
    const f = res.violations.filter((v) => v.ruleId === 'broken-link');
    assert.equal(f.length, 1);
    assert.match(f[0].fix.hint, /HTTP 404.*referrer \//);
    const { report } = buildReportBundle([{ ...res, page: res.name }], { producer: { name: 'ada-scan', version: '0.0.0-test' } });
    assert.equal(report.pages[0].findings.find((x) => x.nativeRuleId === 'broken-link').verdict, 'confirmed');
    assert.equal(computeExitCode(report.summary, {}), 0);
  } finally {
    await site.close();
  }
});

test('CLI: unresolvable host exits 2 even with --no-fail and says why; --allow-incomplete exits 0', async (t) => {
  if (!await requireBrowser(t)) return;
  const out = mkdtempSync(path.join(tmpdir(), 'ada-incomplete-'));
  const cli = (...extra) => spawnSync(process.execPath, [
    path.join(ROOT, 'bin/ada-scan.js'), '--url', 'http://does-not-exist.invalid/', '--layers', 'links',
    '--no-fail', '--out-dir', out, ...extra,
  ], { cwd: ROOT, encoding: 'utf8', timeout: 120000, env: { ...process.env, ADA_SCAN_ROOT: ROOT, ADA_SCAN_NO_DOTENV: '1', ADA_SCAN_DEPLOYMENT_URL: '' } });
  const failed = cli();
  assert.equal(failed.status, 2, failed.stdout + failed.stderr);
  assert.match(failed.stdout, /INCOMPLETE SCAN: 1 page\(s\) failed/);
  assert.match(failed.stdout, /not scanned/);
  const allowed = cli('--allow-incomplete');
  assert.equal(allowed.status, 0, allowed.stdout + allowed.stderr);
  assert.match(allowed.stdout, /--allow-incomplete: exit code 2 suppressed/);
});
