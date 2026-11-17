import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCisDemo, DemoSandboxError, DEFAULT_DEMO_SESSION_ID_PATTERN, generateDefaultDemoSessionId } from '../../src/fix/demo/orchestrator.js';
import { runDemoSubcommand } from '../../src/index.js';
import { FixControllerError } from '../../src/fix/controller/session.js';

function mockReport(targetFile) {
  return {
    reportId: 'demo-report-fixture',
    pages: [{
      findings: [{
        findingId: 'sha256:demo',
        source: { file: targetFile, line: 1 },
      }],
    }],
  };
}

function writeMinimalProject(root) {
  mkdirSync(join(root, 'src', 'pages'), { recursive: true });
  writeFileSync(join(root, 'src', 'pages', 'index.liquid'), '<div id="page">Home</div>\n');
  mkdirSync(join(root, 'ada-scan', 'bin'), { recursive: true });
  writeFileSync(join(root, 'ada-scan', 'bin', 'ada-scan.js'), '#!/usr/bin/env node\n');
}

test('runCisDemo wires trusted fix options without writing original source', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-demo-orchestrator-'));
  try {
    writeMinimalProject(root);
    const originalBefore = '<div id="page">Home</div>\n';
    let trustedArgs = null;
    const report = mockReport('src/pages/index.liquid');

    const result = await runCisDemo({
      originalRoot: root,
      targetFile: 'src/pages/index.liquid',
      sessionId: 'demo-orchestrator',
      route: '/',
      useUI: false,
    }, {
      applyHandlerWrap: null,
      prepareDemoSandbox: async () => ({
        originalRoot: root,
        sessionDir: join(root, 'scan-reports', 'fix-sessions', 'demo-orchestrator'),
        sandboxRoot: join(root, 'scan-reports', 'fix-sessions', 'demo-orchestrator', 'demo-workspace'),
        artifactsDir: join(root, 'scan-reports', 'fix-sessions', 'demo-orchestrator', 'artifacts'),
        targetFile: 'src/pages/index.liquid',
        checkpoints: {
          original: { fileSha256: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
          sandbox: { fileSha256: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
        },
        copy: { fileCount: 1, totalBytes: 10 },
      }),
      runFreshSandboxScan: async () => ({ report }),
      runTrustedFixCli: async (options) => {
        trustedArgs = options;
        return { status: 'pending', reason: 'REVIEW_UI_PENDING' };
      },
    });

    assert.equal(trustedArgs.report, report);
    assert.equal(trustedArgs.localRoot, join(root, 'scan-reports', 'fix-sessions', 'demo-orchestrator', 'demo-workspace'));
    assert.equal(trustedArgs.sessionRoot, root);
    assert.equal(trustedArgs.sessionId, 'demo-orchestrator');
    assert.equal(trustedArgs.targetSourceFile, 'src/pages/index.liquid');
    assert.equal(trustedArgs.useUI, false);
    assert.equal(trustedArgs.verification, null);
    assert.equal(trustedArgs.postVerify, undefined);
    assert.equal(trustedArgs.applyHandlerWrap, null);
    assert.equal(trustedArgs.sandboxContext?.enabled, true);
    assert.equal(trustedArgs.sandboxContext?.targetFile, 'src/pages/index.liquid');
    assert.equal(typeof trustedArgs.rollbackHandler, 'function');
    assert.equal(result.review.status, 'pending');
    assert.equal(result.sessionId, 'demo-orchestrator');
    assert.equal(result.originalRoot, root);
    assert.equal(result.artifactsDir, 'artifacts');
    assert.deepEqual(result.artifactPaths, {
      patch: 'artifacts/candidate.patch',
      fixed: 'artifacts/fixed/src/pages/index.liquid',
      evidence: 'artifacts/evidence.json',
    });
    assert.equal(result.artifacts, undefined);
    assert.equal(result.artifactError, undefined);
    assert.match(result.checkpoints.original.fileSha256, /^sha256:/);
    assert.equal(JSON.stringify(result).includes('CIS_AUTH_TOKEN'), false);
    assert.equal(readFileSync(join(root, 'src/pages/index.liquid'), 'utf8'), originalBefore);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runCisDemo forwards postVerify and cisTransportFactory to trusted fix cli', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-demo-orchestrator-'));
  try {
    writeMinimalProject(root);
    const report = mockReport('src/pages/index.liquid');
    const postVerify = async () => ({ ok: true, reason: 'POST_VERIFY_PASSED', unitResults: [] });
    const cisTransportFactory = () => ({ async chatCompletion() { return { content: '{}' }; } });
    let trustedArgs = null;

    await runCisDemo({
      originalRoot: root,
      targetFile: 'src/pages/index.liquid',
      sessionId: 'demo-orchestrator-trusted-options',
      route: '/',
      useUI: false,
    }, {
      applyHandlerWrap: null,
      prepareDemoSandbox: async () => ({
        originalRoot: root,
        sessionDir: join(root, 'scan-reports', 'fix-sessions', 'demo-orchestrator-trusted-options'),
        sandboxRoot: join(root, 'scan-reports', 'fix-sessions', 'demo-orchestrator-trusted-options', 'demo-workspace'),
        artifactsDir: join(root, 'scan-reports', 'fix-sessions', 'demo-orchestrator-trusted-options', 'artifacts'),
        targetFile: 'src/pages/index.liquid',
        checkpoints: {
          original: { fileSha256: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
          sandbox: { fileSha256: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
        },
        copy: { fileCount: 1, totalBytes: 10 },
      }),
      runFreshSandboxScan: async () => ({ report }),
      runTrustedFixCli: async (options) => {
        trustedArgs = options;
        return { status: 'pending', reason: 'REVIEW_UI_PENDING' };
      },
      postVerify,
      cisTransportFactory,
      cisModel: 'anthropic.claude-sonnet-5',
    });

    assert.equal(trustedArgs.postVerify, postVerify);
    assert.equal(trustedArgs.cisTransportFactory, cisTransportFactory);
    assert.equal(trustedArgs.cisModel, 'anthropic.claude-sonnet-5');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runCisDemo rejects reports without target-file findings', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-demo-orchestrator-'));
  try {
    writeMinimalProject(root);
    const report = mockReport('src/partials/layout/header.liquid');

    await assert.rejects(
      () => runCisDemo({
        originalRoot: root,
        targetFile: 'src/pages/index.liquid',
        sessionId: 'demo-no-findings',
        route: '/',
      }, {
        applyHandlerWrap: null,
        prepareDemoSandbox: async () => ({
          originalRoot: root,
          sessionDir: join(root, 'scan-reports', 'fix-sessions', 'demo-no-findings'),
          sandboxRoot: join(root, 'scan-reports', 'fix-sessions', 'demo-no-findings', 'demo-workspace'),
          artifactsDir: join(root, 'scan-reports', 'fix-sessions', 'demo-no-findings', 'artifacts'),
          targetFile: 'src/pages/index.liquid',
          checkpoints: {
            original: { fileSha256: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
            sandbox: { fileSha256: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
          },
          copy: { fileCount: 1, totalBytes: 10 },
        }),
        runFreshSandboxScan: async () => ({ report }),
        runTrustedFixCli: async () => {
          throw new Error('runTrustedFixCli should not be called');
        },
      }),
      (error) => error instanceof DemoSandboxError && error.code === 'DEMO_NO_TARGET_FINDINGS',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('generateDefaultDemoSessionId includes random hex suffix and explicit ids stay caller-controlled', () => {
  const generated = generateDefaultDemoSessionId(1_700_000_000_000);
  assert.match(generated, DEFAULT_DEMO_SESSION_ID_PATTERN);
  assert.equal(generated.startsWith('demo-1700000000000-'), true);
  assert.notEqual(generateDefaultDemoSessionId(1_700_000_000_000), generateDefaultDemoSessionId(1_700_000_000_000));
});

test('runCisDemo uses generated session id when none is provided', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-demo-orchestrator-'));
  try {
    writeMinimalProject(root);
    const result = await runCisDemo({
      originalRoot: root,
      targetFile: 'src/pages/index.liquid',
      route: '/',
    }, {
      applyHandlerWrap: null,
      prepareDemoSandbox: async ({ sessionId }) => ({
        originalRoot: root,
        sessionDir: join(root, 'scan-reports', 'fix-sessions', sessionId),
        sandboxRoot: join(root, 'scan-reports', 'fix-sessions', sessionId, 'demo-workspace'),
        artifactsDir: join(root, 'scan-reports', 'fix-sessions', sessionId, 'artifacts'),
        targetFile: 'src/pages/index.liquid',
        checkpoints: {
          original: { fileSha256: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
          sandbox: { fileSha256: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
        },
        copy: { fileCount: 1, totalBytes: 10 },
      }),
      runFreshSandboxScan: async () => ({ report: mockReport('src/pages/index.liquid') }),
      runTrustedFixCli: async () => ({ status: 'pending', reason: 'REVIEW_UI_PENDING' }),
    });
    assert.match(result.sessionId, DEFAULT_DEMO_SESSION_ID_PATTERN);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runDemoSubcommand rejects missing --file and empty flag values', async () => {
  await assert.rejects(
    () => runDemoSubcommand([]),
    (error) => error instanceof FixControllerError && error.code === 'DEMO_FILE_REQUIRED',
  );
  await assert.rejects(
    () => runDemoSubcommand(['--file']),
    (error) => error instanceof FixControllerError && error.code === 'DEMO_FILE_REQUIRED',
  );
  await assert.rejects(
    () => runDemoSubcommand(['--file', 'src/pages/index.liquid', '--source']),
    (error) => error instanceof FixControllerError && error.code === 'DEMO_SOURCE_REQUIRED',
  );
});
