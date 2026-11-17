import { randomBytes } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closeReviewServerWithCisTransport } from '../../src/fix/controller/index.js';
import { hashFileBytes } from '../../src/fix/candidate/intent.js';
import { readDemoEvidence } from '../../src/fix/demo/artifacts.js';
import { runCisDemo } from '../../src/fix/demo/orchestrator.js';
import { TOKEN_HEADER } from '../../src/fix/review/server.js';
import { readBoundedFile } from '../../src/fix/review/secure-io.js';
import { compareVerificationFindings } from '../../src/fix/verify/verification-key.js';
import { buildScanReportV2 } from '../../src/reporter/report-v2.js';
import { buildSourcePreimage } from '../../src/tracer/preimage.js';
import {
  buildPocReport,
  createCountingCisTransport,
  setupPocProject,
} from './helpers/poc-session.js';
import { createLoopbackSiteAdapter, createPassingScanner } from './helpers/shadow-adapters.js';

const TARGET_FILE = 'src/pages/index.liquid';
const PLANTED_SECRET = 'must-not-leak';
const SECRET_MARKERS = ['CIS_AUTH_TOKEN', 'SECRET=', 'credentials/api.json'];
const SESSION_WALK_MAX_FILE_BYTES = 512 * 1024;
const SESSION_WALK_MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const SESSION_WALK_MAX_FILES = 500;
const EXCLUDED_SECRET_PATHS = Object.freeze([
  'demo-workspace/.env',
  'demo-workspace/credentials/api.json',
]);

function uniqueSessionId() {
  return `demo-e2e-${process.pid}-${randomBytes(4).toString('hex')}`;
}

function snapshotBytes(root, rel) {
  return readFileSync(join(root, rel));
}

function walkSessionRegularFiles(sessionDir) {
  const files = [];
  let totalBytes = 0;

  function visit(currentDir) {
    for (const name of readdirSync(currentDir)) {
      const absPath = join(currentDir, name);
      let stat;
      try {
        stat = lstatSync(absPath);
      } catch {
        continue;
      }
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        visit(absPath);
        continue;
      }
      if (!stat.isFile()) continue;
      if (files.length >= SESSION_WALK_MAX_FILES) {
        throw new Error(`session walk exceeded ${SESSION_WALK_MAX_FILES} files under ${sessionDir}`);
      }
      if (stat.size > SESSION_WALK_MAX_FILE_BYTES) {
        throw new Error(`session file exceeds per-file bound: ${absPath}`);
      }
      totalBytes += stat.size;
      if (totalBytes > SESSION_WALK_MAX_TOTAL_BYTES) {
        throw new Error(`session walk exceeded total byte bound under ${sessionDir}`);
      }
      files.push(absPath);
    }
  }

  visit(sessionDir);
  return files;
}

function assertNoSecretLeakage(sessionDir) {
  for (const rel of EXCLUDED_SECRET_PATHS) {
    assert.equal(existsSync(join(sessionDir, rel)), false, `copied secret source must stay out of session: ${rel}`);
  }

  for (const filePath of walkSessionRegularFiles(sessionDir)) {
    const rel = relative(sessionDir, filePath);
    const raw = readBoundedFile(filePath, SESSION_WALK_MAX_FILE_BYTES) || '';
    assert.equal(raw.includes(PLANTED_SECRET), false, `planted secret value leaked in ${rel}`);
    for (const marker of SECRET_MARKERS) {
      assert.equal(raw.includes(marker), false, `unexpected secret marker ${marker} in ${rel}`);
    }
  }

  const serialized = JSON.stringify({ sessionDir });
  assert.equal(serialized.includes('CIS_AUTH_TOKEN'), false);
  assert.equal(serialized.includes(PLANTED_SECRET), false);
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

function assertBytesUnchanged(root, rel, expected, label) {
  assert.equal(snapshotBytes(root, rel).equals(expected), true, label);
}

function findAccessibilityUnit(snapshot, fixUnitId) {
  return snapshot.accessibility?.sources
    ?.flatMap((group) => group.units)
    ?.find((unit) => unit.fixUnitId === fixUnitId);
}

test('demo e2e: runCisDemo through HTTP apply and sandbox rollback with deterministic fixtures', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-demo-e2e-'));
  const sessionId = uniqueSessionId();
  const sessionDir = join(root, 'scan-reports', 'fix-sessions', sessionId);
  const sandboxRoot = join(sessionDir, 'demo-workspace');
  let transport = null;
  let reviewServer = null;
  try {
    const digest = setupPocProject(root);
    writeFileSync(join(root, '.env'), `SECRET=${PLANTED_SECRET}\n`);
    mkdirSync(join(root, 'credentials'), { recursive: true });
    writeFileSync(join(root, 'credentials', 'api.json'), `{"token":"${PLANTED_SECRET}"}`);
    const originalBefore = snapshotBytes(root, TARGET_FILE);
    const originalHash = hashFileBytes(originalBefore);

    let postVerifyCalls = 0;
    const noopRunCommand = async () => ({ code: 0, stdout: '', stderr: '' });
    const verification = {
      build: { command: process.execPath, args: [join(sandboxRoot, 'scripts/build.js')] },
      site: createLoopbackSiteAdapter('http://127.0.0.1:8765'),
      scanner: createPassingScanner(),
    };

    const demo = await runCisDemo({
      originalRoot: root,
      targetFile: TARGET_FILE,
      sessionId,
      route: '/',
      useUI: true,
    }, {
      runCommand: noopRunCommand,
      packageManagerCommand: process.execPath,
      runFreshSandboxScan: async ({ sandboxRoot: scannedRoot }) => ({
        report: buildPocReport(scannedRoot, digest),
      }),
      verification,
      cisTransportFactory: ({ fixUnits, localRoot }) => {
        const ready = fixUnits.find((row) => row.status === 'ready');
        assert.ok(ready, 'expected ready fix unit for CIS transport');
        transport = createCountingCisTransport(
          localRoot,
          ready.fixUnitId,
          ready.findingIds[0],
          ready.sourceOwner,
        );
        return transport;
      },
      cisModel: 'anthropic.claude-sonnet-5',
      postVerify: async () => {
        postVerifyCalls += 1;
        return { ok: true, reason: 'POST_VERIFY_PASSED', unitResults: [] };
      },
    });

    assert.equal(demo.review.status, 'review');
    assert.equal(existsSync(sandboxRoot), true);
    assert.equal(existsSync(join(sandboxRoot, TARGET_FILE)), true);
    assert.match(demo.checkpoints.original.fileSha256, /^sha256:[a-f0-9]{64}$/);
    assert.equal(demo.checkpoints.original.fileSha256, demo.checkpoints.sandbox.fileSha256);
    assert.equal(demo.checkpoints.original.fileSha256, originalHash);

    const sandboxBeforeBytes = snapshotBytes(sandboxRoot, TARGET_FILE);
    assert.equal(sandboxBeforeBytes.equals(originalBefore), true);

    reviewServer = demo.review.reviewServer;
    const token = reviewServer.reviewUrl.split('#token=')[1];
    const baseUrl = reviewServer.url.replace(/\/$/, '');
    const origin = reviewServer.origin;

    const initialSnapRes = await apiFetch(baseUrl, token, origin, '/api/snapshot');
    assert.equal(initialSnapRes.status, 200);
    const initialSnap = initialSnapRes.payload;
    const readyUnit = initialSnap.units.find(
      (row) => row.sourceFile === TARGET_FILE && row.reviewStatus === 'pending',
    );
    assert.ok(readyUnit, 'snapshot must expose a proposable target unit');

    const uid = encodeURIComponent(readyUnit.fixUnitId);
    const proposeRes = await apiFetch(baseUrl, token, origin, `/api/fix-units/${uid}/propose`, {
      method: 'POST',
      body: {},
    });
    assert.equal(proposeRes.status, 200);
    assertBytesUnchanged(root, TARGET_FILE, originalBefore, 'propose must not write original');
    assertBytesUnchanged(sandboxRoot, TARGET_FILE, sandboxBeforeBytes, 'propose must not write sandbox');

    const rejectVerify = await apiFetch(baseUrl, token, origin, `/api/fix-units/${uid}/verify`, {
      method: 'POST',
      body: { acknowledgedCheckIds: [] },
    });
    assert.equal(rejectVerify.status, 400);

    const snapAfterProposalRes = await apiFetch(baseUrl, token, origin, '/api/snapshot');
    assert.equal(snapAfterProposalRes.status, 200);
    const snapAfterProposal = snapAfterProposalRes.payload;
    const candidate = snapAfterProposal.units.find((row) => row.fixUnitId === readyUnit.fixUnitId)?.candidate;
    assert.ok(candidate?.manualCheckAttestations?.length === 1);
    const accessibilityUnit = findAccessibilityUnit(snapAfterProposal, readyUnit.fixUnitId);
    assert.equal(accessibilityUnit?.diff?.kind, 'candidate');
    const diffRows = accessibilityUnit?.diff?.view?.files?.flatMap((file) => file.rows) || [];
    assert.ok(diffRows.some((line) => line.kind === 'removed'));
    assert.ok(diffRows.some((line) => line.kind === 'added'));
    const checkId = candidate.manualCheckAttestations[0].checkId;

    const verifyRes = await apiFetch(baseUrl, token, origin, `/api/fix-units/${uid}/verify`, {
      method: 'POST',
      body: { acknowledgedCheckIds: [checkId] },
    });
    assert.equal(verifyRes.status, 200);
    assertBytesUnchanged(root, TARGET_FILE, originalBefore, 'verify must not write original');
    assertBytesUnchanged(sandboxRoot, TARGET_FILE, sandboxBeforeBytes, 'verify must not write sandbox');

    const decisionRes = await apiFetch(baseUrl, token, origin, `/api/fix-units/${uid}/decision`, {
      method: 'POST',
      body: { decision: 'accepted', candidateHash: candidate.candidateHash },
    });
    assert.equal(decisionRes.status, 200);

    const approveDiffRes = await apiFetch(baseUrl, token, origin, `/api/fix-units/${uid}/approve-diff`, {
      method: 'POST',
      body: { candidateHash: candidate.candidateHash, diffHash: candidate.diffHash },
    });
    assert.equal(approveDiffRes.status, 200);
    assertBytesUnchanged(root, TARGET_FILE, originalBefore, 'pre-apply must not write original');
    assertBytesUnchanged(sandboxRoot, TARGET_FILE, sandboxBeforeBytes, 'pre-apply must not write sandbox');

    const applyRes = await apiFetch(baseUrl, token, origin, '/api/apply', { method: 'POST', body: {} });
    assert.equal(applyRes.status, 200);
    assert.equal(applyRes.payload.result?.postVerified, true);
    assert.equal(postVerifyCalls, 1);

    const auditTypes = new Set(demo.review.reviewState.auditLog.map((event) => event.type));
    assert.ok(auditTypes.has('post_verify_started'));
    assert.ok(auditTypes.has('post_verify_completed'));
    assert.ok(auditTypes.has('apply_completed'));

    const originalAfterApply = snapshotBytes(root, TARGET_FILE);
    const sandboxAfterApply = snapshotBytes(sandboxRoot, TARGET_FILE);
    assert.equal(originalAfterApply.equals(originalBefore), true);
    assert.equal(sandboxAfterApply.equals(sandboxBeforeBytes), false);
    assert.match(sandboxAfterApply.toString('utf8'), /aria-label="Apply"/);

    const postApplySnapRes = await apiFetch(baseUrl, token, origin, '/api/snapshot');
    assert.equal(postApplySnapRes.status, 200);
    const postApplySnap = postApplySnapRes.payload;
    assert.equal(postApplySnap.sandbox?.rollbackAvailable, true);
    assert.equal(postApplySnap.sandbox?.rollbackCompleted, false);
    assert.equal(typeof postApplySnap.sandbox?.transactionId, 'string');
    assert.match(postApplySnap.sandbox?.transactionId, /^transaction-\d+-[a-f0-9]+$/);
    assert.equal(postApplySnap.sandbox?.artifactPaths?.patch, 'artifacts/candidate.patch');
    assert.equal(postApplySnap.sandbox?.artifactPaths?.fixed, `artifacts/fixed/${TARGET_FILE}`);
    assert.equal(postApplySnap.sandbox?.artifactPaths?.evidence, 'artifacts/evidence.json');
    assert.equal(postApplySnap.sandbox?.artifactPaths?.transactionId, postApplySnap.sandbox.transactionId);
    assert.equal(postApplySnap.sandbox?.artifactPaths?.transactionDir, postApplySnap.sandbox.transactionId);

    const transactionId = postApplySnap.sandbox.transactionId;
    const transactionDir = join(sessionDir, transactionId);
    assert.equal(existsSync(join(transactionDir, 'journal.ndjson')), true);
    assert.equal(existsSync(join(transactionDir, 'snapshots', TARGET_FILE)), true);

    const fixedRel = `artifacts/fixed/${TARGET_FILE}`;
    const fixedBytes = readFileSync(join(sessionDir, fixedRel));
    const patchText = readFileSync(join(sessionDir, 'artifacts/candidate.patch'), 'utf8');
    assert.equal(fixedBytes.equals(sandboxAfterApply), true);
    assert.equal(patchText, accessibilityUnit.diff.text);
    assert.match(patchText, /aria-label="Apply"/);

    const evidence = readDemoEvidence(sessionDir);
    assert.equal(evidence.originalUnchangedAfterApply, true);
    assert.equal(evidence.originalUnchangedAfterRollback, null);
    assert.equal(evidence.sandboxRestored, null);
    assert.equal(evidence.candidateHash, candidate.candidateHash);
    assert.equal(evidence.diffHash, candidate.diffHash);
    assert.equal(evidence.transactionId, transactionId);
    assert.match(evidence.modelId, /^[a-z0-9]/i);
    assert.equal(evidence.original.preimageSha256, demo.checkpoints.original.fileSha256);
    assert.equal(evidence.original.afterApplySha256, demo.checkpoints.original.fileSha256);
    assert.equal(evidence.sandbox.postApplySha256, hashFileBytes(sandboxAfterApply));

    const rollbackRes = await apiFetch(baseUrl, token, origin, '/api/sandbox/rollback', {
      method: 'POST',
      body: { confirm: true },
    });
    assert.equal(rollbackRes.status, 200);

    const sandboxAfterRollback = snapshotBytes(sandboxRoot, TARGET_FILE);
    const originalAfterRollback = snapshotBytes(root, TARGET_FILE);
    assert.equal(sandboxAfterRollback.equals(sandboxBeforeBytes), true);
    assert.equal(originalAfterRollback.equals(originalBefore), true);

    assert.equal(existsSync(join(sessionDir, 'artifacts/candidate.patch')), true);
    assert.equal(existsSync(join(sessionDir, fixedRel)), true);

    const evidenceAfterRollback = readDemoEvidence(sessionDir);
    assert.equal(evidenceAfterRollback.originalUnchangedAfterApply, true);
    assert.equal(evidenceAfterRollback.originalUnchangedAfterRollback, true);
    assert.equal(evidenceAfterRollback.sandboxRestored, true);
    assert.equal(evidenceAfterRollback.sandbox.afterRollbackSha256, evidenceAfterRollback.sandbox.preimageSha256);
    assert.equal(evidenceAfterRollback.original.afterRollbackSha256, evidenceAfterRollback.original.preimageSha256);

    const finalSnapRes = await apiFetch(baseUrl, token, origin, '/api/snapshot');
    assert.equal(finalSnapRes.status, 200);
    const finalSnap = finalSnapRes.payload;
    assert.equal(finalSnap.sandbox?.rollbackCompleted, true);
    assert.equal(finalSnap.sandbox?.rollbackAvailable, false);

    const replay = await apiFetch(baseUrl, token, origin, '/api/sandbox/rollback', {
      method: 'POST',
      body: { confirm: true },
    });
    assert.equal(replay.status, 400);
    assert.equal(replay.payload.error, 'ROLLBACK_ALREADY_COMPLETED');

    assert.equal(transport?.calls, 1);
    assertNoSecretLeakage(sessionDir);
  } finally {
    if (reviewServer) {
      await closeReviewServerWithCisTransport(reviewServer.close.bind(reviewServer), transport).catch(() => {});
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test('demo e2e: default post-apply verification keeps the full baseline after target filtering', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-demo-default-post-verify-'));
  const sessionId = uniqueSessionId();
  const sessionDir = join(root, 'scan-reports', 'fix-sessions', sessionId);
  const sandboxRoot = join(sessionDir, 'demo-workspace');
  const unrelatedFile = 'src/partials/layout/header.liquid';
  let transport = null;
  let reviewServer = null;
  try {
    const digest = setupPocProject(root);
    mkdirSync(join(root, 'src', 'partials', 'layout'), { recursive: true });
    writeFileSync(join(root, unrelatedFile), '<h3 id="unrelated-heading">Existing issue</h3>\n');

    let scanCalls = 0;
    const receivedBaselines = [];
    let unrelatedFinding = null;
    const scanner = async () => {
      scanCalls += 1;
      return {
        findings: [structuredClone(unrelatedFinding)],
        sourceTraceResolved: true,
        sourceTraceByTarget: [],
        executedLayers: ['axe', 'accessScan'],
        compareFindings(baselineFindings, afterFindings, targetFindingIds) {
          receivedBaselines.push(structuredClone(baselineFindings));
          return compareVerificationFindings(
            baselineFindings,
            afterFindings,
            targetFindingIds,
          );
        },
      };
    };
    scanner.ownsSiteLifecycle = true;

    const demo = await runCisDemo({
      originalRoot: root,
      targetFile: TARGET_FILE,
      sessionId,
      route: '/',
      useUI: true,
    }, {
      runCommand: async () => ({ code: 0, stdout: '', stderr: '' }),
      packageManagerCommand: process.execPath,
      runFreshSandboxScan: async ({ sandboxRoot: scannedRoot }) => {
        const baseReport = buildPocReport(scannedRoot, digest);
        const targetFinding = baseReport.pages[0].findings[0];
        const unrelatedContent = readFileSync(join(scannedRoot, unrelatedFile), 'utf8');
        const unrelatedPreimage = buildSourcePreimage(unrelatedContent, 1);
        const unrelatedCandidate = {
          ...structuredClone(targetFinding),
          canonicalRuleId: 'heading-order',
          nativeRuleId: 'heading-order',
          ruleId: 'heading-order',
          layer: 'accessScan',
          impact: 'serious',
          element: {
            outerHTML: '<h3 id="unrelated-heading">Existing issue</h3>',
            selector: '#unrelated-heading',
          },
          source: {
            ...structuredClone(targetFinding.source),
            file: unrelatedFile,
            line: 1,
            preimageSha256: unrelatedPreimage.preimageSha256,
            preimageRange: unrelatedPreimage.range,
          },
        };
        const report = buildScanReportV2([{
          page: baseReport.pages[0].name,
          route: baseReport.pages[0].route,
          url: baseReport.pages[0].url,
          scannerRuns: baseReport.scanners,
          findings: [targetFinding, unrelatedCandidate],
        }], {
          generatedAt: baseReport.generatedAt,
          producer: baseReport.producer,
          target: baseReport.target,
        });
        unrelatedFinding = report.pages[0].findings.find(
          (finding) => finding.source.file === unrelatedFile,
        );
        return { report };
      },
      verification: {
        build: {
          command: process.execPath,
          args: [join(sandboxRoot, 'scripts/build.js')],
        },
        scanner,
      },
      cisTransportFactory: ({ fixUnits, localRoot }) => {
        const ready = fixUnits.find((row) => row.status === 'ready');
        transport = createCountingCisTransport(
          localRoot,
          ready.fixUnitId,
          ready.findingIds[0],
          ready.sourceOwner,
        );
        return transport;
      },
      cisModel: 'anthropic.claude-sonnet-5',
    });

    reviewServer = demo.review.reviewServer;
    assert.equal(demo.review.fixUnits.length, 1);
    assert.ok(demo.review.fixUnits.every((unit) => unit.sourceOwner.file === TARGET_FILE));
    assert.equal(demo.review.reviewState.getSnapshot().units.length, 1);

    const token = reviewServer.reviewUrl.split('#token=')[1];
    const baseUrl = reviewServer.url.replace(/\/$/, '');
    const origin = reviewServer.origin;
    const unit = demo.review.fixUnits[0];
    const uid = encodeURIComponent(unit.fixUnitId);

    const propose = await apiFetch(baseUrl, token, origin, `/api/fix-units/${uid}/propose`, {
      method: 'POST',
      body: {},
    });
    assert.equal(propose.status, 200);
    const snapshot = (await apiFetch(baseUrl, token, origin, '/api/snapshot')).payload;
    const candidate = snapshot.units.find((row) => row.fixUnitId === unit.fixUnitId)?.candidate;
    const checkId = candidate.manualCheckAttestations[0].checkId;

    const verify = await demo.review.verifyRegisteredCandidate(unit.fixUnitId, {
      acknowledgedCheckIds: [checkId],
    });
    assert.equal(verify.ok, true);
    const decision = await apiFetch(baseUrl, token, origin, `/api/fix-units/${uid}/decision`, {
      method: 'POST',
      body: { decision: 'accepted', candidateHash: candidate.candidateHash },
    });
    assert.equal(decision.status, 200);
    const approval = await apiFetch(baseUrl, token, origin, `/api/fix-units/${uid}/approve-diff`, {
      method: 'POST',
      body: { candidateHash: candidate.candidateHash, diffHash: candidate.diffHash },
    });
    assert.equal(approval.status, 200);

    const apply = await apiFetch(baseUrl, token, origin, '/api/apply', {
      method: 'POST',
      body: {},
    });
    assert.equal(apply.status, 200);
    assert.equal(apply.payload.result?.postVerified, true);
    assert.equal(scanCalls, 2);
    assert.equal(receivedBaselines.length, 2);
    for (const baseline of receivedBaselines) {
      assert.deepEqual(
        baseline
          .map((finding) => [finding.findingId, finding.layer])
          .sort(([left], [right]) => left.localeCompare(right)),
        [
          [unit.findingIds[0], 'axe'],
          [unrelatedFinding.findingId, 'accessScan'],
        ].sort(([left], [right]) => left.localeCompare(right)),
      );
    }

    const auditTypes = demo.review.reviewState.auditLog.map((event) => event.type);
    assert.ok(auditTypes.includes('post_verify_completed'));
    assert.equal(auditTypes.includes('post_verify_skipped'), false);
  } finally {
    if (reviewServer) {
      await closeReviewServerWithCisTransport(
        reviewServer.close.bind(reviewServer),
        transport,
      ).catch(() => {});
    }
    rmSync(root, { recursive: true, force: true });
  }
});
