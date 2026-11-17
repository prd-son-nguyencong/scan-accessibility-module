import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { buildInstrumented } from '../src/tracer/build-instrumented.js';
import { startDevServer } from '../src/utils/server.js';

const probe = fileURLToPath(new URL('./helpers/group-probe.mjs', import.meta.url));
const harness = fileURLToPath(new URL('./helpers/group-harness.mjs', import.meta.url));
const cmd = `${process.execPath} ${probe}`;

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(fn, ms = 8000) {
  for (let t = 0; t < ms; t += 50) { if (fn()) return true; await sleep(50); }
  return false;
}
function pidFile() {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'ada-grp-')), 'pid');
  return { file, read: () => (existsSync(file) ? Number(readFileSync(file, 'utf8')) : null) };
}

test('build timeout kills the grandchild too', async () => {
  const p = pidFile();
  process.env.GROUP_PIDFILE = p.file;
  await assert.rejects(buildInstrumented(true, { buildCommand: cmd, buildTimeoutMs: 800 }), /timed out after 800ms/);
  const gc = p.read();
  assert.ok(gc, 'grandchild pid recorded');
  assert.ok(await until(() => !alive(gc)), 'grandchild must be dead');
});

test('SIGTERM to the scanner kills the build group; a second signal is harmless', async () => {
  const p = pidFile();
  const proc = spawn(process.execPath, [harness], { env: { ...process.env, GROUP_PIDFILE: p.file }, stdio: 'ignore' });
  assert.ok(await until(() => p.read()), 'grandchild started');
  const gc = p.read();
  const exited = new Promise((r) => proc.once('exit', (code, sig) => r({ code, sig })));
  proc.kill('SIGTERM');
  proc.kill('SIGTERM');
  const { code } = await exited;
  assert.equal(code, 143);
  assert.ok(await until(() => !alive(gc)), 'grandchild must be dead');
});

test('startDevServer times out clearly and leaves no orphan', async () => {
  const p = pidFile();
  process.env.GROUP_PIDFILE = p.file;
  await assert.rejects(
    startDevServer({ devCommand: cmd, baseUrl: 'http://localhost:1', devServerTimeoutMs: 800 }),
    /Dev server not ready within 800ms/
  );
  const gc = p.read();
  assert.ok(gc);
  assert.ok(await until(() => !alive(gc)), 'grandchild must be dead');
});
