import './helpers/hermetic-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeExitCode, buildFailedLayerRun } from '../src/index.js';
import { derivePageStatus, partialReasons, runLayerWithRetry } from '../src/scanner/page-health.js';
import { buildReportBundle, printConsoleSummary } from '../src/reporter/scan-report.js';
import { buildQaModel } from '../src/reporter/qa-report.js';
import { withTimeout } from '../src/utils/with-timeout.js';
import { validateConfig } from '../src/utils/config.js';

const run = (layer, status, evidence = {}) => ({ layer, engine: { name: layer, version: '1' }, status, evidence });
const ctx = { allowIncomplete: true, producer: { name: 'ada-scan', version: '0.0.0-test' } };
const page = (name, scannerRuns) => ({ name, url: `http://x.test/${name}`, violations: [], scannerRuns, status: derivePageStatus(null, scannerRuns) });
const focusTimeout = run('focusTrap', 'timeout', { errorMessage: 'layer focusTrap timed out after 180000ms', errorCode: 'scan-failed' });
const lhError = run('lighthouse', 'error', { errorCode: 'scan-failed', errorMessage: 'Lighthouse crashed' });

test('partialReasons: one entry per incomplete layer with its reason; lighthouse and w3c are supplementary; policy skips and complete runs are not reasons', () => {
  const runs = [run('axe', 'complete'), focusTimeout, lhError, run('lighthouse', 'error', { errorCode: 'scan-failed', errorMessage: 'Lighthouse crashed' }), run('w3c', 'skipped', { errorCode: 'external-disabled' }), run('links', 'skipped')];
  assert.deepEqual(partialReasons(runs), [
    { layer: 'focusTrap', reason: 'timeout: layer focusTrap timed out after 180000ms', gating: true },
    { layer: 'lighthouse', reason: 'error: Lighthouse crashed', gating: false },
    { layer: 'links', reason: 'skipped: layer did not complete', gating: true },
  ]);
  assert.ok(partialReasons([lhError], { strict: true }).every((r) => r.gating));
});

test('report: page.partialReasons names the layer, summary.pagesPartialGating counts only gating pages, the exit code follows', () => {
  const pages = [page('hang', [run('axe', 'complete'), focusTimeout]), page('perf', [run('axe', 'complete'), lhError]), page('fine', [run('axe', 'complete')])];
  const { report } = buildReportBundle(pages, ctx);
  const by = Object.fromEntries(report.pages.map((p) => [p.name, p]));
  assert.equal(by.hang.status, 'partial');
  assert.deepEqual(by.hang.partialReasons.map((r) => [r.layer, r.gating]), [['focusTrap', true]]);
  assert.deepEqual(by.perf.partialReasons.map((r) => [r.layer, r.gating]), [['lighthouse', false]]);
  assert.equal(by.fine.partialReasons, undefined);
  assert.equal(report.summary.pagesPartial, 2);
  assert.equal(report.summary.pagesPartialGating, 1);
  assert.equal(computeExitCode(report.summary), 2);

  const perfOnly = buildReportBundle([pages[1], pages[2]], ctx).report;
  assert.equal(perfOnly.summary.pagesPartial, 1);
  assert.equal(perfOnly.summary.pagesPartialGating, 0);
  assert.equal(computeExitCode(perfOnly.summary), 0, 'a supplementary layer alone does not make the scan incomplete');
  const strict = buildReportBundle([pages[1], pages[2]], { ...ctx, strict: true }).report;
  assert.equal(strict.summary.pagesPartialGating, undefined, 'strict: every partial page gates (equal to pagesPartial, so not repeated)');
  assert.equal(computeExitCode(strict.summary), 2);
  assert.equal(computeExitCode({ pagesPartial: 1 }), 2, 'older reports without the gating count keep the old rule');
  assert.equal(computeExitCode({ pagesFailed: 1, pagesPartial: 0, pagesPartialGating: 0 }), 2);
});

test('console and qa-report say why a page is partial and mark supplementary layers', () => {
  const { report } = buildReportBundle([page('hang', [focusTimeout]), page('perf', [lhError])], ctx);
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try { printConsoleSummary(report); } finally { console.log = orig; }
  const out = lines.join('\n');
  assert.match(out, /http:\/\/x\.test\/hang: partial \(focusTrap timeout: layer focusTrap timed out after 180000ms\)/);
  assert.match(out, /http:\/\/x\.test\/perf: partial \(lighthouse error: Lighthouse crashed \[supplementary, not gating\]\)/);
  const qa = buildQaModel(report);
  assert.match(qa.statusReason, /\/hang focusTrap: timeout: layer focusTrap timed out/);
  assert.match(qa.statusReason, /\/perf lighthouse: error: Lighthouse crashed \(supplementary\)/);
  const soft = lines.length && buildReportBundle([page('perf', [lhError])], ctx).report;
  lines.length = 0;
  console.log = (...a) => lines.push(a.join(' '));
  try { printConsoleSummary(soft); } finally { console.log = orig; }
  assert.match(lines.join('\n'), /Only supplementary layers .* exit code stays 0 unless scan\.strict/);
});

test('a layer that hangs to its deadline is retried once in a fresh attempt (the deadline bounds one attempt, not the retry)', async () => {
  const seen = [];
  const out = await runLayerWithRetry(async (v, r, isRetry) => {
    seen.push(isRetry);
    if (!isRetry) await new Promise(() => {}); // hung renderer
    r.push(run('focusTrap', 'complete'));
  }, { bound: (work) => withTimeout(work(), 20, 'layer focusTrap') });
  assert.deepEqual(seen, [false, true]);
  assert.equal(out.attempts, 2);
  assert.match(out.reason, /layer focusTrap timed out after 20ms/);
  assert.equal(derivePageStatus(null, out.scannerRuns), 'ok');
  // hung twice: the second timeout propagates and the caller records a failed (timeout) run, so the page is partial
  await assert.rejects(runLayerWithRetry(() => new Promise(() => {}), { bound: (work) => withTimeout(work(), 20, 'layer focusTrap') }), /timed out/);
  const failed = buildFailedLayerRun('focusTrap', new Error('layer focusTrap timed out after 20ms'));
  assert.deepEqual([failed.status, failed.evidence.transient], ['timeout', true]);
});

test('config: scan.strict must be a boolean', () => {
  assert.equal(validateConfig({ scan: { strict: true } }).some((e) => /scan\.strict/.test(e)), false);
  assert.ok(validateConfig({ scan: { strict: 'yes' } }).some((e) => /scan\.strict must be a boolean/.test(e)));
});
