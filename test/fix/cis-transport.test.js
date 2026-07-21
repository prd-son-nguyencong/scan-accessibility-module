import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Agent } from 'undici';
import {
  assertAllowedCisBaseUrl,
  buildModelsRequestUrl,
  buildPredictionsEnvelope,
  buildPredictionsRequestUrl,
  createCisTransport,
  extractModelInventory,
  extractPredictionsContent,
  COMPOSITE_INVENTORY_ID_PATTERN,
  validateChatCompletionParams,
  validateListModelsTransportOptions,
} from '../../src/fix/cis/transport.js';
import { createCisTransportFromConfig, createCisTransportFromTrustedConfig } from '../../src/fix/cis/config.js';
import { CIS_MODEL_DISCOVERY_LIMITS, CIS_POC_LIMITS, CIS_VALIDATION_LIMITS } from '../../src/fix/cis/limits.js';
import { validateFixture } from '../helpers/cis-contract.js';
import {
  startCisTls12SelfSignedServer,
  startCisTlsTestServer,
  startCisTlsHostnameMismatchServer,
  TEST_CA_PEM,
} from './helpers/cis-tls-server.js';
import { insecureDevEnv, trustedCisTestEnv } from './helpers/cis-ca-fixture.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const predictionsFixture = validateFixture('requests/predictions-chat-completion.json');
const successFixture = validateFixture('responses/predictions-success.json');

/**
 * @param {number} targetBytes
 */
function buildBoundedDiscoveryJson(targetBytes) {
  const prefix = '{"data":[{"id":"model-a","p":"';
  const suffix = '"}]}';
  const padLen = targetBytes - Buffer.byteLength(prefix + suffix, 'utf8');
  if (padLen < 0) throw new Error('targetBytes too small for bounded discovery JSON scaffold');
  const body = `${prefix}${'x'.repeat(padLen)}${suffix}`;
  assert.equal(Buffer.byteLength(body, 'utf8'), targetBytes);
  return body;
}

/**
 * @param {Buffer} bodyBuffer
 */
function streamResponseFromBuffer(bodyBuffer, status = 200, contentType = 'application/json; charset=utf-8') {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Map([['content-type', contentType]]),
    body: {
      getReader() {
        let offset = 0;
        return {
          async read() {
            if (offset >= bodyBuffer.byteLength) return { done: true, value: undefined };
            const chunk = bodyBuffer.subarray(offset, Math.min(offset + 8192, bodyBuffer.byteLength));
            offset += chunk.byteLength;
            return { done: false, value: chunk };
          },
          async cancel() {},
        };
      },
    },
  };
}

test('buildPredictionsEnvelope matches Bruno-derived fixture', () => {
  const envelope = buildPredictionsEnvelope(
    predictionsFixture.request.target.provider,
    predictionsFixture.request.target.model,
    predictionsFixture.request.task.input.messages,
    predictionsFixture.request.task.input.max_completion_tokens,
  );
  assert.deepEqual(envelope.target, predictionsFixture.request.target);
  assert.equal(envelope.task.type, 'openai-chat-completion-v1');
  assert.deepEqual(envelope.task.input.messages, predictionsFixture.request.task.input.messages);
  assert.equal(
    envelope.task.input.max_completion_tokens,
    predictionsFixture.request.task.input.max_completion_tokens,
  );
});

test('buildPredictionsRequestUrl appends bypass_auth only with devBypassAuth', () => {
  const defaultUrl = buildPredictionsRequestUrl('https://127.0.0.1/ml/inference/cis/');
  assert.equal(defaultUrl.searchParams.get('bypass_auth'), null);

  const bypassUrl = buildPredictionsRequestUrl('https://127.0.0.1/ml/inference/cis/', { devBypassAuth: true });
  assert.equal(bypassUrl.searchParams.get('bypass_auth'), 'true');
  assert.equal(bypassUrl.search, '?bypass_auth=true');
});

test('buildPredictionsRequestUrl never enables PoC bypass authentication', () => {
  const url = buildPredictionsRequestUrl('https://127.0.0.1/ml/inference/cis/', { allowBypassAuth: true });
  assert.equal(url.searchParams.get('bypass_auth'), null);
});

test('buildModelsRequestUrl resolves v1alpha1/models without query or hash by default', () => {
  const url = buildModelsRequestUrl('https://cis.example.test/ml/inference/cis');
  assert.match(url.pathname, /\/v1alpha1\/models$/);
  assert.equal(url.search, '');
  assert.equal(url.hash, '');
  assert.equal(url.searchParams.has('bypass_auth'), false);
  assert.equal(url.searchParams.has('model'), false);
});

test('buildModelsRequestUrl appends bypass_auth only with devBypassAuth', () => {
  const bypassUrl = buildModelsRequestUrl('https://cis.example.test/ml/inference/cis', { devBypassAuth: true });
  assert.equal(bypassUrl.searchParams.get('bypass_auth'), 'true');
  assert.equal(bypassUrl.search, '?bypass_auth=true');

  const ignoredUrl = buildModelsRequestUrl('https://cis.example.test/ml/inference/cis', { allowBypassAuth: true });
  assert.equal(ignoredUrl.searchParams.get('bypass_auth'), null);
});

test('extractModelInventory accepts bounded unique model IDs and lexical-sorts', () => {
  assert.deepEqual(
    extractModelInventory({
      object: 'list',
      data: [
        { id: 'zeta.model' },
        { id: 'alpha.model' },
        { id: 'zeta.model' },
        'beta.model',
        { model: 'gamma.model' },
      ],
    }),
    ['alpha.model', 'beta.model', 'gamma.model', 'zeta.model'],
  );
});

test('extractModelInventory accepts live models envelope and data envelope', () => {
  const expected = ['alpha.model', 'beta.model'];
  assert.deepEqual(
    extractModelInventory({
      object: 'list',
      data: [{ id: 'alpha.model' }, { id: 'beta.model' }],
    }),
    expected,
  );
  assert.deepEqual(
    extractModelInventory({
      models: [{ model: 'alpha.model' }, { model: 'beta.model' }],
    }),
    expected,
  );
});

test('extractModelInventory skips composite registry rows and returns only canonical model IDs', () => {
  assert.deepEqual(
    extractModelInventory({
      models: [
        { model: 'anthropic.claude-sonnet-5' },
        { model: 'provider|variant-name' },
      ],
    }),
    ['anthropic.claude-sonnet-5'],
  );
  assert.equal(COMPOSITE_INVENTORY_ID_PATTERN.test('provider|variant-name'), true);
  assert.equal(COMPOSITE_INVENTORY_ID_PATTERN.test('anthropic.claude-sonnet-5'), false);
});

test('extractModelInventory still rejects non-composite invalid model IDs', () => {
  for (const id of [
    'model/with/slash',
    'bad\u0007model',
    '/v1alpha1/models',
  ]) {
    assert.throws(
      () => extractModelInventory({
        models: [
          { model: 'anthropic.claude-sonnet-5' },
          { model: 'provider|variant-name' },
          { model: id },
        ],
      }),
      (error) => error.code === 'TRANSPORT_INVALID_RESPONSE',
      id,
    );
  }
});

test('extractModelInventory rejects ambiguous or missing envelope arrays', () => {
  for (const body of [
    { data: [], models: [] },
    { data: [{ id: 'a' }], models: [{ model: 'b' }] },
    { object: 'list' },
    { data: null, models: null },
  ]) {
    assert.throws(
      () => extractModelInventory(body),
      (error) => error.code === 'TRANSPORT_INVALID_RESPONSE',
    );
  }
});

test('extractModelInventory rejects invalid body and data envelopes', () => {
  for (const body of [null, 'list', {}, { data: null }, { data: 'nope' }]) {
    assert.throws(
      () => extractModelInventory(body),
      (error) => error.code === 'TRANSPORT_INVALID_RESPONSE',
    );
  }
});

test('extractModelInventory rejects more than 4096 rows', () => {
  const data = Array.from({ length: 4097 }, (_value, index) => ({ id: `model-${index}` }));
  assert.throws(
    () => extractModelInventory({ data }),
    (error) => error.code === 'TRANSPORT_INVALID_RESPONSE',
  );
});

test('extractModelInventory accepts exactly 4096 valid rows', () => {
  const data = Array.from({ length: 4096 }, (_value, index) => ({
    id: `model-${String(index).padStart(4, '0')}`,
  }));
  const result = extractModelInventory({ data });
  assert.equal(result.length, 4096);
  assert.equal(result[0], 'model-0000');
  assert.equal(result[4095], 'model-4095');
});

test('extractModelInventory rejects invalid non-string and ambiguous rows', () => {
  assert.throws(
    () => extractModelInventory({ data: [{ id: 123 }] }),
    (error) => error.code === 'TRANSPORT_INVALID_RESPONSE',
  );
  assert.throws(
    () => extractModelInventory({ data: [{ id: 'model-a', model: 'model-b' }] }),
    (error) => error.code === 'TRANSPORT_INVALID_RESPONSE',
  );
  assert.throws(
    () => extractModelInventory({ data: [{}] }),
    (error) => error.code === 'TRANSPORT_INVALID_RESPONSE',
  );
});

test('extractModelInventory rejects IDs longer than 200 characters and path URL token-like values', () => {
  const tooLong = `a${'b'.repeat(200)}`;
  assert.throws(
    () => extractModelInventory({ data: [{ id: tooLong }] }),
    (error) => error.code === 'TRANSPORT_INVALID_RESPONSE',
  );
  for (const id of [
    '/v1alpha1/models',
    'https://cis.example.test/model',
    'Bearer sk-live-secret-token',
    'model/with/slash',
  ]) {
    assert.throws(
      () => extractModelInventory({ data: [{ id }] }),
      (error) => error.code === 'TRANSPORT_INVALID_RESPONSE',
      id,
    );
  }
});

test('extractPredictionsContent validates synthetic success envelope', () => {
  const { content, usage } = extractPredictionsContent(successFixture.response.body);
  assert.equal(typeof content, 'string');
  assert.equal(typeof usage?.prompt_tokens, 'number');
});

test('denies all hosts including loopback without explicit allowlist', () => {
  assert.throws(
    () => assertAllowedCisBaseUrl('https://127.0.0.1/ml/inference/cis', []),
    (error) => error.code === 'TRANSPORT_HOST_DENIED',
  );
  assert.throws(
    () => assertAllowedCisBaseUrl('https://evil.example.test/ml/inference/cis', []),
    (error) => error.code === 'TRANSPORT_HOST_DENIED',
  );
});

test('allows explicit allowlisted host over HTTPS', () => {
  assert.doesNotThrow(() =>
    assertAllowedCisBaseUrl('https://cis.example.test/ml/inference/cis', ['cis.example.test']),
  );
  assert.doesNotThrow(() =>
    assertAllowedCisBaseUrl('https://127.0.0.1/ml/inference/cis', ['127.0.0.1']),
  );
});

test('rejects base URL userinfo query and hash', () => {
  assert.throws(
    () => assertAllowedCisBaseUrl('https://user:pass@127.0.0.1/ml/inference/cis', ['127.0.0.1']),
    (error) => error.code === 'TRANSPORT_INSECURE_URL',
  );
  assert.throws(
    () => assertAllowedCisBaseUrl('https://127.0.0.1/ml/inference/cis?x=1', ['127.0.0.1']),
    (error) => error.code === 'TRANSPORT_INSECURE_URL',
  );
  assert.throws(
    () => assertAllowedCisBaseUrl('https://127.0.0.1/ml/inference/cis#frag', ['127.0.0.1']),
    (error) => error.code === 'TRANSPORT_INSECURE_URL',
  );
});

test('HTTP loopback requires explicit allowInsecureLoopback', () => {
  assert.throws(
    () => assertAllowedCisBaseUrl('http://127.0.0.1/ml/inference/cis', ['127.0.0.1'], false),
    (error) => error.code === 'TRANSPORT_INSECURE_URL',
  );
  assert.doesNotThrow(() =>
    assertAllowedCisBaseUrl('http://127.0.0.1/ml/inference/cis', ['127.0.0.1'], true),
  );
});

test('transport uses injected fetch with redirect error and no envelope in result', async () => {
  /** @type {{ url?: string, init?: RequestInit } | null} */
  let captured = null;
  const fetchImpl = async (url, init) => {
    captured = { url: String(url), init };
    return new Response(JSON.stringify(successFixture.response.body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const transport = createCisTransport({
    baseUrl: 'http://127.0.0.1:9/ml/inference/cis/',
    featureKey: 'feature-key-value-should-not-leak',
    allowedHosts: ['127.0.0.1'],
    allowInsecureLoopback: true,
    fetch: fetchImpl,
    timeoutMs: 500,
  });

  const result = await transport.chatCompletion({
    model: predictionsFixture.request.target.model,
    messages: [{ role: 'user', content: 'Reply with JSON action' }],
    maxCompletionTokens: 64,
  });

  assert.equal(captured?.init?.redirect, 'error');
  assert.equal(captured?.url.includes('bypass_auth=true'), false);
  assert.equal(JSON.parse(String(captured?.init?.body)).task.type, 'openai-chat-completion-v1');
  assert.equal(typeof result.content, 'string');
  assert.equal(Object.prototype.hasOwnProperty.call(result, 'envelope'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(result, 'messages'), false);
  assert.equal(JSON.stringify(result).includes('feature-key-value-should-not-leak'), false);
});

test('transport rejects non-json content-type on successful responses', async () => {
  const fetchImpl = async () => new Response('ok', {
    status: 200,
    headers: { 'content-type': 'text/plain' },
  });
  const transport = createCisTransport({
    baseUrl: 'http://127.0.0.1:9/ml/inference/cis/',
    featureKey: 'test-key',
    allowedHosts: ['127.0.0.1'],
    allowInsecureLoopback: true,
    fetch: fetchImpl,
  });
  await assert.rejects(
    () => transport.chatCompletion({
      model: 'test-model',
      messages: [{ role: 'user', content: 'hi' }],
    }),
    (error) => error.code === 'TRANSPORT_INVALID_RESPONSE',
  );
});

test('transport accepts exact application/json MIME with charset parameter', async () => {
  const fetchImpl = async () => new Response(JSON.stringify(successFixture.response.body), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
  const transport = createCisTransport({
    baseUrl: 'http://127.0.0.1:9/ml/inference/cis/',
    featureKey: 'test-key',
    allowedHosts: ['127.0.0.1'],
    allowInsecureLoopback: true,
    fetch: fetchImpl,
  });
  const result = await transport.chatCompletion({
    model: 'test-model',
    messages: [{ role: 'user', content: 'hi' }],
  });
  assert.equal(typeof result.content, 'string');
});

test('transport rejects non-exact JSON MIME aliases on successful responses', async () => {
  for (const contentType of ['application/ld+json', 'text/json', 'application/json-seq']) {
    const fetchImpl = async () => new Response('{"prediction":{}}', {
      status: 200,
      headers: { 'content-type': contentType },
    });
    const transport = createCisTransport({
      baseUrl: 'http://127.0.0.1:9/ml/inference/cis/',
      featureKey: 'test-key',
      allowedHosts: ['127.0.0.1'],
      allowInsecureLoopback: true,
      fetch: fetchImpl,
    });
    await assert.rejects(
      () => transport.chatCompletion({
        model: 'test-model',
        messages: [{ role: 'user', content: 'hi' }],
      }),
      (error) => error.code === 'TRANSPORT_INVALID_RESPONSE',
      contentType,
    );
  }
});

test('transport maps HTML HTTP errors to TRANSPORT_HTTP_ERROR without leaking body', async () => {
  const secretBody = '<html><body>cis-internal-sentinel.example.test unauthorized secret-token</body></html>';
  for (const [status, label] of [[401, '401'], [503, '503']]) {
    const fetchImpl = async () => new Response(secretBody, {
      status,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
    const transport = createCisTransport({
      baseUrl: 'http://127.0.0.1:9/ml/inference/cis/',
      featureKey: 'test-key',
      allowedHosts: ['127.0.0.1'],
      allowInsecureLoopback: true,
      fetch: fetchImpl,
    });
    await assert.rejects(
      () => transport.listModels(),
      (error) => error.code === 'TRANSPORT_HTTP_ERROR'
        && error.message === 'CIS model inventory request failed.'
        && error.message.includes('cis-internal-sentinel.example.test') === false
        && error.message.includes('secret-token') === false
        && error.meta?.status === status,
      label,
    );
  }
});

test('transport maps malformed JSON HTTP errors to TRANSPORT_HTTP_ERROR without parsing body', async () => {
  const fetchImpl = async () => new Response('{"error":"cis-internal-sentinel.example.test down"', {
    status: 503,
    headers: { 'content-type': 'application/json' },
  });
  const transport = createCisTransport({
    baseUrl: 'http://127.0.0.1:9/ml/inference/cis/',
    featureKey: 'test-key',
    allowedHosts: ['127.0.0.1'],
    allowInsecureLoopback: true,
    fetch: fetchImpl,
  });
  await assert.rejects(
    () => transport.listModels(),
    (error) => error.code === 'TRANSPORT_HTTP_ERROR'
      && error.message === 'CIS model inventory request failed.'
      && error.message.includes('cis-internal-sentinel.example.test') === false,
  );
});

test('transport rejects oversized responses and cancels reader', async () => {
  const chunks = ['{"prediction":{"type":"openai-chat-completion-v1","output":{"choices":[{"message":{"content":"x"}}]}}}'];
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    headers: new Map([['content-type', 'application/json']]),
    body: {
      getReader() {
        let sent = false;
        return {
          async read() {
            if (sent) return { done: true, value: undefined };
            sent = true;
            return { done: false, value: Buffer.from(chunks[0].repeat(500)) };
          },
          async cancel() {},
        };
      },
    },
  });
  const transport = createCisTransport({
    baseUrl: 'http://127.0.0.1:9/ml/inference/cis/',
    featureKey: 'test-key',
    allowedHosts: ['127.0.0.1'],
    allowInsecureLoopback: true,
    fetch: fetchImpl,
    maxResponseBytes: 256,
  });
  await assert.rejects(
    () => transport.chatCompletion({
      model: 'test-model',
      messages: [{ role: 'user', content: 'hi' }],
    }),
    (error) => error.code === 'TRANSPORT_RESPONSE_TOO_LARGE',
  );
});

test('validateListModelsTransportOptions rejects invalid timeoutMs and modelInventoryMaxResponseBytes', () => {
  for (const timeoutMs of [0, -1, 1.5, CIS_POC_LIMITS.requestTimeoutMs + 1]) {
    assert.throws(
      () => validateListModelsTransportOptions({ timeoutMs }),
      (error) => error.code === 'TRANSPORT_INVALID_REQUEST',
    );
  }
  for (const modelInventoryMaxResponseBytes of [0, -1, 1.5, CIS_MODEL_DISCOVERY_LIMITS.maxResponseBytes + 1]) {
    assert.throws(
      () => validateListModelsTransportOptions({ modelInventoryMaxResponseBytes }),
      (error) => error.code === 'TRANSPORT_INVALID_REQUEST',
    );
  }
});

test('listModels rejects invalid transport options before fetching', async () => {
  let fetchCalls = 0;
  const fetchImpl = async () => {
    fetchCalls += 1;
    return new Response(JSON.stringify({ data: [{ id: 'test-model' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const overMaxBytes = createCisTransport({
    baseUrl: 'http://127.0.0.1:9/ml/inference/cis/',
    featureKey: 'test-key',
    allowedHosts: ['127.0.0.1'],
    allowInsecureLoopback: true,
    fetch: fetchImpl,
    modelInventoryMaxResponseBytes: CIS_MODEL_DISCOVERY_LIMITS.maxResponseBytes + 1,
  });
  await assert.rejects(
    () => overMaxBytes.listModels(),
    (error) => error.code === 'TRANSPORT_INVALID_REQUEST',
  );

  const badTimeout = createCisTransport({
    baseUrl: 'http://127.0.0.1:9/ml/inference/cis/',
    featureKey: 'test-key',
    allowedHosts: ['127.0.0.1'],
    allowInsecureLoopback: true,
    fetch: fetchImpl,
    timeoutMs: CIS_POC_LIMITS.requestTimeoutMs + 1,
  });
  await assert.rejects(
    () => badTimeout.listModels(),
    (error) => error.code === 'TRANSPORT_INVALID_REQUEST',
  );

  assert.equal(fetchCalls, 0);
});

test('validateChatCompletionParams enforces roles content and token bounds', () => {
  assert.throws(
    () => validateChatCompletionParams({
      model: 'test-model',
      messages: [{ role: 'tool', content: 'nope' }],
    }),
    (error) => error.code === 'TRANSPORT_INVALID_REQUEST',
  );
  assert.throws(
    () => validateChatCompletionParams({
      model: 'test-model',
      messages: [{ role: 'user', content: 'hi' }],
      maxCompletionTokens: 999_999,
    }),
    (error) => error.code === 'TRANSPORT_INVALID_REQUEST',
  );
});

test('validateChatCompletionParams rejects model IDs outside canonical pattern', () => {
  for (const model of [
    'model/with/slash',
    'provider|variant-name',
    'bad\u0007model',
  ]) {
    assert.throws(
      () => validateChatCompletionParams({
        model,
        messages: [{ role: 'user', content: 'hi' }],
      }),
      (error) => error.code === 'TRANSPORT_INVALID_REQUEST',
      model,
    );
  }
  assert.doesNotThrow(() => validateChatCompletionParams({
    model: 'anthropic.claude-sonnet-5',
    messages: [{ role: 'user', content: 'hi' }],
  }));
});

test('transport distinguishes external cancellation from timeout', async () => {
  const controller = new AbortController();
  const fetchImpl = async (_url, init) => new Promise((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
  });
  const transport = createCisTransport({
    baseUrl: 'http://127.0.0.1:9/ml/inference/cis/',
    featureKey: 'test-key',
    allowedHosts: ['127.0.0.1'],
    allowInsecureLoopback: true,
    fetch: fetchImpl,
    timeoutMs: 30_000,
  });

  const pending = transport.chatCompletion({
    model: 'test-model',
    messages: [{ role: 'user', content: 'hi' }],
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(
    pending,
    (error) => error.code === 'TRANSPORT_CANCELLED',
  );
});

test('transport exposes transportSecurity label without TLS internals', () => {
  const transport = createCisTransport({
    baseUrl: 'http://127.0.0.1:9/ml/inference/cis/',
    featureKey: 'test-key',
    allowedHosts: ['127.0.0.1'],
    allowInsecureLoopback: true,
    fetch: async () => new Response('{}'),
    transportSecurity: 'insecure-dev',
  });
  assert.equal(transport.transportSecurity, 'insecure-dev');
  assert.equal(Object.prototype.hasOwnProperty.call(transport, 'dispatcher'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(transport, 'caPem'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(transport, 'rejectUnauthorized'), false);
});

test('transport listModels uses discovery byte limit while chatCompletion keeps prediction limit', async () => {
  const padLen = CIS_VALIDATION_LIMITS.maxResponseBytes + 100;
  const discoveryBody = `{"data":[{"id":"model-a","p":"${'x'.repeat(padLen)}"}]}`;
  assert.ok(Buffer.byteLength(discoveryBody, 'utf8') > CIS_VALIDATION_LIMITS.maxResponseBytes);
  assert.ok(Buffer.byteLength(discoveryBody, 'utf8') < CIS_MODEL_DISCOVERY_LIMITS.maxResponseBytes);

  const fetchImpl = async (url) => {
    const isModels = String(url).includes('/v1alpha1/models');
    const body = isModels
      ? discoveryBody
      : `${' '.repeat(CIS_VALIDATION_LIMITS.maxResponseBytes + 1)}`;
    return {
      ok: true,
      status: 200,
      headers: new Map([['content-type', 'application/json']]),
      body: {
        getReader() {
          let sent = false;
          return {
            async read() {
              if (sent) return { done: true, value: undefined };
              sent = true;
              return { done: false, value: Buffer.from(body) };
            },
            async cancel() {},
          };
        },
      },
    };
  };

  const transport = createCisTransport({
    baseUrl: 'http://127.0.0.1:9/ml/inference/cis/',
    featureKey: 'test-key',
    allowedHosts: ['127.0.0.1'],
    allowInsecureLoopback: true,
    fetch: fetchImpl,
  });

  const inventory = await transport.listModels();
  assert.deepEqual(inventory, { models: ['model-a'] });

  await assert.rejects(
    () => transport.chatCompletion({
      model: 'test-model',
      messages: [{ role: 'user', content: 'hi' }],
    }),
    (error) => error.code === 'TRANSPORT_RESPONSE_TOO_LARGE',
  );
});

test('transport module source does not embed fixture secrets', () => {
  const source = readFileSync(path.join(__dirname, '../../src/fix/cis/transport.js'), 'utf8');
  assert.equal(source.includes('feature-key-value-should-not-leak'), false);
});

test('transport appends bypass_auth when devBypassAuth is enabled', async () => {
  /** @type {string | undefined} */
  let capturedUrl;
  const fetchImpl = async (url) => {
    capturedUrl = String(url);
    return new Response(JSON.stringify({ data: [{ id: 'test-model' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const transport = createCisTransport({
    baseUrl: 'http://127.0.0.1:9/ml/inference/cis/',
    featureKey: 'test-key',
    allowedHosts: ['127.0.0.1'],
    allowInsecureLoopback: true,
    fetch: fetchImpl,
    devBypassAuth: true,
  });
  await transport.listModels();
  assert.match(capturedUrl, /bypass_auth=true/);
});

test('production CIS source does not reference NODE_TLS_REJECT_UNAUTHORIZED', () => {
  const srcRoot = path.join(__dirname, '../../src/fix/cis');
  for (const file of ['config.js', 'transport.js', 'tls-mode.js', 'ca.js']) {
    const source = readFileSync(path.join(srcRoot, file), 'utf8');
    assert.equal(source.includes('NODE_TLS_REJECT_UNAUTHORIZED'), false, file);
  }
});

test('verified TLS transport succeeds with trusted CA dispatcher', async () => {
  const fixture = await startCisTlsTestServer(successFixture.response.body);
  const dispatcher = new Agent({
    connect: { ca: TEST_CA_PEM, rejectUnauthorized: true },
  });
  try {
    const transport = createCisTransport({
      baseUrl: fixture.baseUrl,
      featureKey: 'test-key',
      allowedHosts: ['localhost'],
      dispatcher,
    });
    const result = await transport.chatCompletion({
      model: predictionsFixture.request.target.model,
      messages: [{ role: 'user', content: 'Return valid JSON.' }],
    });
    assert.equal(result.status, 200);
    assert.equal(typeof result.content, 'string');
  } finally {
    await dispatcher.close();
    await fixture.close();
  }
});

test('transport without trusted dispatcher fails with TRANSPORT_TLS_ERROR', async () => {
  const fixture = await startCisTlsTestServer(successFixture.response.body);
  try {
    const transport = createCisTransport({
      baseUrl: fixture.baseUrl,
      featureKey: 'test-key',
      allowedHosts: ['localhost'],
    });
    await assert.rejects(
      () => transport.chatCompletion({
        model: 'test-model',
        messages: [{ role: 'user', content: 'Return valid JSON.' }],
      }),
      (error) => error.code === 'TRANSPORT_TLS_ERROR'
        && error.message === 'CIS TLS verification failed.',
    );
  } finally {
    await fixture.close();
  }
});

test('transport rejects hostname mismatch with TRANSPORT_TLS_ERROR', async () => {
  const fixture = await startCisTlsHostnameMismatchServer(successFixture.response.body);
  const dispatcher = new Agent({
    connect: { ca: TEST_CA_PEM, rejectUnauthorized: true },
  });
  try {
    const transport = createCisTransport({
      baseUrl: fixture.baseUrlIp,
      featureKey: 'test-key',
      allowedHosts: ['127.0.0.1'],
      dispatcher,
    });
    await assert.rejects(
      () => transport.chatCompletion({
        model: 'test-model',
        messages: [{ role: 'user', content: 'Return valid JSON.' }],
      }),
      (error) => error.code === 'TRANSPORT_TLS_ERROR'
        && error.message === 'CIS TLS verification failed.',
    );
  } finally {
    await dispatcher.close();
    await fixture.close();
    fixture.cleanup();
  }
});

test('createCisTransportFromTrustedConfig builds owned dispatcher and close is idempotent', async () => {
  const fixture = await startCisTlsTestServer(successFixture.response.body);
  const config = {
    ok: true,
    baseUrl: fixture.baseUrl,
    featureKey: 'test-key',
    provider: 'aws',
    model: 'test-model',
    allowedHosts: ['localhost'],
    allowInsecureLoopback: true,
    caPem: TEST_CA_PEM,
    caSha256: trustedCisTestEnv().CIS_CA_SHA256,
    caBundlePath: trustedCisTestEnv().CIS_CA_BUNDLE_PATH,
  };
  try {
    const bundle = createCisTransportFromTrustedConfig(config);
    const transport = await bundle.importTransport();
    assert.equal(typeof transport.close, 'function');
    const result = await transport.chatCompletion({
      model: 'test-model',
      messages: [{ role: 'user', content: 'Return valid JSON.' }],
    });
    assert.equal(result.status, 200);
    await transport.close();
    await transport.close();
  } finally {
    await fixture.close();
  }
});

test('transport close does not close caller-owned dispatcher', async () => {
  const dispatcher = new Agent({ connect: { ca: TEST_CA_PEM, rejectUnauthorized: true } });
  const transport = createCisTransport({
    baseUrl: 'https://localhost:9/ml/inference/cis',
    featureKey: 'test-key',
    allowedHosts: ['localhost'],
    dispatcher,
  });
  await transport.close();
  await dispatcher.close();
});

test('transport close retries after owned dispatcher close failure', async () => {
  let attempts = 0;
  const dispatcher = {
    async close() {
      attempts += 1;
      if (attempts === 1) throw new Error('dispatcher close failed');
    },
  };
  const transport = createCisTransport({
    baseUrl: 'http://127.0.0.1:9/ml/inference/cis/',
    featureKey: 'test-key',
    allowedHosts: ['127.0.0.1'],
    allowInsecureLoopback: true,
    fetch: async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
    dispatcher,
    ownsDispatcher: true,
  });

  await assert.rejects(
    () => transport.close(),
    (error) => error.message === 'dispatcher close failed',
  );
  await transport.close();
  assert.equal(attempts, 2);
});

test('transport close shares one in-flight close across concurrent callers', async () => {
  let closeCalls = 0;
  /** @type {(() => void) | null} */
  let releaseClose = null;
  const dispatcher = {
    close() {
      closeCalls += 1;
      return new Promise((resolve) => {
        releaseClose = resolve;
      });
    },
  };
  const transport = createCisTransport({
    baseUrl: 'http://127.0.0.1:9/ml/inference/cis/',
    featureKey: 'test-key',
    allowedHosts: ['127.0.0.1'],
    allowInsecureLoopback: true,
    fetch: async () => new Response('{}'),
    dispatcher,
    ownsDispatcher: true,
  });

  const first = transport.close();
  const second = transport.close();
  assert.equal(closeCalls, 1);
  releaseClose?.();
  await Promise.all([first, second]);

  closeCalls = 0;
  await transport.close();
  assert.equal(closeCalls, 0);
});

test('transport listModels uses GET without body and returns only model IDs', async () => {
  /** @type {{ url?: string, init?: RequestInit } | null} */
  let captured = null;
  const inventory = {
    object: 'list',
    data: [
      { id: 'anthropic.claude-sonnet-5', owned_by: 'aws' },
      { id: 'anthropic.claude-opus-4-8', extra: 'ignored' },
    ],
  };
  const fetchImpl = async (url, init) => {
    captured = { url: String(url), init };
    return new Response(JSON.stringify(inventory), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const transport = createCisTransport({
    baseUrl: 'http://127.0.0.1:9/ml/inference/cis/',
    featureKey: 'feature-key-value-should-not-leak',
    allowedHosts: ['127.0.0.1'],
    allowInsecureLoopback: true,
    fetch: fetchImpl,
  });

  const result = await transport.listModels();
  assert.equal(captured?.init?.method, 'GET');
  assert.equal(captured?.init?.body, undefined);
  assert.equal(captured?.init?.redirect, 'error');
  assert.equal(captured?.init?.headers?.['Wd-PCA-Feature-Key'], 'feature-key-value-should-not-leak');
  assert.match(String(captured?.url), /\/v1alpha1\/models$/);
  assert.equal(String(captured?.url).includes('bypass_auth'), false);
  assert.deepEqual(result, {
    models: ['anthropic.claude-opus-4-8', 'anthropic.claude-sonnet-5'],
  });
  assert.equal(JSON.stringify(result).includes('feature-key-value-should-not-leak'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(result, 'headers'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(result, 'rawBody'), false);
});

test('transport listModels forwards injected dispatcher to fetch init', async () => {
  /** @type {unknown} */
  let capturedDispatcher = null;
  const dispatcher = { id: 'list-models-dispatcher' };
  const fetchImpl = async (_url, init) => {
    capturedDispatcher = init.dispatcher;
    return new Response(JSON.stringify({ data: [{ id: 'test-model' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const transport = createCisTransport({
    baseUrl: 'http://127.0.0.1:9/ml/inference/cis/',
    featureKey: 'test-key',
    allowedHosts: ['127.0.0.1'],
    allowInsecureLoopback: true,
    fetch: fetchImpl,
    dispatcher,
  });
  await transport.listModels();
  assert.equal(capturedDispatcher, dispatcher);
});

test('transport listModels accepts discovery response at exact 4 MiB boundary', async () => {
  const body = buildBoundedDiscoveryJson(CIS_MODEL_DISCOVERY_LIMITS.maxResponseBytes);
  const fetchImpl = async () => streamResponseFromBuffer(Buffer.from(body, 'utf8'));
  const transport = createCisTransport({
    baseUrl: 'http://127.0.0.1:9/ml/inference/cis/',
    featureKey: 'test-key',
    allowedHosts: ['127.0.0.1'],
    allowInsecureLoopback: true,
    fetch: fetchImpl,
  });
  const result = await transport.listModels();
  assert.deepEqual(result, { models: ['model-a'] });
});

test('transport listModels rejects discovery response at 4 MiB plus one byte', async () => {
  const body = buildBoundedDiscoveryJson(CIS_MODEL_DISCOVERY_LIMITS.maxResponseBytes + 1);
  const fetchImpl = async () => streamResponseFromBuffer(Buffer.from(body, 'utf8'));
  const transport = createCisTransport({
    baseUrl: 'http://127.0.0.1:9/ml/inference/cis/',
    featureKey: 'test-key',
    allowedHosts: ['127.0.0.1'],
    allowInsecureLoopback: true,
    fetch: fetchImpl,
  });
  await assert.rejects(
    () => transport.listModels(),
    (error) => error.code === 'TRANSPORT_RESPONSE_TOO_LARGE',
  );
});

test('transport listModels rejects non-json content-type on successful responses', async () => {
  const fetchImpl = async () => new Response('ok', {
    status: 200,
    headers: { 'content-type': 'text/plain' },
  });
  const transport = createCisTransport({
    baseUrl: 'http://127.0.0.1:9/ml/inference/cis/',
    featureKey: 'test-key',
    allowedHosts: ['127.0.0.1'],
    allowInsecureLoopback: true,
    fetch: fetchImpl,
  });
  await assert.rejects(
    () => transport.listModels(),
    (error) => error.code === 'TRANSPORT_INVALID_RESPONSE',
  );
});

test('transport listModels distinguishes external cancellation from timeout', async () => {
  const controller = new AbortController();
  const fetchImpl = async (_url, init) => new Promise((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
  });
  const transport = createCisTransport({
    baseUrl: 'http://127.0.0.1:9/ml/inference/cis/',
    featureKey: 'test-key',
    allowedHosts: ['127.0.0.1'],
    allowInsecureLoopback: true,
    fetch: fetchImpl,
    timeoutMs: 30_000,
  });

  const pending = transport.listModels({ signal: controller.signal });
  controller.abort();
  await assert.rejects(
    pending,
    (error) => error.code === 'TRANSPORT_CANCELLED'
      && error.message === 'CIS model inventory request was cancelled.',
  );
});

test('transport listModels times out with TRANSPORT_TIMEOUT', async () => {
  const fetchImpl = async (_url, init) => new Promise((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
  });
  const transport = createCisTransport({
    baseUrl: 'http://127.0.0.1:9/ml/inference/cis/',
    featureKey: 'test-key',
    allowedHosts: ['127.0.0.1'],
    allowInsecureLoopback: true,
    fetch: fetchImpl,
    timeoutMs: 25,
  });
  await assert.rejects(
    () => transport.listModels(),
    (error) => error.code === 'TRANSPORT_TIMEOUT'
      && error.message === 'CIS model inventory request timed out.',
  );
});

test('transport listModels maps HTTP errors to stable TRANSPORT_HTTP_ERROR', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({
    error: 'internal-host cis-internal-sentinel.example.test unavailable',
  }), {
    status: 503,
    headers: { 'content-type': 'application/json' },
  });
  const transport = createCisTransport({
    baseUrl: 'http://127.0.0.1:9/ml/inference/cis/',
    featureKey: 'test-key',
    allowedHosts: ['127.0.0.1'],
    allowInsecureLoopback: true,
    fetch: fetchImpl,
  });
  await assert.rejects(
    () => transport.listModels(),
    (error) => error.code === 'TRANSPORT_HTTP_ERROR'
      && error.message === 'CIS model inventory request failed.'
      && error.message.includes('cis-internal-sentinel.example.test') === false,
  );
});

test('transport listModels maps network failures to stable TRANSPORT_NETWORK_ERROR', async () => {
  const fetchImpl = async () => {
    throw new TypeError('fetch failed for https://cis-internal-sentinel.example.test');
  };
  const transport = createCisTransport({
    baseUrl: 'http://127.0.0.1:9/ml/inference/cis/',
    featureKey: 'test-key',
    allowedHosts: ['127.0.0.1'],
    allowInsecureLoopback: true,
    fetch: fetchImpl,
  });
  await assert.rejects(
    () => transport.listModels(),
    (error) => error.code === 'TRANSPORT_NETWORK_ERROR'
      && error.message === 'CIS model inventory request failed.'
      && error.message.includes('cis-internal-sentinel.example.test') === false,
  );
});

test('transport listModels rejects oversized responses and cancels reader', async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    headers: new Map([['content-type', 'application/json']]),
    body: {
      getReader() {
        let sent = false;
        return {
          async read() {
            if (sent) return { done: true, value: undefined };
            sent = true;
            return {
              done: false,
              value: Buffer.from(`{"data":[${'"model-x",'.repeat(500)}]}`),
            };
          },
          async cancel() {},
        };
      },
    },
  });
  const transport = createCisTransport({
    baseUrl: 'http://127.0.0.1:9/ml/inference/cis/',
    featureKey: 'test-key',
    allowedHosts: ['127.0.0.1'],
    allowInsecureLoopback: true,
    fetch: fetchImpl,
    modelInventoryMaxResponseBytes: 256,
  });
  await assert.rejects(
    () => transport.listModels(),
    (error) => error.code === 'TRANSPORT_RESPONSE_TOO_LARGE'
      && error.message === 'CIS response exceeds maxResponseBytes.',
  );
});

test('transport forwards injected dispatcher to fetch init', async () => {
  /** @type {unknown} */
  let capturedDispatcher = null;
  const dispatcher = {};
  const fetchImpl = async (_url, init) => {
    capturedDispatcher = init.dispatcher;
    return new Response(JSON.stringify(successFixture.response.body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const transport = createCisTransport({
    baseUrl: 'http://127.0.0.1:9/ml/inference/cis/',
    featureKey: 'test-key',
    allowedHosts: ['127.0.0.1'],
    allowInsecureLoopback: true,
    fetch: fetchImpl,
    dispatcher,
  });
  await transport.chatCompletion({
    model: 'test-model',
    messages: [{ role: 'user', content: 'hi' }],
  });
  assert.equal(capturedDispatcher, dispatcher);
});

test('createCisTransportFromTrustedConfig rejects insecure-dev, missing CA, and devBypassAuth', () => {
  assert.equal(createCisTransportFromTrustedConfig({
    ok: true,
    transportSecurity: 'insecure-dev',
    baseUrl: 'https://cis.example.test/ml/inference/cis',
    featureKey: 'key',
    model: 'm',
    provider: 'aws',
    allowedHosts: ['cis.example.test'],
  }), null);

  assert.equal(createCisTransportFromTrustedConfig({
    ok: true,
    transportSecurity: 'trusted',
    baseUrl: 'https://127.0.0.1/ml/inference/cis',
    featureKey: 'key',
    model: 'm',
    provider: 'aws',
    allowedHosts: ['127.0.0.1'],
  }), null);

  assert.equal(createCisTransportFromTrustedConfig({
    ok: true,
    transportSecurity: 'trusted',
    devBypassAuth: true,
    baseUrl: 'https://127.0.0.1/ml/inference/cis',
    featureKey: 'key',
    model: 'm',
    provider: 'aws',
    allowedHosts: ['127.0.0.1'],
    caPem: TEST_CA_PEM,
  }), null);

  assert.equal(createCisTransportFromConfig({
    ok: true,
    transportSecurity: 'trusted',
    devBypassAuth: true,
    baseUrl: 'https://127.0.0.1/ml/inference/cis',
    featureKey: 'key',
    model: 'm',
    provider: 'aws',
    allowedHosts: ['127.0.0.1'],
    caPem: TEST_CA_PEM,
  }), null);
});

test('trusted transport wrapper never emits bypass_auth query params', async () => {
  /** @type {string | undefined} */
  let capturedUrl;
  const fetchImpl = async (url) => {
    capturedUrl = String(url);
    return new Response(JSON.stringify({ data: [{ id: 'test-model' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const config = {
    ok: true,
    baseUrl: 'http://127.0.0.1:9/ml/inference/cis/',
    featureKey: 'test-key',
    model: 'test-model',
    provider: 'aws',
    allowedHosts: ['127.0.0.1'],
    allowInsecureLoopback: true,
    transportSecurity: 'trusted',
    devBypassAuth: true,
    caPem: TEST_CA_PEM,
  };
  const bundle = createCisTransportFromTrustedConfig(config);
  assert.equal(bundle, null);

  const safeConfig = { ...config, devBypassAuth: false };
  const safeBundle = createCisTransportFromTrustedConfig(safeConfig);
  const transport = createCisTransport({
    baseUrl: safeConfig.baseUrl,
    featureKey: safeConfig.featureKey,
    allowedHosts: safeConfig.allowedHosts,
    allowInsecureLoopback: true,
    fetch: fetchImpl,
    transportSecurity: 'trusted',
    devBypassAuth: false,
  });
  await transport.listModels();
  assert.equal(capturedUrl?.includes('bypass_auth'), false);
  assert.equal(safeBundle !== null, true);
});

test('guarded insecure-dev config lists models over TLS 1.2 self-signed server and closes dispatcher', async () => {
  const modelsBody = {
    models: [
      { model: 'anthropic.claude-sonnet-5' },
      { model: 'anthropic.claude-opus-4-8' },
    ],
  };
  const fixture = await startCisTls12SelfSignedServer(successFixture.response.body, {
    hostname: 'localhost',
    modelsBody,
  });
  const config = {
    ok: true,
    baseUrl: `https://localhost:${fixture.port}/ml/inference/cis`,
    featureKey: 'test-feature-key',
    model: 'anthropic.claude-sonnet-5',
    provider: 'aws',
    allowedHosts: ['localhost'],
    allowInsecureLoopback: true,
    transportSecurity: 'insecure-dev',
    devBypassAuth: true,
  };
  try {
    const bundle = createCisTransportFromConfig(config);
    const transport = await bundle.importTransport();
    assert.equal(transport.transportSecurity, 'insecure-dev');
    const result = await transport.listModels();
    assert.deepEqual(result, {
      models: ['anthropic.claude-opus-4-8', 'anthropic.claude-sonnet-5'],
    });
    await transport.close();
    await transport.close();
  } finally {
    await fixture.close();
    fixture.cleanup();
  }
});

test('trusted transport without matching CA fails against self-signed TLS 1.2 server', async () => {
  const fixture = await startCisTls12SelfSignedServer(successFixture.response.body, {
    hostname: 'localhost',
  });
  const config = {
    ok: true,
    baseUrl: `https://localhost:${fixture.port}/ml/inference/cis`,
    featureKey: 'test-key',
    model: 'test-model',
    provider: 'aws',
    allowedHosts: ['localhost'],
    allowInsecureLoopback: true,
    transportSecurity: 'trusted',
    devBypassAuth: false,
    caPem: TEST_CA_PEM,
  };
  try {
    const bundle = createCisTransportFromConfig(config);
    const transport = await bundle.importTransport();
    assert.equal(transport.transportSecurity, 'trusted');
    await assert.rejects(
      () => transport.listModels(),
      (error) => error.code === 'TRANSPORT_TLS_ERROR'
        && error.message === 'CIS TLS verification failed.',
    );
    await transport.close();
  } finally {
    await fixture.close();
    fixture.cleanup();
  }
});
