import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveCisConfig } from '../../src/fix/cis/config.js';
import { resolveInsecureDevCisConfig } from '../../src/fix/cis/tls-mode.js';
import { insecureDevEnv } from './helpers/cis-ca-fixture.js';

test('insecure-dev resolves only with every exact guard', () => {
  const result = resolveCisConfig(insecureDevEnv());
  assert.equal(result.ok, true);
  assert.equal(result.transportSecurity, 'insecure-dev');
  assert.equal(result.devBypassAuth, true);
  assert.equal(result.tlsMinVersion, 'TLSv1.2');
  assert.equal(result.tlsMaxVersion, 'TLSv1.2');
  assert.equal(result.caPem, undefined);
  assert.equal(result.baseUrl, 'https://cis.example.test/ml/inference/cis');
  assert.equal(result.featureKey, 'test-feature-key');
  assert.equal(result.model, 'anthropic.claude-sonnet-5');
  assert.equal(result.provider, 'aws');
  assert.deepEqual(result.allowedHosts, ['cis.example.test']);
});

test('insecure-dev accepts allowlist hostname with different DNS letter casing', () => {
  const result = resolveCisConfig(insecureDevEnv({
    CIS_ALLOWED_HOSTS: 'CIS.EXAMPLE.TEST',
  }));
  assert.equal(result.ok, true);
  assert.deepEqual(result.allowedHosts, ['CIS.EXAMPLE.TEST']);
});

test('insecure-dev allows model-free discovery when requireModel is false', () => {
  const env = insecureDevEnv();
  delete env.CIS_MODEL;
  const result = resolveInsecureDevCisConfig(env, { requireModel: false });
  assert.equal(result.ok, true);
  assert.equal(result.model, '');
});

test('insecure-dev requires CIS_MODEL by default', () => {
  const env = insecureDevEnv();
  delete env.CIS_MODEL;
  const result = resolveInsecureDevCisConfig(env);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'CIS_CONFIG_MISSING');
});

for (const [name, overrides, reason] of [
  ['missing acknowledgment', { CIS_INSECURE_DEV_ACK: '' }, 'CIS_INSECURE_DEV_ACK_REQUIRED'],
  ['wrong acknowledgment', { CIS_INSECURE_DEV_ACK: 'WRONG_ACK' }, 'CIS_INSECURE_DEV_ACK_REQUIRED'],
  ['CI', { CI: '1' }, 'CIS_INSECURE_ENV_DENIED'],
  ['CI whitespace-only', { CI: '   ' }, 'CIS_INSECURE_ENV_DENIED'],
  ['CI truthy string', { CI: 'true' }, 'CIS_INSECURE_ENV_DENIED'],
  ['production NODE_ENV', { NODE_ENV: 'production' }, 'CIS_INSECURE_ENV_DENIED'],
  ['Production NODE_ENV', { NODE_ENV: 'Production' }, 'CIS_INSECURE_ENV_DENIED'],
  ['ack leading whitespace', { CIS_INSECURE_DEV_ACK: ' ALLOW_UNVERIFIED_CIS_TLS' }, 'CIS_INSECURE_DEV_ACK_REQUIRED'],
  ['ack trailing whitespace', { CIS_INSECURE_DEV_ACK: 'ALLOW_UNVERIFIED_CIS_TLS ' }, 'CIS_INSECURE_DEV_ACK_REQUIRED'],
  ['TLS max leading whitespace', { CIS_TLS_MAX_VERSION: ' TLSv1.2' }, 'CIS_TLS_VERSION_INVALID'],
  ['TLS max trailing whitespace', { CIS_TLS_MAX_VERSION: 'TLSv1.2 ' }, 'CIS_TLS_VERSION_INVALID'],
  ['auth bypass leading whitespace', { CIS_DEV_BYPASS_AUTH: ' true' }, 'CIS_DEV_AUTH_BYPASS_DENIED'],
  ['auth bypass trailing whitespace', { CIS_DEV_BYPASS_AUTH: 'true ' }, 'CIS_DEV_AUTH_BYPASS_DENIED'],
  ['TLS max v1.3', { CIS_TLS_MAX_VERSION: 'TLSv1.3' }, 'CIS_TLS_VERSION_INVALID'],
  ['missing TLS max', { CIS_TLS_MAX_VERSION: '' }, 'CIS_TLS_VERSION_INVALID'],
  ['auth bypass false', { CIS_DEV_BYPASS_AUTH: 'false' }, 'CIS_DEV_AUTH_BYPASS_DENIED'],
  ['auth bypass missing', { CIS_DEV_BYPASS_AUTH: '' }, 'CIS_DEV_AUTH_BYPASS_DENIED'],
  ['HTTP endpoint', { CIS_PROXY_URL: 'http://cis.example.test/ml/inference/cis' }, 'CIS_INSECURE_DEV_DENIED'],
  ['multiple hosts', { CIS_ALLOWED_HOSTS: 'cis.example.test,other.example.test' }, 'CIS_INSECURE_DEV_DENIED'],
  ['host mismatch', { CIS_ALLOWED_HOSTS: 'other.example.test' }, 'CIS_INSECURE_DEV_DENIED'],
  ['host suffix', { CIS_ALLOWED_HOSTS: 'cis.example.test.evil' }, 'CIS_INSECURE_DEV_DENIED'],
  ['wildcard host', { CIS_ALLOWED_HOSTS: '*.cis.example.test' }, 'CIS_INSECURE_DEV_DENIED'],
  ['empty host list', { CIS_ALLOWED_HOSTS: '' }, 'CIS_INSECURE_DEV_DENIED'],
  ['missing proxy URL', { CIS_PROXY_URL: '' }, 'CIS_CONFIG_MISSING'],
  ['missing auth token', { CIS_AUTH_TOKEN: '' }, 'CIS_CONFIG_MISSING'],
  ['malformed URL', { CIS_PROXY_URL: 'not-a-url' }, 'CIS_CONFIG_INVALID'],
]) {
  test(`insecure-dev rejects invalid ${name}`, () => {
    const result = resolveCisConfig(insecureDevEnv(overrides));
    assert.equal(result.ok, false);
    assert.equal(result.reason, reason);
    assert.match(result.message, /\S/);
    assert.equal(result.message.includes('test-feature-key'), false);
    assert.equal(result.message.includes('cis.example.test'), false);
  });
}
