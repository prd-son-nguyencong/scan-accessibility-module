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

async function startHarness(root, { stateOptions = {}, serverOptions = {}, prepare } = {}) {
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
    ...stateOptions,
  });
  if (prepare) prepare(state);
  const server = await startReviewServer({ state, ...serverOptions });
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

const TRANSACTION_ID = 'transaction-1700000000000-abcd1234';
const SANDBOX_TARGET = 'src/partials/jobs/sort.liquid';
const ROLLBACK_MESSAGE = 'Sandbox restored byte-for-byte. Original source remained unchanged.';

async function withWorkbenchPage(harnessOptions, fn, { allowedErrors = [] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ada-review-workbench-ui-'));
  let browser;
  let server;
  try {
    ({ server } = await startHarness(root, harnessOptions));
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    page.on('console', (message) => {
      if (message.type() === 'error' && !/favicon\.ico/i.test(message.text()) && !allowedErrors.some((re) => re.test(message.text()))) errors.push(message.text());
    });
    await page.goto(server.reviewUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 });
    await page.waitForFunction(() => {
      const gate = document.getElementById('apply-gate');
      return gate && !/Loading/i.test(gate.textContent || '');
    }, { timeout: 20_000 });
    await fn(page);
    assert.deepEqual(errors, [], `Unexpected browser errors: ${errors.join('\n')}`);
    await context.close();
  } finally {
    if (browser) await browser.close();
    if (server) await server.close();
    rmSync(root, { recursive: true, force: true });
  }
}

test('workbench hides security banner and sandbox card for a trusted session without sandbox', async () => {
  await withWorkbenchPage({}, async (page) => {
    assert.equal(await page.locator('#security-warning').isVisible(), false);
    assert.equal(await page.locator('#sandbox-status').isVisible(), false);
  });
});

test('workbench shows insecure-dev banner and sandbox card, and rolls back through the confirm dialog under CSP', async () => {
  let releaseHandler;
  const handlerGate = new Promise((resolve) => { releaseHandler = resolve; });
  let handlerCalls = 0;
  const rollbackHandler = async ({ transactionId }) => {
    handlerCalls += 1;
    await handlerGate;
    return {
      transactionId,
      targetFile: SANDBOX_TARGET,
      restored: [{ file: SANDBOX_TARGET }],
      sandboxRestored: true,
      originalUnchangedAfterRollback: true,
    };
  };
  await withWorkbenchPage({
    stateOptions: {
      transportSecurity: 'insecure-dev',
      devAuthBypass: true,
      sandboxContext: { enabled: true, targetFile: SANDBOX_TARGET },
    },
    prepare: (state) => {
      state.raw.applyCompleted = true;
      state.raw.sandbox.transactionId = TRANSACTION_ID;
    },
    serverOptions: { rollbackHandler },
  }, async (page) => {
    const banner = page.locator('#security-warning');
    await banner.waitFor({ state: 'visible', timeout: 10_000 });
    assert.equal(await banner.getAttribute('role'), 'alert');
    assert.equal(
      (await banner.textContent()).trim(),
      'Unverified TLS — development only. Development auth bypass is enabled.',
    );

    const card = page.locator('#sandbox-status');
    await card.waitFor({ state: 'visible', timeout: 10_000 });
    assert.equal(await page.locator('#sandbox-status-text').textContent(), `Sandbox: ${SANDBOX_TARGET} · rollback available`);
    const rollbackBtn = page.locator('#rollback-btn');
    assert.equal(await rollbackBtn.isEnabled(), true);

    // Cancel closes the dialog without calling the server.
    await rollbackBtn.click();
    assert.equal(await page.locator('#rollback-dialog').evaluate((d) => d.open), true);
    await page.locator('#rollback-cancel').click();
    assert.equal(await page.locator('#rollback-dialog').evaluate((d) => d.open), false);
    assert.equal(handlerCalls, 0);

    // Confirm: dialog goes aria-busy, both buttons disabled, a second submit is ignored.
    await rollbackBtn.click();
    await page.locator('#rollback-confirm').click();
    await page.waitForFunction(() => document.getElementById('rollback-dialog').getAttribute('aria-busy') === 'true');
    assert.equal(await page.locator('#rollback-confirm').isDisabled(), true);
    assert.equal(await rollbackBtn.isDisabled(), true);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#rollback-dialog').evaluate((d) => d.open), true, 'Escape must not close a busy dialog');
    assert.equal(handlerCalls, 1);

    releaseHandler();
    await page.waitForFunction((message) => document.getElementById('status-live').textContent === message, ROLLBACK_MESSAGE);
    assert.equal(await page.locator('#status-live').textContent(), ROLLBACK_MESSAGE);
    assert.equal(await page.locator('#rollback-dialog').evaluate((d) => d.open), false);
    assert.equal(await page.locator('#rollback-dialog').getAttribute('aria-busy'), null);
    assert.equal(await page.locator('#sandbox-status-text').textContent(), `Sandbox: ${SANDBOX_TARGET} · rolled back`);
    assert.equal(await rollbackBtn.isDisabled(), true);
    assert.equal(handlerCalls, 1);
  });
});

test('workbench announces rollback failure and keeps the dialog usable', async () => {
  const rollbackHandler = async () => ({ transactionId: TRANSACTION_ID, targetFile: SANDBOX_TARGET, restored: [], sandboxRestored: false, originalUnchangedAfterRollback: true });
  await withWorkbenchPage({
    stateOptions: { sandboxContext: { enabled: true, targetFile: SANDBOX_TARGET } },
    prepare: (state) => {
      state.raw.applyCompleted = true;
      state.raw.sandbox.transactionId = TRANSACTION_ID;
    },
    serverOptions: { rollbackHandler },
  }, async (page) => {
    await page.locator('#rollback-btn').click();
    await page.locator('#rollback-confirm').click();
    await page.waitForFunction(() => /^Rollback failed:/.test(document.getElementById('status-live').textContent));
    assert.equal(await page.locator('#rollback-dialog').getAttribute('aria-busy'), null);
    assert.equal(await page.locator('#rollback-confirm').isEnabled(), true);
  }, { allowedErrors: [/status of 400/] }); // the handler's failed verification is the expected 400
});
