import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertBundleRedacted } from '../../scripts/lib/cis-redaction.js';
import { CisTransportError } from '../../src/fix/cis/transport.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = path.join(__dirname, '../../scripts/cis-models.js');

const SENTINEL_ENDPOINT = 'https://cis-internal-sentinel.example.test:8443/ml/inference/cis';
const SENTINEL_TOKEN = 'super-secret-feature-key-sentinel-value';
const SENTINEL_CA_PATH = '/tmp/secret-ca-bundle-sentinel.pem';

function discoveryConfig() {
  return {
    ok: true,
    baseUrl: SENTINEL_ENDPOINT,
    featureKey: SENTINEL_TOKEN,
    model: '',
    provider: 'aws',
    allowedHosts: ['cis-internal-sentinel.example.test'],
    allowInsecureLoopback: false,
    caPem: '-----BEGIN CERTIFICATE-----\nSENTINEL-CA-BYTES\n-----END CERTIFICATE-----\n',
    caSha256: `sha256:${'a'.repeat(64)}`,
    caBundlePath: SENTINEL_CA_PATH,
  };
}

test('cis-models script is import-safe and loads host env via config module', async () => {
  const source = readFileSync(SCRIPT_PATH, 'utf8');
  assert.match(source, /['"]\.\.\/src\/utils\/config\.js['"]/);
  assert.match(source, /resolveTrustedCisConfig/);
  assert.match(source, /requireModel:\s*false/);
  assert.match(source, /createCisTransportFromTrustedConfig/);
  assert.match(source, /runCisModelsCli/);
  assert.match(source, /listModels/);
  assert.match(source, /isMain/);
  assert.match(source, /redactTransportErrorMessage/);
  assertBundleRedacted(source, SCRIPT_PATH);
});

test('cis-models main exits with stable code on missing config without leaking secrets', async () => {
  const { runCisModelsCli } = await import('../../scripts/cis-models.js');
  const stderr = [];
  const code = await runCisModelsCli({
    env: {},
    stdoutWrite: () => {},
    stderrWrite: (chunk) => {
      stderr.push(String(chunk));
    },
  });
  assert.notEqual(code, 0);
  const output = stderr.join('');
  assert.match(output, /CIS_CONFIG_MISSING/);
  assert.equal(output.includes('127.0.0.1'), false);
  assert.equal(output.includes('Wd-PCA-Feature-Key'), false);
});

test('runCisModelsCli success prints one JSON object with models only and closes transport', async () => {
  const { runCisModelsCli } = await import('../../scripts/cis-models.js');
  let closed = false;
  const stdout = [];
  const stderr = [];

  const code = await runCisModelsCli({
    env: {},
    resolveConfig: () => discoveryConfig(),
    createTransportBundle: () => ({
      async importTransport() {
        return {
          async listModels() {
            return { models: ['anthropic.claude-sonnet-5', 'anthropic.claude-opus-4-8'] };
          },
          async close() {
            closed = true;
          },
        };
      },
    }),
    stdoutWrite: (chunk) => {
      stdout.push(String(chunk));
    },
    stderrWrite: (chunk) => {
      stderr.push(String(chunk));
    },
  });

  assert.equal(code, 0);
  assert.equal(closed, true);
  assert.equal(stderr.join(''), '');
  assert.deepEqual(JSON.parse(stdout.join('').trim()), {
    models: ['anthropic.claude-sonnet-5', 'anthropic.claude-opus-4-8'],
  });
  assert.deepEqual(Object.keys(JSON.parse(stdout.join('').trim())), ['models']);
});

test('runCisModelsCli failure prints stable sanitized code and closes transport without sentinels', async () => {
  const { runCisModelsCli } = await import('../../scripts/cis-models.js');
  let closed = false;
  const stdout = [];
  const stderr = [];

  const code = await runCisModelsCli({
    env: {},
    resolveConfig: () => discoveryConfig(),
    createTransportBundle: () => ({
      async importTransport() {
        return {
          async listModels() {
            throw new CisTransportError('TRANSPORT_HTTP_ERROR', 'CIS model inventory request failed.');
          },
          async close() {
            closed = true;
          },
        };
      },
    }),
    stdoutWrite: (chunk) => {
      stdout.push(String(chunk));
    },
    stderrWrite: (chunk) => {
      stderr.push(String(chunk));
    },
  });

  assert.notEqual(code, 0);
  assert.equal(closed, true);
  assert.equal(stdout.join(''), '');
  const output = stderr.join('');
  assert.match(output, /TRANSPORT_HTTP_ERROR: CIS model inventory request failed\./);
  assert.equal(output.includes(SENTINEL_ENDPOINT), false);
  assert.equal(output.includes(SENTINEL_TOKEN), false);
  assert.equal(output.includes(SENTINEL_CA_PATH), false);
  assert.equal(output.includes('SENTINEL-CA-BYTES'), false);
});
