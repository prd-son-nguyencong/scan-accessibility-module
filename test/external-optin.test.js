import './helpers/hermetic-env.mjs';
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { externalGate, resetExternalAnnouncements } from '../src/utils/external.js';
import { scanW3cValidation } from '../src/scanner/w3c.js';
import { derivePageStatus } from '../src/scanner/page-health.js';
import { DEFAULT_CONFIG, validateConfig } from '../src/utils/config.js';

const realFetch = globalThis.fetch;
const realLog = console.log;
afterEach(() => {
  globalThis.fetch = realFetch;
  console.log = realLog;
  resetExternalAnnouncements();
});

test('default config sends nothing: external is off', () => {
  assert.deepEqual(DEFAULT_CONFIG.external, { w3c: false, psi: false });
});

test('w3c is skipped by default and nothing is fetched', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('must not be called'); };
  const res = await scanW3cValidation('https://careers.example.com/', DEFAULT_CONFIG);
  assert.equal(calls, 0);
  assert.equal(res.scannerRun.status, 'skipped');
  assert.equal(res.scannerRun.evidence.errorCode, 'external-disabled');
  assert.match(res.scannerRun.engine.name, /none/);
  // skipped-by-config is not an incomplete scan
  assert.equal(derivePageStatus(null, [res.scannerRun]), 'ok');
});

test('private and loopback hosts are never sent, even when enabled', async () => {
  globalThis.fetch = async () => { throw new Error('must not be called'); };
  const cfg = { external: { w3c: true, psi: true } };
  for (const url of ['http://localhost:1234/', 'http://127.0.0.1/', 'http://192.168.1.5/x']) {
    assert.equal(externalGate('psi', url, cfg).reason, 'private-host');
    const res = await scanW3cValidation(url, cfg);
    assert.equal(res.scannerRun.status, 'skipped');
    assert.equal(res.scannerRun.evidence.errorCode, 'private-host');
  }
});

test('gate announces what is sent exactly once per service', () => {
  const lines = [];
  console.log = (m) => lines.push(m);
  const cfg = { external: { psi: true } };
  const opts = { sends: 'the page URL', endpoint: 'https://psi.example/' };
  assert.equal(externalGate('psi', 'https://careers.example.com/', cfg, opts).allowed, true);
  assert.equal(externalGate('psi', 'https://careers.example.com/a', cfg, opts).allowed, true);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /psi.*the page URL.*psi\.example/);
  assert.equal(externalGate('w3c', 'https://careers.example.com/', cfg, opts).reason, 'external-disabled');
});

test('policy-skipped layers do not make a page partial; other skips still do', () => {
  assert.equal(derivePageStatus(null, [{ status: 'skipped', evidence: { errorCode: 'external-disabled' } }]), 'ok');
  assert.equal(derivePageStatus(null, [{ status: 'skipped' }]), 'partial');
});

test('validateConfig checks external', () => {
  assert.deepEqual(validateConfig({ external: { w3c: true, w3cEndpoint: 'http://v.local/nu/' } }), []);
  assert.equal(validateConfig({ external: { psi: 'yes' } }).length, 1);
  assert.equal(validateConfig({ external: [] }).length, 1);
});
