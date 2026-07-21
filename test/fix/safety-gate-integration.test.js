import {
  mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSourcePreimage } from '../../src/tracer/preimage.js';
import {
  CandidateIntentError,
  hashFileContent,
  validateAndBuildCandidate,
} from '../../src/fix/candidate/intent.js';
import { attachDiffToCandidate } from '../../src/fix/candidate/diff.js';
import { runShadowVerification } from '../../src/fix/verify/shadow.js';
import { applyBatchTransaction } from '../../src/fix/apply/transaction.js';
import { acquireWorkspaceLock, releaseWorkspaceLock } from '../../src/fix/apply/lock.js';
import { createReviewState } from '../../src/fix/review/state.js';
import { lookupPolicyDecision } from '../../src/fix/policy/registry.js';
import { planCisFixRoute } from '../../src/fix/controller/cli-routing.js';
import { buildScanReportV2 } from '../../src/reporter/report-v2.js';
import { runFixSubcommand } from '../../src/index.js';
import {
  evaluateSafetyGate,
  collectLeftoverArtifacts,
  scanOutputForRedactionLeaks,
} from '../../src/fix/eval/poc-gates.js';
import { sanitizeCisTelemetryRecord, appendCisTelemetryRecord } from '../../src/fix/cis/telemetry.js';
import { persistPassedVerificationArtifact } from './helpers/candidate-fixture.js';
import { createLoopbackSiteAdapter, createPassingScanner } from './helpers/shadow-adapters.js';
import { runFullPocHttpSession } from './helpers/poc-session.js';

const REPORT_ID = 'sha256:safety-gate';
const REPORT_FIXTURE = JSON.parse(
  readFileSync(new URL('../fixtures/fix/report-v2.json', import.meta.url), 'utf8'),
);

function writeFile(root, rel, content) {
  const full = join(root, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content, 'utf8');
}

function buildCandidate(root, rel, oldText, newText, line = 1) {
  const content = readFileSync(join(root, rel), 'utf8');
  const preimage = buildSourcePreimage(content, line);
  return attachDiffToCandidate(validateAndBuildCandidate({
    localRoot: root,
    reportId: REPORT_ID,
    policyVersion: '1',
    edits: [{
      file: rel,
      blockRange: { startLine: line, endLine: line },
      expectedBlockSha256: preimage.preimageSha256,
      expectedFileSha256: hashFileContent(content),
      oldText,
      newText,
    }],
  }));
}

function entryFor(sessionDir, candidate, fixUnitId = 'u1') {
  return {
    fixUnitId,
    candidate,
    candidateHash: candidate.candidateHash,
    diffHash: candidate.diffHash,
    verificationArtifactId: persistPassedVerificationArtifact(sessionDir, {
      candidateHash: candidate.candidateHash,
      diffHash: candidate.diffHash,
    }),
  };
}

function noopBuild(root) {
  writeFile(root, 'scripts/noop.js', 'process.exit(0);\n');
  return { command: process.execPath, args: ['scripts/noop.js'] };
}

async function runScanOnlyFixRoute(root, name, target) {
  const report = buildScanReportV2(structuredClone(REPORT_FIXTURE.scanResults), {
    ...REPORT_FIXTURE.context,
    target,
  });
  const reportPath = join(root, `${name}.json`);
  writeFileSync(reportPath, JSON.stringify(report), 'utf8');
  return runFixSubcommand(['--report', reportPath, '--source', root]);
}

test('safety gate integration: real FS snapshots and rejection matrix', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-safety-gate-'));
  const sessionDir = join(root, 'scan-reports', 'fix-sessions', 'safety');
  mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  try {
    writeFile(root, 'src/a.liquid', '<button id="a">A</button>\n');
    writeFile(root, 'src/b.liquid', '<button id="b">B</button>\n');
    const beforeA = readFileSync(join(root, 'src/a.liquid'));
    const beforeB = readFileSync(join(root, 'src/b.liquid'));

    const candidateA = buildCandidate(root, 'src/a.liquid', '<button id="a">A</button>', '<button id="a" aria-label="A">A</button>');
    const candidateB = buildCandidate(root, 'src/b.liquid', '<button id="b">B</button>', '<button id="b" aria-label="B">B</button>');

    const shadow = await runShadowVerification({
      localRoot: root,
      sessionDir,
      candidate: candidateA,
      targetFindingIds: [],
      baselineFindings: [],
      manualChecks: [],
      manualChecksAcknowledged: true,
      build: noopBuild(root),
      scanner: createPassingScanner(),
      site: createLoopbackSiteAdapter(),
    });
    assert.equal(shadow.ok, true);

    const afterShadowA = readFileSync(join(root, 'src/a.liquid'));
    assert.equal(afterShadowA.equals(beforeA), true, 'shadow verify must not mutate workspace source');

    let staleRejections = 0;
    let staleAttempts = 0;
    const expectRejectedCandidate = (build) => {
      staleAttempts += 1;
      try {
        build();
      } catch (error) {
        if (error instanceof CandidateIntentError) staleRejections += 1;
      }
    };

    expectRejectedCandidate(() => validateAndBuildCandidate({
      localRoot: root,
      reportId: REPORT_ID,
      policyVersion: '1',
      edits: [{
        file: 'src/a.liquid',
        blockRange: { startLine: 1, endLine: 1 },
        expectedBlockSha256: `sha256:${'0'.repeat(64)}`,
        expectedFileSha256: hashFileContent(beforeA.toString('utf8')),
        oldText: '<button id="a">A</button>',
        newText: '<button id="a" aria-label="A">A</button>',
      }],
    }));
    expectRejectedCandidate(() => validateAndBuildCandidate({
      localRoot: root,
      reportId: REPORT_ID,
      policyVersion: '1',
      edits: [{
        file: '../outside.liquid',
        blockRange: { startLine: 1, endLine: 1 },
        expectedBlockSha256: candidateA.edits[0].expectedBlockSha256,
        expectedFileSha256: candidateA.edits[0].expectedFileSha256,
        oldText: '<button id="a">A</button>',
        newText: '<button id="a" aria-label="A">A</button>',
      }],
    }));
    symlinkSync(join(root, 'src/a.liquid'), join(root, 'src/link.liquid'));
    expectRejectedCandidate(() => validateAndBuildCandidate({
      localRoot: root,
      reportId: REPORT_ID,
      policyVersion: '1',
      edits: [{
        file: 'src/link.liquid',
        blockRange: { startLine: 1, endLine: 1 },
        expectedBlockSha256: candidateA.edits[0].expectedBlockSha256,
        expectedFileSha256: candidateA.edits[0].expectedFileSha256,
        oldText: '<button id="a">A</button>',
        newText: '<button id="a" aria-label="A">A</button>',
      }],
    }));

    const urlOnlyResult = planCisFixRoute({
      fix: true,
      fixMode: 'cis',
      targetMode: 'url-only',
      url: 'https://example.test/',
      localRoot: null,
    });
    const hybridUnattestedResult = await runScanOnlyFixRoute(root, 'hybrid-report', {
      mode: 'hybrid',
      url: 'https://example.test/',
      buildRevision: 'git:remote-revision',
      instrumentationDigest: `sha256:${'a'.repeat(64)}`,
      deploymentUrl: 'https://example.test',
      attestationStatus: 'complete',
      attestationReason: null,
    });
    staleAttempts += 1;
    if (hybridUnattestedResult.status === 'scan-only') staleRejections += 1;

    const fixUnits = [{
      fixUnitId: 'u1',
      kind: 'accessibility',
      status: 'ready',
      findingIds: ['f1'],
      canonicalRuleId: 'button-name',
      pageState: 'initial',
      sourceOwner: {
        file: 'src/a.liquid',
        line: 1,
        preimageSha256: candidateA.edits[0].expectedBlockSha256,
      },
      evidence: [],
      affectedRoutes: ['/'],
      findings: [{
        findingId: 'f1',
        canonicalRuleId: 'button-name',
        nativeRuleId: 'button-name',
        category: 'accessibility',
        route: '/',
        pageState: 'initial',
        source: {
          file: 'src/a.liquid',
          line: 1,
          preimageSha256: candidateA.edits[0].expectedBlockSha256,
          preimageRange: { start: 1, end: 2 },
          confidence: 'high',
          method: 'test-fixture',
        },
      }],
    }];
    const state = createReviewState({
      sessionDir,
      reportId: REPORT_ID,
      sessionId: 'safety',
      fixUnits,
      traceResults: [],
      policyRoutes: [{ fixUnitId: 'u1', proposalAllowed: true, decision: lookupPolicyDecision(fixUnits[0]) }],
      localRoot: root,
    });
    state.registerCandidate('u1', {
      candidateHash: candidateA.candidateHash,
      diffHash: candidateA.diffHash,
      diff: candidateA.diff,
      editIntents: candidateA.edits,
      policyVersion: '1',
      manualChecks: [],
      verified: false,
      conflictFree: true,
      verification: { status: 'pending' },
    });

    let wrongCandidateRejections = 0;
    const wrongCandidateAttempts = 2;
    try {
      state.approveExactDiff('u1', `sha256:${'f'.repeat(64)}`, candidateA.diffHash);
    } catch {
      wrongCandidateRejections += 1;
    }
    try {
      state.approveExactDiff('u1', candidateA.candidateHash, `sha256:${'f'.repeat(64)}`);
    } catch {
      wrongCandidateRejections += 1;
    }

    const forcedFailure = await applyBatchTransaction({
      localRoot: root,
      sessionDir,
      entries: [entryFor(sessionDir, candidateA, 'u1'), entryFor(sessionDir, candidateB, 'u2')],
      failAfterWrite: 1,
    });
    const rollbackRestored = forcedFailure.status === 'rolled-back'
      && readFileSync(join(root, 'src/a.liquid')).equals(beforeA)
      && readFileSync(join(root, 'src/b.liquid')).equals(beforeB);
    assert.equal(rollbackRestored, true);

    appendCisTelemetryRecord(sessionDir, sanitizeCisTelemetryRecord({
      sessionCalls: 1,
      outcome: 'proposed',
      tokens: { total: 3, prompt: 1, completion: 2 },
      latencyMs: { total: 4, calls: [4] },
    }));
    const telemetryRaw = readFileSync(join(sessionDir, 'cis-telemetry.ndjson'), 'utf8');
    assert.equal(scanOutputForRedactionLeaks(telemetryRaw).ok, true);

    const gate = evaluateSafetyGate({
      preApplyBytesByFile: {
        'src/a.liquid': beforeA.toString('utf8'),
        'src/b.liquid': beforeB.toString('utf8'),
      },
      postApplyBytesByFile: {
        'src/a.liquid': afterShadowA.toString('utf8'),
        'src/b.liquid': beforeB.toString('utf8'),
      },
      staleRejections,
      staleAttempts,
      wrongCandidateRejections,
      wrongCandidateAttempts,
      rollbackRestored,
      urlOnlyBlocked: urlOnlyResult.kind === 'scan-only' && urlOnlyResult.capability.canFix === false,
      hybridUnattestedBlocked: hybridUnattestedResult.status === 'scan-only',
      logs: telemetryRaw,
      sessionArtifacts: collectLeftoverArtifacts(root),
    });
    assert.equal(gate.ok, true, JSON.stringify(gate));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('safety gate: symlink path rejected and cancel leaves no artifacts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-safety-symlink-'));
  try {
    writeFile(root, 'src/real.liquid', 'alpha\n');
    try {
      symlinkSync(join(root, 'src/real.liquid'), join(root, 'src/escape.liquid'));
    } catch {
      return;
    }

    assert.throws(
      () => buildCandidate(root, 'src/escape.liquid', 'alpha', 'beta'),
      CandidateIntentError,
    );

    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      () => runShadowVerification({
        localRoot: root,
        sessionDir: join(root, 'scan-reports', 'fix-sessions', 'abort'),
        candidate: buildCandidate(root, 'src/real.liquid', 'alpha', 'beta'),
        targetFindingIds: [],
        baselineFindings: [],
        manualChecks: [],
        manualChecksAcknowledged: true,
        build: noopBuild(root),
        scanner: createPassingScanner(),
        site: createLoopbackSiteAdapter(),
        signal: controller.signal,
      }),
    );

    assert.deepEqual(collectLeftoverArtifacts(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('safety gate: command timeout reaps the child and removes the shadow workspace', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-safety-timeout-'));
  const previousTmpDir = process.env.TMPDIR;
  try {
    const isolatedTmp = join(root, 'tmp');
    mkdirSync(isolatedTmp, { recursive: true });
    process.env.TMPDIR = isolatedTmp;
    writeFile(root, 'src/real.liquid', 'alpha\n');
    writeFile(
      root,
      'scripts/hang.js',
      readFileSync(new URL('../fixtures/fix/scripts/hang.js', import.meta.url), 'utf8'),
    );
    const pidFile = join(root, 'timeout-child.pid');
    const before = readFileSync(join(root, 'src/real.liquid'));
    const startedAt = Date.now();

    await assert.rejects(
      () => runShadowVerification({
        localRoot: root,
        sessionDir: join(root, 'scan-reports', 'fix-sessions', 'timeout'),
        candidate: buildCandidate(root, 'src/real.liquid', 'alpha', 'beta'),
        targetFindingIds: [],
        baselineFindings: [],
        manualChecks: [],
        manualChecksAcknowledged: true,
        build: { command: process.execPath, args: ['scripts/hang.js'] },
        scanner: createPassingScanner(),
        site: createLoopbackSiteAdapter(),
        commandEnv: { ADA_FIX_PID_FILE: pidFile },
        buildTimeoutMs: 1_000,
      }),
      (error) => error.code === 'COMMAND_TIMEOUT',
    );

    assert.ok(Date.now() - startedAt >= 4_500, 'timeout must await TERM/KILL child reaping');
    const childPid = Number.parseInt(readFileSync(pidFile, 'utf8'), 10);
    assert.throws(
      () => process.kill(childPid, 0),
      (error) => error?.code === 'ESRCH',
      'timed-out child process must be reaped before verification returns',
    );
    rmSync(pidFile, { force: true });
    assert.equal(readFileSync(join(root, 'src/real.liquid')).equals(before), true);
    assert.deepEqual(collectLeftoverArtifacts(root), []);
  } finally {
    if (previousTmpDir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmpDir;
    rmSync(root, { recursive: true, force: true });
  }
});

test('safety gate: PoC HTTP apply leaves no leftover artifacts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-safety-poc-bytes-'));
  try {
    const session = await runFullPocHttpSession(root);
    assert.equal(session.applyStatus, 200);
    assert.deepEqual(collectLeftoverArtifacts(root), []);
    await session.cli.reviewServer.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('safety gate: live workspace lock blocks concurrent apply ownership', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-safety-lock-'));
  try {
    const first = acquireWorkspaceLock(root);
    assert.throws(() => acquireWorkspaceLock(root), (error) => error.code === 'LOCK_CONTENTION');
    releaseWorkspaceLock(first.lockPath, first.token);
    assert.deepEqual(collectLeftoverArtifacts(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
