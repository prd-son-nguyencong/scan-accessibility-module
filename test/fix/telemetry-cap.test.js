import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendCisTelemetryRecord,
  readCisTelemetryRecords,
  MAX_FILE_BYTES,
  TELEMETRY_FILE,
} from '../../src/fix/cis/telemetry.js';

test('telemetry log rotates at the size cap and the reader tolerates a torn line', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ada-telemetry-cap-'));
  try {
    const file = join(dir, TELEMETRY_FILE);
    const rec = (n) => ({ fixUnitId: `u${n}`, sessionCalls: 1, outcome: 'proposed', reasonCode: 'x'.repeat(100) });
    writeFileSync(file, `${JSON.stringify({ sessionCalls: 1 })}\n`.repeat(Math.floor(MAX_FILE_BYTES / 19)));
    for (let i = 0; i < 3; i += 1) appendCisTelemetryRecord(dir, rec(i));
    assert.ok(statSync(file).size <= MAX_FILE_BYTES);
    assert.ok(statSync(`${file}.1`).size <= MAX_FILE_BYTES);
    assert.equal(statSync(file).size < 2000, true);
    const records = readCisTelemetryRecords(dir);
    assert.equal(records.at(-1).fixUnitId, 'u2');

    appendFileSync(file, '{"torn":\n');
    writeFileSync(`${file}.1`, 'not json\n');
    assert.equal(readCisTelemetryRecords(dir).at(-1).fixUnitId, 'u2');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
