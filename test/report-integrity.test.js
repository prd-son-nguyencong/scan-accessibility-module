import './helpers/hermetic-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildScanReportV2, computeReportId, projectReportV1, validateScanReportV2 } from '../src/reporter/report-v2.js';
import { loadBaseline, readReportFile } from '../src/reporter/scan-report.js';
import { setReportsDir } from '../src/utils/paths.js';

const context = {
  generatedAt: '2026-07-15T00:00:00.000Z',
  producer: { name: 'ada-scan', version: '1.0.1' },
  target: { mode: 'url-only', url: 'https://example.test/' },
};
const SHA = `sha256:${'b'.repeat(64)}`;
const run = { layer: 'axe', engine: { name: 'axe-core', version: '4.12.1' }, status: 'complete' };

function violation(overrides = {}) {
  return {
    ruleId: 'image-alt',
    layer: 'axe',
    impact: 'critical',
    element: { selector: 'img.a', outerHTML: '<img class="a" src="a.png">' },
    source: { file: 'src/partials/home/hero.liquid', line: 7, confidence: 'high', method: 'manifest', preimageSha256: SHA },
    fix: { hint: 'Images need alt text' },
    ...overrides,
  };
}

function build(pages, ctx = context) {
  return buildScanReportV2(
    pages.map((p, i) => ({ page: `p${i}`, url: `https://example.test${p.route || '/'}`, scannerRuns: [run], violations: [], ...p })),
    ctx,
  );
}

const findingsOf = (report) => report.pages.flatMap((page) => page.findings);

// Changed deliberately (loop-repeat merge): three elements of one confident source line are ONE root cause with every occurrence counted;
// the same elements on three different lines stay three findings with distinct ids.
test('three <img> on one source line are one finding with count 3; on three lines they stay three', () => {
  const imgs = (lineOf) => ['a', 'b', 'c'].map((n, i) => violation({
    element: { selector: `img.${n}`, outerHTML: `<img class="${n}" src="${n}.png">` },
    source: { ...violation().source, line: lineOf(i) },
  }));
  const one = findingsOf(build([{ violations: imgs(() => 7) }]));
  assert.equal(one.length, 1);
  assert.equal(one[0].count, 3);
  assert.equal(one[0].evidence.observations.length, 3);
  const report = build([{ violations: imgs((i) => 7 + i) }]);
  const findings = findingsOf(report);
  assert.equal(findings.length, 3);
  assert.equal(new Set(findings.map((f) => f.findingId)).size, 3);
  assert.equal(new Set(findings.map((f) => f.stableId)).size, 3);
  assert.equal(report.summary.occurrenceCount, 3);
});

test('observations of one finding from the same layer sum; identical duplicates and other layers do not inflate', () => {
  const report = build([{ violations: [
    violation({ fix: { hint: 'first message' } }),
    violation({ fix: { hint: 'second message' } }),
    violation({ fix: { hint: 'third message' } }),
    violation({ fix: { hint: 'third message' } }),
    violation({ layer: 'lighthouse', fix: { hint: 'lighthouse view of the same element' } }),
  ] }]);
  const [finding] = findingsOf(report);
  assert.equal(findingsOf(report).length, 1);
  assert.equal(finding.evidence.observations.length, 4);
  assert.equal(finding.count, 3);
  assert.equal(projectReportV1(report).summary.totalViolations, 3);
});

test('stableId survives volatile fields and differs per element, rule and query', () => {
  const base = violation();
  const moved = violation({
    element: { selector: 'img.a', outerHTML: '<img class="a" src="a.png" data-x="changed">' },
    source: { ...base.source, line: 40, preimageSha256: `sha256:${'c'.repeat(64)}` },
  });
  const ids = (list) => findingsOf(build([{ violations: list }])).map((f) => f.stableId);
  const [a] = ids([base]);
  const [b] = findingsOf(build([{ violations: [moved] }], { ...context, generatedAt: '2026-08-01T00:00:00.000Z' })).map((f) => f.stableId);
  assert.match(a, /^sha256:[a-f0-9]{64}$/);
  assert.equal(a, b);
  assert.notEqual(a, ids([violation({ element: { selector: 'img.z', outerHTML: '<img class="z">' } })])[0]);
  assert.notEqual(a, ids([violation({ ruleId: 'role-img-alt' })])[0]);
  // the id set is the same for two runs of the same input
  const set = (r) => new Set(findingsOf(r).map((f) => f.stableId));
  const input = [{ violations: [base, violation({ element: { selector: 'img.b', outerHTML: '<img class="b">' } })] }];
  assert.deepEqual(set(build(input)), set(build(structuredClone(input))));
});

test('routes that differ only by query stay distinct pages and distinct stable ids', () => {
  const report = build([
    { route: '/jobs?page=1', violations: [violation()] },
    { route: '/jobs?page=2', violations: [violation()] },
  ]);
  // query values are redacted (hashed) in the route key, so the routes stay distinct without exposing the values
  const routes = report.pages.map((p) => p.route);
  assert.equal(new Set(routes).size, 2);
  assert.ok(routes.every((r) => /^\/jobs\?page=r-[a-f0-9]{8}$/.test(r)), routes.join());
  const [a, b] = findingsOf(report);
  assert.notEqual(a.stableId, b.stableId);
  assert.notEqual(a.findingId, b.findingId);
});

test('info findings are not part of occurrence totals in either projection', () => {
  const report = build([{ violations: [violation(), violation({
    layer: 'lighthouse', impact: 'info', element: { selector: 'html', outerHTML: '<html>' }, ruleId: 'lh-note',
  })] }]);
  assert.equal(report.summary.occurrenceCount, 1);
  assert.equal(report.summary.infoCount, 1);
  assert.equal(projectReportV1(report).summary.totalViolations, 1);
});

test('source candidates are kept on v2 findings and in the v1 projection', () => {
  const candidates = [{ file: './src/a.liquid', line: 3, confidence: 'low', method: 'hybrid-ambiguous-hint', preimageSha256: SHA }];
  const report = build([{ violations: [violation({
    source: { confidence: 'none', method: 'hybrid-ambiguous-hint' }, sourceCandidates: candidates,
  })] }]);
  const [finding] = findingsOf(report);
  assert.deepEqual(finding.sourceCandidates, [{ ...candidates[0], file: 'src/a.liquid' }]);
  assert.deepEqual(projectReportV1(report).pages[0].violations[0].sourceCandidates, finding.sourceCandidates);
});

test('stableId is validated when present and optional for older v2 reports', () => {
  const report = build([{ violations: [violation()] }]);
  const legacy = structuredClone(report);
  delete findingsOf(legacy)[0].stableId;
  legacy.reportId = computeReportId(legacy);
  assert.equal(validateScanReportV2(legacy), true);
  const tampered = structuredClone(report);
  findingsOf(tampered)[0].stableId = SHA;
  assert.throws(() => validateScanReportV2(tampered), /stable ID/);
});

test('readReportFile and loadBaseline reject corrupt, tampered and unknown reports without throwing', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ada-report-'));
  const write = (name, content) => {
    const file = path.join(dir, name);
    writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
    return file;
  };
  const report = build([{ violations: [violation()] }]);
  assert.ok(readReportFile(write('ok.json', report)).report);
  assert.ok(readReportFile(write('v1.json', projectReportV1(report))).report);

  assert.match(readReportFile(write('bad.json', '{"pages":')).error, /not readable JSON/);
  assert.match(readReportFile(write('empty.json', {})).error, /not a scan report/);
  assert.match(readReportFile(write('v3.json', { ...report, schemaVersion: '3.0.0' })).error, /unsupported schemaVersion/);
  const tampered = structuredClone(report);
  tampered.pages[0].findings[0].count = 99;
  assert.match(readReportFile(write('tampered.json', tampered)).error, /failed validation/);
  assert.match(readReportFile(path.join(dir, 'missing.json')).error, /not readable/);

  setReportsDir(dir);
  const warn = console.warn;
  const warnings = [];
  console.warn = (message) => warnings.push(message);
  try {
    write('baseline.json', tampered);
    assert.equal(loadBaseline(), null);
    assert.match(warnings.join('\n'), /Ignoring invalid baseline/);
    write('baseline.json', report);
    assert.equal(loadBaseline().reportId, report.reportId);
  } finally {
    console.warn = warn;
    setReportsDir(undefined);
  }
});
