import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeSanitizedDriftError,
  sanitizeDriftStderr,
  assertNeutralDriftArtifact,
} from '../scripts/accessscan-corpus/lib/drift-error.js';
import { buildDriftArtifactPayload, buildDriftHumanSummary } from '../scripts/accessscan-corpus/lib/drift-artifact.js';
import { CorpusToolingError, CORPUS_TOOLING_ERROR_CODES } from '../scripts/accessscan-corpus/lib/errors.js';

test('normalizeSanitizedDriftError redacts hosts secrets and URLs from Playwright failures', () => {
  const normalized = normalizeSanitizedDriftError(new Error(
    'page.goto: net::ERR_CONNECTION_REFUSED at https://user:secret@hitachi728.preview.sites.stg.paradox.ai/jobs',
  ));
  assert.equal(normalized.errorCode, 'network_failure');
  assert.doesNotMatch(normalized.message, /hitachi728|paradox\.ai|secret|https?:\/\//i);

  const timeout = normalizeSanitizedDriftError(new Error('Timeout 30000ms exceeded'));
  assert.equal(timeout.errorCode, 'navigation_timeout');
});

test('sanitizeDriftStderr removes raw stderr secrets before artifact emission', () => {
  const sanitized = sanitizeDriftStderr(
    'Authorization: Bearer abc.def token=supersecret https://evil.example/path',
  );
  assert.doesNotMatch(sanitized, /Bearer|supersecret|evil\.example|https?:\/\//i);
  assert.match(sanitized, /neutral-text-/i);
});

test('drift summary and artifact remain neutral for error cases with null snapshotDrift', () => {
  const payload = buildDriftArtifactPayload({
    ok: false,
    observedExitCode: 1,
    caseCount: 1,
    driftCount: 0,
    errorCount: 1,
    driftBasis: 'scanner-vs-frozen-oracle',
    cases: [{
      caseId: 'site-728',
      ok: false,
      snapshotDrift: null,
      findingsEquivalent: null,
      errorCode: 'forbidden_source_url',
      message: 'Navigation host is not on the reviewed allowlist',
      driftBasis: 'scanner-vs-frozen-oracle',
    }],
  });

  assertNeutralDriftArtifact(payload);
  assert.equal(payload.cases[0].snapshotDrift, null);
  const summary = buildDriftHumanSummary(payload);
  assert.match(summary, /error \(forbidden_source_url\)/);
  assert.doesNotMatch(summary, /paradox\.ai|https?:\/\//i);
});

test('tooling errors sanitize outbound messages without leaking source url details', () => {
  const error = new CorpusToolingError(
    CORPUS_TOOLING_ERROR_CODES.FORBIDDEN_SOURCE_URL,
    'Navigation host is not on the reviewed allowlist at https://hitachi728.preview.sites.stg.paradox.ai/jobs',
  );
  const normalized = normalizeSanitizedDriftError(error);
  assert.equal(normalized.errorCode, 'forbidden_source_url');
  assert.doesNotMatch(normalized.message, /hitachi728|paradox\.ai|https?:\/\//i);
});
