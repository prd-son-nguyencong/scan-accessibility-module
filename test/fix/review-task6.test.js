import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSourcePreimage } from '../../src/tracer/preimage.js';
import { hashFileContent, validateAndBuildCandidate } from '../../src/fix/candidate/intent.js';
import { attachDiffToCandidate } from '../../src/fix/candidate/diff.js';
import { createReviewState, loadReviewState, persistReviewState } from '../../src/fix/review/state.js';
import { startReviewServer } from '../../src/fix/review/server.js';
import { createTrustedApplyHandler } from '../../src/fix/apply/handler.js';
import {
  buildValidatedCandidate,
  buildVerifiedCandidateRecord,
  persistPassedVerificationArtifact,
} from './helpers/candidate-fixture.js';

const REPORT_ID = 'sha256:review-task6';

function buildCandidateRecord(root, relPath, line, oldText, newText) {
  const content = readFileSync(join(root, relPath), 'utf8');
  const preimage = buildSourcePreimage(content, line);
  const candidate = attachDiffToCandidate(validateAndBuildCandidate({
    localRoot: root,
    reportId: REPORT_ID,
    policyVersion: '1',
    edits: [{
      file: relPath,
      blockRange: { startLine: line, endLine: line },
      expectedBlockSha256: preimage.preimageSha256,
      expectedFileSha256: hashFileContent(content),
      oldText,
      newText,
    }],
  }));
  return {
    candidateHash: candidate.candidateHash,
    diffHash: candidate.diffHash,
    diff: candidate.diff,
    editIntents: candidate.edits,
    policyVersion: candidate.policyVersion,
    promptVersion: candidate.promptVersion,
    modelId: candidate.modelId,
    verified: false,
    conflictFree: true,
    verification: { status: 'pending' },
  };
}

function verifiedCandidateRecord(root, sessionDir, relPath, line, oldText, newText) {
  const base = buildCandidateRecord(root, relPath, line, oldText, newText);
  const artifactId = persistPassedVerificationArtifact(sessionDir, {
    candidateHash: base.candidateHash,
    diffHash: base.diffHash,
  });
  return {
    ...base,
    verified: true,
    verification: { status: 'passed', artifactId },
  };
}

function bootstrap(root, {
  includeBlocked = false,
  verificationBaselineFindings = undefined,
} = {}) {
  mkdirSync(join(root, 'src'), { recursive: true });
  const content = '<button id="apply">Apply</button>\n';
  writeFileSync(join(root, 'src/a.liquid'), content);
  const preimage = buildSourcePreimage(content, 1);
  const sessionDir = join(root, 'scan-reports', 'fix-sessions', 'task6');
  mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  const source = {
    file: 'src/a.liquid',
    line: 1,
    preimageSha256: preimage.preimageSha256,
    confidence: 'high',
    method: 'attested',
  };
  const fixUnits = [{
    fixUnitId: 'unit-a',
    kind: 'accessibility',
    title: 'Apply button',
    canonicalRuleId: 'button-name',
    pageState: 'initial',
    findingIds: ['f1'],
    status: 'ready',
    sourceOwner: source,
    evidence: [],
    affectedRoutes: ['/'],
    findings: [{
      findingId: 'f1',
      source,
      pageState: 'initial',
      canonicalRuleId: 'button-name',
      layer: 'accessScan',
      impact: 'serious',
      element: { selector: '#apply' },
    }],
  }];
  if (includeBlocked) {
    fixUnits.push({
      fixUnitId: 'unit-blocked',
      kind: 'accessibility',
      title: 'Manual-only issue',
      canonicalRuleId: 'color-contrast',
      pageState: 'initial',
      findingIds: ['f-blocked'],
      status: 'trace-required',
      sourceOwner: {
        file: null,
        line: null,
        preimageSha256: null,
        confidence: 'none',
        method: 'unresolved',
      },
      evidence: [],
      affectedRoutes: ['/'],
      findings: [{
        findingId: 'f-blocked',
        pageState: 'initial',
        canonicalRuleId: 'color-contrast',
      }],
    });
  }
  return createReviewState({
    sessionDir,
    reportId: REPORT_ID,
    sessionId: 'task6',
    fixUnits,
    traceResults: [],
    policyRoutes: [
      { fixUnitId: 'unit-a', proposalAllowed: true },
      ...(includeBlocked ? [{ fixUnitId: 'unit-blocked', proposalAllowed: false }] : []),
    ],
    localRoot: root,
    verificationBaselineFindings,
  });
}

test('registerCandidate rejects self-asserted verified flag', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-review-task6-'));
  try {
    const state = bootstrap(root);
    const candidate = verifiedCandidateRecord(root, state.sessionDir, 'src/a.liquid', 1, '<button id="apply">', '<button id="apply" aria-label="Apply">');
    assert.throws(
      () => state.registerCandidate('unit-a', candidate, { replace: true }),
      (error) => error.code === 'VERIFIED_REGISTRATION_NOT_ALLOWED',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('candidate replacement invalidates accept and diff approval', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-review-task6-'));
  try {
    const state = bootstrap(root);
    const first = verifiedCandidateRecord(root, state.sessionDir, 'src/a.liquid', 1, '<button id="apply">', '<button id="apply" aria-label="Apply">');
    state.registerVerifiedCandidate('unit-a', first, { replace: true });
    state.accept('unit-a', first.candidateHash);
    state.approveExactDiff('unit-a', first.candidateHash, first.diffHash);
    const second = verifiedCandidateRecord(root, state.sessionDir, 'src/a.liquid', 1, '<button id="apply">', '<button id="apply" aria-label="Submit">');
    state.registerVerifiedCandidate('unit-a', second, { replace: true });
    assert.equal(state.getDecision('unit-a').decision, 'pending');
    assert.equal(state.raw.diffApprovals['unit-a'], undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('apply gate opens only with verified accept and exact diff approval', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-review-task6-'));
  try {
    const state = bootstrap(root);
    const candidate = verifiedCandidateRecord(root, state.sessionDir, 'src/a.liquid', 1, '<button id="apply">', '<button id="apply" aria-label="Apply">');
    state.registerVerifiedCandidate('unit-a', candidate, { replace: true });
    let gate = state.getSnapshot().applyGate;
    assert.equal(gate.blocked, true);
    state.accept('unit-a', candidate.candidateHash);
    gate = state.getSnapshot().applyGate;
    assert.equal(gate.reason, 'DIFF_APPROVAL_REQUIRED');
    state.approveExactDiff('unit-a', candidate.candidateHash, candidate.diffHash);
    gate = state.getSnapshot().applyGate;
    assert.equal(gate.blocked, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('unrelated blocked units do not prevent an approved verified partial apply', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-review-task6-'));
  try {
    const state = bootstrap(root, { includeBlocked: true });
    const candidate = verifiedCandidateRecord(root, state.sessionDir, 'src/a.liquid', 1, '<button id="apply">', '<button id="apply" aria-label="Apply">');
    state.registerVerifiedCandidate('unit-a', candidate, { replace: true });
    state.accept('unit-a', candidate.candidateHash);
    state.approveExactDiff('unit-a', candidate.candidateHash, candidate.diffHash);

    const eligibility = state.getApplyEligibility();
    assert.equal(eligibility.allowed, true);
    assert.equal(eligibility.gate.blockedCount, 1);
    assert.deepEqual(eligibility.units.map((unit) => unit.fixUnitId), ['unit-a']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('partial apply passes the full report baseline to post-apply verification', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-review-task6-'));
  try {
    const state = bootstrap(root, { includeBlocked: true });
    const candidate = verifiedCandidateRecord(root, state.sessionDir, 'src/a.liquid', 1, '<button id="apply">', '<button id="apply" aria-label="Apply">');
    state.registerVerifiedCandidate('unit-a', candidate, { replace: true });
    state.accept('unit-a', candidate.candidateHash);
    state.approveExactDiff('unit-a', candidate.candidateHash, candidate.diffHash);

    let receivedBaseline = null;
    await state.applyAcceptedCandidates(async ({ baselineByUnit }) => {
      receivedBaseline = baselineByUnit.get('unit-a');
      return { status: 'committed' };
    });

    assert.deepEqual(
      receivedBaseline.map((finding) => finding.findingId).sort(),
      ['f-blocked', 'f1'],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('target-filtered review state passes its process-only full baseline to post-apply verification', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-review-task6-'));
  try {
    const unrelatedFinding = {
      findingId: 'f-unrelated',
      canonicalRuleId: 'heading-order',
      layer: 'axe',
      impact: 'serious',
      route: '/',
      pageState: 'initial',
      source: { file: 'src/layouts/base.liquid', line: 4 },
      element: { selector: 'main h3' },
    };
    const state = bootstrap(root);
    const targetFinding = structuredClone(state.baseFixUnits[0].findings[0]);
    const filteredState = bootstrap(root, {
      verificationBaselineFindings: [targetFinding, unrelatedFinding],
    });
    const candidate = verifiedCandidateRecord(
      root,
      filteredState.sessionDir,
      'src/a.liquid',
      1,
      '<button id="apply">',
      '<button id="apply" aria-label="Apply">',
    );
    filteredState.registerVerifiedCandidate('unit-a', candidate, { replace: true });
    filteredState.accept('unit-a', candidate.candidateHash);
    filteredState.approveExactDiff('unit-a', candidate.candidateHash, candidate.diffHash);

    assert.deepEqual(filteredState.fixUnits.map((unit) => unit.fixUnitId), ['unit-a']);
    assert.equal(filteredState.getSnapshot().units.length, 1);

    let receivedBaseline = null;
    await filteredState.applyAcceptedCandidates(async ({ baselineByUnit }) => {
      receivedBaseline = baselineByUnit.get('unit-a');
      return { status: 'committed' };
    });

    assert.deepEqual(
      receivedBaseline.map((finding) => [finding.findingId, finding.layer]),
      [
        ['f1', 'accessScan'],
        ['f-unrelated', 'axe'],
      ],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('verification baseline stays process-only, isolated, and caller-supplied after reload', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-review-task6-'));
  try {
    const suppliedBaseline = [{
      findingId: 'f-reload-only',
      canonicalRuleId: 'heading-order',
      layer: 'axe',
      impact: 'serious',
      source: { file: 'src/layouts/base.liquid', line: 4 },
    }];
    const state = bootstrap(root, { verificationBaselineFindings: suppliedBaseline });
    persistReviewState(state);

    suppliedBaseline[0].source.file = 'src/mutated-by-caller.liquid';
    assert.ok(state.raw.verificationBaselineFindings);
    assert.equal(state.raw.verificationBaselineFindings[0].source.file, 'src/layouts/base.liquid');
    assert.equal(Object.isFrozen(state.raw.verificationBaselineFindings), true);
    assert.equal(Object.isFrozen(state.raw.verificationBaselineFindings[0].source), true);

    const sessionPayload = JSON.parse(readFileSync(join(state.sessionDir, 'session.json'), 'utf8'));
    assert.equal('verificationBaselineFindings' in sessionPayload, false);
    assert.equal(JSON.stringify(sessionPayload).includes('f-reload-only'), false);
    assert.equal(JSON.stringify(state.getSnapshot()).includes('f-reload-only'), false);

    const reloadOptions = {
      sessionDir: state.sessionDir,
      reportId: REPORT_ID,
      sessionId: 'task6',
      fixUnits: state.baseFixUnits,
      traceResults: [],
      policyRoutes: [{ fixUnitId: 'unit-a', proposalAllowed: true }],
      localRoot: root,
    };
    const legacyReload = loadReviewState(reloadOptions);
    assert.deepEqual(
      legacyReload.raw.verificationBaselineFindings.map((finding) => finding.findingId),
      ['f1'],
    );

    const suppliedReload = loadReviewState({
      ...reloadOptions,
      verificationBaselineFindings: [{
        findingId: 'f-reloaded',
        source: { file: 'src/layouts/reloaded.liquid', line: 2 },
      }],
    });
    assert.deepEqual(
      suppliedReload.raw.verificationBaselineFindings.map((finding) => finding.findingId),
      ['f-reloaded'],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('null postVerify cannot disable mandatory trusted apply verification', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-review-task6-'));
  try {
    const state = bootstrap(root);
    const candidate = verifiedCandidateRecord(
      root,
      state.sessionDir,
      'src/a.liquid',
      1,
      '<button id="apply">',
      '<button id="apply" aria-label="Apply">',
    );
    state.registerVerifiedCandidate('unit-a', candidate, { replace: true });
    state.accept('unit-a', candidate.candidateHash);
    state.approveExactDiff('unit-a', candidate.candidateHash, candidate.diffHash);

    let scanCalls = 0;
    const scanner = async () => {
      scanCalls += 1;
      return {
        findings: [],
        sourceTraceResolved: true,
        executedLayers: ['axe', 'accessScan'],
      };
    };
    scanner.ownsSiteLifecycle = true;

    const result = await state.applyAcceptedCandidates(createTrustedApplyHandler({
      localRoot: root,
      sessionDir: state.sessionDir,
      reportId: REPORT_ID,
      verification: { scanner },
      postVerify: null,
    }));

    assert.equal(result.postVerified, true);
    assert.equal(scanCalls, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('default post-apply comparison rejects a true new critical finding and rolls back', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-review-task6-'));
  try {
    const seedState = bootstrap(root);
    const targetFinding = structuredClone(seedState.baseFixUnits[0].findings[0]);
    const unrelatedFinding = {
      findingId: 'f-existing-unrelated',
      canonicalRuleId: 'heading-order',
      layer: 'axe',
      impact: 'serious',
      route: '/',
      pageState: 'initial',
      source: { file: 'src/layouts/base.liquid', line: 4 },
      element: { selector: 'main h3' },
    };
    const state = bootstrap(root, {
      verificationBaselineFindings: [targetFinding, unrelatedFinding],
    });
    const beforeBytes = readFileSync(join(root, 'src/a.liquid'));
    const candidate = verifiedCandidateRecord(
      root,
      state.sessionDir,
      'src/a.liquid',
      1,
      '<button id="apply">',
      '<button id="apply" aria-label="Apply">',
    );
    state.registerVerifiedCandidate('unit-a', candidate, { replace: true });
    state.accept('unit-a', candidate.candidateHash);
    state.approveExactDiff('unit-a', candidate.candidateHash, candidate.diffHash);

    const newCriticalFinding = {
      findingId: 'f-new-critical',
      canonicalRuleId: 'image-alt',
      layer: 'axe',
      impact: 'critical',
      route: '/',
      pageState: 'initial',
      source: { file: 'src/a.liquid', line: 1 },
      element: { selector: '#new-critical' },
    };
    const scanner = async () => ({
      findings: [
        structuredClone(unrelatedFinding),
        structuredClone(newCriticalFinding),
      ],
      sourceTraceResolved: true,
      executedLayers: ['axe', 'accessScan'],
    });
    scanner.ownsSiteLifecycle = true;

    let failure = null;
    try {
      await state.applyAcceptedCandidates(createTrustedApplyHandler({
        localRoot: root,
        sessionDir: state.sessionDir,
        reportId: REPORT_ID,
        verification: { scanner },
      }));
    } catch (error) {
      failure = error;
    }

    assert.equal(failure?.code, 'POST_VERIFY_FAILED');
    assert.deepEqual(
      failure.postVerify.unitResults[0].delta.newCriticalSerious
        .map((finding) => finding.findingId),
      ['f-new-critical'],
    );
    assert.equal(readFileSync(join(root, 'src/a.liquid')).equals(beforeBytes), true);
    assert.ok(state.auditLog.some((event) => event.type === 'post_verify_failed'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('approveExactDiff rejects before accept', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-review-task6-'));
  try {
    const state = bootstrap(root);
    const candidate = verifiedCandidateRecord(root, state.sessionDir, 'src/a.liquid', 1, '<button id="apply">', '<button id="apply" aria-label="Apply">');
    state.registerVerifiedCandidate('unit-a', candidate, { replace: true });
    assert.throws(
      () => state.approveExactDiff('unit-a', candidate.candidateHash, candidate.diffHash),
      (error) => error.code === 'ACCEPT_REQUIRED',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('invalidateVerification clears accept and diff approval', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-review-task6-'));
  try {
    const state = bootstrap(root);
    const candidate = verifiedCandidateRecord(root, state.sessionDir, 'src/a.liquid', 1, '<button id="apply">', '<button id="apply" aria-label="Apply">');
    state.registerVerifiedCandidate('unit-a', candidate, { replace: true });
    state.accept('unit-a', candidate.candidateHash);
    state.approveExactDiff('unit-a', candidate.candidateHash, candidate.diffHash);
    state.invalidateVerification('unit-a', 'verification_rerun');
    assert.equal(state.getDecision('unit-a').decision, 'pending');
    assert.equal(state.raw.diffApprovals['unit-a'], undefined);
    assert.equal(state.getSnapshot().applyGate.blocked, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('approve diff and apply endpoints require token origin and verified state', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-review-task6-'));
  try {
    const state = bootstrap(root);
    const candidate = verifiedCandidateRecord(root, state.sessionDir, 'src/a.liquid', 1, '<button id="apply">', '<button id="apply" aria-label="Apply">');
    state.registerVerifiedCandidate('unit-a', candidate, { replace: true });
    state.accept('unit-a', candidate.candidateHash);
    const server = await startReviewServer({
      state,
      applyHandler: createTrustedApplyHandler({ localRoot: root, sessionDir: state.sessionDir, reportId: REPORT_ID }),
    });
    const denied = await fetch(`${server.url}api/fix-units/unit-a/approve-diff`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ candidateHash: candidate.candidateHash, diffHash: candidate.diffHash }),
    });
    assert.equal(denied.status, 403);
    const wrongHash = await fetch(`${server.url}api/fix-units/unit-a/approve-diff`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: server.origin,
        'x-review-token': server.token,
      },
      body: JSON.stringify({ candidateHash: candidate.candidateHash, diffHash: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }),
    });
    assert.equal(wrongHash.status, 400);
    const approved = await fetch(`${server.url}api/fix-units/unit-a/approve-diff`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: server.origin,
        'x-review-token': server.token,
      },
      body: JSON.stringify({ candidateHash: candidate.candidateHash, diffHash: candidate.diffHash }),
    });
    assert.equal(approved.status, 200);
    const applyResponse = await fetch(`${server.url}api/apply`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: server.origin,
        'x-review-token': server.token,
      },
      body: '{}',
    });
    assert.equal(applyResponse.status, 200);
    assert.match(readFileSync(join(root, 'src/a.liquid'), 'utf8'), /aria-label="Apply"/);
    await server.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('apply endpoint rejects when gate is closed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-review-task6-'));
  try {
    const state = bootstrap(root);
    const candidate = buildCandidateRecord(root, 'src/a.liquid', 1, '<button id="apply">', '<button id="apply" aria-label="Apply">');
    state.registerCandidate('unit-a', candidate, { replace: true });
    const server = await startReviewServer({
      state,
      applyHandler: createTrustedApplyHandler({ localRoot: root, sessionDir: state.sessionDir, reportId: REPORT_ID }),
    });
    const response = await fetch(`${server.url}api/apply`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: server.origin,
        'x-review-token': server.token,
      },
      body: '{}',
    });
    assert.equal(response.status, 400);
    await server.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('restart roundtrip preserves apply eligibility after persist', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-review-task6-'));
  try {
    const state = bootstrap(root);
    const candidate = verifiedCandidateRecord(root, state.sessionDir, 'src/a.liquid', 1, '<button id="apply">', '<button id="apply" aria-label="Apply">');
    state.registerVerifiedCandidate('unit-a', candidate, { replace: true });
    state.accept('unit-a', candidate.candidateHash);
    state.approveExactDiff('unit-a', candidate.candidateHash, candidate.diffHash);
    persistReviewState(state);
    const reloaded = loadReviewState({
      sessionDir: state.sessionDir,
      reportId: REPORT_ID,
      sessionId: 'task6',
      fixUnits: state.baseFixUnits,
      traceResults: [],
      policyRoutes: [{ fixUnitId: 'unit-a', proposalAllowed: true }],
      localRoot: root,
    });
    assert.equal(reloaded.getSnapshot().applyGate.blocked, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
