import { createHash } from 'node:crypto';
import {
  mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, cpSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeInstrumentationDigest } from '../../src/tracer/build-instrumented.js';
import { buildScanReportV2 } from '../../src/reporter/report-v2.js';
import { buildSourcePreimage } from '../../src/tracer/preimage.js';
import { hashBlockText } from '../../src/fix/context/broker.js';
import { runTrustedFixCli } from '../../src/fix/controller/index.js';
import { TOKEN_HEADER } from '../../src/fix/review/server.js';
import { createLoopbackSiteAdapter, createPassingScanner } from './helpers/shadow-adapters.js';
import { readBoundedFile } from '../../src/fix/review/secure-io.js';
import { SUCCESS_PATH_AUDIT_TYPES } from '../../src/fix/audit/coverage.js';

const FIXTURE_ROOT = fileURLToPath(new URL('../fixtures/fix/projects/minimal-liquid-site', import.meta.url));
const REVISION = 'git:abc123';

function blockIdForUnit(fixUnitId) {
  return `ctx_${createHash('sha256').update(fixUnitId).digest('hex').slice(0, 16)}`;
}

function setupProject(root) {
  cpSync(FIXTURE_ROOT, root, { recursive: true });
  writeFileSync(join(root, '.scan-config.json'), JSON.stringify({ outDir: 'dist' }));
  mkdirSync(join(root, 'dist'), { recursive: true });
  const manifest = { 'dist/pages/index.html': 'src/pages/index.liquid' };
  writeFileSync(join(root, 'dist', 'scan-manifest.json'), JSON.stringify(manifest));
  const digest = computeInstrumentationDigest(manifest);
  writeFileSync(join(root, 'dist', 'scan-attestation.json'), JSON.stringify({
    buildRevision: REVISION,
    instrumentationDigest: digest,
  }));
  return digest;
}

function buildReport(root, digest) {
  const rel = 'src/pages/index.liquid';
  const content = readFileSync(join(root, rel), 'utf8');
  const preimage = buildSourcePreimage(content, 3);
  const baseFixture = JSON.parse(readFileSync(new URL('../fixtures/fix/report-v2.json', import.meta.url), 'utf8'));
  const scanResults = structuredClone(baseFixture.scanResults);
  scanResults[0].url = 'http://127.0.0.1:8765/';
  scanResults[0].violations = [{
    id: 'runtime-axe',
    ruleId: 'button-name',
    layer: 'axe',
    category: 'accessibility',
    wcagRef: 'wcag2a',
    impact: 'critical',
    priority: 1,
    count: 1,
    foundAt: '2026-07-15T00:01:00.000Z',
    element: { outerHTML: '<button id="apply">Apply</button>', selector: '#apply' },
    source: {
      mode: 'url',
      file: rel,
      line: 3,
      snippet: 'apply',
      url: 'http://127.0.0.1:8765/',
      confidence: 'high',
      method: 'instrumentation-manifest',
      preimageSha256: preimage.preimageSha256,
      preimageRange: preimage.range,
    },
    fix: { deterministic: false, hint: 'Add aria-label.', patch: null },
    evidence: { tags: ['wcag2a'], viewports: [{ name: 'mobile', width: 390, height: 844 }] },
  }];
  return buildScanReportV2(scanResults, {
    ...baseFixture.context,
    target: {
      mode: 'local-only',
      url: 'http://127.0.0.1:8765/',
      buildRevision: REVISION,
      instrumentationDigest: digest,
    },
  });
}

function snapshotBytes(root, rel) {
  return readFileSync(join(root, rel));
}

async function apiFetch(baseUrl, token, origin, path, { method = 'GET', body = null } = {}) {
  const headers = {
    [TOKEN_HEADER]: token,
    Origin: origin,
  };
  if (body != null) {
    headers['Content-Type'] = 'application/json';
  }
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json();
  return { status: response.status, payload };
}

function createDeterministicCisTransport(root, fixUnitId, findingId, sourceOwner) {
  const bindingsBlockId = blockIdForUnit(fixUnitId);
  const lines = readFileSync(join(root, 'src/pages/index.liquid'), 'utf8').split('\n');
  const startLine = sourceOwner?.preimageRange?.start || sourceOwner?.line || 3;
  const endLine = sourceOwner?.preimageRange?.end || sourceOwner?.line || 3;
  const blockHash = hashBlockText(lines.slice(startLine - 1, endLine).join('\n'));
  return {
    async chatCompletion() {
      return {
        content: JSON.stringify({
          action: 'propose_patch',
          edits: [{
            blockId: bindingsBlockId,
            expectedSha256: blockHash,
            oldText: '<button id="apply">Apply</button>',
            newText: '<button id="apply" aria-label="Apply">Apply</button>',
          }],
          resolvesFindingIds: [findingId],
          rationale: 'Add aria-label for apply control.',
          manualChecks: ['Confirm screen reader announces Apply.'],
        }),
      };
    },
  };
}

test('PoC integration: propose → verify attestation → apply with post-verify via HTTP', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-poc-integration-'));
  const rel = 'src/pages/index.liquid';
  try {
    const digest = setupProject(root);
    const report = buildReport(root, digest);
    const beforeBytes = snapshotBytes(root, rel);

    const verification = {
      build: { command: process.execPath, args: [join(root, 'scripts/build.js')] },
      site: createLoopbackSiteAdapter('http://127.0.0.1:8765'),
      scanner: createPassingScanner(),
    };

    const cli = await runTrustedFixCli({
      report,
      localRoot: root,
      useUI: true,
      verification,
      cisTransportFactory: ({ fixUnits }) => {
        const ready = fixUnits.find((row) => row.status === 'ready');
        return createDeterministicCisTransport(root, ready.fixUnitId, ready.findingIds[0], ready.sourceOwner);
      },
      postVerify: async () => ({ ok: true, reason: 'POST_VERIFY_PASSED', unitResults: [] }),
    });

    assert.equal(cli.status, 'review');
    const unit = cli.fixUnits.find((row) => row.status === 'ready');
    assert.ok(unit, 'expected ready unit');

    const token = cli.reviewServer.reviewUrl.split('#token=')[1];
    const baseUrl = cli.reviewServer.url.replace(/\/$/, '');
    const origin = cli.reviewServer.origin;

    await apiFetch(baseUrl, token, origin, `/api/fix-units/${encodeURIComponent(unit.fixUnitId)}/propose`, {
      method: 'POST',
      body: {},
    });
    assert.equal(snapshotBytes(root, rel).equals(beforeBytes), true, 'propose must not write source');

    const rejectVerify = await apiFetch(baseUrl, token, origin, `/api/fix-units/${encodeURIComponent(unit.fixUnitId)}/verify`, {
      method: 'POST',
      body: { acknowledgedCheckIds: [] },
    });
    assert.equal(rejectVerify.status, 400);

    const snapAfterProposal = (await apiFetch(baseUrl, token, origin, '/api/snapshot')).payload;
    const candidate = snapAfterProposal.units.find((row) => row.fixUnitId === unit.fixUnitId)?.candidate;
    assert.ok(candidate?.manualCheckAttestations?.length === 1);
    const checkId = candidate.manualCheckAttestations[0].checkId;

    const verifyRes = await apiFetch(baseUrl, token, origin, `/api/fix-units/${encodeURIComponent(unit.fixUnitId)}/verify`, {
      method: 'POST',
      body: { acknowledgedCheckIds: [checkId] },
    });
    assert.equal(verifyRes.status, 200);
    assert.equal(snapshotBytes(root, rel).equals(beforeBytes), true, 'verify must not write source');

    await apiFetch(baseUrl, token, origin, `/api/fix-units/${encodeURIComponent(unit.fixUnitId)}/decision`, {
      method: 'POST',
      body: { decision: 'accepted', candidateHash: candidate.candidateHash },
    });
    await apiFetch(baseUrl, token, origin, `/api/fix-units/${encodeURIComponent(unit.fixUnitId)}/approve-diff`, {
      method: 'POST',
      body: { candidateHash: candidate.candidateHash, diffHash: candidate.diffHash },
    });
    assert.equal(snapshotBytes(root, rel).equals(beforeBytes), true, 'pre-apply must not write source');

    const applyRes = await apiFetch(baseUrl, token, origin, '/api/apply', { method: 'POST', body: {} });
    assert.equal(applyRes.status, 200);
    const afterBytes = snapshotBytes(root, rel);
    assert.notEqual(afterBytes.equals(beforeBytes), true, 'apply must write source');
    assert.match(afterBytes.toString('utf8'), /aria-label="Apply"/);

    const telemetryRaw = readBoundedFile(join(cli.sessionDir, 'cis-telemetry.ndjson'), 256 * 1024);
    assert.ok(telemetryRaw && telemetryRaw.includes('"sessionCalls"'));

    const auditTypes = new Set(cli.reviewState.auditLog.map((event) => event.type));
    for (const type of SUCCESS_PATH_AUDIT_TYPES) {
      assert.ok(auditTypes.has(type), `missing audit ${type}`);
    }

    await cli.reviewServer.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('PoC integration: post-verify failure rolls back committed bytes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-poc-postfail-'));
  const rel = 'src/pages/index.liquid';
  try {
    const digest = setupProject(root);
    const report = buildReport(root, digest);
    const beforeBytes = snapshotBytes(root, rel);

    const verification = {
      build: { command: process.execPath, args: [join(root, 'scripts/build.js')] },
      site: createLoopbackSiteAdapter('http://127.0.0.1:8765'),
      scanner: createPassingScanner(),
    };

    const cli = await runTrustedFixCli({
      report,
      localRoot: root,
      useUI: true,
      verification,
      cisTransportFactory: ({ fixUnits }) => {
        const ready = fixUnits.find((row) => row.status === 'ready');
        return createDeterministicCisTransport(root, ready.fixUnitId, ready.findingIds[0], ready.sourceOwner);
      },
      postVerify: async () => ({ ok: false, reason: 'POST_VERIFY_FAILED', unitResults: [] }),
    });

    const unit = cli.fixUnits.find((row) => row.status === 'ready');
    const token = cli.reviewServer.reviewUrl.split('#token=')[1];
    const baseUrl = cli.reviewServer.url.replace(/\/$/, '');
    const origin = cli.reviewServer.origin;

    await apiFetch(baseUrl, token, origin, `/api/fix-units/${encodeURIComponent(unit.fixUnitId)}/propose`, {
      method: 'POST',
      body: {},
    });
    const snap = (await apiFetch(baseUrl, token, origin, '/api/snapshot')).payload;
    const candidate = snap.units.find((row) => row.fixUnitId === unit.fixUnitId)?.candidate;
    const checkId = candidate.manualCheckAttestations[0].checkId;

    await apiFetch(baseUrl, token, origin, `/api/fix-units/${encodeURIComponent(unit.fixUnitId)}/verify`, {
      method: 'POST',
      body: { acknowledgedCheckIds: [checkId] },
    });
    await apiFetch(baseUrl, token, origin, `/api/fix-units/${encodeURIComponent(unit.fixUnitId)}/decision`, {
      method: 'POST',
      body: { decision: 'accepted', candidateHash: candidate.candidateHash },
    });
    await apiFetch(baseUrl, token, origin, `/api/fix-units/${encodeURIComponent(unit.fixUnitId)}/approve-diff`, {
      method: 'POST',
      body: { candidateHash: candidate.candidateHash, diffHash: candidate.diffHash },
    });

    const applyRes = await apiFetch(baseUrl, token, origin, '/api/apply', { method: 'POST', body: {} });
    assert.equal(applyRes.status, 400);
    assert.equal(snapshotBytes(root, rel).equals(beforeBytes), true, 'post-verify failure must rollback bytes');

    const auditTypes = new Set(cli.reviewState.auditLog.map((event) => event.type));
    assert.ok(auditTypes.has('post_verify_failed'));
    assert.ok(auditTypes.has('post_verify_started'));

    await cli.reviewServer.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('PoC integration: parallel /api/apply invokes handler once and blocks duplicate commit', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-poc-parallel-apply-'));
  const rel = 'src/pages/index.liquid';
  let cli = null;
  try {
    const digest = setupProject(root);
    const report = buildReport(root, digest);
    const beforeBytes = snapshotBytes(root, rel);
    let handlerCalls = 0;

    const verification = {
      build: { command: process.execPath, args: [join(root, 'scripts/build.js')] },
      site: createLoopbackSiteAdapter('http://127.0.0.1:8765'),
      scanner: createPassingScanner(),
    };

    cli = await runTrustedFixCli({
      report,
      localRoot: root,
      useUI: true,
      verification,
      cisTransportFactory: ({ fixUnits }) => {
        const ready = fixUnits.find((row) => row.status === 'ready');
        return createDeterministicCisTransport(root, ready.fixUnitId, ready.findingIds[0], ready.sourceOwner);
      },
      postVerify: async () => {
        await new Promise((resolve) => setTimeout(resolve, 400));
        return { ok: true, reason: 'POST_VERIFY_PASSED', unitResults: [] };
      },
      applyHandlerWrap: (handler) => async (payload) => {
        handlerCalls += 1;
        return handler(payload);
      },
    });

    const unit = cli.fixUnits.find((row) => row.status === 'ready');
    const token = cli.reviewServer.reviewUrl.split('#token=')[1];
    const baseUrl = cli.reviewServer.url.replace(/\/$/, '');
    const origin = cli.reviewServer.origin;
    const uid = encodeURIComponent(unit.fixUnitId);

    await apiFetch(baseUrl, token, origin, `/api/fix-units/${uid}/propose`, { method: 'POST', body: {} });
    const snap = (await apiFetch(baseUrl, token, origin, '/api/snapshot')).payload;
    const candidate = snap.units.find((row) => row.fixUnitId === unit.fixUnitId)?.candidate;
    const checkId = candidate.manualCheckAttestations[0].checkId;
    await apiFetch(baseUrl, token, origin, `/api/fix-units/${uid}/verify`, {
      method: 'POST',
      body: { acknowledgedCheckIds: [checkId] },
    });
    await apiFetch(baseUrl, token, origin, `/api/fix-units/${uid}/decision`, {
      method: 'POST',
      body: { decision: 'accepted', candidateHash: candidate.candidateHash },
    });
    await apiFetch(baseUrl, token, origin, `/api/fix-units/${uid}/approve-diff`, {
      method: 'POST',
      body: { candidateHash: candidate.candidateHash, diffHash: candidate.diffHash },
    });

    const headers = {
      [TOKEN_HEADER]: token,
      Origin: origin,
      'Content-Type': 'application/json',
    };
    const [first, second] = await Promise.all([
      fetch(`${baseUrl}/api/apply`, { method: 'POST', headers, body: '{}' }),
      fetch(`${baseUrl}/api/apply`, { method: 'POST', headers, body: '{}' }),
    ]);

    const statuses = [first.status, second.status].sort();
    assert.ok(statuses.includes(200), `expected one success, got ${statuses.join(',')}`);
    assert.ok(statuses.includes(400), `expected one blocked, got ${statuses.join(',')}`);
    assert.equal(handlerCalls, 1, 'trusted apply handler must run exactly once');

    const applyStarted = cli.reviewState.auditLog.filter((event) => event.type === 'apply_started');
    assert.equal(applyStarted.length, 1);
    assert.equal(snapshotBytes(root, rel).equals(beforeBytes), false);

  } finally {
    await cli?.reviewServer?.close().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
});

test('PoC integration: explicit session id resumes verified accepted diff without source writes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-poc-resume-'));
  const rel = 'src/pages/index.liquid';
  const sessionId = 'resume-e2e';
  let firstCli = null;
  let resumedCli = null;
  try {
    const digest = setupProject(root);
    const report = buildReport(root, digest);
    const beforeBytes = snapshotBytes(root, rel);
    const verification = {
      build: { command: process.execPath, args: [join(root, 'scripts/build.js')] },
      site: createLoopbackSiteAdapter('http://127.0.0.1:8765'),
      scanner: createPassingScanner(),
    };
    const cisTransportFactory = ({ fixUnits }) => {
      const ready = fixUnits.find((row) => row.status === 'ready');
      return createDeterministicCisTransport(root, ready.fixUnitId, ready.findingIds[0], ready.sourceOwner);
    };

    firstCli = await runTrustedFixCli({
      report,
      localRoot: root,
      sessionId,
      useUI: true,
      verification,
      cisTransportFactory,
      postVerify: async () => ({ ok: true, reason: 'POST_VERIFY_PASSED', unitResults: [] }),
    });
    const unit = firstCli.fixUnits.find((row) => row.status === 'ready');
    const token = firstCli.reviewServer.reviewUrl.split('#token=')[1];
    const baseUrl = firstCli.reviewServer.url.replace(/\/$/, '');
    const origin = firstCli.reviewServer.origin;
    const uid = encodeURIComponent(unit.fixUnitId);

    await apiFetch(baseUrl, token, origin, `/api/fix-units/${uid}/propose`, { method: 'POST', body: {} });
    const proposed = (await apiFetch(baseUrl, token, origin, '/api/snapshot')).payload;
    const candidate = proposed.units.find((row) => row.fixUnitId === unit.fixUnitId)?.candidate;
    const checkId = candidate.manualCheckAttestations[0].checkId;
    await apiFetch(baseUrl, token, origin, `/api/fix-units/${uid}/verify`, {
      method: 'POST',
      body: { acknowledgedCheckIds: [checkId] },
    });
    await apiFetch(baseUrl, token, origin, `/api/fix-units/${uid}/decision`, {
      method: 'POST',
      body: { decision: 'accepted', candidateHash: candidate.candidateHash },
    });
    await apiFetch(baseUrl, token, origin, `/api/fix-units/${uid}/approve-diff`, {
      method: 'POST',
      body: { candidateHash: candidate.candidateHash, diffHash: candidate.diffHash },
    });
    await firstCli.reviewServer.close();
    firstCli = null;

    resumedCli = await runTrustedFixCli({
      report,
      localRoot: root,
      sessionId,
      useUI: true,
      verification,
      cisTransportFactory,
      postVerify: async () => ({ ok: true, reason: 'POST_VERIFY_PASSED', unitResults: [] }),
    });
    const resumed = resumedCli.reviewState.getSnapshot();
    const resumedUnit = resumed.units.find((row) => row.fixUnitId === unit.fixUnitId);
    assert.equal(resumedUnit.reviewStatus, 'accepted');
    assert.equal(resumedUnit.verified, true);
    assert.equal(resumedUnit.diffApproved, true);
    assert.equal(resumed.applyGate.blocked, false);
    assert.equal(snapshotBytes(root, rel).equals(beforeBytes), true);
  } finally {
    await firstCli?.reviewServer?.close().catch(() => {});
    await resumedCli?.reviewServer?.close().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
});
