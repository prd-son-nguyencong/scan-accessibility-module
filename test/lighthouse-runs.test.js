import './helpers/hermetic-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanWithLighthouse, mapLighthouseA11yAudit, generateLighthouseAccessibilityViolations } from '../src/scanner/lighthouse.js';
import { buildLighthouseScannerRuns, buildLighthouseScoreEntry } from '../src/index.js';
import { validateConfig } from '../src/utils/config.js';
import { parseCliArgs } from '../src/utils/cli-args.js';
import { derivePageStatus } from '../src/scanner/page-health.js';
import { startParadoxSite } from './helpers/paradox-site-server.js';

const lhr = (perf, extra = {}) => ({
  lighthouseVersion: '12.0.0',
  fetchTime: `t${perf}`,
  finalUrl: 'http://127.0.0.1/',
  categories: {
    performance: { score: perf / 100 },
    accessibility: { score: 0.9, auditRefs: [{ id: 'color-contrast', weight: 3 }, { id: 'made-up-audit', weight: 1 }] },
    'best-practices': { score: 1 },
    seo: { score: 1 },
  },
  audits: {
    'color-contrast': { title: 'Contrast', score: 0, details: { items: [{ node: { selector: 'p', snippet: '<p>' } }] } },
    'made-up-audit': { title: 'Made up', score: 0, details: { items: [] } },
  },
  ...extra,
});

// Stub runner: perf scores per form factor are consumed in order.
const stub = (plan) => {
  const calls = [];
  const runner = async (url, mode) => {
    calls.push(mode);
    const step = plan[mode].shift();
    if (step instanceof Error) throw step;
    if (step === 'hang') return new Promise(() => {});
    return lhr(step);
  };
  return { runner, calls };
};

test('N=3 reports the median score, records every run and keeps provenance', async () => {
  const { runner, calls } = stub({ mobile: [50, 90, 70], desktop: [80, 60, 100] });
  const res = await scanWithLighthouse('http://127.0.0.1/', { lighthouse: { runs: 3, timeoutMs: 1000 } }, { runner });
  assert.equal(res.lighthouse.mobile.scores.performance, 70);
  assert.equal(res.lighthouse.desktop.scores.performance, 80);
  assert.deepEqual(res.lighthouse.mobile.runs.map((r) => r.scores.performance), [50, 90, 70]);
  assert.deepEqual(calls, ['mobile', 'mobile', 'mobile', 'desktop', 'desktop', 'desktop']);
  assert.deepEqual(res.lighthouse.mobile.provenance, {
    source: 'local', version: '12.0.0', formFactor: 'mobile', runsRequested: 3, runs: 3, comparableToPsi: false,
  });
  assert.equal(res.partial, false);
});

test('default is a single run per form factor', async () => {
  const { runner, calls } = stub({ mobile: [60], desktop: [70] });
  const res = await scanWithLighthouse('http://127.0.0.1/', {}, { runner });
  assert.deepEqual(calls, ['mobile', 'desktop']);
  assert.equal(res.lighthouse.desktop.provenance.runs, 1);
});

test('one failing form factor is partial, not a crash', async () => {
  const { runner } = stub({ mobile: [60], desktop: [new Error('chrome crashed')] });
  const res = await scanWithLighthouse('http://127.0.0.1/', {}, { runner });
  assert.equal(res.lighthouse.mobile.scores.performance, 60);
  assert.equal(res.lighthouse.desktop, null);
  assert.equal(res.partial, true);
  assert.equal(res.errors.desktop.code, 'error');
  const runs = buildLighthouseScannerRuns(res);
  assert.deepEqual(runs.map((r) => [r.viewport.name, r.status]), [['mobile', 'complete'], ['desktop', 'error']]);
  assert.equal(derivePageStatus(null, runs), 'partial');
});

test('a hung run times out per lighthouse.timeoutMs and the layer status is timeout', async () => {
  const { runner } = stub({ mobile: ['hang'], desktop: ['hang'] });
  const res = await scanWithLighthouse('http://127.0.0.1/', { lighthouse: { timeoutMs: 20 } }, { runner });
  assert.equal(res.source, 'error');
  assert.equal(res.errors.mobile.code, 'timeout');
  assert.equal(buildLighthouseScannerRuns(res)[0].status, 'timeout');
});

test('failed runs are skipped when others succeed', async () => {
  const { runner } = stub({ mobile: [50, new Error('x'), 70], desktop: [60, 60, 60] });
  const res = await scanWithLighthouse('http://127.0.0.1/', { lighthouse: { runs: 3 } }, { runner });
  assert.equal(res.lighthouse.mobile.provenance.runs, 2);
  assert.equal(res.lighthouse.mobile.provenance.runsRequested, 3);
  assert.equal(res.lighthouse.mobile.scores.performance, 60);
});

test('concurrent scans never overlap runner calls', async () => {
  let active = 0;
  let max = 0;
  const runner = async () => {
    max = Math.max(max, ++active);
    await new Promise((r) => setTimeout(r, 5));
    active--;
    return lhr(80);
  };
  await Promise.all([1, 2, 3].map(() => scanWithLighthouse('http://127.0.0.1/', {}, { runner })));
  assert.equal(max, 1);
});

test('a11y audits map to impact and WCAG; unknown ids stay moderate and flagged unmapped', async () => {
  assert.deepEqual(mapLighthouseA11yAudit('color-contrast'), { impact: 'serious', wcagCriteria: '1.4.3', unmapped: false });
  assert.deepEqual(mapLighthouseA11yAudit('nope'), { impact: 'moderate', wcagCriteria: null, unmapped: true });
  const { runner } = stub({ mobile: [60], desktop: [60] });
  const res = await scanWithLighthouse('http://127.0.0.1/', {}, { runner });
  const found = generateLighthouseAccessibilityViolations(res.lighthouse);
  const contrast = found.find((v) => v.rule === 'color-contrast');
  assert.equal(contrast.impact, 'serious');
  assert.equal(contrast.wcagCriteria, '1.4.3');
  assert.equal(contrast.evidence.layer, 'lighthouse');
  assert.equal(found.find((v) => v.rule === 'made-up-audit').evidence.unmapped, true);
});

test('config and CLI validation', () => {
  assert.deepEqual(validateConfig({ lighthouse: { runs: 3, timeoutMs: 5000 } }), []);
  assert.equal(validateConfig({ lighthouse: { runs: 0 } }).length, 1);
  assert.equal(parseCliArgs(['--lighthouse-runs', '3'])['lighthouse-runs'], '3');
});

test('real Lighthouse smoke against the fixture site', { skip: process.env.ADA_SCAN_TEST_LIGHTHOUSE !== '1', timeout: 300_000 }, async () => {
  const site = await startParadoxSite();
  try {
    const res = await scanWithLighthouse(`${site.url}/`, { lighthouse: { runs: 1, timeoutMs: 120_000 } });
    assert.ok(res.lighthouse.mobile && res.lighthouse.desktop, JSON.stringify(res.errors));
    assert.equal(res.lighthouse.mobile.provenance.formFactor, 'mobile');
  } finally {
    await site.close();
  }
});

test('only Lighthouse accessibility audits become findings; metrics and perf audits stay informational', async () => {
  const withMetrics = (perf) => lhr(perf, {
    audits: {
      'color-contrast': { title: 'Contrast', score: 0, details: { items: [{ node: { selector: 'p', snippet: '<p>' } }] } },
      'made-up-audit': { title: 'Made up', score: 1 },
      'first-contentful-paint': { title: 'FCP', score: 0, numericValue: 9000 },
      'largest-contentful-paint': { title: 'LCP', score: 0, numericValue: 9000 },
      'render-blocking-resources': { title: 'Render blocking', score: 0, numericValue: 500 },
    },
  });
  const runner = async (url, mode) => withMetrics(mode === 'mobile' ? 20 : 30);
  const res = await scanWithLighthouse('https://example.test/', { lighthouse: { runs: 1 } }, { runner });
  assert.deepEqual(res.violations.map((v) => v.rule), ['color-contrast']);
  assert.equal(res.lighthouse.mobile.metrics['first-contentful-paint'].rating, 'poor');
  assert.match(res.lighthouse.mobile.metrics['first-contentful-paint'].target, /good <= 1\.8 s, poor > 3\.0 s/);
  assert.equal(res.lighthouse.mobile.scores.performance, 20);
});

test('score entry and HTML carry every run with median and spread, flagging variance above 5', async () => {
  const { runner } = stub({ mobile: [50, 90, 70], desktop: [80, 82, 81] });
  const res = await scanWithLighthouse('http://127.0.0.1/', { lighthouse: { runs: 3, timeoutMs: 1000 } }, { runner });
  const entry = buildLighthouseScoreEntry(res);
  assert.deepEqual(entry.runSummary.mobile.runs.map((r) => r.performance), [50, 90, 70]);
  assert.equal(entry.runSummary.mobile.median.performance, 70);
  assert.equal(entry.runSummary.mobile.spread.performance, 40);
  assert.equal(entry.runSummary.desktop.spread.performance, 2);
  const { buildPerformanceDashboard } = await import('../src/reporter/html.js');
  const markup = buildPerformanceDashboard({ home: entry });
  assert.match(markup, /Scores per run \(3\)/);
  assert.match(markup, /50, 90, 70/);
  assert.match(markup, /score variance/);
  assert.equal((markup.match(/score variance/g) || []).length, 1);
});
