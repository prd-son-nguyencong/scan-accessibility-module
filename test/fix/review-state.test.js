import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeInstrumentationDigest } from '../../src/tracer/build-instrumented.js';
import { buildScanReportV2 } from '../../src/reporter/report-v2.js';
import { buildFixUnits } from '../../src/fix/canonical/fix-unit.js';
import {
  ReviewStateError,
  createReviewState,
  loadReviewState,
  persistReviewState,
  trimSnapshotPayload,
} from '../../src/fix/review/state.js';
import { createSourceTraceInbox, traceAllFindings } from '../../src/fix/trace/inbox.js';
import { buildTraceCandidatesFromFindings } from '../../src/fix/trace/candidates.js';
import { buildValidatedCandidate, buildVerifiedCandidateRecord } from './helpers/candidate-fixture.js';
import {
  registeredCandidateHash,
  withFixtureCandidates,
} from './review-fixtures.js';

const baseFixture = JSON.parse(
  readFileSync(new URL('../fixtures/fix/report-v2.json', import.meta.url), 'utf8'),
);

function localReport() {
  return buildScanReportV2(baseFixture.scanResults, {
    ...baseFixture.context,
    target: {
      mode: 'local-only',
      url: 'http://localhost:1234/',
      buildRevision: 'git:abc123',
      instrumentationDigest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    },
  });
}

function bootstrapSession(root, report) {
  const sessionDir = join(root, 'scan-reports', 'fix-sessions', 'fix-test');
  mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  const findings = report.pages.flatMap((page) => page.findings);
  const fixUnits = withFixtureCandidates(buildFixUnits(findings), root, sessionDir, { reportId: report.reportId });
  const traceInbox = createSourceTraceInbox({
    reportId: report.reportId,
    localRoot: root,
    sessionDir,
    candidates: buildTraceCandidatesFromFindings(findings),
  });
  const traceResults = traceAllFindings(traceInbox, findings);
  return createReviewState({
    sessionDir,
    reportId: report.reportId,
    sessionId: 'fix-test',
    fixUnits,
    traceResults,
    policyRoutes: fixUnits.map((unit) => ({
      fixUnitId: unit.fixUnitId,
      proposalAllowed: unit.status === 'ready',
    })),
    traceInbox,
    localRoot: root,
  });
}

test('createReviewState rejects duplicate finding IDs across units', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-review-state-'));
  try {
    const report = localReport();
    const findings = report.pages[0].findings;
    assert.throws(
      () => createReviewState({
        sessionDir: join(root, 's'),
        reportId: report.reportId,
        sessionId: 'fix-dup',
        fixUnits: [
          { fixUnitId: 'unit-a', kind: 'accessibility', title: 'a', findingIds: [findings[0].findingId], status: 'ready', sourceOwner: { file: 'src/a.liquid', line: 1 }, evidence: [], affectedRoutes: ['/'], findings: [findings[0]] },
          { fixUnitId: 'unit-b', kind: 'accessibility', title: 'b', findingIds: [findings[0].findingId], status: 'ready', sourceOwner: { file: 'src/b.liquid', line: 1 }, evidence: [], affectedRoutes: ['/'], findings: [findings[0]] },
        ],
        traceResults: [],
        policyRoutes: [],
        localRoot: root,
      }),
      (error) => error instanceof ReviewStateError && error.code === 'DUPLICATE_FINDING_ID',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('accept records a decision but does not write source', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-review-state-'));
  try {
    const sourcePath = join(root, 'src', 'partials', 'jobs', 'sort.liquid');
    mkdirSync(join(root, 'src', 'partials', 'jobs'), { recursive: true });
    const originalSource = '<select id="sort-select"></select>\n';
    writeFileSync(sourcePath, originalSource);
    const report = localReport();
    const state = bootstrapSession(root, report);
    const unitId = state.fixUnits[0].fixUnitId;
    state.accept(unitId, registeredCandidateHash(state, unitId));
    assert.equal(state.getDecision(unitId).decision, 'accepted');
    assert.equal(readFileSync(sourcePath, 'utf8'), originalSource);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('accept rejects hash that does not match registered candidate', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-review-state-'));
  try {
    const report = localReport();
    const state = bootstrapSession(root, report);
    const unitId = state.fixUnits[0].fixUnitId;
    assert.throws(
      () => state.accept(unitId, 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
      (error) => error instanceof ReviewStateError && error.code === 'CANDIDATE_HASH_MISMATCH',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('accept rejects blocked units without registered candidate', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-review-state-'));
  try {
    const report = localReport();
    const state = bootstrapSession(root, report);
    const blocked = state.fixUnits.find((unit) => unit.status !== 'ready') || state.fixUnits[0];
    const blockedHash = state.raw.candidates[blocked.fixUnitId]?.candidateHash
      || 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    if (blocked.status === 'ready') {
      delete state.raw.candidates[blocked.fixUnitId];
    }
    assert.throws(
      () => state.accept(blocked.fixUnitId, blockedHash),
      (error) => error instanceof ReviewStateError && error.code === 'ACCEPT_NOT_ALLOWED',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('idempotent accept does not duplicate audit events', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-review-state-'));
  try {
    const state = bootstrapSession(root, localReport());
    const unitId = state.fixUnits[0].fixUnitId;
    state.accept(unitId, registeredCandidateHash(state, unitId));
    const first = state.auditLog.filter((event) => event.type === 'decision_accepted').length;
    state.accept(unitId, registeredCandidateHash(state, unitId));
    const second = state.auditLog.filter((event) => event.type === 'decision_accepted').length;
    assert.equal(first, 1);
    assert.equal(second, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('revision_requested persists pending decision with note and audit event', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-review-state-'));
  try {
    const state = bootstrapSession(root, localReport());
    const unitId = state.fixUnits[0].fixUnitId;
    state.requestRevision(unitId, 'Need clearer label strategy');
    const decision = state.getDecision(unitId);
    assert.equal(decision.decision, 'pending');
    assert.equal(decision.revisionNote, 'Need clearer label strategy');
    assert.ok(state.auditLog.some((event) => event.type === 'revision_requested'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('undo restores accepted and rejected decisions to pending until apply starts', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-review-state-'));
  try {
    const state = bootstrapSession(root, localReport());
    const unitId = state.fixUnits[0].fixUnitId;
    state.accept(unitId, registeredCandidateHash(state, unitId));
    state.undo(unitId);
    assert.equal(state.getDecision(unitId).decision, 'pending');
    state.reject(unitId, 'not applicable');
    state.undo(unitId);
    assert.equal(state.getDecision(unitId).decision, 'pending');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('setPreferences does not append audit events', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-review-state-'));
  try {
    const state = bootstrapSession(root, localReport());
    const before = state.auditLog.length;
    state.setPreferences({ search: 'select-name', statusFilter: 'pending' });
    assert.equal(state.auditLog.length, before);
    assert.equal(state.raw.preferences.search, 'select-name');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('persistReviewState writes session.json with mode 0600 and directory 0700', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-review-state-'));
  try {
    const state = bootstrapSession(root, localReport());
    persistReviewState(state);
    assert.equal(statSync(state.sessionDir).mode & 0o777, 0o700);
    assert.equal(statSync(join(state.sessionDir, 'session.json')).mode & 0o777, 0o600);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('loadReviewState rejects symlink session.json and sessionDir', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-review-state-'));
  try {
    const state = bootstrapSession(root, localReport());
    persistReviewState(state);
    const sessionPath = join(state.sessionDir, 'session.json');
    const payload = readFileSync(sessionPath, 'utf8');
    rmSync(sessionPath);
    const outside = join(root, 'outside-session.json');
    writeFileSync(outside, payload, { mode: 0o600 });
    symlinkSync(outside, sessionPath);
    assert.throws(
      () => loadReviewState({ sessionDir: state.sessionDir, reportId: localReport().reportId, sessionId: 'fix-test', fixUnits: state.fixUnits, traceResults: state.traceResults, policyRoutes: state.policyRoutes, localRoot: root }),
      (error) => error instanceof ReviewStateError && error.code === 'SYMLINK_SESSION_FILE',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('state survives restart via session.json', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-review-state-'));
  try {
    const report = localReport();
    const state = bootstrapSession(root, report);
    const unitId = state.fixUnits[0].fixUnitId;
    state.accept(unitId, registeredCandidateHash(state, unitId));
    persistReviewState(state);
    const reloaded = loadReviewState({
      sessionDir: state.sessionDir,
      reportId: report.reportId,
      sessionId: 'fix-test',
      fixUnits: state.fixUnits,
      traceResults: state.traceResults,
      policyRoutes: state.policyRoutes,
      localRoot: root,
    });
    assert.equal(reloaded.getDecision(unitId).decision, 'accepted');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('pending candidate manual-check attestations survive restart', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-review-state-'));
  try {
    const report = localReport();
    const state = bootstrapSession(root, report);
    const unitId = state.fixUnits[0].fixUnitId;
    const candidate = structuredClone(state.raw.candidates[unitId]);
    delete state.raw.candidates[unitId];
    const registered = state.registerCandidate(unitId, {
      ...candidate,
      manualChecks: ['Confirm the control has the intended accessible name.'],
    });
    assert.equal(registered.manualCheckAttestations.length, 1);

    persistReviewState(state);
    const reloaded = loadReviewState({
      sessionDir: state.sessionDir,
      reportId: report.reportId,
      sessionId: 'fix-test',
      fixUnits: state.fixUnits,
      traceResults: state.traceResults,
      policyRoutes: state.policyRoutes,
      localRoot: root,
    });

    assert.deepEqual(
      reloaded.raw.candidates[unitId].manualCheckAttestations,
      registered.manualCheckAttestations,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('loadReviewState fails closed on report and session mismatch', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-review-state-'));
  try {
    const report = localReport();
    const state = bootstrapSession(root, report);
    persistReviewState(state);
    assert.throws(
      () => loadReviewState({ sessionDir: state.sessionDir, reportId: 'sha256:wrong', sessionId: 'fix-test', fixUnits: state.fixUnits, traceResults: state.traceResults, policyRoutes: state.policyRoutes, localRoot: root }),
      (error) => error instanceof ReviewStateError && error.code === 'REPORT_MISMATCH',
    );
    assert.throws(
      () => loadReviewState({ sessionDir: state.sessionDir, reportId: report.reportId, sessionId: 'fix-other', fixUnits: state.fixUnits, traceResults: state.traceResults, policyRoutes: state.policyRoutes, localRoot: root }),
      (error) => error instanceof ReviewStateError && error.code === 'SESSION_MISMATCH',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('snapshot exposes verified flag independently of accepted review status', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-review-state-'));
  try {
    const report = localReport();
    const state = bootstrapSession(root, report);
    const unitId = state.fixUnits[0].fixUnitId;
    state.raw.candidates[unitId] = buildVerifiedCandidateRecord(root, state.sessionDir);
    state.accept(unitId, registeredCandidateHash(state, unitId));
    const row = state.getSnapshot().units.find((unit) => unit.fixUnitId === unitId);
    assert.equal(row.verified, true);
    assert.equal(row.reviewStatus, 'accepted');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('mergeIntoUnit combines matching accessibility units without mutating base fix units', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-review-state-'));
  try {
    const report = localReport();
    const findings = report.pages.flatMap((page) => page.findings);
    const sessionDir = join(root, 'scan-reports', 'fix-sessions', 'fix-test');
    mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
    const fixUnits = buildFixUnits(findings);
    const source = fixUnits[0];
    const target = fixUnits[1];
    const sharedSource = structuredClone(source.findings[0].source);
    for (const finding of target.findings) {
      finding.source = structuredClone(sharedSource);
    }
    target.canonicalRuleId = source.canonicalRuleId;
    target.pageState = source.pageState;
    target.status = 'ready';
    const traceInbox = createSourceTraceInbox({
      reportId: report.reportId,
      localRoot: root,
      sessionDir,
      candidates: buildTraceCandidatesFromFindings(findings),
    });
    const state = createReviewState({
      sessionDir,
      reportId: report.reportId,
      sessionId: 'fix-test',
      fixUnits,
      traceResults: traceAllFindings(traceInbox, findings),
      policyRoutes: fixUnits.map((unit) => ({
        fixUnitId: unit.fixUnitId,
        proposalAllowed: unit.status === 'ready',
      })),
      traceInbox,
      localRoot: root,
    });
    const baseSourceFindingCount = state.raw.baseFixUnits[0].findingIds.length;
    state.mergeIntoUnit(source.fixUnitId, target.fixUnitId);
    const snapshot = state.getSnapshot();
    assert.equal(snapshot.units.length, fixUnits.length - 1);
    assert.equal(state.raw.baseFixUnits[0].findingIds.length, baseSourceFindingCount);
    assert.ok(state.auditLog.some((event) => event.type === 'unit_merged'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('mutation rolls back when persistence fails', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-review-state-'));
  try {
    const state = bootstrapSession(root, localReport());
    const unitId = state.fixUnits[0].fixUnitId;
    const beforeRevision = state.stateRevision;
    const blockedPath = join(root, 'blocked-file');
    writeFileSync(blockedPath, 'not-a-directory');
    state.raw.sessionDir = blockedPath;
    assert.throws(
      () => state.reject(unitId, 'cannot persist'),
      (error) => error instanceof ReviewStateError && error.code === 'PERSIST_FAILED',
    );
    assert.equal(state.getDecision(unitId).decision, 'pending');
    assert.equal(state.stateRevision, beforeRevision);
    assert.equal(state.auditLog.filter((event) => event.type === 'decision_rejected').length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('manual mapping unblocks unit, regroups by file, and allows accept after restart', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-review-state-'));
  try {
    const partialDir = join(root, 'src', 'partials', 'jobs');
    mkdirSync(partialDir, { recursive: true });
    const content = '<select id="sort-select"></select>\n';
    writeFileSync(join(partialDir, 'sort.liquid'), content);
    const { buildSourcePreimage } = await import('../../src/tracer/preimage.js');
    const expected = buildSourcePreimage(content, 1).preimageSha256;

    const report = localReport();
    const findings = report.pages.flatMap((page) => page.findings);
    const fixUnits = buildFixUnits(findings);
    const blockedUnit = structuredClone(fixUnits[0]);
    for (const finding of blockedUnit.findings) {
      finding.source = { confidence: 'none', method: 'unresolved' };
    }
    blockedUnit.status = 'trace-required';
    blockedUnit.sourceOwner = { file: null, line: null, preimageSha256: null, confidence: 'none', method: 'unresolved' };
    const remaining = fixUnits.slice(1);
    const allUnits = [blockedUnit, ...remaining];
    const sessionDir = join(root, 'scan-reports', 'fix-sessions', 'fix-map');
    mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
    const traceInbox = createSourceTraceInbox({
      reportId: report.reportId,
      localRoot: root,
      sessionDir,
      candidates: buildTraceCandidatesFromFindings(findings),
    });
    const state = createReviewState({
      sessionDir,
      reportId: report.reportId,
      sessionId: 'fix-map',
      fixUnits: allUnits,
      traceResults: traceAllFindings(traceInbox, allUnits.flatMap((unit) => unit.findings || [])),
      policyRoutes: allUnits.map((unit) => ({
        fixUnitId: unit.fixUnitId,
        proposalAllowed: true,
      })),
      traceInbox,
      localRoot: root,
    });

    const findingId = blockedUnit.findingIds[0];
    const before = state.getSnapshot();
    const beforeRow = before.units.find((row) => row.fixUnitId === blockedUnit.fixUnitId);
    assert.ok(beforeRow);
    assert.equal(beforeRow.reviewStatus, 'blocked');

    state.applyManualMapping({
      findingId,
      file: 'src/partials/jobs/sort.liquid',
      line: 1,
      expectedPreimageSha256: expected,
    });

    const afterMap = state.getSnapshot();
    const mappedRow = afterMap.units.find((row) => row.fixUnitId === blockedUnit.fixUnitId);
    assert.equal(mappedRow.reviewStatus, 'pending');
    assert.equal(mappedRow.sourceFile, 'src/partials/jobs/sort.liquid');
    assert.ok(mappedRow.editorLink);
    assert.ok(afterMap.accessibility.sources.some((group) => group.file === 'src/partials/jobs/sort.liquid'));

    state.raw.candidates[blockedUnit.fixUnitId] = buildValidatedCandidate(root, { reportId: report.reportId });
    state.accept(blockedUnit.fixUnitId, registeredCandidateHash(state, blockedUnit.fixUnitId));
    persistReviewState(state);

    const reloaded = loadReviewState({
      sessionDir,
      reportId: report.reportId,
      sessionId: 'fix-map',
      fixUnits: allUnits,
      traceResults: traceAllFindings(traceInbox, allUnits.flatMap((unit) => unit.findings || [])),
      policyRoutes: allUnits.map((unit) => ({ fixUnitId: unit.fixUnitId, proposalAllowed: true })),
      traceInbox,
      localRoot: root,
    });
    assert.equal(reloaded.getDecision(blockedUnit.fixUnitId).decision, 'accepted');
    const reloadedRow = reloaded.getSnapshot().units.find((row) => row.fixUnitId === blockedUnit.fixUnitId);
    assert.equal(reloadedRow.sourceFile, 'src/partials/jobs/sort.liquid');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('merge overlay survives restart and hides merged source row', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-review-state-'));
  try {
    const report = localReport();
    const findings = report.pages.flatMap((page) => page.findings);
    const sessionDir = join(root, 'scan-reports', 'fix-sessions', 'fix-merge');
    mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
    const fixUnits = buildFixUnits(findings);
    const source = fixUnits[0];
    const target = fixUnits[1];
    const sharedSource = structuredClone(source.findings[0].source);
    for (const finding of target.findings) {
      finding.source = structuredClone(sharedSource);
    }
    target.canonicalRuleId = source.canonicalRuleId;
    target.pageState = source.pageState;
    target.status = 'ready';
    const traceInbox = createSourceTraceInbox({
      reportId: report.reportId,
      localRoot: root,
      sessionDir,
      candidates: buildTraceCandidatesFromFindings(findings),
    });
    const state = createReviewState({
      sessionDir,
      reportId: report.reportId,
      sessionId: 'fix-merge',
      fixUnits,
      traceResults: traceAllFindings(traceInbox, findings),
      policyRoutes: fixUnits.map((unit) => ({ fixUnitId: unit.fixUnitId, proposalAllowed: unit.status === 'ready' })),
      traceInbox,
      localRoot: root,
    });
    state.mergeIntoUnit(source.fixUnitId, target.fixUnitId);
    persistReviewState(state);
    const mergedTarget = state.getSnapshot().units.find((row) => row.fixUnitId === target.fixUnitId);
    assert.ok(mergedTarget);

    const reloaded = loadReviewState({
      sessionDir,
      reportId: report.reportId,
      sessionId: 'fix-merge',
      fixUnits,
      traceResults: traceAllFindings(traceInbox, findings),
      policyRoutes: fixUnits.map((unit) => ({ fixUnitId: unit.fixUnitId, proposalAllowed: unit.status === 'ready' })),
      traceInbox,
      localRoot: root,
    });
    const snapshot = reloaded.getSnapshot();
    assert.equal(snapshot.units.some((row) => row.fixUnitId === source.fixUnitId), false);
    assert.ok(snapshot.units.some((row) => row.fixUnitId === target.fixUnitId));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('loadReviewState replays manual mappings from trace-audit when session omits them', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-review-state-'));
  try {
    const partialDir = join(root, 'src', 'partials', 'jobs');
    mkdirSync(partialDir, { recursive: true });
    const content = '<select id="sort-select"></select>\n';
    writeFileSync(join(partialDir, 'sort.liquid'), content);
    const { buildSourcePreimage } = await import('../../src/tracer/preimage.js');
    const expected = buildSourcePreimage(content, 1).preimageSha256;

    const report = localReport();
    const findings = report.pages.flatMap((page) => page.findings);
    const fixUnits = buildFixUnits(findings);
    const blockedUnit = structuredClone(fixUnits[0]);
    for (const finding of blockedUnit.findings) {
      finding.source = { confidence: 'none', method: 'unresolved' };
    }
    blockedUnit.status = 'trace-required';
    blockedUnit.sourceOwner = { file: null, line: null, preimageSha256: null, confidence: 'none', method: 'unresolved' };
    const allUnits = [blockedUnit, ...fixUnits.slice(1)];
    const sessionDir = join(root, 'scan-reports', 'fix-sessions', 'fix-audit');
    mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
    const traceInbox = createSourceTraceInbox({
      reportId: report.reportId,
      localRoot: root,
      sessionDir,
      candidates: buildTraceCandidatesFromFindings(findings),
    });
    const state = createReviewState({
      sessionDir,
      reportId: report.reportId,
      sessionId: 'fix-audit',
      fixUnits: allUnits,
      traceResults: traceAllFindings(traceInbox, allUnits.flatMap((unit) => unit.findings || [])),
      policyRoutes: allUnits.map((u) => ({ fixUnitId: u.fixUnitId, proposalAllowed: true })),
      traceInbox,
      localRoot: root,
    });
    const findingId = blockedUnit.findingIds[0];
    state.applyManualMapping({
      findingId,
      file: 'src/partials/jobs/sort.liquid',
      line: 1,
      expectedPreimageSha256: expected,
    });
    persistReviewState(state);

    const sessionPath = join(sessionDir, 'session.json');
    const persisted = JSON.parse(readFileSync(sessionPath, 'utf8'));
    delete persisted.manualMappings;
    writeFileSync(sessionPath, `${JSON.stringify(persisted, null, 2)}\n`, { mode: 0o600 });

    const reloaded = loadReviewState({
      sessionDir,
      reportId: report.reportId,
      sessionId: 'fix-audit',
      fixUnits: allUnits,
      traceResults: traceAllFindings(traceInbox, allUnits.flatMap((unit) => unit.findings || [])),
      policyRoutes: allUnits.map((u) => ({ fixUnitId: u.fixUnitId, proposalAllowed: true })),
      traceInbox,
      localRoot: root,
    });
    assert.ok(reloaded.raw.manualMappings[findingId]);
    const row = reloaded.getSnapshot().units.find((entry) => entry.fixUnitId === blockedUnit.fixUnitId);
    assert.equal(row.sourceFile, 'src/partials/jobs/sort.liquid');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('batchAccept accepts verified conflict-free units atomically', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-review-state-'));
  try {
    const report = localReport();
    const findings = report.pages.flatMap((page) => page.findings);
    const sessionDir = join(root, 'scan-reports', 'fix-sessions', 'fix-batch');
    mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
    const fixUnits = withFixtureCandidates(buildFixUnits(findings), root, sessionDir, { verified: true, reportId: report.reportId });
    const traceInbox = createSourceTraceInbox({
      reportId: report.reportId,
      localRoot: root,
      sessionDir,
      candidates: buildTraceCandidatesFromFindings(findings),
    });
    const state = createReviewState({
      sessionDir,
      reportId: report.reportId,
      sessionId: 'fix-batch',
      fixUnits,
      traceResults: traceAllFindings(traceInbox, findings),
      policyRoutes: fixUnits.map((unit) => ({ fixUnitId: unit.fixUnitId, proposalAllowed: true })),
      traceInbox,
      localRoot: root,
    });
    const eligible = state.getSnapshot().units.filter((row) => row.batchEligible);
    assert.ok(eligible.length >= 1);
    state.batchAccept(eligible.map((row) => row.fixUnitId));
    for (const row of eligible) {
      assert.equal(state.getDecision(row.fixUnitId).decision, 'accepted');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('snapshot omits auditLog and top-level traceResults and stays bounded', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-review-state-'));
  try {
    const state = bootstrapSession(root, localReport());
    const snapshot = state.getSnapshot();
    assert.equal(snapshot.auditLog, undefined);
    assert.equal(snapshot.traceResults, undefined);
    assert.ok(snapshot.stateRevision >= 0);
    assert.ok(Buffer.byteLength(JSON.stringify(snapshot), 'utf8') <= 256 * 1024);
    assert.ok(Array.isArray(snapshot.accessibility.traceInbox));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('registerCandidate rejects merged and blocked units', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-review-state-'));
  try {
    const report = localReport();
    const findings = report.pages.flatMap((page) => page.findings);
    const sessionDir = join(root, 'scan-reports', 'fix-sessions', 'fix-reg');
    mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
    const fixUnits = buildFixUnits(findings);
    const source = fixUnits[0];
    const target = fixUnits[1];
    const sharedSource = structuredClone(source.findings[0].source);
    for (const finding of target.findings) {
      finding.source = structuredClone(sharedSource);
    }
    target.canonicalRuleId = source.canonicalRuleId;
    target.pageState = source.pageState;
    target.status = 'ready';
    const traceInbox = createSourceTraceInbox({
      reportId: report.reportId,
      localRoot: root,
      sessionDir,
      candidates: buildTraceCandidatesFromFindings(findings),
    });
    const state = createReviewState({
      sessionDir,
      reportId: report.reportId,
      sessionId: 'fix-reg',
      fixUnits,
      traceResults: traceAllFindings(traceInbox, findings),
      policyRoutes: fixUnits.map((unit) => ({ fixUnitId: unit.fixUnitId, proposalAllowed: true })),
      traceInbox,
      localRoot: root,
    });
    state.mergeIntoUnit(source.fixUnitId, target.fixUnitId);
    assert.throws(
      () => state.registerCandidate(source.fixUnitId, buildValidatedCandidate(root)),
      (error) => error instanceof ReviewStateError && error.code === 'MERGED_UNIT',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('tampered trace audit fails closed on load', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-review-state-'));
  try {
    const report = localReport();
    const findings = report.pages.flatMap((page) => page.findings);
    const fixUnits = buildFixUnits(findings);
    const sessionDir = join(root, 'scan-reports', 'fix-sessions', 'fix-tamper');
    mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(sessionDir, 'trace-audit.jsonl'), '{not-json}\n', { mode: 0o600 });
    assert.throws(
      () => createReviewState({
        sessionDir,
        reportId: report.reportId,
        sessionId: 'fix-tamper',
        fixUnits,
        traceResults: [],
        policyRoutes: fixUnits.map((unit) => ({ fixUnitId: unit.fixUnitId, proposalAllowed: true })),
        localRoot: root,
      }),
      (error) => error instanceof ReviewStateError && error.code === 'CORRUPT_TRACE_AUDIT',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('merge rejects different canonical rules sharing one source block', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-review-state-'));
  try {
    const report = localReport();
    const findings = report.pages.flatMap((page) => page.findings);
    const fixUnits = buildFixUnits(findings);
    const source = fixUnits[0];
    const target = fixUnits[1];
    const sharedSource = structuredClone(source.findings[0].source);
    for (const finding of target.findings) {
      finding.source = structuredClone(sharedSource);
    }
    target.status = 'ready';
    delete source.candidate;
    delete target.candidate;
    const sessionDir = join(root, 'scan-reports', 'fix-sessions', 'fix-merge-rule');
    mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
    const traceInbox = createSourceTraceInbox({
      reportId: report.reportId,
      localRoot: root,
      sessionDir,
      candidates: buildTraceCandidatesFromFindings(findings),
    });
    const state = createReviewState({
      sessionDir,
      reportId: report.reportId,
      sessionId: 'fix-merge-rule',
      fixUnits,
      traceResults: traceAllFindings(traceInbox, findings),
      policyRoutes: fixUnits.map((unit) => ({ fixUnitId: unit.fixUnitId, proposalAllowed: true })),
      traceInbox,
      localRoot: root,
    });
    assert.throws(
      () => state.mergeIntoUnit(source.fixUnitId, target.fixUnitId),
      (error) => error instanceof ReviewStateError && error.code === 'MERGE_NOT_ALLOWED',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('manual mapping rejects ready unit with registered candidate', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-review-state-'));
  try {
    const partialDir = join(root, 'src', 'partials', 'jobs');
    mkdirSync(partialDir, { recursive: true });
    writeFileSync(join(partialDir, 'sort.liquid'), '<select id="sort-select"></select>\n');
    const report = localReport();
    const state = bootstrapSession(root, report);
    const findingId = state.fixUnits[0].findingIds[0];
    const { buildSourcePreimage } = await import('../../src/tracer/preimage.js');
    const expected = buildSourcePreimage('<select id="sort-select"></select>\n', 1).preimageSha256;
    assert.throws(
      () => state.applyManualMapping({
        findingId,
        file: 'src/partials/jobs/sort.liquid',
        line: 1,
        expectedPreimageSha256: expected,
      }),
      (error) => error instanceof ReviewStateError && error.code === 'MAPPING_NOT_ALLOWED',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('registerCandidate rejects policy-nonproposable units', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-review-state-'));
  try {
    const report = localReport();
    const state = bootstrapSession(root, report);
    const unitId = state.fixUnits[0].fixUnitId;
    state.raw.policyRoutes = state.raw.policyRoutes.map((route) => (
      route.fixUnitId === unitId ? { ...route, proposalAllowed: false } : route
    ));
    assert.throws(
      () => state.registerCandidate(unitId, buildValidatedCandidate(root)),
      (error) => error instanceof ReviewStateError && error.code === 'POLICY_BLOCKED',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('batchAccept rejects empty unit list', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-review-state-'));
  try {
    const state = bootstrapSession(root, localReport());
    assert.throws(
      () => state.batchAccept([]),
      (error) => error instanceof ReviewStateError && error.code === 'BATCH_NOT_ELIGIBLE',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('trimSnapshotPayload never exceeds MAX_SNAPSHOT_BYTES', async () => {
  const { trimSnapshotPayload, MAX_SNAPSHOT_BYTES } = await import('../../src/fix/review/state.js');
  const huge = 'x'.repeat(MAX_SNAPSHOT_BYTES);
  const snapshot = {
    schemaVersion: '1.0.0',
    reportId: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    sessionId: 'fix-huge',
    stateRevision: 1,
    preferences: { mode: 'accessibility', search: '', sourceFilter: 'all', statusFilter: 'all', severityFilter: 'all', typeFilter: 'all', selectedUnitId: null, activeTab: 'list' },
    applyGate: { blocked: true, reason: 'PENDING_DECISIONS', pendingCount: 1, blockedCount: 0, acceptedCount: 0, verifiedCount: 0, batchEligibleCount: 0, message: 'blocked' },
    units: [{ fixUnitId: 'u1', kind: 'accessibility', title: huge, reviewStatus: 'pending', severity: 'serious', sourceFile: null, candidateHash: null, acceptAllowed: false, verified: false, batchEligible: false, evidenceSummary: huge, trace: [{ findingId: 'f1', route: '/', unresolved: true, partials: [{ file: 'a.liquid', line: 1, confidence: 'high', method: 'x', preimageSha256: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', editorLink: 'vscode://file/x' }] }] }],
    accessibility: { traceInbox: [{ findingId: 'f1', route: '/', unresolved: true, fixUnitId: 'u1', partials: [{ file: 'a.liquid', line: 1, confidence: 'high', method: 'x', preimageSha256: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', editorLink: 'vscode://file/x' }], mergeTargets: [] }], sources: [{ file: '(unmapped)', units: [{ fixUnitId: 'u1', title: huge, reviewStatus: 'pending', severity: 'serious', evidenceSummary: huge, snippets: [{ findingId: 'f1', snippet: huge }], evidence: [{ message: huge }], diff: { kind: 'none', text: huge }, decision: { decision: 'pending' }, candidate: null, mergeTargets: [], trace: [] }] }] },
    performance: { metrics: [] },
  };
  const trimmed = trimSnapshotPayload(snapshot);
  assert.ok(Buffer.byteLength(JSON.stringify(trimmed), 'utf8') <= MAX_SNAPSHOT_BYTES);
  assert.equal(trimmed.truncated, true);
});

test('loadReviewState marks APPLY_RECOVERY_REQUIRED after restart with stale in-progress apply', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-review-recovery-'));
  try {
    const report = localReport();
    const state = bootstrapSession(root, report);
    state.raw.applyStarted = true;
    state.raw.applyCompleted = false;
    state.raw.applyInFlight = false;
    persistReviewState(state);
    const reloaded = loadReviewState({
      sessionDir: state.sessionDir,
      reportId: report.reportId,
      sessionId: state.sessionId,
      fixUnits: state.baseFixUnits,
      traceResults: state.traceResults,
      policyRoutes: state.policyRoutes,
      traceInbox: state.raw.traceInbox,
      localRoot: root,
    });
    assert.equal(reloaded.raw.applyRecoveryRequired, true);
    const gate = reloaded.getApplyEligibility();
    assert.equal(gate.allowed, false);
    assert.match(gate.reason, /APPLY_RECOVERY_REQUIRED/);
    assert.ok(reloaded.auditLog.some((event) => event.type === 'apply_recovery_required'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('loadReviewState recovery inspects live lock and latest transaction journal', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-review-recovery-lock-'));
  try {
    const report = localReport();
    const state = bootstrapSession(root, report);
    state.raw.applyStarted = true;
    state.raw.applyCompleted = false;
    state.raw.applyInFlight = false;
    persistReviewState(state);

    writeFileSync(join(root, '.ada-fix.apply.lock'), JSON.stringify({ pid: process.pid, token: 'stale' }), 'utf8');
    const txDir = join(state.sessionDir, 'transaction-recovery-test');
    mkdirSync(txDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(txDir, 'journal.ndjson'), `${JSON.stringify({ type: 'write', file: 'src/a.liquid' })}\n`, 'utf8');

    const reloaded = loadReviewState({
      sessionDir: state.sessionDir,
      reportId: report.reportId,
      sessionId: state.sessionId,
      fixUnits: state.baseFixUnits,
      traceResults: state.traceResults,
      policyRoutes: state.policyRoutes,
      traceInbox: state.raw.traceInbox,
      localRoot: root,
    });
    assert.equal(reloaded.raw.applyRecoveryRequired, true);
    assert.ok(reloaded.auditLog.some((event) => event.type === 'apply_recovery_lock_present'));
    assert.ok(reloaded.auditLog.some((event) => event.type === 'apply_recovery_journal_present'));
    assert.equal(reloaded.getApplyEligibility().allowed, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('apply recovery gate stays closed until explicit reconciliation', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-review-recovery-gate-'));
  try {
    const report = localReport();
    const state = bootstrapSession(root, report);
    state.raw.applyStarted = true;
    state.raw.applyCompleted = false;
    persistReviewState(state);

    const reloaded = loadReviewState({
      sessionDir: state.sessionDir,
      reportId: report.reportId,
      sessionId: state.sessionId,
      fixUnits: state.baseFixUnits,
      traceResults: state.traceResults,
      policyRoutes: state.policyRoutes,
      localRoot: root,
    });
    assert.equal(reloaded.getApplyEligibility().allowed, false);
    assert.equal(reloaded.raw.applyRecoveryRequired, true);
    reloaded.raw.applyRecoveryRequired = false;
    assert.equal(reloaded.getApplyEligibility().allowed, false, 'must not auto-reopen without reconciliation');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('createReviewState exposes normalized transportSecurity and devAuthBypass in snapshot', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-review-transport-labels-'));
  try {
    const report = localReport();
    const sessionDir = join(root, 'scan-reports', 'fix-sessions', 'labels');
    mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
    const state = createReviewState({
      sessionDir,
      reportId: report.reportId,
      sessionId: 'labels',
      fixUnits: [],
      traceResults: [],
      policyRoutes: [],
      localRoot: root,
      transportSecurity: 'insecure-dev',
      devAuthBypass: true,
    });

    const snapshot = state.getSnapshot();
    assert.equal(snapshot.transportSecurity, 'insecure-dev');
    assert.equal(snapshot.devAuthBypass, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('createReviewState normalizes invalid transport labels to disabled and false', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-review-transport-normalize-'));
  try {
    const report = localReport();
    const sessionDir = join(root, 'scan-reports', 'fix-sessions', 'normalize');
    mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
    const state = createReviewState({
      sessionDir,
      reportId: report.reportId,
      sessionId: 'normalize',
      fixUnits: [],
      traceResults: [],
      policyRoutes: [],
      localRoot: root,
      transportSecurity: 'evil-mode',
      devAuthBypass: 'true',
    });

    const snapshot = state.getSnapshot();
    assert.equal(snapshot.transportSecurity, 'disabled');
    assert.equal(snapshot.devAuthBypass, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('transport labels are not persisted in session.json', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-review-transport-persist-'));
  try {
    const report = localReport();
    const state = bootstrapSession(root, report);
    state.raw.transportSecurity = 'insecure-dev';
    state.raw.devAuthBypass = true;
    state.setPreferences({ search: 'persist-probe' });

    const sessionJson = readFileSync(join(state.sessionDir, 'session.json'), 'utf8');
    assert.equal(sessionJson.includes('transportSecurity'), false);
    assert.equal(sessionJson.includes('devAuthBypass'), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('trimSnapshotPayload retains transport labels when snapshot is trimmed', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-review-transport-trim-'));
  try {
    const report = localReport();
    const state = bootstrapSession(root, report);
    state.raw.transportSecurity = 'trusted';
    state.raw.devAuthBypass = false;

    const snapshot = state.getSnapshot();
    const trimmed = trimSnapshotPayload({
      ...snapshot,
      units: Array.from({ length: 500 }, (_, index) => ({
        ...snapshot.units[0],
        fixUnitId: `unit-${index}`,
        title: 'x'.repeat(500),
        trace: Array.from({ length: 20 }, () => ({
          findingId: `sha256:${'a'.repeat(64)}`,
          route: '/',
          unresolved: false,
          partials: Array.from({ length: 20 }, () => ({
            file: 'src/a.liquid',
            line: 1,
            confidence: 'high',
            method: 'attested',
            preimageSha256: `sha256:${'b'.repeat(64)}`,
          })),
        })),
        editorLinks: ['vscode://file/a'],
      })),
    });

    assert.equal(trimmed.transportSecurity, 'trusted');
    assert.equal(trimmed.devAuthBypass, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('diffForUnit exposes structured view without changing candidate hashes', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-review-diff-view-'));
  try {
    const state = bootstrapSession(root, localReport());
    const unitId = state.fixUnits[0].fixUnitId;
    const candidate = state.raw.candidates[unitId];
    const beforeHash = candidate.candidateHash;
    const beforeDiffHash = candidate.diffHash;
    const beforeDiff = candidate.diff;

    const accessibilityUnit = state.getSnapshot().accessibility.sources
      .flatMap((group) => group.units)
      .find((unit) => unit.fixUnitId === unitId);
    assert.ok(accessibilityUnit?.diff);
    assert.equal(accessibilityUnit.diff.kind, 'candidate');
    assert.equal(accessibilityUnit.diff.text, beforeDiff);
    assert.equal(accessibilityUnit.diff.view?.ok, true);
    assert.ok(Array.isArray(accessibilityUnit.diff.view.files));

    assert.equal(candidate.candidateHash, beforeHash);
    assert.equal(candidate.diffHash, beforeDiffHash);
    assert.equal(candidate.diff, beforeDiff);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('diffForUnit malformed candidate diff keeps raw text with failed view', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-review-diff-malformed-'));
  try {
    const state = bootstrapSession(root, localReport());
    const unitId = state.fixUnits[0].fixUnitId;
    state.raw.candidates[unitId].diff = 'not-a-valid-unified-diff';
    const accessibilityUnit = state.getSnapshot().accessibility.sources
      .flatMap((group) => group.units)
      .find((unit) => unit.fixUnitId === unitId);
    assert.equal(accessibilityUnit.diff.text, 'not-a-valid-unified-diff');
    assert.equal(accessibilityUnit.diff.view?.ok, false);
    assert.equal(accessibilityUnit.diff.view?.reason, 'MALFORMED_UNIFIED_DIFF');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('trimSnapshotPayload drops structured diff view before canonical text', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-review-diff-trim-'));
  try {
    const state = bootstrapSession(root, localReport());
    const snapshot = state.getSnapshot();
    const unitId = state.fixUnits[0].fixUnitId;
    const canonicalDiff = state.raw.candidates[unitId].diff;
    const bloated = structuredClone(snapshot);
    const accessibilityUnit = bloated.accessibility.sources
      .flatMap((group) => group.units)
      .find((unit) => unit.fixUnitId === unitId);
    assert.ok(accessibilityUnit?.diff?.view?.ok);
    const extraRows = Array.from({ length: 5000 }, (_, index) => ({
      kind: 'context',
      oldLine: index + 1,
      newLine: index + 1,
      text: 'x'.repeat(40),
    }));
    accessibilityUnit.diff.view.files[0].rows.push(...extraRows);

    const trimmed = trimSnapshotPayload(bloated);
    const trimmedUnit = trimmed.accessibility?.sources
      ?.flatMap((group) => group.units)
      ?.find((unit) => unit.fixUnitId === unitId);
    assert.ok(trimmedUnit?.diff?.text);
    assert.equal(trimmedUnit.diff.text, canonicalDiff);
    assert.equal(trimmedUnit.diff.view, null);
    assert.equal(trimmedUnit.diff.viewTrimmed, true);
    assert.ok(Buffer.byteLength(JSON.stringify(trimmed), 'utf8') <= 256 * 1024);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('trimSnapshotPayload trims performance plan diff text after structured view removal', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-review-diff-perf-trim-'));
  try {
    const state = bootstrapSession(root, localReport());
    const snapshot = state.getSnapshot();
    const sourceDiff = snapshot.accessibility.sources
      .flatMap((group) => group.units)
      .find((unit) => unit.diff?.view?.ok)?.diff;
    assert.ok(sourceDiff);
    const bloated = structuredClone(snapshot);
    bloated.performance = {
      metrics: [{
        metric: 'lcp',
        opportunities: [{
          fixUnitId: 'perf-plan-trim',
          plan: {
            files: ['src/partials/jobs/sort.liquid'],
            diff: structuredClone(sourceDiff),
          },
        }],
      }],
    };
    const extraRows = Array.from({ length: 5000 }, (_, index) => ({
      kind: 'context',
      oldLine: index + 1,
      newLine: index + 1,
      text: 'y'.repeat(40),
    }));
    bloated.performance.metrics[0].opportunities[0].plan.diff.view.files[0].rows.push(...extraRows);

    const trimmed = trimSnapshotPayload(bloated);
    const trimmedDiff = trimmed.performance.metrics[0].opportunities[0].plan.diff;
    assert.ok(trimmedDiff.text);
    assert.equal(trimmedDiff.text, sourceDiff.text);
    assert.equal(trimmedDiff.view, null);
    assert.equal(trimmedDiff.viewTrimmed, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function bootstrapSandboxSession(root, report, { persistedSandbox = null } = {}) {
  const session = bootstrapSession(root, report);
  session.raw.sandbox = {
    enabled: true,
    targetFile: 'src/partials/jobs/sort.liquid',
    transactionId: null,
    artifactPaths: null,
    artifactError: null,
    rollbackCompleted: false,
    rollbackResult: null,
  };
  if (persistedSandbox) {
    persistReviewState(session);
    const sessionPath = join(session.sessionDir, 'session.json');
    const parsed = JSON.parse(readFileSync(sessionPath, 'utf8'));
    parsed.sandbox = persistedSandbox;
    writeFileSync(sessionPath, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
    return loadReviewState({
      sessionDir: session.sessionDir,
      reportId: report.reportId,
      sessionId: session.sessionId,
      fixUnits: session.baseFixUnits,
      traceResults: session.traceResults,
      policyRoutes: session.policyRoutes,
      traceInbox: session.raw.traceInbox,
      localRoot: root,
      sandboxContext: { enabled: true, targetFile: 'src/partials/jobs/sort.liquid' },
      persisted: parsed,
    });
  }
  return session;
}

test('sandbox rollback persists metadata after apply including artifactError path', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-review-sandbox-apply-'));
  try {
    const report = localReport();
    const state = bootstrapSandboxSession(root, report);
    state.raw.applyCompleted = true;
    state.raw.sandbox.transactionId = 'transaction-1700000000000-deadbeef';
    state.raw.sandbox.artifactError = 'ARTIFACT_EXPORT_FAILED';
    persistReviewState(state);

    const reloaded = loadReviewState({
      sessionDir: state.sessionDir,
      reportId: report.reportId,
      sessionId: state.sessionId,
      fixUnits: state.baseFixUnits,
      traceResults: state.traceResults,
      policyRoutes: state.policyRoutes,
      traceInbox: state.raw.traceInbox,
      localRoot: root,
      sandboxContext: { enabled: true, targetFile: 'src/partials/jobs/sort.liquid' },
      persisted: JSON.parse(readFileSync(join(state.sessionDir, 'session.json'), 'utf8')),
    });

    const snapshot = reloaded.getSnapshot();
    assert.equal(snapshot.sandbox.rollbackAvailable, true);
    assert.equal(snapshot.sandbox.artifactError, 'ARTIFACT_EXPORT_FAILED');
    assert.equal(snapshot.sandbox.transactionId, 'transaction-1700000000000-deadbeef');
    assert.equal(reloaded.raw.rollbackInFlight, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rollbackSandboxTransaction succeeds and rejects replay', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-review-sandbox-rollback-'));
  try {
    const report = localReport();
    const state = bootstrapSandboxSession(root, report);
    state.raw.applyCompleted = true;
    state.raw.sandbox.transactionId = 'transaction-1700000000000-cafebabe';

    const handler = async () => ({
      transactionId: 'transaction-1700000000000-cafebabe',
      targetFile: 'src/partials/jobs/sort.liquid',
      restored: [{ file: 'src/partials/jobs/sort.liquid' }],
      sandboxRestored: true,
      originalUnchangedAfterRollback: true,
    });

    const result = await state.rollbackSandboxTransaction(handler);
    assert.equal(result.sandboxRestored, true);
    assert.equal(state.getSnapshot().sandbox.rollbackCompleted, true);
    assert.equal(state.getSnapshot().sandbox.rollbackAvailable, false);

    await assert.rejects(
      () => state.rollbackSandboxTransaction(handler),
      (error) => error instanceof ReviewStateError && error.code === 'ROLLBACK_ALREADY_COMPLETED',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rollbackSandboxTransaction dedupes concurrent requests', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-review-sandbox-concurrent-'));
  try {
    const report = localReport();
    const state = bootstrapSandboxSession(root, report);
    state.raw.applyCompleted = true;
    state.raw.sandbox.transactionId = 'transaction-1700000000000-beefbeef';

    let calls = 0;
    const handler = () => new Promise((resolve) => {
      calls += 1;
      setTimeout(() => resolve({
        transactionId: 'transaction-1700000000000-beefbeef',
        targetFile: 'src/partials/jobs/sort.liquid',
        restored: [{ file: 'src/partials/jobs/sort.liquid' }],
        sandboxRestored: true,
        originalUnchangedAfterRollback: true,
      }), 30);
    });

    const first = state.rollbackSandboxTransaction(handler);
    const second = state.rollbackSandboxTransaction(handler);
    await Promise.all([first, second]);
    assert.equal(calls, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('non-sandbox sessions omit sandbox snapshot block', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-review-non-sandbox-'));
  try {
    const state = bootstrapSession(root, localReport());
    assert.equal(state.getSnapshot().sandbox, null);
    persistReviewState(state);
    const sessionJson = readFileSync(join(state.sessionDir, 'session.json'), 'utf8');
    assert.equal(sessionJson.includes('"sandbox"'), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('invalid persisted sandbox block fails hydration', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-review-sandbox-invalid-'));
  try {
    const report = localReport();
    assert.throws(
      () => bootstrapSandboxSession(root, report, {
        persistedSandbox: {
          enabled: true,
          targetFile: '../evil.liquid',
          transactionId: null,
          artifactPaths: null,
          artifactError: null,
          rollbackCompleted: false,
          rollbackResult: null,
        },
      }),
      (error) => error instanceof ReviewStateError && error.code === 'CORRUPT_SESSION',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rollbackSandboxTransaction rejects unavailable, in-flight, and conflict paths', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-review-sandbox-rollback-guards-'));
  try {
    const report = localReport();
    const state = bootstrapSandboxSession(root, report);
    const handler = async () => ({
      transactionId: 'transaction-1700000000000-cafebabe',
      targetFile: 'src/partials/jobs/sort.liquid',
      restored: [{ file: 'src/partials/jobs/sort.liquid' }],
      sandboxRestored: true,
      originalUnchangedAfterRollback: true,
    });

    await assert.rejects(
      () => state.rollbackSandboxTransaction(handler),
      (error) => error instanceof ReviewStateError && error.code === 'ROLLBACK_NOT_AVAILABLE',
    );

    state.raw.applyCompleted = true;
    state.raw.sandbox.transactionId = 'transaction-1700000000000-cafebabe';
    state.raw.rollbackInFlight = true;
    await assert.rejects(
      () => state.rollbackSandboxTransaction(handler),
      (error) => error instanceof ReviewStateError && error.code === 'ROLLBACK_IN_PROGRESS',
    );

    state.raw.rollbackInFlight = false;
    const conflictHandler = async () => {
      const error = new Error('conflict');
      error.code = 'ROLLBACK_CONFLICTED';
      throw error;
    };
    await assert.rejects(
      () => state.rollbackSandboxTransaction(conflictHandler),
      (error) => error instanceof ReviewStateError && error.code === 'ROLLBACK_CONFLICTED',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('persisted sandbox artifactPaths reload with deep equality', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-review-sandbox-artifact-paths-'));
  try {
    const report = localReport();
    const artifactPaths = Object.freeze({
      patch: 'artifacts/candidate.patch',
      fixed: 'artifacts/fixed/src/partials/jobs/sort.liquid',
      evidence: 'artifacts/evidence.json',
    });
    const state = bootstrapSandboxSession(root, report, {
      persistedSandbox: {
        enabled: true,
        targetFile: 'src/partials/jobs/sort.liquid',
        transactionId: 'transaction-1700000000000-feedface',
        artifactPaths,
        artifactError: null,
        rollbackCompleted: false,
        rollbackResult: null,
      },
    });
    state.raw.applyCompleted = true;
    persistReviewState(state);

    const reloaded = loadReviewState({
      sessionDir: state.sessionDir,
      reportId: report.reportId,
      sessionId: state.sessionId,
      fixUnits: state.baseFixUnits,
      traceResults: state.traceResults,
      policyRoutes: state.policyRoutes,
      traceInbox: state.raw.traceInbox,
      localRoot: root,
      sandboxContext: { enabled: true, targetFile: 'src/partials/jobs/sort.liquid' },
      persisted: JSON.parse(readFileSync(join(state.sessionDir, 'session.json'), 'utf8')),
    });

    const snapshot = reloaded.getSnapshot();
    assert.deepEqual(snapshot.sandbox.artifactPaths, artifactPaths);
    assert.notEqual(snapshot.sandbox.artifactPaths, artifactPaths);
    assert.equal(snapshot.sandbox.rollbackAvailable, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rollbackSandboxTransaction rejects handler result that mismatches sandbox transaction or target', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-review-sandbox-rollback-mismatch-'));
  try {
    const report = localReport();
    const state = bootstrapSandboxSession(root, report);
    state.raw.applyCompleted = true;
    state.raw.sandbox.transactionId = 'transaction-1700000000000-cafebabe';

    const wrongTransactionHandler = async () => ({
      transactionId: 'transaction-1700000000000-deadbeef',
      targetFile: 'src/partials/jobs/sort.liquid',
      restored: [{ file: 'src/partials/jobs/sort.liquid' }],
      sandboxRestored: true,
      originalUnchangedAfterRollback: true,
    });
    await assert.rejects(
      () => state.rollbackSandboxTransaction(wrongTransactionHandler),
      (error) => error instanceof ReviewStateError && error.code === 'ROLLBACK_VERIFICATION_FAILED',
    );
    assert.equal(state.getSnapshot().sandbox.rollbackCompleted, false);
    assert.equal(state.raw.rollbackInFlight, false);

    const wrongTargetHandler = async () => ({
      transactionId: 'transaction-1700000000000-cafebabe',
      targetFile: 'src/partials/jobs/other.liquid',
      restored: [{ file: 'src/partials/jobs/other.liquid' }],
      sandboxRestored: true,
      originalUnchangedAfterRollback: true,
    });
    await assert.rejects(
      () => state.rollbackSandboxTransaction(wrongTargetHandler),
      (error) => error instanceof ReviewStateError && error.code === 'ROLLBACK_VERIFICATION_FAILED',
    );
    assert.equal(state.getSnapshot().sandbox.rollbackCompleted, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rollbackSandboxTransaction clears in-flight flag when rollback_started persistence fails', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-review-sandbox-rollback-persist-start-'));
  try {
    const report = localReport();
    const state = bootstrapSandboxSession(root, report);
    state.raw.applyCompleted = true;
    state.raw.sandbox.transactionId = 'transaction-1700000000000-beefbeef';
    persistReviewState(state);

    const blockedPath = join(root, 'blocked-session-dir');
    writeFileSync(blockedPath, 'not-a-directory');
    state.raw.sessionDir = blockedPath;

    const handler = async () => ({
      transactionId: 'transaction-1700000000000-beefbeef',
      targetFile: 'src/partials/jobs/sort.liquid',
      restored: [{ file: 'src/partials/jobs/sort.liquid' }],
      sandboxRestored: true,
      originalUnchangedAfterRollback: true,
    });

    await assert.rejects(
      () => state.rollbackSandboxTransaction(handler),
      (error) => error instanceof ReviewStateError && error.code === 'PERSIST_FAILED',
    );
    assert.equal(state.raw.rollbackInFlight, false);
    assert.equal(state.raw.rollbackPromise, null);
    assert.equal(state.getSnapshot().sandbox.rollbackCompleted, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
