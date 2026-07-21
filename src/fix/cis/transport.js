import { CIS_MODEL_DISCOVERY_LIMITS, CIS_POC_LIMITS, CIS_VALIDATION_LIMITS } from './limits.js';
import { estimateMessagesTokenCount } from './parser.js';

export class CisTransportError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {{ status?: number, elapsedMs?: number, usage?: Record<string, number> }} [meta]
   */
  constructor(code, message, meta = {}) {
    super(message);
    this.name = 'CisTransportError';
    this.code = code;
    this.meta = Object.freeze({ ...meta });
  }
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const ALLOWED_MESSAGE_ROLES = new Set(['system', 'user', 'assistant']);
/** Canonical selectable chat model IDs — no pipe composite registry entries. */
const MODEL_ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,199}$/i;
/** Bounded pipe-composite registry rows returned by live inventory; skipped, never selectable. */
export const COMPOSITE_INVENTORY_ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,98}\|[a-z0-9][a-z0-9._:-]{0,98}$/i;
const TLS_ERROR_CODES = new Set([
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

/**
 * @param {unknown} error
 */
function isTlsVerificationError(error) {
  const code = error?.cause?.code || error?.code;
  return typeof code === 'string' && TLS_ERROR_CODES.has(code);
}

/**
 * @param {string} hostname
 */
export function isLoopbackHost(hostname) {
  return LOOPBACK_HOSTS.has(String(hostname).toLowerCase());
}

/**
 * @param {string} baseUrl
 * @param {string[]} allowedHosts
 * @param {boolean} allowInsecureLoopback
 */
export function assertAllowedCisBaseUrl(baseUrl, allowedHosts, allowInsecureLoopback = false) {
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new CisTransportError('TRANSPORT_INSECURE_URL', 'CIS base URL is invalid.');
  }

  if (parsed.username || parsed.password) {
    throw new CisTransportError('TRANSPORT_INSECURE_URL', 'CIS base URL must not include credentials.');
  }
  if (parsed.search || parsed.hash) {
    throw new CisTransportError('TRANSPORT_INSECURE_URL', 'CIS base URL must not include query or hash.');
  }

  const hostname = parsed.hostname.toLowerCase();
  const allowlisted = allowedHosts.map((host) => host.toLowerCase()).includes(hostname);
  if (!allowlisted) {
    throw new CisTransportError('TRANSPORT_HOST_DENIED', 'CIS host is not allowlisted.');
  }

  const loopback = isLoopbackHost(hostname);
  if (parsed.protocol !== 'https:') {
    const insecureAllowed = allowInsecureLoopback && loopback;
    if (!insecureAllowed) {
      throw new CisTransportError('TRANSPORT_INSECURE_URL', 'CIS transport requires HTTPS.');
    }
  }
}

/**
 * @param {string} provider
 * @param {string} model
 * @param {Array<{ role: string, content: string }>} messages
 * @param {number} maxCompletionTokens
 */
export function buildPredictionsEnvelope(provider, model, messages, maxCompletionTokens) {
  return {
    target: { provider, model },
    task: {
      type: 'openai-chat-completion-v1',
      input: {
        messages,
        max_completion_tokens: maxCompletionTokens,
      },
    },
  };
}

/**
 * @param {string} baseUrl
 * @param {{ devBypassAuth?: boolean }} [options]
 */
export function buildPredictionsRequestUrl(baseUrl, options = {}) {
  const normalized = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const url = new URL('v1alpha1/predictions', normalized);
  if (options.devBypassAuth === true) {
    url.searchParams.set('bypass_auth', 'true');
  }
  return url;
}

/**
 * @param {string} baseUrl
 * @param {{ devBypassAuth?: boolean }} [options]
 */
export function buildModelsRequestUrl(baseUrl, options = {}) {
  const normalized = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const url = new URL('v1alpha1/models', normalized);
  if (options.devBypassAuth === true) {
    url.searchParams.set('bypass_auth', 'true');
  }
  return url;
}

/**
 * @param {unknown} row
 */
function extractModelInventoryRowId(row) {
  if (typeof row === 'string') return row;
  if (!row || typeof row !== 'object') return null;

  const hasId = typeof row.id === 'string';
  const hasModel = typeof row.model === 'string';
  if (hasId && hasModel) {
    if (row.id !== row.model) return undefined;
    return row.id;
  }
  if (hasId) return row.id;
  if (hasModel) return row.model;
  return null;
}

/**
 * @param {string | null | undefined} contentTypeHeader
 */
function isJsonContentType(contentTypeHeader) {
  const mediaType = String(contentTypeHeader ?? '').split(';', 1)[0].trim().toLowerCase();
  return mediaType === 'application/json';
}

/**
 * @param {{
 *   timeoutMs?: number,
 *   modelInventoryMaxResponseBytes?: number,
 * }} options
 */
export function validateListModelsTransportOptions(options) {
  const {
    timeoutMs = CIS_POC_LIMITS.requestTimeoutMs,
    modelInventoryMaxResponseBytes = CIS_MODEL_DISCOVERY_LIMITS.maxResponseBytes,
  } = options;

  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > CIS_POC_LIMITS.requestTimeoutMs) {
    throw new CisTransportError('TRANSPORT_INVALID_REQUEST', 'timeoutMs exceeds safe request bounds.');
  }
  if (!Number.isInteger(modelInventoryMaxResponseBytes)
    || modelInventoryMaxResponseBytes <= 0
    || modelInventoryMaxResponseBytes > CIS_MODEL_DISCOVERY_LIMITS.maxResponseBytes) {
    throw new CisTransportError(
      'TRANSPORT_INVALID_REQUEST',
      'modelInventoryMaxResponseBytes exceeds safe response bounds.',
    );
  }
}

/**
 * @param {unknown} body
 */
export function extractModelInventory(body) {
  if (!body || typeof body !== 'object') {
    throw new CisTransportError('TRANSPORT_INVALID_RESPONSE', 'CIS model inventory is invalid.');
  }

  const hasData = Array.isArray(body.data);
  const hasModels = Array.isArray(body.models);
  if (hasData === hasModels) {
    throw new CisTransportError('TRANSPORT_INVALID_RESPONSE', 'CIS model inventory is invalid.');
  }

  const rows = hasData ? body.data : body.models;
  if (rows.length > CIS_MODEL_DISCOVERY_LIMITS.maxRows) {
    throw new CisTransportError('TRANSPORT_INVALID_RESPONSE', 'CIS model inventory is invalid.');
  }

  const ids = [];
  const seen = new Set();
  for (const row of rows) {
    const id = extractModelInventoryRowId(row);
    if (id === undefined || typeof id !== 'string') {
      throw new CisTransportError('TRANSPORT_INVALID_RESPONSE', 'CIS model ID is invalid.');
    }
    if (COMPOSITE_INVENTORY_ID_PATTERN.test(id)) {
      continue;
    }
    if (!MODEL_ID_PATTERN.test(id)) {
      throw new CisTransportError('TRANSPORT_INVALID_RESPONSE', 'CIS model ID is invalid.');
    }
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids.sort((left, right) => left.localeCompare(right));
}

/**
 * @param {unknown} body
 */
export function extractPredictionsContent(body) {
  if (!body || typeof body !== 'object') {
    throw new CisTransportError('TRANSPORT_INVALID_RESPONSE', 'CIS response body is not an object.');
  }
  const prediction = body.prediction;
  if (!prediction || typeof prediction !== 'object') {
    throw new CisTransportError('TRANSPORT_INVALID_RESPONSE', 'CIS response missing prediction envelope.');
  }
  if (prediction.type !== 'openai-chat-completion-v1') {
    throw new CisTransportError('TRANSPORT_INVALID_RESPONSE', 'CIS prediction type mismatch.');
  }
  const output = prediction.output;
  const choices = output?.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new CisTransportError('TRANSPORT_INVALID_RESPONSE', 'CIS response missing choices.');
  }
  const content = choices[0]?.message?.content;
  if (typeof content !== 'string') {
    throw new CisTransportError('TRANSPORT_INVALID_RESPONSE', 'CIS response missing assistant content.');
  }

  /** @type {Record<string, number> | undefined} */
  let usage;
  const rawUsage = output?.usage;
  if (rawUsage && typeof rawUsage === 'object') {
    usage = {};
    for (const key of ['prompt_tokens', 'completion_tokens', 'total_tokens']) {
      if (Number.isFinite(rawUsage[key])) usage[key] = rawUsage[key];
    }
  }

  return { content, usage };
}

/**
 * @param {{
 *   model: string,
 *   messages: Array<{ role: string, content: string }>,
 *   maxCompletionTokens?: number,
 *   timeoutMs?: number,
 *   maxResponseBytes?: number,
 * }} params
 */
export function validateChatCompletionParams(params) {
  const {
    model,
    messages,
    maxCompletionTokens = CIS_POC_LIMITS.maxOutputTokens,
    timeoutMs = CIS_POC_LIMITS.requestTimeoutMs,
    maxResponseBytes = CIS_VALIDATION_LIMITS.maxResponseBytes,
  } = params;

  if (!model?.trim()) {
    throw new CisTransportError('TRANSPORT_INVALID_REQUEST', 'Model id is required.');
  }
  const modelId = model.trim();
  if (!MODEL_ID_PATTERN.test(modelId)) {
    throw new CisTransportError('TRANSPORT_INVALID_REQUEST', 'Model id is invalid.');
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new CisTransportError('TRANSPORT_INVALID_REQUEST', 'Messages are required.');
  }
  for (const [index, message] of messages.entries()) {
    if (!message || typeof message !== 'object') {
      throw new CisTransportError('TRANSPORT_INVALID_REQUEST', `messages[${index}] must be an object.`);
    }
    if (!ALLOWED_MESSAGE_ROLES.has(message.role)) {
      throw new CisTransportError('TRANSPORT_INVALID_REQUEST', `messages[${index}].role is not allowlisted.`);
    }
    if (typeof message.content !== 'string' || message.content.length === 0) {
      throw new CisTransportError('TRANSPORT_INVALID_REQUEST', `messages[${index}].content must be a non-empty string.`);
    }
  }

  if (!Number.isInteger(maxCompletionTokens)
    || maxCompletionTokens < 1
    || maxCompletionTokens > CIS_POC_LIMITS.maxOutputTokens) {
    throw new CisTransportError(
      'TRANSPORT_INVALID_REQUEST',
      'maxCompletionTokens must be an integer between 1 and maxOutputTokens.',
    );
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > CIS_POC_LIMITS.requestTimeoutMs) {
    throw new CisTransportError('TRANSPORT_INVALID_REQUEST', 'timeoutMs exceeds safe request bounds.');
  }
  if (!Number.isInteger(maxResponseBytes) || maxResponseBytes <= 0 || maxResponseBytes > CIS_VALIDATION_LIMITS.maxResponseBytes) {
    throw new CisTransportError('TRANSPORT_INVALID_REQUEST', 'maxResponseBytes exceeds safe response bounds.');
  }
  if (estimateMessagesTokenCount(messages) > CIS_POC_LIMITS.maxInputTokens) {
    throw new CisTransportError('TRANSPORT_INVALID_REQUEST', 'Messages exceed maxInputTokens.');
  }
}

/**
 * @param {{
 *   baseUrl: string,
 *   featureKey: string,
 *   provider?: string,
 *   allowedHosts?: string[],
 *   allowInsecureLoopback?: boolean,
 *   fetch?: typeof fetch,
 *   dispatcher?: import('undici').Dispatcher,
 *   ownsDispatcher?: boolean,
 *   timeoutMs?: number,
 *   maxResponseBytes?: number,
 *   modelInventoryMaxResponseBytes?: number,
 *   devBypassAuth?: boolean,
 *   transportSecurity?: 'trusted' | 'insecure-dev',
 * }} options
 */
export function createCisTransport(options) {
  const {
    baseUrl,
    featureKey,
    provider = 'aws',
    allowedHosts = [],
    allowInsecureLoopback = false,
    fetch: fetchImpl = globalThis.fetch,
    dispatcher = null,
    ownsDispatcher = false,
    timeoutMs = CIS_POC_LIMITS.requestTimeoutMs,
    maxResponseBytes = CIS_VALIDATION_LIMITS.maxResponseBytes,
    modelInventoryMaxResponseBytes = CIS_MODEL_DISCOVERY_LIMITS.maxResponseBytes,
    devBypassAuth = false,
    transportSecurity = 'trusted',
  } = options;

  if (!featureKey?.trim()) {
    throw new CisTransportError('TRANSPORT_HOST_DENIED', 'CIS feature key is required.');
  }

  assertAllowedCisBaseUrl(baseUrl, allowedHosts, allowInsecureLoopback);

  let closeSucceeded = false;
  /** @type {Promise<void> | null} */
  let closePromise = null;

  async function closeOwnedDispatcher() {
    if (ownsDispatcher && dispatcher && typeof dispatcher.close === 'function') {
      await dispatcher.close();
    }
  }

  const urlOptions = { devBypassAuth: devBypassAuth === true };

  return {
    provider,
    transportSecurity,
    buildPredictionsEnvelope(messages, maxCompletionTokens, model) {
      return buildPredictionsEnvelope(provider, model, messages, maxCompletionTokens);
    },
    buildPredictionsRequestUrl() {
      return buildPredictionsRequestUrl(baseUrl, urlOptions);
    },
    buildModelsRequestUrl() {
      return buildModelsRequestUrl(baseUrl, urlOptions);
    },
    async close() {
      if (closeSucceeded) return;
      if (!closePromise) {
        closePromise = closeOwnedDispatcher()
          .then(() => {
            closeSucceeded = true;
          })
          .catch((error) => {
            closePromise = null;
            throw error;
          });
      }
      await closePromise;
    },
    /**
     * @param {{
     *   model: string,
     *   messages: Array<{ role: string, content: string }>,
     *   maxCompletionTokens?: number,
     *   signal?: AbortSignal,
     * }} params
     */
    async chatCompletion(params) {
      const {
        model,
        messages,
        maxCompletionTokens = CIS_POC_LIMITS.maxOutputTokens,
        signal,
      } = params;

      validateChatCompletionParams({
        model,
        messages,
        maxCompletionTokens,
        timeoutMs,
        maxResponseBytes,
      });

      const url = buildPredictionsRequestUrl(baseUrl, urlOptions);
      const envelope = buildPredictionsEnvelope(provider, model, messages, maxCompletionTokens);
      return executeBoundedJsonRequest({
        url,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Wd-PCA-Feature-Key': featureKey,
        },
        body: JSON.stringify(envelope),
        signal,
        timeoutMs,
        maxResponseBytes,
        fetchImpl,
        dispatcher,
        messages: {
          httpError: 'CIS predictions request failed.',
          cancelled: 'CIS predictions request was cancelled.',
          timeout: 'CIS predictions request timed out.',
          networkError: 'CIS predictions request failed.',
        },
        parseSuccessfulBody(parsedBody, ctx) {
          const { content, usage } = extractPredictionsContent(parsedBody);
          return {
            content,
            usage,
            elapsedMs: ctx.elapsedMs,
            status: ctx.status,
          };
        },
      });
    },
    /**
     * @param {{ signal?: AbortSignal }} [params]
     */
    async listModels(params = {}) {
      const { signal } = params;

      validateListModelsTransportOptions({
        timeoutMs,
        modelInventoryMaxResponseBytes,
      });

      return executeBoundedJsonRequest({
        url: buildModelsRequestUrl(baseUrl, urlOptions),
        method: 'GET',
        headers: {
          'Wd-PCA-Feature-Key': featureKey,
        },
        signal,
        timeoutMs,
        maxResponseBytes: modelInventoryMaxResponseBytes,
        fetchImpl,
        dispatcher,
        messages: {
          httpError: 'CIS model inventory request failed.',
          cancelled: 'CIS model inventory request was cancelled.',
          timeout: 'CIS model inventory request timed out.',
          networkError: 'CIS model inventory request failed.',
        },
        parseSuccessfulBody(parsedBody) {
          return { models: extractModelInventory(parsedBody) };
        },
      });
    },
  };
}

/**
 * @param {{
 *   url: URL,
 *   method: 'GET' | 'POST',
 *   headers: Record<string, string>,
 *   body?: string,
 *   signal?: AbortSignal,
 *   timeoutMs: number,
 *   maxResponseBytes: number,
 *   fetchImpl: typeof fetch,
 *   dispatcher: import('undici').Dispatcher | null,
 *   messages: {
 *     httpError: string,
 *     cancelled: string,
 *     timeout: string,
 *     networkError: string,
 *   },
 *   parseSuccessfulBody: (body: unknown, ctx: { status: number, elapsedMs: number }) => unknown,
 * }} params
 */
async function executeBoundedJsonRequest(params) {
  const {
    url,
    method,
    headers,
    body,
    signal,
    timeoutMs,
    maxResponseBytes,
    fetchImpl,
    dispatcher,
    messages,
    parseSuccessfulBody,
  } = params;

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const abortListener = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', abortListener, { once: true });
  }

  const started = Date.now();
  try {
    let effectiveFetch = fetchImpl;
    if (dispatcher && fetchImpl === globalThis.fetch) {
      ({ fetch: effectiveFetch } = await import('undici'));
    }

    const init = {
      method,
      headers,
      signal: controller.signal,
      redirect: 'error',
      ...(dispatcher ? { dispatcher } : {}),
    };
    if (body !== undefined) init.body = body;

    const response = await effectiveFetch(url.toString(), init);
    const elapsedMs = Date.now() - started;
    const rawBytes = await readBoundedResponseText(response, maxResponseBytes);

    if (!response.ok) {
      throw new CisTransportError('TRANSPORT_HTTP_ERROR', messages.httpError, {
        status: response.status,
        elapsedMs,
      });
    }

    if (!isJsonContentType(response.headers.get('content-type'))) {
      throw new CisTransportError('TRANSPORT_INVALID_RESPONSE', 'CIS response content-type is not JSON.', {
        status: response.status,
        elapsedMs,
      });
    }

    let parsedBody = null;
    try {
      parsedBody = rawBytes ? JSON.parse(rawBytes) : null;
    } catch {
      throw new CisTransportError('TRANSPORT_INVALID_RESPONSE', 'CIS response is not JSON.', {
        status: response.status,
        elapsedMs,
      });
    }

    return parseSuccessfulBody(parsedBody, { status: response.status, elapsedMs });
  } catch (error) {
    if (error instanceof CisTransportError) throw error;
    if (isTlsVerificationError(error)) {
      throw new CisTransportError('TRANSPORT_TLS_ERROR', 'CIS TLS verification failed.');
    }
    if (error?.name === 'AbortError') {
      if (signal?.aborted && !timedOut) {
        throw new CisTransportError('TRANSPORT_CANCELLED', messages.cancelled, {
          elapsedMs: Date.now() - started,
        });
      }
      throw new CisTransportError('TRANSPORT_TIMEOUT', messages.timeout, {
        elapsedMs: Date.now() - started,
      });
    }
    throw new CisTransportError('TRANSPORT_NETWORK_ERROR', messages.networkError);
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', abortListener);
  }
}

/**
 * @param {Response} response
 * @param {number} maxBytes
 */
async function readBoundedResponseText(response, maxBytes) {
  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      throw new CisTransportError('TRANSPORT_RESPONSE_TOO_LARGE', 'CIS response exceeds maxResponseBytes.');
    }
    return text;
  }

  const reader = response.body.getReader();
  /** @type {Uint8Array[]} */
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new CisTransportError('TRANSPORT_RESPONSE_TOO_LARGE', 'CIS response exceeds maxResponseBytes.');
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof CisTransportError) throw error;
    await reader.cancel().catch(() => {});
    throw error;
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * @param {Error} error
 */
export function redactTransportErrorMessage(error) {
  if (!(error instanceof CisTransportError)) return 'CIS transport failed.';
  return `${error.code}: ${error.message}`;
}
