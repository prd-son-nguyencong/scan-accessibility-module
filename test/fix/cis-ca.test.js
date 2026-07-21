import {
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadTrustedCaBundle, MAX_CA_BUNDLE_BYTES } from '../../src/fix/cis/ca.js';
import { resolveCisConfig, resolveTrustedCisConfig } from '../../src/fix/cis/config.js';
import {
  fingerprintForCaPem,
  TEST_CA_PATH,
  trustedCisTestEnv,
} from './helpers/cis-ca-fixture.js';

const { O_RDONLY, O_NOFOLLOW } = constants;

test('loadTrustedCaBundle validates PEM and exact byte fingerprint', () => {
  const pem = readFileSync(TEST_CA_PATH, 'utf8');
  const sha256 = fingerprintForCaPem(pem);
  const result = loadTrustedCaBundle(TEST_CA_PATH, sha256);
  assert.equal(result.sha256, sha256);
  assert.match(result.pem, /BEGIN CERTIFICATE/);
  assert.equal(result.certificateCount, 1);
  assert.throws(() => {
    result.pem = 'mutated';
  });
});

test('loadTrustedCaBundle rejects fingerprint mismatch', () => {
  assert.throws(
    () => loadTrustedCaBundle(TEST_CA_PATH, `sha256:${'0'.repeat(64)}`),
    (error) => error.code === 'CIS_CA_FINGERPRINT_MISMATCH',
  );
});

test('loadTrustedCaBundle rejects invalid fingerprint format', () => {
  assert.throws(
    () => loadTrustedCaBundle(TEST_CA_PATH, 'sha256:NOT_HEX'),
    (error) => error.code === 'CIS_CA_FINGERPRINT_MISMATCH',
  );
  assert.throws(
    () => loadTrustedCaBundle(TEST_CA_PATH, ''),
    (error) => error.code === 'CIS_CA_FINGERPRINT_MISMATCH',
  );
});

test('loadTrustedCaBundle rejects symlinks and invalid PEM', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-cis-ca-'));
  try {
    const invalid = join(root, 'invalid.pem');
    const link = join(root, 'link.pem');
    writeFileSync(invalid, 'not a certificate\n', { mode: 0o644 });
    symlinkSync(TEST_CA_PATH, link);
    assert.throws(
      () => loadTrustedCaBundle(invalid, fingerprintForCaPem('not a certificate\n')),
      (error) => error.code === 'CIS_CA_INVALID',
    );
    assert.throws(
      () => loadTrustedCaBundle(link, `sha256:${'0'.repeat(64)}`),
      (error) => error.code === 'CIS_CA_UNTRUSTED_PATH',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('loadTrustedCaBundle rejects missing file and empty path', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-cis-ca-missing-'));
  try {
    assert.throws(
      () => loadTrustedCaBundle('', `sha256:${'0'.repeat(64)}`),
      (error) => error.code === 'CIS_CA_MISSING',
    );
    assert.throws(
      () => loadTrustedCaBundle(join(root, 'missing.pem'), `sha256:${'0'.repeat(64)}`),
      (error) => error.code === 'CIS_CA_MISSING',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('loadTrustedCaBundle rejects zero-byte CA bundle as invalid PEM', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-cis-ca-empty-'));
  try {
    const emptyPath = join(root, 'empty.pem');
    writeFileSync(emptyPath, '', { mode: 0o644 });
    assert.throws(
      () => loadTrustedCaBundle(emptyPath, `sha256:${'0'.repeat(64)}`),
      (error) => error.code === 'CIS_CA_INVALID',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('loadTrustedCaBundle rejects oversized and non-regular files', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-cis-ca-bounds-'));
  try {
    const largePath = join(root, 'large.pem');
    writeFileSync(largePath, `${'x'.repeat(MAX_CA_BUNDLE_BYTES + 1)}\n`, { mode: 0o644 });
    assert.throws(
      () => loadTrustedCaBundle(largePath, `sha256:${'0'.repeat(64)}`),
      (error) => error.code === 'CIS_CA_INVALID',
    );

    const dirPath = join(root, 'dir.pem');
    const fd = openSync(dirPath, 'w');
    writeSync(fd, Buffer.from('placeholder'));
    closeSync(fd);
    rmSync(dirPath);
    mkdirSync(dirPath);
    assert.throws(
      () => loadTrustedCaBundle(dirPath, `sha256:${'0'.repeat(64)}`),
      (error) => error.code === 'CIS_CA_INVALID',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('loadTrustedCaBundle maps unexpected read failures to CIS_CA_INVALID without paths', () => {
  const secretPath = '/secret/ca.pem';
  assert.throws(
    () => loadTrustedCaBundle(TEST_CA_PATH, fingerprintForCaPem(readFileSync(TEST_CA_PATH, 'utf8')), {
      readBoundedFile() {
        const error = new Error(`EACCES: permission denied, open '${secretPath}'`);
        error.code = 'EACCES';
        throw error;
      },
    }),
    (error) => error.code === 'CIS_CA_INVALID'
      && error.message.includes(secretPath) === false
      && error.message.includes('EACCES') === false,
  );
});

test('loadTrustedCaBundle error messages omit paths and certificate metadata', () => {
  try {
    loadTrustedCaBundle(TEST_CA_PATH, `sha256:${'0'.repeat(64)}`);
    assert.fail('expected fingerprint mismatch');
  } catch (error) {
    assert.match(String(error.message), /fingerprint/i);
    assert.equal(error.message.includes(TEST_CA_PATH), false);
    assert.equal(error.message.includes('ada-scan test CA'), false);
  }
});

test('resolveTrustedCisConfig requires CA settings in missing-config gate', () => {
  const missingCa = resolveTrustedCisConfig({
    CIS_PROXY_URL: 'https://127.0.0.1:9999',
    CIS_AUTH_TOKEN: 'test-key',
    CIS_MODEL: 'test-model',
  });
  assert.equal(missingCa.ok, false);
  assert.equal(missingCa.reason, 'CIS_CONFIG_MISSING');
});

test('resolveTrustedCisConfig requires CIS_MODEL by default but allows model-free discovery', () => {
  const env = trustedCisTestEnv();
  delete env.CIS_MODEL;

  const missingModel = resolveTrustedCisConfig(env);
  assert.equal(missingModel.ok, false);
  assert.equal(missingModel.reason, 'CIS_CONFIG_MISSING');

  const discovery = resolveTrustedCisConfig(env, { requireModel: false });
  assert.equal(discovery.ok, true);
  assert.equal(discovery.model, '');
});

test('resolveTrustedCisConfig loads pinned CA after URL and host validation', () => {
  const config = resolveTrustedCisConfig(trustedCisTestEnv());
  assert.equal(config.ok, true);
  assert.match(config.caPem, /BEGIN CERTIFICATE/);
  assert.match(config.caSha256, /^sha256:[a-f0-9]{64}$/);
  assert.equal(config.caBundlePath, TEST_CA_PATH);
});

test('resolveTrustedCisConfig returns stable CA failure codes', () => {
  const mismatch = resolveTrustedCisConfig(trustedCisTestEnv({
    CIS_CA_SHA256: `sha256:${'0'.repeat(64)}`,
  }));
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.reason, 'CIS_CA_FINGERPRINT_MISMATCH');

  const root = mkdtempSync(join(tmpdir(), 'ada-cis-config-ca-'));
  try {
    const invalid = join(root, 'invalid.pem');
    writeFileSync(invalid, 'not pem\n', { mode: 0o644 });
    const invalidConfig = resolveTrustedCisConfig(trustedCisTestEnv({
      CIS_CA_BUNDLE_PATH: invalid,
      CIS_CA_SHA256: fingerprintForCaPem('not pem\n'),
    }));
    assert.equal(invalidConfig.ok, false);
    assert.equal(invalidConfig.reason, 'CIS_CA_INVALID');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  const missingRoot = mkdtempSync(join(tmpdir(), 'ada-cis-config-missing-'));
  try {
    const missingPath = resolveTrustedCisConfig(trustedCisTestEnv({
      CIS_CA_BUNDLE_PATH: join(missingRoot, 'does-not-exist.pem'),
    }));
    assert.equal(missingPath.ok, false);
    assert.equal(missingPath.reason, 'CIS_CA_MISSING');
  } finally {
    rmSync(missingRoot, { recursive: true, force: true });
  }
});

test('resolveTrustedCisConfig fail-closes on unexpected CA loader failures', () => {
  const secretPath = '/secret/ca.pem';
  const config = resolveTrustedCisConfig(trustedCisTestEnv(), {
    loadTrustedCaBundle() {
      const error = new Error(`EPERM: operation not permitted, open '${secretPath}'`);
      error.code = 'EPERM';
      throw error;
    },
  });
  assert.equal(config.ok, false);
  assert.equal(config.reason, 'CIS_CA_INVALID');
  assert.equal(config.message, 'CIS CA configuration is invalid.');
  assert.equal(config.message.includes(secretPath), false);
  assert.equal(config.message.includes('EPERM'), false);
});

test('resolveTrustedCisConfig preserves existing host and HTTPS checks', () => {
  const denied = resolveTrustedCisConfig(trustedCisTestEnv({
    CIS_PROXY_URL: 'https://evil.example.test:9999',
    CIS_ALLOWED_HOSTS: '127.0.0.1',
  }));
  assert.equal(denied.ok, false);
  assert.equal(denied.reason, 'CIS_HOST_DENIED');

  const insecure = resolveTrustedCisConfig(trustedCisTestEnv({
    CIS_PROXY_URL: 'http://cis.example.test:9999',
    CIS_ALLOWED_HOSTS: 'cis.example.test',
  }));
  assert.equal(insecure.ok, false);
  assert.equal(insecure.reason, 'CIS_CONFIG_INSECURE');
});

test('resolveCisConfig defaults to trusted pinned-CA mode', () => {
  const result = resolveCisConfig(trustedCisTestEnv());
  assert.equal(result.ok, true);
  assert.equal(result.transportSecurity, 'trusted');
  assert.equal(result.devBypassAuth, false);
  assert.match(result.caPem, /BEGIN CERTIFICATE/);
});

test('trusted mode rejects development auth bypass', () => {
  const result = resolveCisConfig(trustedCisTestEnv({
    CIS_DEV_BYPASS_AUTH: 'true',
  }));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'CIS_DEV_AUTH_BYPASS_DENIED');
});

test('loadTrustedCaBundle reads exact file bytes for fingerprinting', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-cis-ca-bytes-'));
  try {
    const filePath = join(root, 'bundle.pem');
    const sourcePem = readFileSync(TEST_CA_PATH);
    writeFileSync(filePath, sourcePem, { mode: 0o644 });
    const readFd = openSync(filePath, O_RDONLY | O_NOFOLLOW);
    const stat = fstatSync(readFd);
    const buffer = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < stat.size) {
      offset += readSync(readFd, buffer, offset, stat.size - offset, null);
    }
    closeSync(readFd);
    const sha256 = fingerprintForCaPem(buffer);
    const result = loadTrustedCaBundle(filePath, sha256);
    assert.equal(result.sha256, sha256);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
