import './helpers/hermetic-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startParadoxSite } from './helpers/paradox-site-server.js';

const moduleUrl = new URL('../src/tracer/build-instrumented.js', import.meta.url).href;

// ROOT is fixed at import time, so each case runs in a child rooted at a temp project.
function tryBuild(pkg, config = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'ada-build-fallback-'));
  try {
    if (pkg) writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg));
    const code = `import('${moduleUrl}').then(async (m) => console.log(JSON.stringify(await m.tryBuildInstrumented(true, ${JSON.stringify(config)}))))`;
    const r = spawnSync(process.execPath, ['-e', code], {
      cwd: dir, encoding: 'utf8', env: { ...process.env, ADA_SCAN_ROOT: dir, BUILD_PROBE: '' },
    });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout.trim().split('\n').pop());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('no package.json: no build attempted, tracing unavailable', () => {
  const out = tryBuild(null);
  assert.match(out.unavailable, /no package\.json with a build script/);
  assert.equal(out.attestation, null);
});

test('package.json without a build script: no build attempted', () => {
  assert.match(tryBuild({ scripts: { test: 'x' } }).unavailable, /no package\.json with a build script/);
});

test('failing build is reported, not thrown', () => {
  const out = tryBuild({ scripts: { build: 'x' } }, { buildCommand: `${process.execPath} -e process.exit(3)` });
  assert.match(out.unavailable, /Instrumented build failed \(exit 3\)/);
});

test('passing build leaves tracing available', () => {
  const out = tryBuild({ scripts: { build: 'x' } }, { buildCommand: `${process.execPath} -e 0` });
  assert.equal(out.unavailable, null);
  assert.equal(out.attestation.status, 'missing-instrumentation');
});

// End to end: a local-URL scan from a cwd without a build script degrades to an untraced scan.
test('CLI: local URL without a build script warns and strips sources; --require-trace exits 2', async () => {
  const site = await startParadoxSite();
  const cwd = mkdtempSync(path.join(tmpdir(), 'ada-cli-notrace-'));
  const bin = new URL('../bin/ada-scan.js', import.meta.url).pathname;
  // async: the fixture server lives in this process, so a sync spawn would block it.
  const scan = (extra) => promisify(execFile)(process.execPath, [bin, '--url', `${site.url}/`, '--layers', 'axe', '--no-reverify', '--out-dir', path.join(cwd, 'out'), ...extra], {
    cwd, encoding: 'utf8', timeout: 180000, env: { ...process.env, ADA_SCAN_ROOT: cwd },
  }).then((o) => ({ status: 0, ...o }), (e) => ({ status: e.code, stdout: e.stdout || '', stderr: e.stderr || '' }));
  try {
    const strict = await scan(['--require-trace']);
    assert.equal(strict.status, 2, strict.stdout + strict.stderr);
    assert.match(strict.stdout + strict.stderr, /source tracing unavailable/);

    const r = await scan([]);
    assert.ok([0, 1].includes(r.status), r.stdout + r.stderr);
    assert.match(r.stdout + r.stderr, /source tracing unavailable/);
    const report = JSON.parse(readFileSync(path.join(cwd, 'out', 'latest.json'), 'utf8'));
    assert.equal(report.runMetadata.sourceTracing.status, 'unavailable');
    const findings = report.pages.flatMap((p) => p.findings || p.violations || []);
    assert.ok(findings.length > 0, 'fixture should yield findings');
    for (const f of findings) {
      // the report normalizer adds null fields; what matters is no guessed path
      assert.deepEqual([f.source.mode, f.source.method, f.source.file, f.source.line, f.source.confidence], ['url', 'unavailable', null, null, 'none']);
      assert.equal(f.sourceCandidates, undefined);
    }
  } finally {
    await site.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});
