import {
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { buildScanReportV2 } from '../../src/reporter/report-v2.js';
import { startFixController } from '../../src/fix/controller/index.js';
import { startReviewServer, REVIEW_DIFF_VIEW_PATH } from '../../src/fix/review/server.js';
import { createReviewState } from '../../src/fix/review/state.js';
import { withFixtureCandidates } from './review-fixtures.js';
import {
  patchScanResultsSources,
  REVISION,
  writeHybridAttestationProject,
  writeVerifiedFixtureSources,
} from './helpers/hybrid-fixture.js';

const baseFixture = JSON.parse(
  readFileSync(new URL('../fixtures/fix/report-v2.json', import.meta.url), 'utf8'),
);

function withBuildRevision(revision, fn) {
  const previous = process.env.ADA_SCAN_BUILD_REVISION;
  process.env.ADA_SCAN_BUILD_REVISION = revision;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.ADA_SCAN_BUILD_REVISION;
    else process.env.ADA_SCAN_BUILD_REVISION = previous;
  }
}

function writeTempProject(root) {
  return withBuildRevision(REVISION, () => writeHybridAttestationProject(root, {
    revision: REVISION,
    manifest: { 'dist/pages/index.html': 'src/pages/index.liquid' },
  }));
}

function localReport(root, digest) {
  const sourceMap = writeVerifiedFixtureSources(root);
  return buildScanReportV2(patchScanResultsSources(baseFixture.scanResults, sourceMap), {
    ...baseFixture.context,
    target: {
      mode: 'local-only',
      url: 'http://localhost:1234/',
      buildRevision: REVISION,
      instrumentationDigest: digest,
      deploymentUrl: null,
      attestationStatus: null,
      attestationReason: null,
    },
  });
}

async function startHarness(root) {
  const { digest } = writeTempProject(root);
  const report = localReport(root, digest);
  const controller = startFixController({ report, localRoot: root });
  const fixUnits = withFixtureCandidates(controller.fixUnits, root, controller.sessionDir, { reportId: report.reportId });
  const state = createReviewState({
    sessionDir: controller.sessionDir,
    reportId: report.reportId,
    sessionId: controller.session.sessionId,
    fixUnits,
    traceResults: controller.traceResults,
    policyRoutes: fixUnits.map((unit) => ({
      fixUnitId: unit.fixUnitId,
      proposalAllowed: unit.status === 'ready',
    })),
    traceInbox: controller.traceInbox,
    localRoot: root,
  });
  const server = await startReviewServer({ state });
  return { server, state, fixUnits };
}

test('workbench loads diff-view module under CSP and renders unified diff table', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-review-workbench-csp-'));
  let browser;
  let server;
  try {
    ({ server } = await startHarness(root));
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();

    const pageErrors = [];
    const consoleErrors = [];
    page.on('pageerror', (error) => pageErrors.push(String(error)));
    page.on('console', (message) => {
      if (message.type() === 'error') {
        consoleErrors.push(message.text());
      }
    });

    const diffViewUrl = new URL(REVIEW_DIFF_VIEW_PATH, server.url).href;
    const diffViewResponse = page.waitForResponse(
      (response) => response.url() === diffViewUrl && response.status() === 200,
      { timeout: 20_000 },
    );

    await page.goto(server.reviewUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 });
    const moduleResponse = await diffViewResponse;
    assert.match(moduleResponse.headers()['content-type'] || '', /javascript/);

    await page.waitForFunction(() => {
      const gate = document.getElementById('apply-gate');
      return gate && !/Loading review session/i.test(gate.textContent || '');
    }, { timeout: 20_000 });

    const unitButtons = page.locator('#unit-list .list-item');
    assert.ok(await unitButtons.count() > 0);
    await unitButtons.first().click();

    await page.waitForSelector('#review-panel .diff-table', { timeout: 20_000 });
    assert.ok(await page.locator('#review-panel .unified-diff').count() >= 1);

    const workbenchResponse = await fetch(server.url);
    const csp = workbenchResponse.headers.get('content-security-policy') || '';
    assert.match(csp, /'strict-dynamic'/);

    const benignConsoleNoise = (line) => /favicon\.ico/i.test(line);
    assert.deepEqual(
      consoleErrors.filter((line) => !benignConsoleNoise(line)),
      [],
      `Unexpected console errors: ${consoleErrors.join('\n')}`,
    );
    assert.deepEqual(pageErrors, [], `Unexpected page errors: ${pageErrors.join('\n')}`);

    await context.close();
  } finally {
    if (browser) await browser.close();
    if (server) await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});
