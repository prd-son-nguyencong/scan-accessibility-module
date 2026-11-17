import { readFileSync, readdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { CIS_POC_LIMITS } from '../../src/fix/cis/limits.js';
import { assertBundleRedacted } from '../../scripts/lib/cis-redaction.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(__dirname, '../..');
const FIXTURES_ROOT = path.join(PACKAGE_ROOT, 'test/fixtures/cis');
const CONTRACT_DOC = path.join(PACKAGE_ROOT, 'docs/cis-contract.md');

const ALLOWED_PROVENANCE = new Set([
  'bruno-derived',
  'synthetic-probe',
  'synthetic-inferred',
  'synthetic',
  'observed-environment',
  'observed-live-redacted',
]);

const RESPONSE_PROVENANCE = new Set(['synthetic-inferred', 'synthetic', 'observed-environment', 'observed-live-redacted']);

/**
 * Only the observed network failure from this characterization environment is recorded live.
 */
export const CIS_ACCESS_LIMITATION = Object.freeze({
  liveProbeAttempted: true,
  liveProbeReachable: false,
  liveProbeError: 'fetch failed (network unreachable from characterization environment)',
  liveProbeAt: '2026-07-14T11:08:00.000Z',
  structuredOutputPassThrough: 'unverified',
  toolsPassThrough: 'unverified',
  fallbackPolicy: 'prompt-plus-local-validator',
});

/**
 * @param {typeof CIS_POC_LIMITS} limits
 */
export function validateLimits(limits) {
  const requiredNumbers = [
    'maxContextRounds',
    'maxGenerationAttempts',
    'maxConcurrency',
    'requestTimeoutMs',
    'maxInputTokens',
    'maxOutputTokens',
    'sessionWallClockBudgetMs',
    'sessionCallBudget',
  ];

  for (const key of requiredNumbers) {
    if (!Number.isInteger(limits[key]) || limits[key] <= 0) {
      throw new Error(`CIS_POC_LIMITS.${key} must be a positive integer`);
    }
  }

  if (limits.maxContextRounds > 2) throw new Error('maxContextRounds exceeds PoC cap');
  if (limits.maxGenerationAttempts > 2) throw new Error('maxGenerationAttempts exceeds PoC cap');
  if (limits.maxConcurrency > 2) throw new Error('maxConcurrency exceeds PoC cap');
}

/**
 * @returns {string[]}
 */
export function listContractArtifacts() {
  const fixtureFiles = readdirSync(FIXTURES_ROOT, { recursive: true })
    .filter((entry) => String(entry).endsWith('.json'))
    .map((entry) => path.join(FIXTURES_ROOT, entry));

  const brunoFiles = readdirSync(path.join(FIXTURES_ROOT, 'bruno-source'))
    .filter((entry) => entry.endsWith('.bru'))
    .map((entry) => path.join(FIXTURES_ROOT, 'bruno-source', entry));

  return [
    CONTRACT_DOC,
    path.join(PACKAGE_ROOT, 'scripts', 'cis-characterize.js'),
    ...fixtureFiles,
    ...brunoFiles,
  ];
}

export { assertBundleRedacted };

/**
 * @param {string} relativePath path under test/fixtures/cis
 */
export function validateFixture(relativePath) {
  const absolutePath = path.join(FIXTURES_ROOT, relativePath);
  const raw = readFileSync(absolutePath, 'utf8');
  assertBundleRedacted(raw, relativePath);
  const fixture = JSON.parse(raw);

  validateProvenanceRules(relativePath, fixture);

  if (relativePath.startsWith('requests/')) {
    validateRequestFixture(relativePath, fixture);
  } else if (relativePath.startsWith('responses/')) {
    validateResponseFixture(relativePath, fixture);
  } else {
    throw new Error(`Unknown fixture group for ${relativePath}`);
  }

  return fixture;
}

/**
 * @param {string} relativePath
 * @param {Record<string, unknown>} fixture
 */
function validateProvenanceRules(relativePath, fixture) {
  const provenance = fixture.meta?.provenance;
  if (!provenance || !ALLOWED_PROVENANCE.has(provenance)) {
    throw new Error(`${relativePath} has invalid meta.provenance: ${provenance}`);
  }

  if (provenance === 'observed-live-redacted') {
    const capture = fixture.meta.capture;
    if (!capture?.capturedAt || !capture?.probe || !capture?.environment) {
      throw new Error(`${relativePath} observed-live-redacted requires meta.capture metadata`);
    }
  }

  if (relativePath.startsWith('responses/') && provenance === 'bruno-derived') {
    throw new Error(`${relativePath} response fixtures cannot be bruno-derived`);
  }

  if (relativePath.startsWith('responses/') && !RESPONSE_PROVENANCE.has(provenance)) {
    throw new Error(`${relativePath} response provenance must be synthetic or observed`);
  }

  const input = fixture.request?.task?.input;
  const hasOpenAiProbeFields =
    input && (Object.prototype.hasOwnProperty.call(input, 'response_format') || Object.prototype.hasOwnProperty.call(input, 'tools'));

  if (hasOpenAiProbeFields && provenance !== 'synthetic-probe') {
    throw new Error(`${relativePath} inferred OpenAI fields require synthetic-probe provenance`);
  }

  if (
    (relativePath.includes('structured-output') || relativePath.includes('tools')) &&
    provenance !== 'synthetic-probe'
  ) {
    throw new Error(`${relativePath} must use synthetic-probe provenance`);
  }
}

/**
 * @param {string} relativePath
 * @param {Record<string, unknown>} fixture
 */
function validateRequestFixture(relativePath, fixture) {
  if (!fixture.request || typeof fixture.request !== 'object') {
    throw new Error(`${relativePath} missing request object`);
  }

  if (relativePath.includes('models-list')) {
    if (fixture.request.method !== 'GET' || !fixture.request.path?.includes('/models')) {
      throw new Error(`${relativePath} must describe GET /models`);
    }
    if (fixture.request.query?.bypass_auth !== 'true') {
      throw new Error(`${relativePath} must include bypass_auth=true`);
    }
    if (!Object.prototype.hasOwnProperty.call(fixture.request.query, 'model')) {
      throw new Error(`${relativePath} must include empty model query param per Bruno get-models.bru`);
    }
    return;
  }

  const { target, task } = fixture.request;
  if (!target?.provider || !target?.model) {
    throw new Error(`${relativePath} missing target.provider/model`);
  }
  if (!task?.type || !task?.input) {
    throw new Error(`${relativePath} missing task.type/input`);
  }
  if (task.type !== 'openai-chat-completion-v1') {
    throw new Error(`${relativePath} task.type must be openai-chat-completion-v1`);
  }
  if (!Array.isArray(task.input.messages) || task.input.messages.length === 0) {
    throw new Error(`${relativePath} task.input.messages must be a non-empty array`);
  }
}

/**
 * @param {string} relativePath
 * @param {Record<string, unknown>} fixture
 */
function validateResponseFixture(relativePath, fixture) {
  if (relativePath.includes('characterization-network-unreachable')) {
    if (fixture.observation?.reachable !== false) {
      throw new Error(`${relativePath} must record reachable=false`);
    }
    return;
  }

  if (!fixture.response || typeof fixture.response !== 'object') {
    throw new Error(`${relativePath} missing response object`);
  }

  if (relativePath.includes('timeout')) {
    if (fixture.response.error !== 'timeout') {
      throw new Error(`${relativePath} timeout fixture must set response.error=timeout`);
    }
    return;
  }

  if (relativePath.includes('malformed-output')) {
    if (typeof fixture.parseResult?.validJson !== 'boolean') {
      throw new Error(`${relativePath} malformed fixture requires parseResult.validJson`);
    }
    const content = fixture.response.body?.prediction?.output?.choices?.[0]?.message?.content;
    if (content !== '<redacted-content>') {
      throw new Error(`${relativePath} must redact raw model output per cis-redaction policy`);
    }
    return;
  }

  if (typeof fixture.response.status !== 'number') {
    throw new Error(`${relativePath} missing numeric response.status`);
  }

  if (relativePath.includes('models-success')) {
    if (!Array.isArray(fixture.response.body?.data)) {
      throw new Error(`${relativePath} models success requires body.data array`);
    }
  }

  if (relativePath.includes('predictions-success')) {
    const output = fixture.response.body?.prediction?.output;
    const usage = output?.usage;
    if (!usage || typeof usage.prompt_tokens !== 'number' || typeof usage.completion_tokens !== 'number') {
      throw new Error(`${relativePath} predictions success requires usage token numbers`);
    }
  }

  if (relativePath.includes('error')) {
    if (!fixture.response.body?.error) {
      throw new Error(`${relativePath} error fixture requires body.error`);
    }
  }
}
