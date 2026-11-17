import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readCisTelemetryRecords } from '../../src/fix/cis/telemetry.js';
import { evaluateOperationalGate, collectLeftoverArtifacts } from '../../src/fix/eval/poc-gates.js';
import { evaluateSuccessPathAuditSequence } from '../../src/fix/audit/coverage.js';
import { SUCCESS_PATH_AUDIT_TYPES } from '../../src/fix/audit/coverage.js';
import { runFullPocHttpSession } from './helpers/poc-session.js';

test('operational gate loads actual PoC telemetry NDJSON and persisted session audit', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-op-gate-'));
  try {
    const session = await runFullPocHttpSession(root);
    assert.equal(session.applyStatus, 200);

    const telemetryFromDisk = readCisTelemetryRecords(session.sessionDir);
    assert.ok(telemetryFromDisk.length >= 1, 'expected telemetry NDJSON from real proposal run');
    assert.ok(
      telemetryFromDisk.every((record) => Number.isFinite(record.sessionCalls) && record.sessionCalls >= 1),
      'sessionCalls must originate from transport invocations',
    );

    assert.deepEqual(session.persistedAuditLog, session.auditLog);
    const sequence = evaluateSuccessPathAuditSequence(session.persistedAuditLog, SUCCESS_PATH_AUDIT_TYPES);
    assert.equal(sequence.ok, true, JSON.stringify(sequence));

    const gate = evaluateOperationalGate({
      telemetryRecords: telemetryFromDisk,
      auditLog: session.persistedAuditLog,
      leftoverArtifacts: collectLeftoverArtifacts(root),
      requiredAuditTypes: SUCCESS_PATH_AUDIT_TYPES,
    });
    assert.equal(gate.ok, true, JSON.stringify(gate));
    assert.ok(gate.p95 <= 2, `p95 sessionCalls ${gate.p95} exceeds budget`);

    await session.cli.reviewServer.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('operational gate p95 uses multiple real proposal sessions with transport-originated call counts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-op-gate-multi-'));
  const records = [];
  try {
    for (let index = 0; index < 4; index += 1) {
      const subRoot = mkdtempSync(join(root, `run-${index}-`));
      const session = await runFullPocHttpSession(subRoot);
      records.push(...readCisTelemetryRecords(session.sessionDir));
      await session.cli.reviewServer.close();
    }

    assert.ok(records.length >= 4, `expected >=4 telemetry records, got ${records.length}`);
    const callCounts = records.map((record) => record.sessionCalls);
    assert.ok(callCounts.every((count) => count === 1), `unexpected call counts: ${callCounts.join(',')}`);

    const { evaluateCisCallBudget } = await import('../../src/fix/cis/telemetry.js');
    const budget = evaluateCisCallBudget(records, 2);
    assert.equal(budget.ok, true, JSON.stringify(budget));
    assert.equal(budget.p95, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
