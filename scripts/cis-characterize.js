#!/usr/bin/env node
/**
 * CIS characterization probe — manual/offline use only.
 *
 * Reads credentials from environment; never logs base URL host, feature key,
 * authorization values, or raw model content.
 *
 * Usage:
 *   CIS_BASE_URL=https://<host>/ml/inference/cis \
 *   CIS_FEATURE_KEY=<key> \
 *   CIS_MODEL=anthropic.claude-sonnet-4-20250514-v1:0 \
 *   CIS_PROBES=models,predictions \
 *   node scripts/cis-characterize.js
 *
 * sessionCallBudget is 2 per invocation. Five probes exist; run multiple invocations
 * with at most two probes each, e.g.:
 *   CIS_PROBES=models,predictions
 *   CIS_PROBES=structured-output,tools
 *   CIS_PROBES=invalid-model
 */
import path from 'path';
import { pathToFileURL } from 'url';
import { CIS_POC_LIMITS } from '../src/fix/cis/limits.js';
import { redactProbeResponse, serializeRedactedArtifact } from './lib/cis-redaction.js';

const TIMEOUT_MS = CIS_POC_LIMITS.requestTimeoutMs;
const PROVIDER = process.env.CIS_PROVIDER || 'aws';

export const ALL_PROBE_NAMES = Object.freeze([
  'models',
  'predictions',
  'structured-output',
  'tools',
  'invalid-model',
]);

export const DEFAULT_PROBE_NAMES = Object.freeze(['models', 'predictions']);

/**
 * @param {string} [input]
 */
export function parseProbeSelection(input = process.env.CIS_PROBES || '') {
  const raw = input.trim() || DEFAULT_PROBE_NAMES.join(',');
  const names = raw
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);

  for (const name of names) {
    if (!ALL_PROBE_NAMES.includes(name)) {
      throw new Error(`unknown probe: ${name}`);
    }
  }

  if (names.length > CIS_POC_LIMITS.sessionCallBudget) {
    throw new Error(
      `probe selection exceeds sessionCallBudget (${CIS_POC_LIMITS.sessionCallBudget}); run multiple invocations`,
    );
  }

  return names;
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value?.trim()) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return value.trim();
}

async function probe(name, url, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const started = Date.now();
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const elapsedMs = Date.now() - started;
    let body = null;
    const text = await response.text();
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { _parseError: true, _preview: text };
    }
    return redactProbeResponse({
      name,
      ok: true,
      status: response.status,
      elapsedMs,
      headers: response.headers,
      body,
    });
  } catch (error) {
    return {
      name,
      ok: false,
      error: error.name === 'AbortError' ? 'timeout' : 'fetch failed',
      elapsedMs: Date.now() - started,
    };
  } finally {
    clearTimeout(timer);
  }
}

function buildUrl(baseUrl, pathname, query = {}) {
  const url = new URL(pathname, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }
  return url;
}

function predictionBody(model, input) {
  return {
    target: { provider: PROVIDER, model },
    task: { type: 'openai-chat-completion-v1', input },
  };
}

/**
 * @param {string} name
 * @param {string} baseUrl
 * @param {string} featureKey
 * @param {string} model
 */
async function runNamedProbe(name, baseUrl, featureKey, model) {
  const headers = {
    'Content-Type': 'application/json',
    'Wd-PCA-Feature-Key': featureKey,
  };

  switch (name) {
    case 'models':
      return probe(
        name,
        buildUrl(baseUrl, 'v1alpha1/models', { bypass_auth: 'true', model: '' }),
        { method: 'GET', headers: { 'Wd-PCA-Feature-Key': featureKey } },
      );
    case 'predictions':
      return probe(name, buildUrl(baseUrl, 'v1alpha1/predictions', { bypass_auth: 'true' }), {
        method: 'POST',
        headers,
        body: JSON.stringify(
          predictionBody(model, {
            messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
            max_completion_tokens: 16,
          }),
        ),
      });
    case 'structured-output':
      return probe(name, buildUrl(baseUrl, 'v1alpha1/predictions', { bypass_auth: 'true' }), {
        method: 'POST',
        headers,
        body: JSON.stringify(
          predictionBody(model, {
            messages: [{ role: 'user', content: 'Return JSON {"status":"ok"}' }],
            max_completion_tokens: 32,
            response_format: { type: 'json_object' },
          }),
        ),
      });
    case 'tools':
      return probe(name, buildUrl(baseUrl, 'v1alpha1/predictions', { bypass_auth: 'true' }), {
        method: 'POST',
        headers,
        body: JSON.stringify(
          predictionBody(model, {
            messages: [{ role: 'user', content: 'What is 2+2?' }],
            max_completion_tokens: 32,
            tools: [
              {
                type: 'function',
                function: {
                  name: 'add',
                  description: 'add numbers',
                  parameters: {
                    type: 'object',
                    properties: { a: { type: 'number' }, b: { type: 'number' } },
                    required: ['a', 'b'],
                  },
                },
              },
            ],
          }),
        ),
      });
    case 'invalid-model':
      return probe(name, buildUrl(baseUrl, 'v1alpha1/predictions', { bypass_auth: 'true' }), {
        method: 'POST',
        headers,
        body: JSON.stringify(
          predictionBody('invalid.model.does-not-exist', {
            messages: [{ role: 'user', content: 'hi' }],
            max_completion_tokens: 8,
          }),
        ),
      });
    default:
      throw new Error(`unknown probe: ${name}`);
  }
}

async function main() {
  const baseUrl = requireEnv('CIS_BASE_URL');
  const featureKey = requireEnv('CIS_FEATURE_KEY');
  const model = requireEnv('CIS_MODEL');
  const selectedProbes = parseProbeSelection(process.env.CIS_PROBES || '');

  /** @type {Record<string, unknown>} */
  const probes = {};
  for (const name of selectedProbes) {
    probes[name] = await runNamedProbe(name, baseUrl, featureKey, model);
  }

  const artifact = {
    meta: {
      probeScript: 'scripts/cis-characterize.js',
      timeoutMs: TIMEOUT_MS,
      selectedProbes,
      sessionCallBudget: CIS_POC_LIMITS.sessionCallBudget,
      emittedAt: new Date().toISOString(),
      note: 'Redacted characterization artifact. Do not commit credentials or internal hosts.',
    },
    probes,
  };

  console.log(serializeRedactedArtifact(artifact));
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  main();
}
