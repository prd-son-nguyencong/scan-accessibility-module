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

function bootstrap(root, { includeBlocked = false } = {}) {
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
    findings: [{ findingId: 'f1', source, pageState: 'initial', canonicalRuleId: 'button-name' }],
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
