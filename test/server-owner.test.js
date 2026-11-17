import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, symlinkSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { ensureServer, listenerCwds, serverOwner } from '../src/utils/server.js';
import { getProjectRoot } from '../src/utils/paths.js';
import { CliError } from '../src/utils/cli-args.js';

const hasLsof = (() => { try { execFileSync('lsof', ['-v'], { stdio: 'ignore' }); return true; } catch (e) { return e.code !== 'ENOENT'; } })();

test('serverOwner: inside the root is own, a sibling sharing a name prefix is foreign', () => {
  const root = '/Users/x/Documents/local-career-site';
  assert.equal(serverOwner(root, [{ pid: '1', cwd: root }]), 'own');
  assert.equal(serverOwner(root, [{ pid: '1', cwd: `${root}/packages/web` }]), 'own');
  assert.equal(serverOwner(root, [{ pid: '1', cwd: `${root}-italy` }]), 'foreign');
  assert.equal(serverOwner(root, [{ pid: '1', cwd: '/' }]), 'foreign');
});

test('serverOwner: unknown listeners are unknown, any own listener wins', () => {
  const root = '/a/site';
  assert.equal(serverOwner(root, null), 'unknown');
  assert.equal(serverOwner(root, [{ pid: '1', cwd: '/b' }, { pid: '2', cwd: '/a/site' }]), 'own');
});

test('serverOwner follows symlinks on both sides', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'owner-'));
  const realRoot = path.join(dir, 'real');
  mkdirSync(realRoot);
  symlinkSync(realRoot, path.join(dir, 'link'));
  assert.equal(serverOwner(path.join(dir, 'link'), [{ pid: '1', cwd: realRoot }]), 'own');
  rmSync(dir, { recursive: true, force: true });
});

test('listenerCwds parses lsof output, dedupes pids and returns null when anything is unreadable', () => {
  const ok = (a) => (a.includes('-Fp') ? 'p10\nf29\np10\nf30\n' : 'p10\nfcwd\nn/some/dir\n');
  assert.deepEqual(listenerCwds(1234, ok), [{ pid: '10', cwd: '/some/dir' }]);
  assert.equal(listenerCwds(1234, () => { throw new Error('no lsof'); }), null);
  assert.equal(listenerCwds(1234, (a) => (a.includes('-Fp') ? '' : 'x')), null);
  assert.equal(listenerCwds(1234, (a) => (a.includes('-Fp') ? 'p10\n' : 'p10\nfcwd\n')), null);
});

// A server on 127.0.0.1 (never `localhost`: fetch could try ::1 first, miss it and start a dev server, which would look like a pass).
async function listen() {
  const server = http.createServer((_, res) => res.end('ok'));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, base: `http://127.0.0.1:${server.address().port}`, port: server.address().port };
}
const cfg = (base) => ({ baseUrl: base, devCommand: 'node -e "process.exit(1)"' });

test('ensureServer refuses a server owned by another project and starts nothing', async () => {
  const { server, base } = await listen();
  try {
    await assert.rejects(
      ensureServer(new Set(), cfg(base), { listeners: () => [{ pid: '53861', cwd: '/x/local-career-site-italy' }], root: '/x/local-career-site' }),
      (e) => e instanceof CliError && e.exitCode === 2 && /another project/.test(e.message) && /--no-server/.test(e.message) && /53861/.test(e.message),
    );
  } finally { server.close(); }
});

test('ensureServer reuses its own server, and warns but proceeds when the owner is unknown', async () => {
  const { server, base } = await listen();
  const warns = [];
  const w = console.warn; console.warn = (m) => warns.push(m);
  try {
    assert.equal(await ensureServer(new Set(), cfg(base), { listeners: () => [{ pid: '1', cwd: '/x/site' }], root: '/x/site' }), null);
    assert.equal(warns.length, 0);
    assert.equal(await ensureServer(new Set(), cfg(base), { listeners: () => null, root: '/x/site' }), null);
    assert.equal(warns.length, 1);
    assert.equal(await ensureServer(new Set(['--no-server']), cfg(base), { listeners: () => [{ pid: '1', cwd: '/elsewhere' }], root: '/x/site' }), null);
  } finally { console.warn = w; server.close(); }
});

// Real lsof against a real child process in another directory.
async function child(cwd) {
  const p = spawn(process.execPath, ['-e', "const s=require('http').createServer((q,r)=>r.end('ok'));s.listen(0,'127.0.0.1',()=>console.log(s.address().port))"], { cwd, stdio: ['ignore', 'pipe', 'ignore'] });
  const port = await new Promise((resolve) => p.stdout.once('data', (d) => resolve(Number(String(d).trim()))));
  return { p, port, base: `http://127.0.0.1:${port}` };
}

test('real lsof: a server started from another directory is foreign, one started in the project root is own', { skip: !hasLsof }, async () => {
  const other = mkdtempSync(path.join(tmpdir(), 'foreign-'));
  const marker = path.join(other, 'dev-started');
  const foreign = await child(other);
  const own = await child(getProjectRoot());
  try {
    await sleep(100);
    await assert.rejects(
      ensureServer(new Set(), { baseUrl: foreign.base, devCommand: `node -e "require('fs').writeFileSync('${marker}','1')"` }),
      (e) => e instanceof CliError && /another project/.test(e.message),
    );
    assert.equal(existsSync(marker), false, 'no dev server may be started');
    assert.equal(await ensureServer(new Set(), cfg(own.base)), null);
  } finally { foreign.p.kill(); own.p.kill(); rmSync(other, { recursive: true, force: true }); }
});
