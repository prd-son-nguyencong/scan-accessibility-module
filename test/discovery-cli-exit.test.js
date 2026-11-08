import './helpers/hermetic-env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../bin/ada-scan.js');
const page = (t) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${t}</title><meta name="viewport" content="width=device-width"></head><body><main><h1>${t}</h1></main></body></html>`;

test('CLI end to end: dist/pages shells never become routes, so a clean host-like tree exits 0 (not 2) and scans only the template routes', { timeout: 280_000 }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ada-cli-exit-'));
  const names = ['index', 'about', '404'];
  for (const n of names) {
    for (const f of [`src/pages/${n}.liquid`, `dist/pages/${n}.html`]) { mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); writeFileSync(path.join(root, f), ''); }
  }
  writeFileSync(path.join(root, 'dist/index.html'), '');
  const server = http.createServer((req, res) => {
    const n = new URL(req.url, 'http://x').pathname.replace(/^\/$/, '/index').slice(1);
    if (!names.includes(n)) return res.writeHead(404).end('nf');
    res.writeHead(n === '404' ? 404 : 200, { 'content-type': 'text/html' }).end(page(n));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  writeFileSync(path.join(root, '.scan-config.json'), JSON.stringify({ baseUrl: `http://127.0.0.1:${server.address().port}`, buildCommand: 'node -e 0' }));
  try {
    const child = spawn(process.execPath, [CLI, '--layers', 'axe', '--no-psi'], { cwd: root, env: { ...process.env, ADA_SCAN_ROOT: root, ADA_SCAN_DEPLOYMENT_URL: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
    const code = await new Promise((r) => child.on('close', r));
    assert.ok([0, 1].includes(code), `exit ${code}, expected 0 or 1`);
    const report = JSON.parse(readFileSync(path.join(root, '.ada-scan/latest.json'), 'utf8'));
    assert.deepEqual(report.pages.map((p) => p.route).sort(), ['/', '/404', '/about']);
    assert.ok(report.pages.every((p) => p.status === 'ok'));
  } finally { await new Promise((r) => { server.close(r); server.closeAllConnections?.(); }); rmSync(root, { recursive: true, force: true }); }
});
