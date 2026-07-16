import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveFixCapability } from '../../src/fix/controller/mode-gate.js';

const DIGEST = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const REVISION = 'git:abc123def4567890123456789012345678901234';
const DEPLOYMENT_URL = 'https://example.test';

function hybridBase(overrides = {}) {
  return {
    url: `${DEPLOYMENT_URL}/`,
    localRoot: '/repo',
    remoteRevision: REVISION,
    localRevision: REVISION,
    remoteInstrumentationDigest: DIGEST,
    localInstrumentationDigest: DIGEST,
    remoteDeploymentUrl: DEPLOYMENT_URL,
    localDeploymentUrl: DEPLOYMENT_URL,
    scannedUrl: `${DEPLOYMENT_URL}/`,
    attestationStatus: 'complete',
    ...overrides,
  };
}

test('URL-only is always scan-only', () => {
  assert.deepEqual(resolveFixCapability({ url: 'https://example.test' }), {
    mode: 'url-only',
    canFix: false,
    reason: 'LOCAL_SOURCE_REQUIRED',
  });
});

test('local-only grants fix capability when a local root is present', () => {
  const result = resolveFixCapability({
    localRoot: '/repo',
  });
  assert.equal(result.mode, 'local-only');
  assert.equal(result.canFix, true);
  assert.equal(result.reason, null);
});

test('hybrid exact attestation match grants fix capability', () => {
  const result = resolveFixCapability(hybridBase());
  assert.equal(result.mode, 'hybrid');
  assert.equal(result.canFix, true);
  assert.equal(result.reason, null);
});

test('hybrid build revision mismatch fails closed', () => {
  const result = resolveFixCapability(hybridBase({
    remoteRevision: 'git:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    localRevision: 'git:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  }));
  assert.equal(result.mode, 'hybrid');
  assert.equal(result.canFix, false);
  assert.equal(result.reason, 'BUILD_REVISION_MISMATCH');
});

test('hybrid missing remote build revision fails closed', () => {
  const result = resolveFixCapability(hybridBase({ remoteRevision: null }));
  assert.equal(result.canFix, false);
  assert.equal(result.reason, 'BUILD_REVISION_MISSING');
});

test('hybrid missing local build revision fails closed', () => {
  const result = resolveFixCapability(hybridBase({ localRevision: null }));
  assert.equal(result.canFix, false);
  assert.equal(result.reason, 'BUILD_REVISION_MISSING');
});

test('hybrid instrumentation digest mismatch fails closed', () => {
  const result = resolveFixCapability(hybridBase({
    localInstrumentationDigest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  }));
  assert.equal(result.canFix, false);
  assert.equal(result.reason, 'INSTRUMENTATION_DIGEST_MISMATCH');
});

test('hybrid missing remote instrumentation digest fails closed', () => {
  const result = resolveFixCapability(hybridBase({ remoteInstrumentationDigest: null }));
  assert.equal(result.canFix, false);
  assert.equal(result.reason, 'INSTRUMENTATION_DIGEST_MISSING');
});

test('hybrid missing local instrumentation digest fails closed', () => {
  const result = resolveFixCapability(hybridBase({ localInstrumentationDigest: null }));
  assert.equal(result.canFix, false);
  assert.equal(result.reason, 'INSTRUMENTATION_DIGEST_MISSING');
});

test('hybrid target mode requires attestation even for localhost URL', () => {
  const result = resolveFixCapability({
    targetMode: 'hybrid',
    url: 'http://localhost:1234/',
    localRoot: '/repo',
    remoteRevision: REVISION,
    localRevision: null,
    remoteInstrumentationDigest: DIGEST,
    localInstrumentationDigest: null,
  });
  assert.equal(result.mode, 'hybrid');
  assert.equal(result.canFix, false);
  assert.equal(result.reason, 'BUILD_REVISION_MISSING');
});

test('url-only target with added localRoot requires hybrid attestation', () => {
  const result = resolveFixCapability(hybridBase({ targetMode: 'url-only' }));
  assert.equal(result.mode, 'hybrid');
  assert.equal(result.canFix, true);
});

test('local-only target downgrade cannot skip hybrid attestation for remote URL', () => {
  const result = resolveFixCapability({
    targetMode: 'local-only',
    url: 'https://example.test',
    localRoot: '/repo',
  });
  assert.equal(result.mode, 'hybrid');
  assert.equal(result.canFix, false);
  assert.equal(result.reason, 'BUILD_REVISION_MISSING');
});

test('local-only target mode stays local-only for localhost URL', () => {
  const result = resolveFixCapability({
    targetMode: 'local-only',
    url: 'http://localhost:1234/',
    localRoot: '/repo',
  });
  assert.equal(result.mode, 'local-only');
  assert.equal(result.canFix, true);
  assert.equal(result.reason, null);
});

test('hybrid dirty build revision fails closed', () => {
  const dirty = `${REVISION}:dirty`;
  const result = resolveFixCapability(hybridBase({
    remoteRevision: dirty,
    localRevision: dirty,
  }));
  assert.equal(result.canFix, false);
  assert.equal(result.reason, 'BUILD_REVISION_DIRTY');
});

test('hybrid deployment URL mismatch fails closed', () => {
  const result = resolveFixCapability(hybridBase({
    localDeploymentUrl: 'https://other.test',
  }));
  assert.equal(result.canFix, false);
  assert.equal(result.reason, 'DEPLOYMENT_URL_MISMATCH');
});
