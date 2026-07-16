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
  validateChatCompletionParams,
} from '../../src/fix/cis/transport.js';
import { createCisTransportFromTrustedConfig } from '../../src/fix/cis/config.js';
import { validateFixture } from '../helpers/cis-contract.js';
import { startCisTlsTestServer, startCisTlsHostnameMismatchServer, TEST_CA_PEM } from './helpers/cis-tls-server.js';
import { trustedCisTestEnv } from './helpers/cis-ca-fixture.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const predictionsFixture = validateFixture('requests/predictions-chat-completion.json');
const successFixture = validateFixture('responses/predictions-success.json');

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

test('buildPredictionsRequestUrl omits bypass_auth by default', () => {
  const url = buildPredictionsRequestUrl('https://127.0.0.1/ml/inference/cis/');
  assert.match(url.pathname, /\/v1alpha1\/predictions$/);
  assert.equal(url.searchParams.get('bypass_auth'), null);
});

test('buildPredictionsRequestUrl never enables PoC bypass authentication', () => {
  const url = buildPredictionsRequestUrl('https://127.0.0.1/ml/inference/cis/', { allowBypassAuth: true });
  assert.equal(url.searchParams.get('bypass_auth'), null);
});

test('buildModelsRequestUrl resolves v1alpha1/models without query or hash', () => {
  const url = buildModelsRequestUrl('https://cis.example.test/ml/inference/cis');
  assert.match(url.pathname, /\/v1alpha1\/models$/);
  assert.equal(url.search, '');
  assert.equal(url.hash, '');
  assert.equal(url.searchParams.has('bypass_auth'), false);
  assert.equal(url.searchParams.has('model'), false);
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

test('extractModelInventory rejects invalid body and data envelopes', () => {
  for (const body of [null, 'list', {}, { data: null }, { data: 'nope' }]) {
    assert.throws(
      () => extractModelInventory(body),
      (error) => error.code === 'TRANSPORT_INVALID_RESPONSE',
    );
  }
});

test('extractModelInventory rejects more than 256 rows', () => {
  const data = Array.from({ length: 257 }, (_value, index) => ({ id: `model-${index}` }));
  assert.throws(
    () => extractModelInventory({ data }),
    (error) => error.code === 'TRANSPORT_INVALID_RESPONSE',
  );
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

test('transport rejects non-json content-type', async () => {
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

test('transport module source does not embed fixture secrets', () => {
  const source = readFileSync(path.join(__dirname, '../../src/fix/cis/transport.js'), 'utf8');
  assert.equal(source.includes('feature-key-value-should-not-leak'), false);
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

test('transport listModels rejects non-json content-type', async () => {
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
    maxResponseBytes: 256,
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
