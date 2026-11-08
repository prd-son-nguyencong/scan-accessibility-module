import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildHtml } from '../src/reporter/html.js';
import { generateRoiDocuments } from '../src/reporter/roi-doc.js';
import { buildScanReportV2 } from '../src/reporter/report-v2.js';
import { buildQaModel, renderQaHtml } from '../src/reporter/qa-report.js';
import { redactUrl } from '../src/utils/route.js';
import { parseCliArgs } from '../src/utils/cli-args.js';
import { resetProjectRootCache, setReportsDir } from '../src/utils/paths.js';

// sha256 of the value, first 8 hex (computed independently of the implementation)
const h8 = (v) => createHash('sha256').update(v).digest('hex').slice(0, 8);
const TOKEN_URL = 'https://user:pw@site.example/jobs?token=SECRET123&q=a&q=b#frag-SECRET';

function csp(html) {
  const m = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/);
  assert.ok(m, 'CSP meta present');
  return m[1];
}

function assertStrict(html, { script }) {
  const policy = csp(html);
  assert.match(policy, /^default-src 'none'; /);
  assert.doesNotMatch(policy, /unsafe-eval|https?:|\*/);
  assert.doesNotMatch(policy, /script-src[^;]*unsafe-inline/);
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 2); // the theme script (before first paint) and the report's own (explorer or theme toggle)
  // expected hashes computed independently of the builder: sha256 of the exact script text
  for (const [, body] of scripts) assert.ok(policy.includes(`'sha256-${createHash('sha256').update(body).digest('base64')}'`), 'every inline script is hash-allowed');
  assert.equal((policy.match(/'sha256-/g) || []).length, 2, 'no other script is allowed');
  const markup = html.replace(/<script[^>]*>[\s\S]*?<\/script>/g, '').replace(/<style>[\s\S]*?<\/style>/g, '');
  assert.doesNotMatch(markup.replace(/="[^"]*"/g, '=""'), /<[^>]*\son[a-z]+\s*=/i, 'no inline event handler');
  assert.doesNotMatch(markup, /<(?:script|link|iframe|object|embed)\b[^>]*(?:src|href)="https?:/i, 'no remote load');
  assert.doesNotMatch(html, /\sstyle="[^"]*url\(/i);
}

const report = {
  timestamp: '2026-10-27T00:00:00.000Z',
  pages: [{ name: 'home', url: 'http://x.test/', violations: [{ ruleId: 'image-alt', layer: 'axe', impact: 'serious', count: 1, element: { selector: 'img', outerHTML: '<img>' }, source: {} }] }],
  lighthouse: {},
};

test('visual report carries a strict CSP bound to its one inline script', () => {
  assertStrict(buildHtml(report), { script: true });
});

let root;
let prev;
beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), 'ada-rptsec-')));
  prev = process.env.ADA_SCAN_ROOT;
  process.env.ADA_SCAN_ROOT = root;
  resetProjectRootCache();
  setReportsDir(null);
});
afterEach(() => {
  if (prev === undefined) delete process.env.ADA_SCAN_ROOT; else process.env.ADA_SCAN_ROOT = prev;
  resetProjectRootCache();
  setReportsDir(null);
});

test('ROI documents carry a strict CSP bound to their two inline scripts', () => {
  const latest = { timestamp: report.timestamp, summary: { totalViolations: 0, pagesScanned: 1, layerCounts: {} }, pages: [] };
  const { comparisonPath, technicalPath } = generateRoiDocuments(latest, null);
  for (const f of [comparisonPath, technicalPath]) assertStrict(readFileSync(f, 'utf8'), { script: false });
});

test('ROI executive summary with a baseline comparison keeps the strict CSP', () => {
  const comparison = { baseline: { source: 'baseline', generatedAt: report.timestamp }, totals: { fixed: 2, remaining: 1, new: 1, reclassified: 0, needsReview: { baseline: 0, current: 0 } }, warnings: ['a <b>warning</b>'] };
  const latest = { timestamp: report.timestamp, summary: { totalViolations: 0, pagesScanned: 1, layerCounts: {} }, pages: [], comparison };
  const { comparisonPath } = generateRoiDocuments(latest, null);
  assertStrict(readFileSync(comparisonPath, 'utf8'), { script: false });
});

test('QA report with ownership and comparison fields carries a strict CSP and escapes values', () => {
  const v = (selector, outerHTML) => ({ ruleId: 'image-alt', layer: 'axe', impact: 'serious', verdict: 'confirmed', element: { selector, outerHTML }, source: {} });
  const r = buildScanReportV2([{ name: 'home', page: '/', url: 'https://x.test/', scannerRuns: [{ layer: 'axe', engine: { name: 'axe-core', version: '4' }, status: 'complete' }],
    violations: [v('img.a', '<img class="a">'), v('<img src=x onerror=alert(1)>', '<div data-react-component="Jobs"></div>')] }],
  { generatedAt: report.timestamp, producer: { name: 'ada-scan', version: '1' }, target: { mode: 'url-only', url: 'https://x.test/' },
    comparison: { baseline: { source: '<b>baseline</b>', generatedAt: report.timestamp }, totals: { fixed: 1, remaining: 1, new: 1, reclassified: 0, needsReview: { baseline: 0, current: 0 } },
      new: [{ ruleId: 'image-alt', selector: '<script>alert(1)</script>' }], warnings: [] } });
  const model = buildQaModel(r);
  assert.equal(model.platformOwned.reduce((n, g) => n + g.total, 0), 1, 'the widget finding is platform-owned');
  assert.equal(model.baseline.totals.fixed, 1, 'comparison consumed');
  const html = renderQaHtml(model);
  assertStrict(html, { script: false });
  assert.doesNotMatch(html, /<script>alert|<img src=x|<b>baseline/);
});

test('redactUrl leaves an absolute URL with nothing to redact exactly as written', () => {
  assert.equal(redactUrl('https://example.test'), 'https://example.test');
  assert.equal(redactUrl('https://example.test/careers'), 'https://example.test/careers');
});

test('redactUrl drops userinfo and fragment and masks query values, keeping names', () => {
  assert.equal(redactUrl(TOKEN_URL), `https://site.example/jobs?token=r-${h8('SECRET123')}&q=r-${h8('a\0b')}`);
  assert.equal(redactUrl(TOKEN_URL, { keepQuery: true }), 'https://site.example/jobs?token=SECRET123&q=a&q=b');
  assert.equal(redactUrl('/jobs?token=SECRET123#x'), `/jobs?token=r-${h8('SECRET123')}`);
  assert.equal(redactUrl('/plain'), '/plain');
  assert.equal(redactUrl(null), null);
});

function scanWith(url, context = {}) {
  return buildScanReportV2([{
    page: 'jobs', url, route: url, status: 'ok',
    scannerRuns: [{ layer: 'axe', engine: { name: 'axe-core', version: '4.12.1' }, status: 'complete' }],
    violations: [{ ruleId: 'image-alt', layer: 'axe', impact: 'serious', count: 1, element: { selector: 'img', outerHTML: '<img>' }, source: {} }],
  }], { producer: { version: '0.0.0' }, target: { mode: 'url-only', url }, ...context });
}

test('report JSON redacts query strings, userinfo and fragments by default', () => {
  const json = JSON.stringify(scanWith(TOKEN_URL));
  assert.ok(!json.includes('SECRET123'), 'token absent');
  assert.ok(!json.includes('user:pw'), 'userinfo absent');
  assert.ok(!json.includes('frag-SECRET'), 'fragment absent');
  const built = scanWith(TOKEN_URL);
  const redacted = `?token=r-${h8('SECRET123')}&q=r-${h8('a\0b')}`;
  assert.equal(built.pages[0].url, `https://site.example/jobs${redacted}`);
  assert.equal(built.pages[0].route, `/jobs${redacted}`);
  assert.equal(built.target.url, `https://site.example/jobs${redacted}`);
});

test('same URL gives the same route key and stableId across scans; a different token value differs', () => {
  const a = scanWith('https://site.example/jobs?token=AAA');
  const again = scanWith('https://site.example/jobs?token=AAA');
  const other = scanWith('https://site.example/jobs?token=BBB');
  assert.equal(a.pages[0].route, again.pages[0].route);
  assert.equal(a.pages[0].findings[0].stableId, again.pages[0].findings[0].stableId);
  assert.notEqual(a.pages[0].route, other.pages[0].route);
});

test('--keep-query keeps the query in url fields but never userinfo or fragment', () => {
  const kept = scanWith(TOKEN_URL, { keepQuery: true });
  assert.equal(kept.pages[0].url, 'https://site.example/jobs?token=SECRET123&q=a&q=b');
  assert.equal(kept.target.url, 'https://site.example/jobs?token=SECRET123&q=a&q=b');
  assert.ok(!JSON.stringify(kept).includes('user:pw'));
  assert.equal(parseCliArgs(['--keep-query'])['keep-query'], true);
});

test('HTML built from a redacted report shows no token', () => {
  const built = scanWith(TOKEN_URL);
  const html = buildHtml({ timestamp: built.generatedAt, pages: [{ name: 'jobs', url: built.pages[0].url, violations: [] }], lighthouse: {} });
  assert.ok(!html.includes('SECRET123'));
});

test('tokens inside failure messages and evidence URLs are redacted (HTML and JSON)', () => {
  const msg = `net::ERR navigating to ${TOKEN_URL} timed out`;
  const mk = (ctx) => buildScanReportV2([{
    page: 'jobs', url: 'https://site.example/jobs', route: '/jobs', status: 'failed',
    failure: { message: msg },
    lighthouseScores: { finalUrl: TOKEN_URL },
    scannerRuns: [{ layer: 'axe', engine: { name: 'axe-core', version: '4.12.1' }, status: 'complete', evidence: { finalUrl: TOKEN_URL } }],
    violations: [],
  }], { producer: { version: '0.0.0' }, target: { mode: 'url-only', url: 'https://site.example/jobs' }, ...ctx });
  const json = JSON.stringify(mk());
  for (const leak of ['SECRET123', 'user:pw', 'frag-SECRET']) assert.ok(!json.includes(leak), leak);
  const page = mk().pages[0];
  assert.equal(page.failure.message, `net::ERR navigating to https://site.example/jobs?token=r-${h8('SECRET123')}&q=r-${h8('a\0b')} timed out`);
  assert.ok(JSON.stringify(mk({ keepQuery: true })).includes('token=SECRET123'));
  assert.ok(!JSON.stringify(mk({ keepQuery: true })).includes('user:pw'));
});
