import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planCisFixRoute } from '../../src/fix/controller/cli-routing.js';

const DIGEST = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const REVISION = 'git:abc123def4567890123456789012345678901234';
const DEPLOYMENT_URL = 'https://example.test';

test('URL-only CIS fix is scan-only and must not import trusted controller', () => {
  const plan = planCisFixRoute({
    fix: true,
    fixMode: 'cis',
    url: 'https://example.test',
    localRoot: null,
    remoteRevision: null,
    remoteInstrumentationDigest: null,
    localRevision: null,
    localInstrumentationDigest: null,
  });
  assert.equal(plan.kind, 'scan-only');
  assert.equal(plan.importController, false);
  assert.equal(plan.capability.reason, 'LOCAL_SOURCE_REQUIRED');
});

test('local-only CIS fix routes to trusted controller without attestation', () => {
  const plan = planCisFixRoute({
    fix: true,
    fixMode: 'cis',
    targetMode: 'local-only',
    url: 'http://localhost:1234/',
    localRoot: '/repo',
  });
  assert.equal(plan.kind, 'trusted-controller');
  assert.equal(plan.importController, true);
  assert.equal(plan.capability.mode, 'local-only');
});

test('hybrid mismatch is scan-only without controller import', () => {
  const plan = planCisFixRoute({
    fix: true,
    fixMode: 'cis',
    targetMode: 'hybrid',
    url: 'https://example.test',
    localRoot: '/repo',
    remoteRevision: 'git:aaa',
    remoteInstrumentationDigest: DIGEST,
    localRevision: 'git:bbb',
    localInstrumentationDigest: DIGEST,
  });
  assert.equal(plan.kind, 'scan-only');
  assert.equal(plan.importController, false);
  assert.equal(plan.capability.reason, 'BUILD_REVISION_MISMATCH');
});

test('non-CIS fix modes stay on legacy engine', () => {
  const plan = planCisFixRoute({
    fix: true,
    fixMode: 'claude',
    url: 'https://example.test',
    localRoot: null,
  });
  assert.equal(plan.kind, 'legacy-fix-engine');
  assert.equal(plan.importController, false);
});

test('fix subcommand plan uses report target and explicit local attestation', () => {
  const plan = planCisFixRoute({
    fix: true,
    fixMode: 'cis',
    targetMode: 'hybrid',
    url: 'https://example.test/',
    localRoot: '/repo',
    remoteRevision: REVISION,
    remoteInstrumentationDigest: DIGEST,
    localRevision: REVISION,
    localInstrumentationDigest: DIGEST,
    remoteDeploymentUrl: DEPLOYMENT_URL,
    localDeploymentUrl: DEPLOYMENT_URL,
    attestationStatus: 'complete',
    fromFixSubcommand: true,
  });
  assert.equal(plan.kind, 'trusted-controller');
  assert.equal(plan.importController, true);
});
