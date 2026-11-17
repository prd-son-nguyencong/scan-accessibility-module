import './helpers/hermetic-env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildScanReportV2, validateScanReportV2, projectReportV1 } from '../src/reporter/report-v2.js';
import { computeExitCode } from '../src/index.js';

const CTX = { producer: { version: '0.0.0-test' } };
const skipped = (name) => ({ name, url: `http://127.0.0.1:1${name}`, violations: [], scannerRuns: [], status: 'skipped-empty', failure: null, skipped: { reason: 'empty-page', note: 'empty template' } });

test('a scan whose only pages are skipped-empty builds a valid report with zero scanner runs and exits 0 (skipped is not incomplete)', () => {
  const report = buildScanReportV2([skipped('/a'), skipped('/b')], CTX);
  assert.equal(report.scanners.length, 0);
  assert.equal(report.summary.pagesSkipped, 2);
  assert.equal(validateScanReportV2(report), true);
  assert.equal(projectReportV1(report).pages.length, 2);
  assert.equal(computeExitCode(report.summary), 0);
});

test('a report with no scanner runs and a page that did run still fails validation', () => {
  const ran = { name: '/c', url: 'http://127.0.0.1:1/c', violations: [], scannerRuns: [], status: 'ok', failure: null };
  assert.throws(() => validateScanReportV2(buildScanReportV2([skipped('/a'), ran], CTX)), /scanner metadata is required/);
});
