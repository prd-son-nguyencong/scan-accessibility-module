import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { containsHostLeakage } from '../src/scanner/access-scan/corpus/sanitization.js';
import { buildSnapshotIdentity } from '../scripts/accessscan-corpus/lib/snapshot-identity.js';
import {
  buildOracleEvidenceDigest,
} from '../scripts/accessscan-corpus/lib/oracle-digest.js';
import {
  buildCorpusReportFromOracle,
} from '../scripts/accessscan-corpus/lib/oracle-report.js';
import { sanitizeOracleSnippetHtml } from '../scripts/accessscan-corpus/lib/oracle-snippet-sanitize.js';
import {
  assertCommittedEvidenceNeutral,
} from '../scripts/accessscan-corpus/lib/oracle-evidence-slice.js';
import {
  containsNonNeutralCommittedText,
  containsPartialRedactionMarker,
  isNeutralPlaceholderText,
  pseudonymizeHtmlTextContent,
  pseudonymizeHumanText,
  pseudonymizeCommittedTextValue,
} from '../scripts/accessscan-corpus/lib/text-pseudonymization.js';
import {
  loadSourceManifest,
  listSeededSourceEntries,
} from '../scripts/accessscan-corpus/lib/source-manifest.js';
import {
  verifyOracleEvidenceDigest,
} from '../scripts/accessscan-corpus/lib/oracle-digest-verify.js';
import { installCorpusToolingTestResetHooks } from './helpers/accessscan-corpus-test-reset.js';

installCorpusToolingTestResetHooks();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CORPUS_ROOT = path.join(__dirname, 'fixtures/accessscan-corpus');

test('containsHostLeakage detects loopback and literal IP hosts', () => {
  assert.equal(containsHostLeakage('https://127.0.0.1/neutral-asset.png'), true);
  assert.equal(containsHostLeakage('http://localhost:1234/jobs'), true);
  assert.equal(containsHostLeakage('http://[::1]/careers'), true);
  assert.equal(containsHostLeakage('http://192.168.0.4/path'), true);
  assert.equal(containsHostLeakage('/neutral-asset.png'), false);
});

test('pseudonymizeHumanText replaces marketing copy with deterministic neutral placeholders', () => {
  const registry = new Map();
  const first = pseudonymizeHumanText('RMHC', 'text', registry);
  const second = pseudonymizeHumanText('RMHC', 'text', registry);
  const other = pseudonymizeHumanText('Fortune award copy', 'text', registry);

  assert.equal(first, second);
  assert.notEqual(first, other);
  assert.match(first, /^neutral-text-\d+-[a-f0-9]{8}$/);
  assert.equal(isNeutralPlaceholderText(first), true);
});

test('pseudonymizeHtmlTextContent pseudonymizes semantic attributes and text nodes', () => {
  const html = pseudonymizeHtmlTextContent(
    '<a aria-label="Ronald House Charities (Opens in a new tab)"> RMHC </a>',
  );
  assert.equal(containsPartialRedactionMarker(html), false);
  assert.equal(html.includes('RMHC'), false);
  assert.equal(html.includes('Ronald'), false);
  assert.match(html, /aria-label="neutral-aria-label-/);
  assert.match(html, />neutral-text-/);
});

test('sanitizeOracleSnippetHtml removes partial redaction markers and brand residue', () => {
  const html = sanitizeOracleSnippetHtml(
    '<svg role="img" aria-label="Elevance Health logo" alt="Health\'s white logo"><use href="https://127.0.0.1/logo.png"></use></svg>',
  );
  assert.equal(containsPartialRedactionMarker(html), false);
  assert.equal(containsHostLeakage(html), false);
  assert.equal(html.includes('Health'), false);
  assert.equal(html.includes('127.0.0.1'), false);
});

test('verifyOracleEvidenceDigest fails closed on digest mismatch', () => {
  const payload = {
    reports: {
      General: {
        ListEmpty: {
          failures: 1,
          failuresHtml: ['%3Cul%3E%3C%2Ful%3E'],
        },
      },
    },
  };
  const oracle = buildCorpusReportFromOracle(payload);
  const digest = buildOracleEvidenceDigest(oracle.report);

  assert.throws(
    () => verifyOracleEvidenceDigest(payload, 'sha256:deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef'),
    /digest/i,
  );
  assert.equal(verifyOracleEvidenceDigest(payload, digest).ok, true);
});

test('committed seeded site cases are neutralized and snapshot hashes match provenance', () => {
  const sourceManifest = loadSourceManifest();

  for (const entry of listSeededSourceEntries(sourceManifest)) {
    const caseId = String(entry.caseId);
    const caseDir = path.join(CORPUS_ROOT, 'cases', caseId);
    const files = {
      'meta.json': readFileSync(path.join(caseDir, 'meta.json'), 'utf8'),
      'snapshot.json': readFileSync(path.join(caseDir, 'snapshot.json'), 'utf8'),
      'expected.json': readFileSync(path.join(caseDir, 'expected.json'), 'utf8'),
      'page.html': readFileSync(path.join(caseDir, 'page.html'), 'utf8'),
    };

    assert.doesNotThrow(
      () => assertCommittedEvidenceNeutral(files),
      `${caseId} committed evidence is not neutralized`,
    );

    const snapshot = JSON.parse(files['snapshot.json']);
    const identity = buildSnapshotIdentity(snapshot);
    const provenance = /** @type {{ stableCaptureHashes?: string[] }} */ (entry.captureProvenance);
    assert.equal(provenance.stableCaptureHashes?.[0], identity);
    assert.equal(provenance.stableCaptureHashes?.[1], identity);
  }
});

test('pseudonymizeCommittedTextValue tokenizes concatenated accessible names', () => {
  const output = pseudonymizeCommittedTextValue('Home Remote Remote 1 6 6 Neutral footer');
  assert.equal(output.includes('Remote'), false);
  assert.equal(output.includes('Home'), true);
  assert.equal(output.includes('Neutral footer'), true);
  assert.match(output, /neutral-text-/);
});

test('containsNonNeutralCommittedText flags marketing residue and partial redaction', () => {
  assert.equal(containsNonNeutralCommittedText('Ronald House Charities'), true);
  assert.equal(containsNonNeutralCommittedText('[redacted] Health'), true);
  assert.equal(containsNonNeutralCommittedText('neutral-text-0-abcdef12'), false);
  assert.equal(containsNonNeutralCommittedText('Neutral header'), false);
});

test('containsNonNeutralCommittedText ignores structural HTML without human-readable text', () => {
  assert.equal(containsNonNeutralCommittedText('<meta charset="utf-8" />'), false);
  assert.equal(containsNonNeutralCommittedText('<span />'), false);
});

test('containsNonNeutralCommittedText flags unsanitized meta content and accepts pseudonymized markup', () => {
  const raw = '<meta name="description" content="Fortune award copy for kidney care" />';
  assert.equal(containsNonNeutralCommittedText(raw), true);
  const neutral = pseudonymizeHtmlTextContent(raw);
  assert.equal(containsNonNeutralCommittedText(neutral), false);
});

test('pseudonymizeHtmlTextContent neutralizes non-framework meta content attributes', () => {
  const html = pseudonymizeHtmlTextContent(
    '<meta name="description" content="Fortune award copy for kidney care" />',
  );
  assert.equal(html.includes('Fortune'), false);
  assert.match(html, /content="neutral-content-/);
});
