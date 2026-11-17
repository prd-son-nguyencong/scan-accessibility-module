import '../helpers/hermetic-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFixer } from '../../src/fix/harness/fixers/index.js';

test('createFixer builds the recipes and external fixers and rejects an unknown name', async () => {
  assert.equal((await createFixer('recipes', { localRoot: '.' })).name, 'recipes');
  assert.equal((await createFixer('external', { localRoot: '.', env: {} })).name, 'external');
  await assert.rejects(() => createFixer('nope', { localRoot: '.' }), /Unknown fixer/);
});

test('createFixer cis fails closed with the resolver reason when the configuration is missing or refused', async () => {
  await assert.rejects(() => createFixer('cis', { localRoot: '.', env: {} }), /CIS_CONFIG_MISSING/);
  // insecure-dev without the acknowledgement is refused
  await assert.rejects(
    () => createFixer('cis', { localRoot: '.', env: { CIS_TLS_MODE: 'insecure-dev', CIS_PROXY_URL: 'https://example.invalid/x', CIS_AUTH_TOKEN: 't', CIS_MODEL: 'm' } }),
    /CIS_INSECURE_DEV_ACK_REQUIRED/,
  );
  // insecure-dev is refused in CI whatever else is set
  await assert.rejects(
    () => createFixer('cis', { localRoot: '.', env: { CI: '1', CIS_TLS_MODE: 'insecure-dev', CIS_INSECURE_DEV_ACK: 'ALLOW_UNVERIFIED_CIS_TLS', CIS_TLS_MAX_VERSION: 'TLSv1.2', CIS_DEV_BYPASS_AUTH: 'true', CIS_PROXY_URL: 'https://h.invalid/x', CIS_AUTH_TOKEN: 't', CIS_MODEL: 'm', CIS_ALLOWED_HOSTS: 'h.invalid' } }),
    /CIS_INSECURE_ENV_DENIED/,
  );
});

test('createFixer cis builds a fixer from a valid insecure-dev configuration without calling the network', async () => {
  const f = await createFixer('cis', {
    localRoot: '.',
    env: { CIS_TLS_MODE: 'insecure-dev', CIS_INSECURE_DEV_ACK: 'ALLOW_UNVERIFIED_CIS_TLS', CIS_TLS_MAX_VERSION: 'TLSv1.2', CIS_DEV_BYPASS_AUTH: 'true', CIS_PROXY_URL: 'https://h.invalid/ml', CIS_AUTH_TOKEN: 'tok', CIS_MODEL: 'anthropic.claude-sonnet-5-5', CIS_ALLOWED_HOSTS: 'h.invalid' },
  });
  assert.equal(f.name, 'cis');
  assert.equal(f.mechanicallySafe, false);
});
