import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTrustedCommand, TrustedCommandError } from '../../src/fix/verify/command.js';
import { resolveTrustedVerificationConfig } from '../../src/fix/verify/config.js';
import { buildVerificationKey, compareVerificationFindings } from '../../src/fix/verify/verification-key.js';
import {
  assertSiteRootContained,
  createStaticSiteAdapter,
  createViteSiteAdapter,
} from '../../src/fix/verify/site.js';
import { createTrustedVerificationAdapters } from '../../src/fix/verify/adapters.js';
import { sanitizeCisTelemetryRecord, evaluateCisCallBudget, nearestRankP95 } from '../../src/fix/cis/telemetry.js';
import { resolveTrustedCisConfig } from '../../src/fix/cis/config.js';
import { evaluateAuditCoverage, SUCCESS_PATH_AUDIT_TYPES } from '../../src/fix/audit/coverage.js';
import {
  evaluateSafetyGate,
  evaluateQualityGate,
  evaluateOperationalGate,
  evaluateTracePrecision,
} from '../../src/fix/eval/poc-gates.js';

test('parseTrustedCommand rejects shell metacharacters', () => {
  assert.throws(
    () => parseTrustedCommand('npm run build; rm -rf /'),
    (error) => error instanceof TrustedCommandError && error.code === 'COMMAND_SHELL_METACHAR',
  );
});

test('parseTrustedCommand rejects interpreter -e/-c invocations', () => {
  assert.throws(
    () => parseTrustedCommand({ command: 'bash', args: ['-c', 'echo hi'] }),
    (error) => error instanceof TrustedCommandError && error.code === 'COMMAND_INTERPRETER_DENIED',
  );
  assert.throws(
    () => parseTrustedCommand({ command: 'node', args: ['-e', 'process.exit(0)'] }),
    (error) => error instanceof TrustedCommandError && error.code === 'COMMAND_INTERPRETER_DENIED',
  );
  assert.throws(
    () => parseTrustedCommand({ command: 'python3', args: ['-c', 'print(1)'] }),
    (error) => error instanceof TrustedCommandError && error.code === 'COMMAND_INTERPRETER_DENIED',
  );
});

test('resolveTrustedVerificationConfig reads build and install commands from scan config', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-verify-config-'));
  try {
    writeFileSync(join(root, '.scan-config.json'), JSON.stringify({
      outDir: 'dist',
      verifyBuildCommand: ['node', 'scripts/build.js'],
      verifyInstallCommand: ['pnpm', 'install', '--offline'],
    }));
    const config = resolveTrustedVerificationConfig(root);
    assert.equal(config.ok, true);
    assert.deepEqual(config.build, { command: 'node', args: ['scripts/build.js'] });
    assert.deepEqual(config.prepare, { command: 'pnpm', args: ['install', '--offline'] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('verification key prefers stable selector over source line', () => {
  const left = {
    canonicalRuleId: 'button-name',
    route: '/',
    pageState: 'initial',
    selector: '#apply',
    source: { file: 'src/a.liquid', line: 3, preimageSha256: 'sha256:aaa' },
  };
  const right = {
    ...left,
    source: { ...left.source, line: 8, preimageSha256: 'sha256:bbb' },
  };
  assert.equal(buildVerificationKey(left), buildVerificationKey(right));
});

test('compareVerificationFindings resolves targets by selector when findingId changes', () => {
  const baseline = [{
    findingId: 'sha256:old',
    canonicalRuleId: 'button-name',
    route: '/',
    pageState: 'initial',
    selector: '#apply',
    impact: 'critical',
  }];
  const after = [{
    findingId: 'sha256:new',
    canonicalRuleId: 'button-name',
    route: '/',
    pageState: 'initial',
    selector: '#apply',
    impact: 'critical',
  }];
  const delta = compareVerificationFindings(baseline, [], ['sha256:old']);
  assert.equal(delta.targetsResolved, true);
  const regression = compareVerificationFindings(baseline, after, ['sha256:old']);
  assert.equal(regression.targetsResolved, false);
});

test('static site adapter binds loopback and serves contained files', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-static-site-'));
  const outDir = join(root, 'dist');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'index.html'), '<html><body>ok</body></html>');
  try {
    assert.equal(assertSiteRootContained(root, 'dist'), true);
    const site = createStaticSiteAdapter({ outDir: 'dist' });
    const handle = await site.start(root);
    assert.match(handle.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    const response = await fetch(new URL('index.html', handle.url));
    assert.equal(response.status, 200);
    assert.match(await response.text(), /ok/);
    await handle.stop();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Vite site adapter renders a full document from the shadow root', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-vite-site-'));
  writeFileSync(
    join(root, 'index.html'),
    '<!doctype html><html lang="en"><head><title>Shadow</title></head><body>rendered</body></html>',
  );
  writeFileSync(join(root, 'vite.config.js'), 'export default {};\n');
  writeFileSync(join(root, '.scan-config.json'), '{}\n');

  let handle = null;
  try {
    handle = await createViteSiteAdapter().start(root);
    assert.match(handle.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    assert.equal(handle.context.mode, 'vite');
    const response = await fetch(handle.url);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /<html lang="en">/);
  } finally {
    await handle?.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test('createTrustedVerificationAdapters uses injectable overrides in tests', () => {
  const scanner = async () => ({ findings: [], sourceTraceResolved: true, executedLayers: ['axe', 'accessScan'] });
  const adapters = createTrustedVerificationAdapters('/tmp', {
    overrides: {
      build: { command: 'node', args: ['build.js'] },
      scanner,
      site: { start: async () => ({ url: 'http://127.0.0.1:9/', stop: async () => {} }) },
      commandEnv: {},
    },
  });
  assert.equal(typeof adapters.scanner, 'function');
});

test('createTrustedVerificationAdapters selects Vite serving for Vite projects', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-vite-adapters-'));
  writeFileSync(
    join(root, 'index.html'),
    '<!doctype html><html lang="en"><head><title>Shadow</title></head><body>rendered</body></html>',
  );
  writeFileSync(join(root, 'vite.config.js'), 'export default {};\n');
  writeFileSync(join(root, '.scan-config.json'), '{}\n');

  let handle = null;
  try {
    const adapters = createTrustedVerificationAdapters(root);
    handle = await adapters.site.start(root);
    assert.equal(handle.context.mode, 'vite');
  } finally {
    await handle?.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test('CIS telemetry sanitizer rejects forbidden fields', () => {
  assert.throws(
    () => sanitizeCisTelemetryRecord({ messages: ['secret'] }),
    /forbidden field/,
  );
  const sanitized = sanitizeCisTelemetryRecord({
    sessionCalls: 2,
    outcome: 'proposed',
    latencyMs: { total: 10, calls: [5, 5] },
    tokens: { prompt: 1, completion: 2, total: 3 },
  });
  assert.equal(sanitized.sessionCalls, 2);
  assert.equal(sanitized.tokens.total, 3);
});

test('evaluateCisCallBudget requires non-empty corpus and p95 <= 2', () => {
  assert.equal(evaluateCisCallBudget([], 2).ok, false);
  assert.equal(evaluateCisCallBudget([{ sessionCalls: 3 }], 2).ok, false);
  assert.equal(evaluateCisCallBudget([{ sessionCalls: 1 }, { sessionCalls: 2 }], 2).ok, true);
  assert.equal(nearestRankP95([1, 2, 2, 2]), 2);
});

test('resolveTrustedCisConfig fails closed without env', () => {
  const result = resolveTrustedCisConfig({});
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'CIS_CONFIG_MISSING');
});

test('audit coverage helper rejects missing required events', () => {
  const result = evaluateAuditCoverage([{ type: 'proposal_registered', at: new Date().toISOString() }]);
  assert.equal(result.ok, false);
});

test('PoC safety gate rejects zero stale denominator and log leaks', () => {
  assert.equal(evaluateSafetyGate({ staleAttempts: 0, wrongCandidateAttempts: 1 }).ok, false);
  assert.equal(evaluateSafetyGate({
    staleRejections: 1,
    staleAttempts: 1,
    wrongCandidateRejections: 1,
    wrongCandidateAttempts: 1,
    logs: 'CIS_AUTH_TOKEN=secret',
  }).ok, false);
});

test('PoC quality gate rejects small trace corpus', () => {
  const result = evaluateQualityGate({ traceCases: new Array(10).fill({ ambiguous: false, expectedFile: 'a', actualFile: 'a', expectedLine: 1, actualLine: 1 }) });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'TRACE_CORPUS_TOO_SMALL');
});

test('PoC quality gate accepts >=99% precision on 100-case corpus', () => {
  const traceCases = Array.from({ length: 100 }, (_item, index) => ({
    ambiguous: false,
    expectedFile: 'src/a.liquid',
    actualFile: index === 99 ? 'src/a.liquid' : 'src/a.liquid',
    expectedLine: 1,
    actualLine: 1,
  }));
  const result = evaluateQualityGate({
    traceCases,
    acceptedBuildExitCodes: [0],
    detectorTargets: Array.from({ length: 10 }, () => ({ canonicalRuleId: 'button-name', route: '/', pageState: 'initial', selector: '#x' })),
    detectorDetected: Array.from({ length: 10 }, () => ({ canonicalRuleId: 'button-name', route: '/', pageState: 'initial', selector: '#x' })),
    newCriticalSerious: [],
    manualChecksRetained: true,
    manualChecksAcknowledged: true,
    unitFindingIds: ['f1'],
  });
  assert.equal(result.ok, true);
});

test('PoC operational gate rejects over-budget telemetry', () => {
  const fail = evaluateOperationalGate({
    telemetryRecords: [{ sessionCalls: 3, outcome: 'proposed', tokens: { total: 1 } }],
    auditLog: [],
    leftoverArtifacts: [],
  });
  assert.equal(fail.ok, false);
});

test('evaluateTracePrecision accepts 99/100 at >=99% threshold', () => {
  const cases = Array.from({ length: 100 }, (_v, index) => ({
    ambiguous: false,
    expectedFile: 'src/a.liquid',
    expectedLine: 1,
    actualFile: index === 0 ? 'src/b.liquid' : 'src/a.liquid',
    actualLine: 1,
  }));
  assert.equal(evaluateTracePrecision(cases).ok, true);
});

test('evaluateTracePrecision rejects 98/100 below threshold', () => {
  const cases = Array.from({ length: 100 }, (_v, index) => ({
    ambiguous: false,
    expectedFile: 'src/a.liquid',
    expectedLine: 1,
    actualFile: index < 2 ? 'src/b.liquid' : 'src/a.liquid',
    actualLine: 1,
  }));
  assert.equal(evaluateTracePrecision(cases).ok, false);
});
