import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync as readSource } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { CisTransportError } from '../../src/fix/cis/transport.js';
import { assertBundleRedacted, assertSerializedRedacted } from '../../scripts/lib/cis-redaction.js';
import {
  buildBenchmarkArtifact,
  buildBenchmarkOutcomeFromResults,
  createBenchmarkModelSession,
  evaluateBenchmarkCaseWithSession,
  findUnavailableModelIds,
  markUnnecessaryCannotFixOutcomes,
  runCisModelBenchmark,
  runCisBenchmarkCli,
  sanitizeBenchmarkOutcome,
  sanitizeBenchmarkRuns,
  selectProposableAccessibilityUnits,
  sessionIdForBenchmarkBootstrap,
  sessionIdForBenchmarkModel,
  writeBenchmarkArtifact,
} from '../../scripts/cis-benchmark.js';
import {
  rankModelRuns,
  BENCHMARK_SCORE_SCHEMA,
  BENCHMARK_MISSING_METRIC,
  rehydrateBenchmarkScore,
} from '../../src/fix/eval/model-selection.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = path.join(__dirname, '../../scripts/cis-benchmark.js');

const SENTINEL_ENDPOINT = 'https://cis-internal-sentinel.example.test:8443/ml/inference/cis';
const SENTINEL_TOKEN = 'super-secret-feature-key-sentinel-value';

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
    caBundlePath: '/tmp/secret-ca-bundle-sentinel.pem',
  };
}

function minimalReport(reportId = 'sha256:benchmark-test') {
  return {
    schemaVersion: '2.0.0',
    reportId,
    generatedAt: '2026-07-16T00:00:00.000Z',
    target: {
      mode: 'local-only',
      url: 'http://127.0.0.1:1234/',
      buildRevision: 'rev-1',
      instrumentationDigest: 'sha256:abc',
      deploymentUrl: null,
      attestationStatus: null,
      attestationReason: null,
    },
    pages: [{
      route: '/',
      pageState: 'initial',
      findings: [{
        findingId: 'sha256:finding-1',
        canonicalRuleId: 'button-name',
        impact: 'critical',
        source: {
          file: 'src/a.liquid',
          line: 1,
          preimageSha256: 'sha256:pre',
          confidence: 'high',
          method: 'attested',
        },
      }],
    }],
  };
}

test('cis-benchmark script is import-safe and loads host env via config module', async () => {
  const source = readSource(SCRIPT_PATH, 'utf8');
  assert.match(source, /['"]\.\.\/src\/utils\/config\.js['"]/);
  assert.match(source, /resolveTrustedCisConfig/);
  assert.match(source, /requireModel:\s*false/);
  assert.match(source, /runCisBenchmarkCli/);
  assert.match(source, /runCisModelBenchmark/);
  assert.match(source, /isMain/);
  assertBundleRedacted(source, SCRIPT_PATH);
});

test('selectProposableAccessibilityUnits sorts deterministically and caps max units', () => {
  const units = selectProposableAccessibilityUnits([
    { fixUnitId: 'unit-b', kind: 'accessibility', canonicalRuleId: 'button-name' },
    { fixUnitId: 'unit-a', kind: 'accessibility', canonicalRuleId: 'link-name' },
    { fixUnitId: 'unit-c', kind: 'manual', canonicalRuleId: 'color-contrast' },
  ], 1);

  assert.deepEqual(units, [{
    fixUnitId: 'unit-a',
    canonicalRuleId: 'link-name',
    eligible: true,
  }]);
});

test('runCisModelBenchmark evaluates models and cases sequentially', async () => {
  const events = [];
  await runCisModelBenchmark({
    modelIds: ['model-a', 'model-b'],
    cases: [{ fixUnitId: 'u1', canonicalRuleId: 'button-name', eligible: true }],
    evaluateCase: async ({ modelId, benchmarkCase }) => {
      events.push(`${modelId}:${benchmarkCase.fixUnitId}`);
      return {
        fixUnitId: benchmarkCase.fixUnitId,
        canonicalRuleId: benchmarkCase.canonicalRuleId,
        eligible: true,
        proposed: modelId === 'model-b',
        verified: modelId === 'model-b',
        newCriticalSerious: 0,
        invalid: false,
        unsafe: false,
        unnecessaryCannotFix: false,
        latencyMs: 100,
        totalTokens: 10,
        manualChecksRequired: 0,
        manualChecksHumanVerified: false,
        reasonCode: modelId === 'model-b' ? 'VERIFIED' : 'CANNOT_FIX',
        _cannotFix: modelId === 'model-a',
      };
    },
  });

  assert.deepEqual(events, ['model-a:u1', 'model-b:u1']);
});

test('runCisModelBenchmark isolates case failures without stopping other models', async () => {
  const result = await runCisModelBenchmark({
    modelIds: ['model-a', 'model-b'],
    cases: [{ fixUnitId: 'u1', canonicalRuleId: 'button-name', eligible: true }],
    evaluateCase: async ({ modelId }) => {
      if (modelId === 'model-a') {
        const error = new Error('broken');
        error.code = 'PARSER_INVALID_JSON';
        throw error;
      }
      return {
        fixUnitId: 'u1',
        canonicalRuleId: 'button-name',
        eligible: true,
        proposed: true,
        verified: true,
        newCriticalSerious: 0,
        invalid: false,
        unsafe: false,
        unnecessaryCannotFix: false,
        latencyMs: 50,
        totalTokens: 5,
        manualChecksRequired: 0,
        manualChecksHumanVerified: false,
        reasonCode: 'VERIFIED',
      };
    },
  });

  assert.equal(result.runs.length, 2);
  assert.equal(result.runs[0].outcomes[0].invalid, true);
  assert.equal(result.runs[1].outcomes[0].verified, true);
});

test('markUnnecessaryCannotFixOutcomes marks cannot_fix only when another model verified', () => {
  const runs = [
    {
      modelId: 'model-a',
      outcomes: [{
        fixUnitId: 'u1',
        proposed: false,
        verified: false,
        invalid: false,
        unsafe: false,
        unnecessaryCannotFix: false,
        newCriticalSerious: 0,
        _cannotFix: true,
      }],
    },
    {
      modelId: 'model-b',
      outcomes: [{
        fixUnitId: 'u1',
        proposed: true,
        verified: true,
        invalid: false,
        unsafe: false,
        unnecessaryCannotFix: false,
        newCriticalSerious: 0,
      }],
    },
  ];

  markUnnecessaryCannotFixOutcomes(runs);
  assert.equal(runs[0].outcomes[0].unnecessaryCannotFix, true);
  assert.equal(runs[1].outcomes[0].unnecessaryCannotFix, false);
});

test('sanitizeBenchmarkOutcome keeps only allowed fields and forces manualChecksHumanVerified false', () => {
  const sanitized = sanitizeBenchmarkOutcome({
    fixUnitId: 'u1',
    canonicalRuleId: 'button-name',
    eligible: true,
    proposed: true,
    verified: true,
    newCriticalSerious: 0,
    invalid: false,
    unsafe: false,
    unnecessaryCannotFix: false,
    latencyMs: 10,
    totalTokens: 2,
    manualChecksRequired: 1,
    manualChecksHumanVerified: true,
    reasonCode: 'VERIFIED',
    sourcePath: 'src/secret.liquid',
    diff: '<patch>',
    endpoint: SENTINEL_ENDPOINT,
    _cannotFix: true,
  });

  assert.deepEqual(new Set(Object.keys(sanitized)), new Set([
    'canonicalRuleId',
    'eligible',
    'fixUnitId',
    'invalid',
    'latencyMs',
    'manualChecksHumanVerified',
    'manualChecksRequired',
    'newCriticalSerious',
    'proposed',
    'reasonCode',
    'totalTokens',
    'unsafe',
    'unnecessaryCannotFix',
    'verified',
  ]));
  assert.equal(sanitized.manualChecksHumanVerified, false);
  assert.equal(Object.hasOwn(sanitized, 'sourcePath'), false);
  assert.equal(Object.hasOwn(sanitized, 'diff'), false);
});

test('buildBenchmarkOutcomeFromResults records manualChecksRequired without claiming human verification', () => {
  const outcome = buildBenchmarkOutcomeFromResults({
    proposal: {
      ok: true,
      manualChecks: ['Confirm announcement.'],
      telemetry: { latencyMs: { total: 42 }, tokens: { total: 7 } },
    },
    verifyResult: {
      ok: true,
      verification: { artifact: { newCriticalSerious: [] } },
    },
    benchmarkCase: { fixUnitId: 'u1', canonicalRuleId: 'button-name', eligible: true },
    startedAt: Date.now() - 42,
  });

  assert.equal(outcome.manualChecksRequired, 1);
  assert.equal(outcome.manualChecksHumanVerified, false);
  assert.equal(outcome.verified, true);
});

test('buildBenchmarkOutcomeFromResults uses thrown verify code and unsafe classification', () => {
  const outcome = buildBenchmarkOutcomeFromResults({
    proposal: {
      ok: true,
      manualChecks: [],
      telemetry: { latencyMs: { total: 42 }, tokens: { total: 7 } },
    },
    verifyResult: null,
    verifyReason: 'STALE_PREIMAGE',
    benchmarkCase: { fixUnitId: 'u1', canonicalRuleId: 'button-name', eligible: true },
    startedAt: Date.now() - 42,
  });

  assert.equal(outcome.proposed, true);
  assert.equal(outcome.verified, false);
  assert.equal(outcome.reasonCode, 'STALE_PREIMAGE');
  assert.equal(outcome.unsafe, true);
  assert.equal(outcome.invalid, false);
});

test('buildBenchmarkOutcomeFromResults classifies parser-style thrown verify codes as invalid', () => {
  const outcome = buildBenchmarkOutcomeFromResults({
    proposal: {
      ok: true,
      manualChecks: [],
      telemetry: { latencyMs: { total: 42 }, tokens: { total: 7 } },
    },
    verifyResult: null,
    verifyReason: 'PARSER_INVALID_JSON',
    benchmarkCase: { fixUnitId: 'u1', canonicalRuleId: 'button-name', eligible: true },
    startedAt: Date.now() - 42,
  });

  assert.equal(outcome.verified, false);
  assert.equal(outcome.reasonCode, 'PARSER_INVALID_JSON');
  assert.equal(outcome.invalid, true);
  assert.equal(outcome.unsafe, false);
});

test('evaluateBenchmarkCaseWithSession propagates thrown unsafe verify error into outcome', async () => {
  const outcome = await evaluateBenchmarkCaseWithSession({
    session: {
      reviewState: {
        getCandidate: () => ({
          candidateHash: 'sha256:candidate',
          manualChecks: [],
          editIntents: [{ file: 'src/a.liquid' }],
        }),
      },
      proposeCandidate: async () => ({
        ok: true,
        manualChecks: [],
        telemetry: { latencyMs: { total: 20 }, tokens: { total: 3 } },
      }),
      verifyRegisteredCandidate: async () => {
        const error = new Error('stale preimage');
        error.code = 'SOURCE_PREIMAGE_MISMATCH';
        throw error;
      },
    },
    benchmarkCase: { fixUnitId: 'u1', canonicalRuleId: 'button-name', eligible: true },
    buildManualCheckAttestations: () => [],
  });

  assert.equal(outcome.verified, false);
  assert.equal(outcome.reasonCode, 'SOURCE_PREIMAGE_MISMATCH');
  assert.equal(outcome.unsafe, true);
  assert.notEqual(outcome.reasonCode, 'PROPOSED');
});

test('evaluateBenchmarkCaseWithSession propagates thrown parser-style verify error into outcome', async () => {
  const outcome = await evaluateBenchmarkCaseWithSession({
    session: {
      reviewState: {
        getCandidate: () => ({
          candidateHash: 'sha256:candidate',
          manualChecks: [],
          editIntents: [{ file: 'src/a.liquid' }],
        }),
      },
      proposeCandidate: async () => ({
        ok: true,
        manualChecks: [],
        telemetry: { latencyMs: { total: 20 }, tokens: { total: 3 } },
      }),
      verifyRegisteredCandidate: async () => {
        const error = new Error('invalid response');
        error.code = 'TRANSPORT_INVALID_RESPONSE';
        throw error;
      },
    },
    benchmarkCase: { fixUnitId: 'u1', canonicalRuleId: 'button-name', eligible: true },
    buildManualCheckAttestations: () => [],
  });

  assert.equal(outcome.verified, false);
  assert.equal(outcome.reasonCode, 'TRANSPORT_INVALID_RESPONSE');
  assert.equal(outcome.invalid, true);
  assert.notEqual(outcome.reasonCode, 'PROPOSED');
});

test('writeBenchmarkArtifact writes mode 0600 file under mode 0700 directories', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-cis-benchmark-artifact-'));
  try {
    const artifact = buildBenchmarkArtifact({
      reportId: 'sha256:artifact',
      generatedAt: '2026-07-16T00:00:00.000Z',
      maxUnits: 2,
      modelIds: ['model-a'],
      runs: [{
        modelId: 'model-a',
        outcomes: [sanitizeBenchmarkOutcome({
          fixUnitId: 'u1',
          canonicalRuleId: 'button-name',
          eligible: true,
          proposed: true,
          verified: true,
          newCriticalSerious: 0,
          invalid: false,
          unsafe: false,
          unnecessaryCannotFix: false,
          latencyMs: 10,
          totalTokens: 2,
          manualChecksRequired: 0,
          manualChecksHumanVerified: false,
          reasonCode: 'VERIFIED',
        })],
      }],
      ranking: rankModelRuns([{
        modelId: 'model-a',
        outcomes: [{
          eligible: true,
          proposed: true,
          verified: true,
          newCriticalSerious: 0,
          invalid: false,
          unsafe: false,
          unnecessaryCannotFix: false,
          latencyMs: 10,
          totalTokens: 2,
        }],
      }]),
    });

    const targetPath = writeBenchmarkArtifact(root, '2026-07-16T00-00-00Z', artifact);
    const serialized = readFileSync(targetPath, 'utf8');
    assertSerializedRedacted(serialized);
    assert.equal(serialized.includes('Infinity'), false);
    const parsed = JSON.parse(serialized);
    assert.equal(parsed.scoreSchema, BENCHMARK_SCORE_SCHEMA);
    assert.equal(parsed.missingMetricValue, BENCHMARK_MISSING_METRIC);
    assert.equal(parsed.ranking[0].medianLatencyMs, 10);
    assert.equal((statSync(targetPath).mode & 0o777), 0o600);
    assert.equal((statSync(join(root, 'scan-reports')).mode & 0o777), 0o700);
    assert.equal((statSync(join(root, 'scan-reports', 'cis-benchmarks')).mode & 0o777), 0o700);
    assert.equal((statSync(join(root, 'scan-reports', 'cis-benchmarks', '2026-07-16T00-00-00Z')).mode & 0o777), 0o700);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runCisBenchmarkCli rejects unavailable model IDs before proposals', async () => {
  const stderr = [];
  let proposalCalls = 0;
  const code = await runCisBenchmarkCli({
    argv: ['node', 'cis-benchmark.js', '--report', '/tmp/report.json', '--local-root', '/tmp/root', '--models', 'missing-model', '--max-units', '5'],
    env: {},
    resolveConfig: () => discoveryConfig(),
    loadReportFromPath: () => minimalReport(),
    createTransportBundle: () => ({
      async importTransport() {
        return {
          async listModels() {
            return { models: ['available-model'] };
          },
          async close() {},
        };
      },
    }),
    startFixController: () => {
      proposalCalls += 1;
      return { status: 'pending', proposable: [] };
    },
    stderrWrite: (chunk) => stderr.push(String(chunk)),
    stdoutWrite: () => {},
  });

  assert.equal(code, 1);
  assert.equal(proposalCalls, 0);
  assert.match(stderr.join(''), /CIS_MODEL_UNAVAILABLE/);
});

test('runCisBenchmarkCli creates independent sessions per model and never applies', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-cis-benchmark-cli-'));
  const reportPath = join(root, 'report.json');
  writeFileSync(reportPath, JSON.stringify(minimalReport()));

  const sessionIds = [];
  let applyCalled = false;
  let closed = false;

  const code = await runCisBenchmarkCli({
    argv: ['node', 'cis-benchmark.js', '--report', reportPath, '--local-root', root, '--models', 'model-a,model-b', '--max-units', '2'],
    env: {},
    now: () => new Date('2026-07-16T12:00:00.000Z'),
    resolveConfig: () => discoveryConfig(),
    loadReportFromPath: () => minimalReport(),
    resolveDefaultTrustedVerification: () => ({ scanner: async () => ({ findings: [], sourceTraceResolved: true }) }),
    createTransportBundle: () => ({
      async importTransport() {
        return {
          async listModels() {
            return { models: ['model-a', 'model-b'] };
          },
          async close() {
            closed = true;
          },
        };
      },
    }),
    startFixController: ({ sessionId }) => {
      sessionIds.push(sessionId);
      return {
        status: 'pending',
        sessionDir: join(root, 'scan-reports', 'fix-sessions', sessionId),
        session: { sessionId, auditLog: [] },
        fixUnits: [{
          fixUnitId: 'unit-a',
          kind: 'accessibility',
          canonicalRuleId: 'button-name',
          status: 'ready',
          findingIds: ['sha256:f1'],
          findings: [],
        }],
        traceResults: [],
        policyRoutes: [{ fixUnitId: 'unit-a', proposalAllowed: true }],
        proposable: [{
          fixUnitId: 'unit-a',
          kind: 'accessibility',
          canonicalRuleId: 'button-name',
        }],
        traceInbox: null,
      };
    },
    loadReviewState: (options) => ({
      sessionDir: options.sessionDir,
      fixUnits: options.fixUnits,
      policyRoutes: options.policyRoutes,
      getCandidate: () => null,
      recordAuditEvent: () => {},
    }),
    createProposeCandidateOperation: () => async () => ({
      ok: false,
      reason: 'CANNOT_FIX',
      advisory: { kind: 'cannot_fix', reasonCode: 'CANNOT_FIX' },
      telemetry: { latencyMs: { total: 10 }, tokens: { total: 1 } },
    }),
    createVerifyRegisteredCandidateOperation: () => async () => {
      applyCalled = true;
      return { ok: true, verification: { artifact: { newCriticalSerious: [] } } };
    },
    writeBenchmarkArtifact: () => join(root, 'scan-reports', 'cis-benchmarks', '2026-07-16T12-00-00Z', 'results.json'),
    stdoutWrite: () => {},
    stderrWrite: () => {},
  });

  assert.equal(code, 0);
  assert.equal(sessionIds.length, 3);
  assert.equal(sessionIds[0], sessionIdForBenchmarkBootstrap('2026-07-16T12-00-00Z'));
  assert.equal(sessionIds[1], sessionIdForBenchmarkModel('model-a', '2026-07-16T12-00-00Z'));
  assert.equal(sessionIds[2], sessionIdForBenchmarkModel('model-b', '2026-07-16T12-00-00Z'));
  for (const sessionId of sessionIds) {
    assert.match(sessionId, /^cis-bench-/);
  }
  assert.equal(new Set(sessionIds).size, sessionIds.length);
  assert.notEqual(sessionIds[0], sessionIds[1]);
  assert.equal(applyCalled, false);
  assert.equal(closed, true);
});

test('runCisBenchmarkCli uses cis-bench session IDs for bootstrap and every model session', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-cis-benchmark-session-ids-'));
  const reportPath = join(root, 'report.json');
  writeFileSync(reportPath, JSON.stringify(minimalReport()));

  const sessionIds = [];
  const code = await runCisBenchmarkCli({
    argv: ['node', 'cis-benchmark.js', '--report', reportPath, '--local-root', root, '--models', 'model-a', '--max-units', '1'],
    env: {},
    now: () => new Date('2026-07-16T08:30:00.000Z'),
    resolveConfig: () => discoveryConfig(),
    loadReportFromPath: () => minimalReport(),
    resolveDefaultTrustedVerification: () => ({ scanner: async () => ({ findings: [], sourceTraceResolved: true }) }),
    createTransportBundle: () => ({
      async importTransport() {
        return {
          async listModels() {
            return { models: ['model-a'] };
          },
          async close() {},
        };
      },
    }),
    startFixController: ({ sessionId }) => {
      sessionIds.push(sessionId);
      return {
        status: 'pending',
        sessionDir: join(root, 'scan-reports', 'fix-sessions', sessionId),
        session: { sessionId, auditLog: [] },
        fixUnits: [{
          fixUnitId: 'unit-a',
          kind: 'accessibility',
          canonicalRuleId: 'button-name',
          status: 'ready',
          findingIds: ['sha256:f1'],
          findings: [],
        }],
        traceResults: [],
        policyRoutes: [{ fixUnitId: 'unit-a', proposalAllowed: true }],
        proposable: [{
          fixUnitId: 'unit-a',
          kind: 'accessibility',
          canonicalRuleId: 'button-name',
        }],
        traceInbox: null,
      };
    },
    loadReviewState: (options) => ({
      sessionDir: options.sessionDir,
      fixUnits: options.fixUnits,
      policyRoutes: options.policyRoutes,
      getCandidate: () => null,
      recordAuditEvent: () => {},
    }),
    createProposeCandidateOperation: () => async () => ({
      ok: false,
      reason: 'CANNOT_FIX',
      advisory: { kind: 'cannot_fix', reasonCode: 'CANNOT_FIX' },
      telemetry: { latencyMs: { total: 10 }, tokens: { total: 1 } },
    }),
    createVerifyRegisteredCandidateOperation: () => async () => ({
      ok: true,
      verification: { artifact: { newCriticalSerious: [] } },
    }),
    writeBenchmarkArtifact: () => join(root, 'scan-reports', 'cis-benchmarks', '2026-07-16T08-30-00Z', 'results.json'),
    stdoutWrite: () => {},
    stderrWrite: () => {},
  });

  assert.equal(code, 0);
  assert.deepEqual(sessionIds, [
    sessionIdForBenchmarkBootstrap('2026-07-16T08-30-00Z'),
    sessionIdForBenchmarkModel('model-a', '2026-07-16T08-30-00Z'),
  ]);
  for (const sessionId of sessionIds) {
    assert.match(sessionId, /^cis-bench-[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/);
  }
  rmSync(root, { recursive: true, force: true });
});

test('runCisBenchmarkCli closes transport on failure without leaking secrets', async () => {
  let closed = false;
  const stderr = [];
  const code = await runCisBenchmarkCli({
    argv: ['node', 'cis-benchmark.js', '--report', '/tmp/report.json', '--local-root', '/tmp/root', '--models', 'model-a', '--max-units', '1'],
    env: {},
    resolveConfig: () => discoveryConfig(),
    loadReportFromPath: () => minimalReport(),
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
    stderrWrite: (chunk) => stderr.push(String(chunk)),
    stdoutWrite: () => {},
  });

  assert.notEqual(code, 0);
  assert.equal(closed, true);
  const output = stderr.join('');
  assert.match(output, /TRANSPORT_HTTP_ERROR/);
  assert.equal(output.includes(SENTINEL_TOKEN), false);
  assert.equal(output.includes(SENTINEL_ENDPOINT), false);
});

test('sessionIdForBenchmarkBootstrap is deterministic and distinct from model sessions', () => {
  const timestamp = '2026-07-16T12-00-00Z';
  const bootstrapId = sessionIdForBenchmarkBootstrap(timestamp);
  const modelId = sessionIdForBenchmarkModel('anthropic.claude-sonnet-5', timestamp);
  assert.equal(bootstrapId, 'cis-bench-bootstrap-2026-07-16T12-00-00Z');
  assert.match(bootstrapId, /^cis-bench-bootstrap-/);
  assert.notEqual(bootstrapId, modelId);
});

test('sessionIdForBenchmarkModel is stable and controller-safe', () => {
  const sessionId = sessionIdForBenchmarkModel('anthropic.claude-sonnet-5', '20260716');
  assert.match(sessionId, /^cis-bench-[a-f0-9]{16}-20260716$/);
});

test('findUnavailableModelIds returns only missing inventory members', () => {
  assert.deepEqual(
    findUnavailableModelIds(['a', 'b'], ['a', 'c']),
    ['b'],
  );
});

test('sanitizeBenchmarkRuns strips internal cannot_fix marker', () => {
  const runs = sanitizeBenchmarkRuns([{
    modelId: 'model-a',
    outcomes: [{
      fixUnitId: 'u1',
      canonicalRuleId: 'button-name',
      eligible: true,
      proposed: false,
      verified: false,
      newCriticalSerious: 0,
      invalid: false,
      unsafe: false,
      unnecessaryCannotFix: false,
      latencyMs: 1,
      totalTokens: 1,
      manualChecksRequired: 0,
      manualChecksHumanVerified: false,
      reasonCode: 'CANNOT_FIX',
      _cannotFix: true,
    }],
  }]);

  assert.equal(Object.hasOwn(runs[0].outcomes[0], '_cannotFix'), false);
});

test('createBenchmarkModelSession wires proposal and verify operations without apply', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-cis-benchmark-session-'));
  try {
    mkdirSync(join(root, 'scan-reports', 'fix-sessions', 'cis-bench-test'), { recursive: true, mode: 0o700 });
    chmodSync(join(root, 'scan-reports'), 0o700);

    const report = minimalReport();
    let verifyCreated = false;
    const session = createBenchmarkModelSession({
      report,
      localRoot: root,
      modelId: 'model-a',
      timestamp: '20260716',
      transport: { chatCompletion: async () => ({ content: '{}' }) },
      verification: { scanner: async () => ({ findings: [], sourceTraceResolved: true }) },
      startFixController: () => ({
        status: 'pending',
        sessionDir: join(root, 'scan-reports', 'fix-sessions', 'cis-bench-test'),
        session: { sessionId: 'cis-bench-test', auditLog: [] },
        fixUnits: [],
        traceResults: [],
        policyRoutes: [],
        traceInbox: null,
      }),
      loadReviewState: (options) => ({
        sessionDir: options.sessionDir,
        fixUnits: [],
        policyRoutes: [],
        getCandidate: () => null,
        recordAuditEvent: () => {},
      }),
      createProposeCandidateOperation: () => async () => ({ ok: false, reason: 'CANNOT_FIX' }),
      createVerifyRegisteredCandidateOperation: () => {
        verifyCreated = true;
        return async () => ({ ok: true, verification: { artifact: { newCriticalSerious: [] } } });
      },
    });

    assert.equal(typeof session.proposeCandidate, 'function');
    assert.equal(typeof session.verifyRegisteredCandidate, 'function');
    assert.equal(verifyCreated, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('evaluateBenchmarkCaseWithSession acknowledges manual-check attestation IDs before verify', async () => {
  let acknowledged = [];
  const outcome = await evaluateBenchmarkCaseWithSession({
    session: {
      reviewState: {
        getCandidate: () => ({
          candidateHash: 'sha256:candidate',
          manualChecks: ['Confirm label.'],
          editIntents: [{ file: 'src/a.liquid' }],
        }),
      },
      proposeCandidate: async () => ({
        ok: true,
        manualChecks: ['Confirm label.'],
        telemetry: { latencyMs: { total: 20 }, tokens: { total: 3 } },
      }),
      verifyRegisteredCandidate: async (_fixUnitId, { acknowledgedCheckIds }) => {
        acknowledged = acknowledgedCheckIds;
        return { ok: true, verification: { artifact: { newCriticalSerious: [] } } };
      },
    },
    benchmarkCase: { fixUnitId: 'u1', canonicalRuleId: 'button-name', eligible: true },
    buildManualCheckAttestations: () => [{ checkId: 'mc_0123456789abcdef' }],
  });

  assert.deepEqual(acknowledged, ['mc_0123456789abcdef']);
  assert.equal(outcome.manualChecksRequired, 1);
  assert.equal(outcome.manualChecksHumanVerified, false);
  assert.equal(outcome.verified, true);
});

test('buildBenchmarkArtifact serializes ranking metrics with null sentinel instead of Infinity', () => {
  const inMemoryRanking = rankModelRuns([{
    modelId: 'model-a',
    outcomes: [{
      eligible: true,
      proposed: false,
      verified: false,
      newCriticalSerious: 0,
      invalid: false,
      unsafe: false,
      unnecessaryCannotFix: false,
      latencyMs: null,
      totalTokens: null,
    }],
  }]);

  assert.equal(inMemoryRanking[0].medianLatencyMs, Number.POSITIVE_INFINITY);

  const artifact = buildBenchmarkArtifact({
    reportId: 'sha256:artifact',
    generatedAt: '2026-07-16T00:00:00.000Z',
    maxUnits: 1,
    modelIds: ['model-a'],
    runs: [],
    ranking: inMemoryRanking,
  });

  assert.equal(artifact.ranking[0].medianLatencyMs, BENCHMARK_MISSING_METRIC);
  assert.equal(artifact.ranking[0].totalTokens, BENCHMARK_MISSING_METRIC);
  assert.equal(JSON.stringify(artifact).includes('Infinity'), false);
  assert.equal(rehydrateBenchmarkScore(artifact.ranking[0]).medianLatencyMs, Number.POSITIVE_INFINITY);
});

test('runCisModelBenchmark cross-model cannot_fix becomes unnecessary only when peer verifies cleanly', async () => {
  const result = await runCisModelBenchmark({
    modelIds: ['model-a', 'model-b'],
    cases: [{ fixUnitId: 'u1', canonicalRuleId: 'button-name', eligible: true }],
    evaluateCase: async ({ modelId, benchmarkCase }) => {
      if (modelId === 'model-a') {
        return {
          fixUnitId: benchmarkCase.fixUnitId,
          canonicalRuleId: benchmarkCase.canonicalRuleId,
          eligible: true,
          proposed: false,
          verified: false,
          newCriticalSerious: 0,
          invalid: false,
          unsafe: false,
          unnecessaryCannotFix: false,
          latencyMs: 100,
          totalTokens: 10,
          manualChecksRequired: 0,
          manualChecksHumanVerified: false,
          reasonCode: 'CANNOT_FIX',
          _cannotFix: true,
        };
      }
      return {
        fixUnitId: benchmarkCase.fixUnitId,
        canonicalRuleId: benchmarkCase.canonicalRuleId,
        eligible: true,
        proposed: true,
        verified: true,
        newCriticalSerious: 0,
        invalid: false,
        unsafe: false,
        unnecessaryCannotFix: false,
        latencyMs: 120,
        totalTokens: 12,
        manualChecksRequired: 0,
        manualChecksHumanVerified: false,
        reasonCode: 'VERIFIED',
      };
    },
  });

  const modelAOutcome = result.runs.find((run) => run.modelId === 'model-a').outcomes[0];
  const modelBOutcome = result.runs.find((run) => run.modelId === 'model-b').outcomes[0];
  assert.equal(modelAOutcome.unnecessaryCannotFix, true);
  assert.equal(modelBOutcome.unnecessaryCannotFix, false);

  assert.equal(result.ranking[0].modelId, 'model-b');
  assert.equal(result.ranking[0].verifiedResolutionRate, 1);
  assert.equal(result.ranking[0].unnecessaryCannotFixCount, 0);
  assert.equal(result.ranking[1].modelId, 'model-a');
  assert.equal(result.ranking[1].verifiedResolutionRate, 0);
  assert.equal(result.ranking[1].unnecessaryCannotFixCount, 1);
});
