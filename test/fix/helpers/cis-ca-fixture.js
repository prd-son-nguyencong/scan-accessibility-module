import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const TEST_CA_PATH = fileURLToPath(new URL('../../fixtures/cis/tls/ca.pem', import.meta.url));

export function fingerprintForCaPem(pem) {
  const bytes = typeof pem === 'string' ? Buffer.from(pem, 'utf8') : pem;
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

export function trustedCisTestEnv(overrides = {}) {
  const pem = readFileSync(TEST_CA_PATH, 'utf8');
  return {
    CIS_PROXY_URL: 'https://127.0.0.1:9999',
    CIS_AUTH_TOKEN: 'test-key',
    CIS_MODEL: 'test-model',
    CIS_ALLOWED_HOSTS: '127.0.0.1',
    CIS_CA_BUNDLE_PATH: TEST_CA_PATH,
    CIS_CA_SHA256: fingerprintForCaPem(pem),
    ...overrides,
  };
}
