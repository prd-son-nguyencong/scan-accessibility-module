import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSessionIdArg, runFixSubcommand } from '../../src/index.js';
import { FixControllerError } from '../../src/fix/controller/session.js';

test('runFixSubcommand throws typed error for missing report instead of exiting', async () => {
  await assert.rejects(
    () => runFixSubcommand(['--report', '/tmp/ada-scan-missing-report-never-exists.json']),
    (error) => error instanceof FixControllerError && error.code === 'REPORT_NOT_FOUND',
  );
});

test('parseSessionIdArg accepts a resumable session id and rejects missing values', () => {
  assert.equal(parseSessionIdArg(['--session', 'review-2026-07-16']), 'review-2026-07-16');
  assert.equal(parseSessionIdArg([]), null);
  assert.throws(
    () => parseSessionIdArg(['--session', '--ui']),
    (error) => error instanceof FixControllerError && error.code === 'INVALID_SESSION_ID',
  );
});
