import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  REDACTION_PLACEHOLDERS,
  assertSerializedRedacted,
  redactHeaders,
  redactProbeBody,
  redactProbeResponse,
  serializeRedactedArtifact,
} from '../scripts/lib/cis-redaction.js';
import { parseProbeSelection, ALL_PROBE_NAMES } from '../scripts/cis-characterize.js';
import { CIS_POC_LIMITS } from '../src/fix/cis/limits.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_ROOT = path.join(__dirname, 'fixtures', 'cis');

const ADVERSARIAL_BODY = {
  prediction: {
    type: 'openai-chat-completion-v1',
    output: {
      id: '550e8400-e29b-41d4-a716-446655440000',
      choices: [
        {
          message: {
            role: 'assistant',
            content: 'OK',
          },
        },
      ],
      usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
    },
  },
  error: {
    message: 'host s0010-ml-https.s0010.us-west-2.awswd unreachable',
  },
};

const ADVERSARIAL_HEADERS = new Map([
  ['Set-Cookie', 'session=abc123secret'],
  ['WWW-Authenticate', 'Bearer secret-token-value'],
  ['Authorization', 'Bearer another-secret'],
  ['Wd-PCA-Feature-Key', 'operator.feature.key'],
  ['X-Request-Id', '550e8400-e29b-41d4-a716-446655440000'],
  ['Content-Type', 'application/json'],
]);

test('redactHeaders unconditionally redacts sensitive header values', () => {
  const redacted = redactHeaders(ADVERSARIAL_HEADERS);
  assert.equal(redacted['set-cookie'], REDACTION_PLACEHOLDERS.header);
  assert.equal(redacted['www-authenticate'], REDACTION_PLACEHOLDERS.header);
  assert.equal(redacted['authorization'], REDACTION_PLACEHOLDERS.header);
  assert.equal(redacted['wd-pca-feature-key'], REDACTION_PLACEHOLDERS.featureKey);
  assert.equal(redacted['x-request-id'], REDACTION_PLACEHOLDERS.requestId);
  assert.equal(redacted['content-type'], 'application/json');
});

test('redactProbeBody redacts short model output and internal host strings', () => {
  const redacted = redactProbeBody(ADVERSARIAL_BODY);
  assert.equal(redacted.prediction.output.choices[0].message.content, REDACTION_PLACEHOLDERS.content);
  assert.equal(redacted.error.message, REDACTION_PLACEHOLDERS.content);
  assert.equal(redacted.prediction.output.id, REDACTION_PLACEHOLDERS.requestId);
});

test('redactProbeResponse never leaks adversarial headers or body content', () => {
  const redacted = redactProbeResponse({
    name: 'predictions',
    ok: true,
    status: 200,
    elapsedMs: 12,
    headers: ADVERSARIAL_HEADERS,
    body: ADVERSARIAL_BODY,
  });

  const serialized = serializeRedactedArtifact({ probes: { predictions: redacted } });
  assertSerializedRedacted(serialized);
  const parsed = JSON.parse(serialized);
  assert.equal(
    parsed.probes.predictions.body.prediction.output.choices[0].message.content,
    REDACTION_PLACEHOLDERS.content,
  );
});

test('serializeRedactedArtifact fails closed when forbidden patterns remain', () => {
  assert.throws(
    () => serializeRedactedArtifact({ leak: 'Bearer abcdefghijklmnop' }),
    /forbidden pattern/i,
  );
});

test('bruno manifest sha256 values match sanitized file contents', () => {
  const manifestPath = path.join(FIXTURES_ROOT, 'bruno-source', 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assert.equal(manifest.externalSourcePath, '<operator-home>/Documents/bruno/ml-https');

  for (const entry of manifest.files) {
    const filePath = path.join(FIXTURES_ROOT, 'bruno-source', entry.file);
    const digest = createHash('sha256').update(readFileSync(filePath)).digest('hex');
    assert.equal(entry.sha256, digest, `${entry.file} sha256 mismatch`);
  }
});

test('parseProbeSelection enforces sessionCallBudget per invocation', () => {
  assert.deepEqual(parseProbeSelection('models,predictions'), ['models', 'predictions']);
  assert.throws(
    () => parseProbeSelection(ALL_PROBE_NAMES.join(',')),
    /sessionCallBudget/,
  );
  assert.throws(() => parseProbeSelection('unknown'), /unknown probe/i);
});

test('default probe selection stays within sessionCallBudget', () => {
  const selected = parseProbeSelection('');
  assert.ok(selected.length > 0);
  assert.ok(selected.length <= CIS_POC_LIMITS.sessionCallBudget);
});
