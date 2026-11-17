import { createHash } from 'node:crypto';
import {
  cpSync, mkdirSync, readFileSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeInstrumentationDigest } from '../../../src/tracer/build-instrumented.js';
import { buildScanReportV2 } from '../../../src/reporter/report-v2.js';
import { buildSourcePreimage } from '../../../src/tracer/preimage.js';
import { hashBlockText } from '../../../src/fix/context/broker.js';
import { runTrustedFixCli } from '../../../src/fix/controller/index.js';
import { readCisTelemetryRecords } from '../../../src/fix/cis/telemetry.js';
import { readBoundedFile } from '../../../src/fix/review/secure-io.js';
import { createLoopbackSiteAdapter, createPassingScanner } from './shadow-adapters.js';

const FIXTURE_ROOT = fileURLToPath(new URL('../../fixtures/fix/projects/minimal-liquid-site', import.meta.url));
const REVISION = 'git:abc123';

export function blockIdForUnit(fixUnitId) {
  return `ctx_${createHash('sha256').update(fixUnitId).digest('hex').slice(0, 16)}`;
}

export function setupPocProject(root) {
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

export function buildPocReport(root, digest) {
  const rel = 'src/pages/index.liquid';
  const content = readFileSync(join(root, rel), 'utf8');
  const preimage = buildSourcePreimage(content, 3);
  const baseFixture = JSON.parse(readFileSync(new URL('../../fixtures/fix/report-v2.json', import.meta.url), 'utf8'));
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

export function createCountingCisTransport(
  root,
  fixUnitId,
  findingId,
  sourceOwner,
  { sessionCalls = 1 } = {},
) {
  const bindingsBlockId = blockIdForUnit(fixUnitId);
  const lines = readFileSync(join(root, 'src/pages/index.liquid'), 'utf8').split('\n');
  const startLine = sourceOwner?.preimageRange?.start || sourceOwner?.line || 3;
  const endLine = sourceOwner?.preimageRange?.end || sourceOwner?.line || 3;
  const blockHash = hashBlockText(lines.slice(startLine - 1, endLine).join('\n'));
  let calls = 0;
  return {
    get calls() { return calls; },
    async chatCompletion() {
      calls += 1;
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
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        elapsedMs: 5,
      };
    },
    sessionCalls,
  };
}

export async function runFullPocHttpSession(root, {
  postVerify = async () => ({ ok: true, reason: 'POST_VERIFY_PASSED', unitResults: [] }),
  transportFactory = null,
} = {}) {
  const digest = setupPocProject(root);
  const report = buildPocReport(root, digest);
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
    cisTransportFactory: transportFactory || (({ fixUnits }) => {
      const ready = fixUnits.find((row) => row.status === 'ready');
      return createCountingCisTransport(
        root,
        ready.fixUnitId,
        ready.findingIds[0],
        ready.sourceOwner,
      );
    }),
    postVerify,
  });

  try {
    const assertOk = async (response, action) => {
      if (response.ok) return response;
      const body = await response.text();
      throw new Error(`${action} failed with HTTP ${response.status}: ${body}`);
    };
    const unit = cli.fixUnits.find((row) => row.status === 'ready');
    const token = cli.reviewServer.reviewUrl.split('#token=')[1];
    const baseUrl = cli.reviewServer.url.replace(/\/$/, '');
    const origin = cli.reviewServer.origin;
    const headers = (body) => ({
      'x-review-token': token,
      Origin: origin,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    });

    const uid = encodeURIComponent(unit.fixUnitId);
    await assertOk(
      await fetch(`${baseUrl}/api/fix-units/${uid}/propose`, { method: 'POST', headers: headers({}), body: '{}' }),
      'propose',
    );
    const snapshotResponse = await assertOk(
      await fetch(`${baseUrl}/api/snapshot`, { headers: headers() }),
      'snapshot',
    );
    const snap = await snapshotResponse.json();
    const candidate = snap.units.find((row) => row.fixUnitId === unit.fixUnitId)?.candidate;
    if (!candidate?.manualCheckAttestations?.[0]) {
      throw new Error('proposal did not register manual-check attestations');
    }
    const checkId = candidate.manualCheckAttestations[0].checkId;
    await assertOk(await fetch(`${baseUrl}/api/fix-units/${uid}/verify`, {
      method: 'POST',
      headers: headers({}),
      body: JSON.stringify({ acknowledgedCheckIds: [checkId] }),
    }), 'verify');
    await assertOk(await fetch(`${baseUrl}/api/fix-units/${uid}/decision`, {
      method: 'POST',
      headers: headers({}),
      body: JSON.stringify({ decision: 'accepted', candidateHash: candidate.candidateHash }),
    }), 'accept');
    await assertOk(await fetch(`${baseUrl}/api/fix-units/${uid}/approve-diff`, {
      method: 'POST',
      headers: headers({}),
      body: JSON.stringify({ candidateHash: candidate.candidateHash, diffHash: candidate.diffHash }),
    }), 'approve diff');
    const applyRes = await assertOk(
      await fetch(`${baseUrl}/api/apply`, { method: 'POST', headers: headers({}), body: '{}' }),
      'apply',
    );

    const sessionAuditRaw = readBoundedFile(join(cli.sessionDir, 'session.json'), 512 * 1024);
    const persisted = JSON.parse(sessionAuditRaw);

    return {
      cli,
      unit,
      applyStatus: applyRes.status,
      telemetryRecords: readCisTelemetryRecords(cli.sessionDir),
      auditLog: cli.reviewState.auditLog,
      persistedAuditLog: persisted.auditLog || [],
      sessionDir: cli.sessionDir,
      token,
      baseUrl,
      origin,
    };
  } catch (error) {
    await cli.reviewServer.close().catch(() => {});
    throw error;
  }
}
