import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildScanReportV2 } from '../../src/reporter/report-v2.js';
import { startFixController, runTrustedFixCli, closeReviewServerWithCisTransport, importTrustedCisTransport } from '../../src/fix/controller/index.js';
import { startReviewServer, TOKEN_HEADER, LOOPBACK_HOST, PUBLIC_ERROR_MESSAGES, REVIEW_DIFF_VIEW_PATH } from '../../src/fix/review/server.js';
import { createReviewState } from '../../src/fix/review/state.js';
import { registeredCandidateHash, withFixtureCandidates } from './review-fixtures.js';
import { buildVerifiedCandidateRecord } from './helpers/candidate-fixture.js';
import { buildFixUnits } from '../../src/fix/canonical/fix-unit.js';
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

function tokenHeaders(server, extra = {}) {
  return { [TOKEN_HEADER]: server.token, ...extra };
}

function mutationHeaders(server, extra = {}) {
  return {
    [TOKEN_HEADER]: server.token,
    origin: server.origin,
    'content-type': 'application/json',
    ...extra,
  };
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
  return { report, controller, state, server, fixUnits };
}

test('review server binds only to 127.0.0.1 and ignores host override', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-review-server-'));
  try {
    const { state, server } = await startHarness(root);
    assert.equal(server.host, LOOPBACK_HOST);
    assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    const forced = await startReviewServer({ state: createReviewState({
      sessionDir: join(root, 'scan-reports', 'fix-sessions', 'fix-host'),
      reportId: 'sha256:test',
      sessionId: 'fix-host',
      fixUnits: [],
      traceResults: [],
      policyRoutes: [],
      localRoot: root,
    }), host: '0.0.0.0' });
    assert.equal(forced.host, LOOPBACK_HOST);
    await server.close();
    await forced.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('GET snapshot requires token but not Origin header', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-review-server-'));
  try {
    const { server } = await startHarness(root);
    const denied = await fetch(`${server.url}api/snapshot`);
    assert.equal(denied.status, 403);
    const allowed = await fetch(`${server.url}api/snapshot`, { headers: tokenHeaders(server) });
    assert.equal(allowed.status, 200);
    await server.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('POST mutations require token and exact browser Origin', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-review-server-'));
  try {
    const { controller, server, fixUnits, state } = await startHarness(root);
    const unitId = fixUnits[0].fixUnitId;
    const candidateHash = registeredCandidateHash(state, unitId);
    const noToken = await fetch(`${server.url}api/fix-units/${unitId}/decision`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: server.origin },
      body: JSON.stringify({ decision: 'accepted', candidateHash }),
    });
    assert.equal(noToken.status, 403);
    const noOrigin = await fetch(`${server.url}api/fix-units/${unitId}/decision`, {
      method: 'POST',
      headers: tokenHeaders(server, { 'content-type': 'application/json' }),
      body: JSON.stringify({ decision: 'accepted', candidateHash }),
    });
    assert.equal(noOrigin.status, 403);
    const wrongOrigin = await fetch(`${server.url}api/fix-units/${unitId}/decision`, {
      method: 'POST',
      headers: mutationHeaders(server, { origin: 'http://evil.test' }),
      body: JSON.stringify({ decision: 'accepted', candidateHash }),
    });
    assert.equal(wrongOrigin.status, 403);
    await server.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('sets connect-src self in CSP and no wildcard CORS', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-review-server-'));
  try {
    const { server } = await startHarness(root);
    const html = await fetch(server.url);
    const csp = html.headers.get('content-security-policy') || '';
    assert.match(csp, /connect-src 'self'/);
    assert.match(csp, /'strict-dynamic'/);
    assert.doesNotMatch(csp, /\*/);
    assert.equal(html.headers.get('access-control-allow-origin'), null);
    await server.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('serves exact diff-view asset with javascript content type and no-store', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-review-server-'));
  try {
    const { server } = await startHarness(root);
    const assetUrl = new URL(REVIEW_DIFF_VIEW_PATH, server.url).href;
    const response = await fetch(assetUrl);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') || '', /text\/javascript/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const body = await response.text();
    assert.match(body, /export function renderDiffContent/);
    assert.match(body, /export function renderUnifiedDiff/);
    assert.doesNotMatch(body, /globalThis\.renderUnifiedDiff/);
    assert.doesNotMatch(body, /^import /m);
    await server.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects non-exact diff-view asset paths without exposing filesystem', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-review-server-'));
  try {
    const { server } = await startHarness(root);
    const unknown = await fetch(new URL('/review/other.js', server.url).href);
    assert.equal(unknown.status, 404);
    const traversal = await fetch(new URL('/review/diff-view.js/../../server.js', server.url).href);
    assert.equal(traversal.status, 404);
    await server.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects unknown routes and methods', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-review-server-'));
  try {
    const { server } = await startHarness(root);
    const missing = await fetch(`${server.url}api/missing`, { headers: tokenHeaders(server) });
    assert.equal(missing.status, 404);
    const put = await fetch(`${server.url}api/snapshot`, {
      method: 'PUT',
      headers: mutationHeaders(server),
      body: '{}',
    });
    assert.equal(put.status, 405);
    await server.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('requires JSON content type and bounded body for mutations', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-review-server-'));
  try {
    const { server, fixUnits } = await startHarness(root);
    const unitId = fixUnits[0].fixUnitId;
    const wrongType = await fetch(`${server.url}api/fix-units/${unitId}/decision`, {
      method: 'POST',
      headers: mutationHeaders(server, { 'content-type': 'text/plain' }),
      body: 'decision=accepted',
    });
    assert.equal(wrongType.status, 415);
    const malformed = await fetch(`${server.url}api/fix-units/${unitId}/decision`, {
      method: 'POST',
      headers: mutationHeaders(server),
      body: '{bad-json',
    });
    assert.equal(malformed.status, 400);
    const huge = await fetch(`${server.url}api/fix-units/${unitId}/decision`, {
      method: 'POST',
      headers: mutationHeaders(server),
      body: JSON.stringify({ decision: 'accepted', candidateHash: 'x'.repeat(200_000) }),
    });
    assert.equal(huge.status, 413);
    await server.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('accept endpoint records decision but does not write source', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-review-server-'));
  try {
    const sourcePath = join(root, 'src', 'partials', 'jobs', 'sort.liquid');
    mkdirSync(join(root, 'src', 'partials', 'jobs'), { recursive: true });
    const originalSource = '<select id="sort-select"></select>\n';
    writeFileSync(sourcePath, originalSource);
    const { state, server, fixUnits } = await startHarness(root);
    const unitId = fixUnits[0].fixUnitId;
    const response = await fetch(`${server.url}api/fix-units/${unitId}/decision`, {
      method: 'POST',
      headers: mutationHeaders(server),
      body: JSON.stringify({ decision: 'accepted', candidateHash: registeredCandidateHash(state, unitId) }),
    });
    assert.equal(response.status, 200);
    assert.equal(state.getDecision(unitId).decision, 'accepted');
    assert.equal(readFileSync(sourcePath, 'utf8'), originalSource);
    await server.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('accept rejects fabricated candidate hash', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-review-server-'));
  try {
    const { server, fixUnits } = await startHarness(root);
    const unitId = fixUnits[0].fixUnitId;
    const response = await fetch(`${server.url}api/fix-units/${unitId}/decision`, {
      method: 'POST',
      headers: mutationHeaders(server),
      body: JSON.stringify({ decision: 'accepted', candidateHash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }),
    });
    assert.equal(response.status, 400);
    await server.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('trace all endpoint refreshes snapshot trace results', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-review-server-'));
  try {
    const { server } = await startHarness(root);
    const response = await fetch(`${server.url}api/trace/all`, {
      method: 'POST',
      headers: mutationHeaders(server),
      body: '{}',
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.ok(Array.isArray(payload.accessibility?.traceInbox));
    await server.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('revision endpoint records durable revision_requested workflow', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-review-server-'));
  try {
    const { state, server, fixUnits } = await startHarness(root);
    const unitId = fixUnits[0].fixUnitId;
    const response = await fetch(`${server.url}api/fix-units/${unitId}/decision`, {
      method: 'POST',
      headers: mutationHeaders(server),
      body: JSON.stringify({ decision: 'revision_requested', revisionNote: 'Need clearer diff' }),
    });
    assert.equal(response.status, 200);
    assert.equal(state.getDecision(unitId).revisionNote, 'Need clearer diff');
    await server.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runTrustedFixCli useUI starts review server and exposes close handle', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-review-server-'));
  try {
    const { digest } = writeTempProject(root);
    const report = localReport(root, digest);
    const result = await runTrustedFixCli({ report, localRoot: root, useUI: true });
    assert.equal(result.status, 'review');
    assert.match(result.reviewUrl, /#token=/);
    assert.equal(statSync(result.sessionDir).mode & 0o777, 0o700);
    await result.reviewServer.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runTrustedFixCli reviewServer.close closes owned CIS transport', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-review-server-'));
  let transportClosed = false;
  try {
    const { digest } = writeTempProject(root);
    const report = localReport(root, digest);
    const result = await runTrustedFixCli({
      report,
      localRoot: root,
      useUI: true,
      cisTransport: {
        async chatCompletion() {
          return { content: '{}', status: 200, elapsedMs: 0 };
        },
        async close() {
          transportClosed = true;
        },
      },
    });
    assert.equal(result.status, 'review');
    await result.reviewServer.close();
    assert.equal(transportClosed, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('closeReviewServerWithCisTransport closes transport when review server close fails', async () => {
  let transportClosed = false;
  const serverError = new Error('review server close failed');

  await assert.rejects(
    () => closeReviewServerWithCisTransport(
      async () => { throw serverError; },
      {
        async close() {
          transportClosed = true;
        },
      },
    ),
    (error) => error === serverError,
  );

  assert.equal(transportClosed, true);
});

test('closeReviewServerWithCisTransport preserves success when both close cleanly', async () => {
  let serverClosed = false;
  let transportClosed = false;

  await closeReviewServerWithCisTransport(
    async () => { serverClosed = true; },
    {
      async close() {
        transportClosed = true;
      },
    },
  );

  assert.equal(serverClosed, true);
  assert.equal(transportClosed, true);
});

test('closeReviewServerWithCisTransport rethrows server error when both close paths fail', async () => {
  const serverError = new Error('review server close failed');
  const transportError = new Error('transport close failed');

  await assert.rejects(
    () => closeReviewServerWithCisTransport(
      async () => { throw serverError; },
      {
        async close() {
          throw transportError;
        },
      },
    ),
    (error) => error === serverError,
  );
});

test('closeReviewServerWithCisTransport rethrows transport error when only transport close fails', async () => {
  const transportError = new Error('transport close failed');

  await assert.rejects(
    () => closeReviewServerWithCisTransport(
      async () => {},
      {
        async close() {
          throw transportError;
        },
      },
    ),
    (error) => error === transportError,
  );
});

test('importTrustedCisTransport logs redacted setup failures without leaking import errors', async () => {
  const sentinel = '/secret/cis/feature-key-sentinel-99';
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args.join(' '));

  try {
    const transport = await importTrustedCisTransport({ ok: true }, {
      createCisTransportFromTrustedConfig: () => ({
        importTransport: async () => {
          throw new Error(`importTransport failed at ${sentinel}`);
        },
      }),
    });

    assert.equal(transport, null);
    const line = logs.find((entry) => entry.includes('CIS transport unavailable'));
    assert.ok(line);
    assert.equal(line.includes(sentinel), false);
    assert.equal(line, 'CIS transport unavailable: CIS transport failed.');
  } finally {
    console.log = originalLog;
  }
});

test('manual mapping endpoint delegates to trace inbox and refreshes snapshot', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-review-server-'));
  let server;
  try {
    const partialDir = join(root, 'src', 'partials', 'jobs');
    mkdirSync(partialDir, { recursive: true });
    const content = '<select id="sort-select"></select>\n';
    writeFileSync(join(partialDir, 'sort.liquid'), content);
    const { buildSourcePreimage } = await import('../../src/tracer/preimage.js');
    const expected = buildSourcePreimage(content, 1).preimageSha256;
    const harness = await startHarness(root);
    server = harness.server;
    const blockedUnit = structuredClone(harness.fixUnits[0]);
    for (const finding of blockedUnit.findings) {
      finding.source = { confidence: 'none', method: 'unresolved' };
    }
    blockedUnit.status = 'trace-required';
    delete blockedUnit.candidate;
    delete blockedUnit.candidateHash;
    harness.state.raw.baseFixUnits[0] = blockedUnit;
    delete harness.state.raw.candidates[blockedUnit.fixUnitId];
    harness.state.raw.traceResults = harness.state.raw.traceResults.map((entry) => (
      entry.findingId === blockedUnit.findingIds[0]
        ? { ...entry, unresolved: true, partials: [] }
        : entry
    ));
    const findingId = blockedUnit.findingIds[0];
    const response = await fetch(`${server.url}api/trace/map`, {
      method: 'POST',
      headers: mutationHeaders(server),
      body: JSON.stringify({
        findingId,
        file: 'src/partials/jobs/sort.liquid',
        line: 1,
        expectedPreimageSha256: expected,
      }),
    });
    assert.equal(response.status, 200);
    assert.ok(harness.state.raw.manualMappings[findingId]);
    const snapshot = await response.json();
    assert.ok(snapshot.snapshot.accessibility?.traceInbox?.length >= 0);
  } finally {
    if (server) await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('API errors return generic messages without filesystem paths', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-review-server-'));
  try {
    const { server, fixUnits } = await startHarness(root);
    const unitId = fixUnits[0].fixUnitId;
    const response = await fetch(`${server.url}api/fix-units/${unitId}/decision`, {
      method: 'POST',
      headers: mutationHeaders(server),
      body: JSON.stringify({ decision: 'accepted', candidateHash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }),
    });
    const payload = await response.json();
    assert.equal(payload.error, 'CANDIDATE_HASH_MISMATCH');
    assert.equal(payload.message, PUBLIC_ERROR_MESSAGES.CANDIDATE_HASH_MISMATCH);
    assert.doesNotMatch(JSON.stringify(payload), /\/Users\/|session\.json|ENOENT/i);
    await server.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('malformed percent encoding returns 400', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-review-server-'));
  try {
    const { server } = await startHarness(root);
    const response = await fetch(`${server.url}api/fix-units/%E0%A4%A/decision`, {
      method: 'POST',
      headers: mutationHeaders(server),
      body: JSON.stringify({ decision: 'pending' }),
    });
    assert.equal(response.status, 400);
    const payload = await response.json();
    assert.equal(payload.error, 'BAD_REQUEST');
    await server.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('batch accept endpoint accepts verified eligible units', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-review-server-'));
  try {
    const { state, server, fixUnits } = await startHarness(root);
    for (const unit of fixUnits) {
      if (state.raw.candidates[unit.fixUnitId]) {
        state.raw.candidates[unit.fixUnitId] = buildVerifiedCandidateRecord(root, state.sessionDir);
      }
    }
    const eligible = state.getSnapshot().units.filter((row) => row.batchEligible);
    assert.ok(eligible.length >= 1);
    const response = await fetch(`${server.url}api/fix-units/batch/accept`, {
      method: 'POST',
      headers: mutationHeaders(server),
      body: JSON.stringify({ unitIds: eligible.map((row) => row.fixUnitId) }),
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.decisions.length, eligible.length);
    await server.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('controller initializes trace inbox candidates from attested report sources', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-review-server-'));
  try {
    const { digest } = writeTempProject(root);
    const controller = startFixController({ report: localReport(root, digest), localRoot: root });
    assert.ok(controller.traceInbox.candidates.length > 0);
    assert.ok(controller.traceResults.some((entry) => entry.partials.length > 0));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('sandbox rollback endpoint requires exact confirm body and trusted origin', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-review-rollback-route-'));
  try {
    const { state, server } = await startHarness(root);
    state.raw.sandbox = {
      enabled: true,
      targetFile: 'src/partials/jobs/sort.liquid',
      transactionId: 'transaction-1700000000000-abcd1234',
      artifactPaths: null,
      artifactError: null,
      rollbackCompleted: false,
      rollbackResult: null,
    };
    state.raw.applyCompleted = true;

    const noHandlerState = createReviewState({
      sessionDir: join(root, 'scan-reports', 'fix-sessions', 'rollback-no-handler'),
      reportId: 'sha256:test',
      sessionId: 'rollback-no-handler',
      fixUnits: [],
      traceResults: [],
      policyRoutes: [],
      localRoot: root,
      sandboxContext: { enabled: true, targetFile: 'src/a.liquid' },
    });
    noHandlerState.raw.applyCompleted = true;
    noHandlerState.raw.sandbox.transactionId = 'transaction-1700000000000-abcd1234';
    const missingHandler = await startReviewServer({ state: noHandlerState });
    const noHandler = await fetch(`${missingHandler.url}api/sandbox/rollback`, {
      method: 'POST',
      headers: mutationHeaders(missingHandler),
      body: JSON.stringify({ confirm: true }),
    });
    assert.equal(noHandler.status, 503);
    await missingHandler.close();

    const badBody = await fetch(`${server.url}api/sandbox/rollback`, {
      method: 'POST',
      headers: mutationHeaders(server),
      body: JSON.stringify({ confirm: false }),
    });
    assert.equal(badBody.status, 400);
    const extraKey = await fetch(`${server.url}api/sandbox/rollback`, {
      method: 'POST',
      headers: mutationHeaders(server),
      body: JSON.stringify({ confirm: true, transactionId: 'transaction-1700000000000-evil' }),
    });
    assert.equal(extraKey.status, 400);

    const handler = async () => ({
      transactionId: 'transaction-1700000000000-abcd1234',
      targetFile: 'src/partials/jobs/sort.liquid',
      restored: [{ file: 'src/partials/jobs/sort.liquid' }],
      sandboxRestored: true,
      originalUnchangedAfterRollback: true,
    });
    const withHandler = await startReviewServer({ state, rollbackHandler: handler });
    const ok = await fetch(`${withHandler.url}api/sandbox/rollback`, {
      method: 'POST',
      headers: mutationHeaders(withHandler),
      body: JSON.stringify({ confirm: true }),
    });
    assert.equal(ok.status, 200);
    const payload = await ok.json();
    assert.equal(payload.snapshot.sandbox.rollbackCompleted, true);

    const replay = await fetch(`${withHandler.url}api/sandbox/rollback`, {
      method: 'POST',
      headers: mutationHeaders(withHandler),
      body: JSON.stringify({ confirm: true }),
    });
    assert.equal(replay.status, 400);
    assert.equal((await replay.json()).error, 'ROLLBACK_ALREADY_COMPLETED');
    await withHandler.close();
    await server.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('sandbox rollback endpoint enforces token, origin, content-type, and sandbox availability', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-review-rollback-guards-'));
  try {
    const { state, server } = await startHarness(root);
    state.raw.sandbox = {
      enabled: true,
      targetFile: 'src/partials/jobs/sort.liquid',
      transactionId: 'transaction-1700000000000-abcd1234',
      artifactPaths: null,
      artifactError: 'ARTIFACT_EXPORT_FAILED',
      rollbackCompleted: false,
      rollbackResult: null,
    };
    state.raw.applyCompleted = true;
    const handler = async () => ({
      transactionId: 'transaction-1700000000000-abcd1234',
      targetFile: 'src/partials/jobs/sort.liquid',
      restored: [{ file: 'src/partials/jobs/sort.liquid' }],
      sandboxRestored: true,
      originalUnchangedAfterRollback: true,
    });
    const withHandler = await startReviewServer({ state, rollbackHandler: handler });

    const noToken = await fetch(`${withHandler.url}api/sandbox/rollback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: withHandler.origin },
      body: JSON.stringify({ confirm: true }),
    });
    assert.equal(noToken.status, 403);

    const noOrigin = await fetch(`${withHandler.url}api/sandbox/rollback`, {
      method: 'POST',
      headers: tokenHeaders(withHandler, { 'content-type': 'application/json' }),
      body: JSON.stringify({ confirm: true }),
    });
    assert.equal(noOrigin.status, 403);

    const wrongOrigin = await fetch(`${withHandler.url}api/sandbox/rollback`, {
      method: 'POST',
      headers: mutationHeaders(withHandler, { origin: 'http://evil.test' }),
      body: JSON.stringify({ confirm: true }),
    });
    assert.equal(wrongOrigin.status, 403);

    const wrongType = await fetch(`${withHandler.url}api/sandbox/rollback`, {
      method: 'POST',
      headers: mutationHeaders(withHandler, { 'content-type': 'text/plain' }),
      body: 'confirm=true',
    });
    assert.equal(wrongType.status, 415);

    const nonSandboxState = createReviewState({
      sessionDir: join(root, 'scan-reports', 'fix-sessions', 'rollback-non-sandbox'),
      reportId: 'sha256:test',
      sessionId: 'rollback-non-sandbox',
      fixUnits: [],
      traceResults: [],
      policyRoutes: [],
      localRoot: root,
    });
    nonSandboxState.raw.applyCompleted = true;
    const nonSandboxServer = await startReviewServer({ state: nonSandboxState, rollbackHandler: handler });
    const unavailable = await fetch(`${nonSandboxServer.url}api/sandbox/rollback`, {
      method: 'POST',
      headers: mutationHeaders(nonSandboxServer),
      body: JSON.stringify({ confirm: true }),
    });
    assert.equal(unavailable.status, 400);
    assert.equal((await unavailable.json()).error, 'ROLLBACK_NOT_AVAILABLE');

    await withHandler.close();
    await nonSandboxServer.close();
    await server.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('parallel sandbox rollback HTTP requests invoke handler once', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-review-rollback-parallel-'));
  try {
    const { state, server: harnessServer } = await startHarness(root);
    state.raw.sandbox = {
      enabled: true,
      targetFile: 'src/partials/jobs/sort.liquid',
      transactionId: 'transaction-1700000000000-abcd1234',
      artifactPaths: null,
      artifactError: null,
      rollbackCompleted: false,
      rollbackResult: null,
    };
    state.raw.applyCompleted = true;

    let handlerCalls = 0;
    const handler = () => new Promise((resolve) => {
      handlerCalls += 1;
      setTimeout(() => resolve({
        transactionId: 'transaction-1700000000000-abcd1234',
        targetFile: 'src/partials/jobs/sort.liquid',
        restored: [{ file: 'src/partials/jobs/sort.liquid' }],
        sandboxRestored: true,
        originalUnchangedAfterRollback: true,
      }), 40);
    });

    const server = await startReviewServer({ state, rollbackHandler: handler });
    const headers = mutationHeaders(server);
    const body = JSON.stringify({ confirm: true });
    const [first, second] = await Promise.all([
      fetch(`${server.url}api/sandbox/rollback`, { method: 'POST', headers, body }),
      fetch(`${server.url}api/sandbox/rollback`, { method: 'POST', headers, body }),
    ]);

    assert.equal(handlerCalls, 1);
    const statuses = [first.status, second.status].sort();
    assert.deepEqual(statuses, [200, 200]);
    assert.equal(state.getSnapshot().sandbox.rollbackCompleted, true);
    await server.close();
    await harnessServer.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
