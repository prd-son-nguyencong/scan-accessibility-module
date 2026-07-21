import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isPrivateOrReservedIpAddress,
  resolvePublicHostAddresses,
  setDnsResolverForTests,
} from '../scripts/accessscan-corpus/lib/dns-policy.js';
import { installCorpusToolingTestResetHooks } from './helpers/accessscan-corpus-test-reset.js';

installCorpusToolingTestResetHooks();

test('isPrivateOrReservedIpAddress blocks IPv4-mapped loopback dotted form', () => {
  assert.equal(isPrivateOrReservedIpAddress('::ffff:127.0.0.1'), true);
  assert.equal(isPrivateOrReservedIpAddress('[::ffff:127.0.0.1]'), true);
  assert.equal(isPrivateOrReservedIpAddress('0:0:0:0:0:ffff:127.0.0.1'), true);
});

test('isPrivateOrReservedIpAddress blocks IPv4-mapped RFC1918 hex form', () => {
  assert.equal(isPrivateOrReservedIpAddress('::ffff:0a00:0001'), true);
});

test('isPrivateOrReservedIpAddress blocks IPv4-mapped link-local metadata hex form', () => {
  assert.equal(isPrivateOrReservedIpAddress('::ffff:a9fe:a9fe'), true);
});

test('isPrivateOrReservedIpAddress denies public IPv4-mapped forms', () => {
  assert.equal(isPrivateOrReservedIpAddress('::ffff:8.8.8.8'), true);
  assert.equal(isPrivateOrReservedIpAddress('::ffff:0808:0808'), true);
});

test('isPrivateOrReservedIpAddress still allows ordinary public IPv4 and IPv6', () => {
  assert.equal(isPrivateOrReservedIpAddress('8.8.8.8'), false);
  assert.equal(isPrivateOrReservedIpAddress('2001:4860:4860::8888'), false);
});

test('resolvePublicHostAddresses rejects DNS answers with IPv4-mapped loopback', async () => {
  setDnsResolverForTests(async () => ['::ffff:127.0.0.1']);
  await assert.rejects(
    () => resolvePublicHostAddresses('mapped-loopback.test'),
    /private|reserved/i,
  );
});

test('resolvePublicHostAddresses rejects DNS answers with IPv4-mapped RFC1918', async () => {
  setDnsResolverForTests(async () => ['::ffff:0a00:0001']);
  await assert.rejects(
    () => resolvePublicHostAddresses('mapped-rfc1918.test'),
    /private|reserved/i,
  );
});

test('resolvePublicHostAddresses rejects DNS answers with IPv4-mapped link-local metadata', async () => {
  setDnsResolverForTests(async () => ['::ffff:a9fe:a9fe']);
  await assert.rejects(
    () => resolvePublicHostAddresses('mapped-metadata.test'),
    /private|reserved/i,
  );
});

test('resolvePublicHostAddresses rejects DNS answers with public IPv4-mapped forms', async () => {
  setDnsResolverForTests(async () => ['::ffff:8.8.8.8']);
  await assert.rejects(
    () => resolvePublicHostAddresses('mapped-public.test'),
    /private|reserved/i,
  );
});

test('resolvePublicHostAddresses accepts ordinary public DNS answers', async () => {
  setDnsResolverForTests(async () => ['8.8.8.8', '2001:4860:4860::8888']);
  const addresses = await resolvePublicHostAddresses('public-cdn.test');
  assert.deepEqual(addresses, ['8.8.8.8', '2001:4860:4860::8888']);
});
