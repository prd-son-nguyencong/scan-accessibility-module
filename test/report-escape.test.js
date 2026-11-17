import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { escapeHtml } from '../src/utils/escape-html.js';
import { buildHtml } from '../src/reporter/html.js';
import { generateRoiDocuments } from '../src/reporter/roi-doc.js';
import { resetProjectRootCache, setReportsDir } from '../src/utils/paths.js';

const PAYLOADS = [`x');alert(1);('`, '<img src=x onerror=alert(1)>', '</script><script>alert(1)</script>', '"><svg onload=alert(1)>', '`onfocus=alert(1)'];

function assertSafe(html, label, scripts = 1) {
  // the data block is application/json (never executed); the report's own script is the one plain <script>
  const markup = html.replace(/<script[^>]*>[\s\S]*?<\/script>/g, '').replace(/<style>[\s\S]*?<\/style>/g, '');
  assert.doesNotMatch(markup, /<img src=x|<svg onload|<script/i, `${label}: injected tag`);
  assert.doesNotMatch(html.replace(/<script>[\s\S]*$/, ''), /<\/script><script>/i, `${label}: script terminator in data`);
  // quoted attribute values are inert text, so drop them before looking for on*= attributes
  assert.doesNotMatch(markup.replace(/="[^"]*"/g, '=""'), /<[^>]*\son[a-z]+\s*=/i, `${label}: inline handler`);
  assert.ok(!html.includes("x');alert"), `${label}: raw JS payload`);
  assert.equal((html.match(/<script/g) || []).length, scripts, `${label}: only the report's own script`);
  for (const [, body] of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) assert.doesNotMatch(body, /alert\(1\)/, `${label}: payload inside script`);
}

test('escapeHtml escapes & < > " \' and backtick, once', () => {
  assert.equal(escapeHtml(`&<>"'\``), '&amp;&lt;&gt;&quot;&#39;&#96;');
  assert.equal(escapeHtml(undefined), '');
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(0), '0');
  assert.equal(escapeHtml(escapeHtml('<')), '&amp;lt;');
});

function hostileReport(p) {
  const violation = (layer, ruleId) => ({
    id: p, ruleId, impact: p, layer, category: p, wcagRef: p, count: 1,
    element: { selector: p, outerHTML: p },
    fix: { hint: p, deterministic: false },
    source: { file: p, line: p, page: p, partial: `${p}-partial` },
  });
  return {
    timestamp: new Date().toISOString(),
    pages: [{
      name: p, url: p, status: 'partial', route: p,
      failure: { message: p },
      violations: [violation('axe', p), violation('w3c', p), violation('accessScan', p)],
      scannerRuns: [{ layer: p, status: p, engine: { name: p, version: p }, source: p, pageState: p, viewport: { name: p },
        evidence: { comparatorVersion: p, execution: { perCheck: [{ checkId: p, status: p, candidateCount: 1, findingCount: 1 }] } } }],
    }],
    lighthouse: { [p]: { lighthouse: { mobile: { scores: { performance: 40, accessibility: 90, bestPractices: 90, seo: 90 } }, desktop: { scores: { performance: 40, accessibility: 90, bestPractices: 90, seo: 90 } } } } },
  };
}

for (const p of PAYLOADS) {
  test(`html report escapes payload ${JSON.stringify(p)}`, () => {
    assertSafe(buildHtml(hostileReport(p)), 'html.js', 3); // theme script, JSON data block, report script
  });
}

test('html report: no inline handlers, no double escaping, honest wording', () => {
  const html = buildHtml(hostileReport('a"b<c'));
  assert.match(html, /a&quot;b&lt;c/);
  assert.doesNotMatch(html, /&amp;(lt|gt|quot|#39);/);
  const clean = buildHtml({ timestamp: new Date().toISOString(), pages: [{ name: 'p', url: 'http://x.test/', violations: [] }], lighthouse: {} });
  assert.doesNotMatch(clean, /Great job|&#x2713; Compliant|All clear/);
  assert.match(clean, /No automated issues found/);
  assert.match(clean, /Manual review is still required/);
});

let root;
let prev;
beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), 'ada-escape-')));
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

for (const p of PAYLOADS) {
  test(`roi-doc escapes payload ${JSON.stringify(p)}`, () => {
    const v = { ruleId: p, layer: p, impact: p, fix: { hint: p }, description: p, source: { file: p, line: p, confidence: p, snippetId: p, method: p } };
    const report = {
      timestamp: new Date().toISOString(),
      summary: {
        totalViolations: 1, pagesScanned: 1, topViolations: [{ id: p, count: 1 }], layerCounts: { [p]: 1 },
        violationsByFile: { [p]: [{ ...v, sourceConfidence: p, snippetId: p }] },
      },
      pages: [{ page: p, url: p, violations: [v], lighthouse: { scores: { performance: p } } }],
    };
    const { comparisonPath, technicalPath } = generateRoiDocuments(report, report);
    for (const f of [comparisonPath, technicalPath]) {
      assertSafe(readFileSync(f, 'utf8'), path.basename(f), 2);
    }
  });
}

test('roi-comparison has no hard-coded automation claims', () => {
  const report = { timestamp: new Date().toISOString(), summary: { totalViolations: 0, pagesScanned: 1, layerCounts: {} }, pages: [] };
  const { comparisonPath } = generateRoiDocuments(report, null);
  const html = readFileSync(comparisonPath, 'utf8');
  assert.doesNotMatch(html, /75–80|Manual QA steps replaced|Eliminated|auto-fixed/);
  assert.match(html, /Manual review is still required/);
});
