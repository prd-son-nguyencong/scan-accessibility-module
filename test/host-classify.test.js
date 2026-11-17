import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyHost, isLoopbackUrl } from '../src/utils/host-classify.js';
import { isPrivateOrReservedIpAddress } from '../scripts/accessscan-corpus/lib/dns-policy.js';

const CASES = [
  // loopback
  ['http://localhost:1234/', 'loopback'],
  ['http://localhost./', 'loopback'],
  ['http://foo.localhost/', 'loopback'],
  ['http://127.0.0.1/', 'loopback'],
  ['http://127.1/', 'loopback'],
  ['http://2130706433/', 'loopback'],
  ['http://0x7f000001/', 'loopback'],
  ['http://0177.0.0.1/', 'loopback'],
  ['http://0.0.0.0/', 'loopback'],
  ['http://[::1]:8080/', 'loopback'],
  ['http://[0::1]/', 'loopback'],
  ['::1', 'loopback'],
  ['http://[::ffff:127.0.0.1]/', 'loopback'],
  ['http://[::ffff:7f00:1]/', 'loopback'],
  ['http://[64:ff9b::7f00:1]/', 'loopback'],
  ['http://[2002:7f00:1::]/', 'loopback'],
  ['http://[::127.0.0.1]/', 'loopback'],
  ['http://[::7f00:1]/', 'loopback'],
  ['http://[::ffff:0:7f00:1]/', 'loopback'],
  ['http://[::ffff:0:a00:1]/', 'private'],
  ['http://[::a00:1]/', 'private'],
  ['http://[::ffff:0:0:1]/', 'reserved'],
  ['http://[::808:808]/', 'reserved'],
  ['http://[::ffff:0:808:808]/', 'reserved'],
  // private
  ['http://10.0.0.1/', 'private'],
  ['http://172.16.0.1/', 'private'],
  ['http://192.168.1.5/', 'private'],
  ['http://100.64.0.1/', 'private'],
  ['http://printer.local/', 'private'],
  ['http://[fd00::1]/', 'private'],
  ['http://[64:ff9b::a00:1]/', 'private'],
  ['http://[2002:c0a8:101::]/', 'private'],
  // link-local
  ['http://169.254.169.254/', 'link-local'],
  ['http://[fe80::1]/', 'link-local'],
  ['http://[fe90::1]/', 'link-local'],
  ['http://[fea0::1]/', 'link-local'],
  ['http://[febf::1]/', 'link-local'],
  ['http://[::ffff:169.254.169.254]/', 'link-local'],
  // reserved
  ['http://192.0.2.1/', 'reserved'],
  ['http://198.51.100.1/', 'reserved'],
  ['http://203.0.113.5/', 'reserved'],
  ['http://198.18.0.1/', 'reserved'],
  ['http://0.1.2.3/', 'reserved'],
  ['http://224.0.0.1/', 'reserved'],
  ['http://255.255.255.255/', 'reserved'],
  ['http://[fec0::1]/', 'reserved'],
  ['http://[ff02::1]/', 'reserved'],
  ['http://[::]/', 'reserved'],
  ['http://[2001:db8::1]/', 'reserved'],
  ['http://[::ffff:8.8.8.8]/', 'reserved'],
  // public
  ['https://example.com/', 'public'],
  ['https://example.com./', 'public'],
  ['http://localhost.evil.com/', 'public'],
  ['http://evil.com.localhost.com/', 'public'],
  ['http://localhost:pw@evil.example/', 'public'],
  ['http://user:pw@localhost/', 'loopback'],
  ['http://8.8.8.8/', 'public'],
  ['http://[2606:4700::1111]/', 'public'],
  // invalid
  ['', 'invalid'],
  [null, 'invalid'],
  ['http://', 'invalid'],
  ['http://1.2.3.4.5/', 'invalid'],
];

for (const [input, kind] of CASES) {
  test(`classifyHost(${JSON.stringify(input)}) is ${kind}`, () => {
    const result = classifyHost(input);
    assert.equal(result.kind, kind, result.reason);
    assert.equal(typeof result.reason, 'string');
  });
}

test('bare hosts classify like URLs', () => {
  assert.equal(classifyHost('localhost:3000').kind, 'loopback');
  assert.equal(classifyHost('example.com').kind, 'public');
});

test('isLoopbackUrl only matches loopback', () => {
  assert.equal(isLoopbackUrl('http://localhost:1/'), true);
  assert.equal(isLoopbackUrl('http://192.168.0.1/'), false);
  assert.equal(isLoopbackUrl('http://localhost:pw@evil/'), false);
});

test('dns-policy table: previously missed ranges are blocked', () => {
  for (const a of ['0::1', 'fe90::1', 'febf::1', 'fec0::1', '64:ff9b::7f00:1', '2002:7f00:1::', '192.0.2.1', '198.18.0.1', '203.0.113.5']) {
    assert.equal(isPrivateOrReservedIpAddress(a), true, a);
  }
  assert.equal(isPrivateOrReservedIpAddress('8.8.8.8'), false);
  assert.equal(isPrivateOrReservedIpAddress('not-an-ip'), true);
});

test('CIS transport and shadow loopback checks use the shared classifier', async () => {
  const { isLoopbackHost } = await import('../src/fix/cis/transport.js');
  const { assertLoopbackSiteUrl } = await import('../src/fix/verify/shadow.js');
  for (const h of ['127.0.0.2', 'localhost.', '[::1]', 'a.localhost']) assert.equal(isLoopbackHost(h), true, h);
  assert.equal(isLoopbackHost('localhost.evil.com'), false);
  assert.equal(assertLoopbackSiteUrl('http://[::1]:8080/'), 'http://[::1]:8080/');
  assert.equal(assertLoopbackSiteUrl('http://127.0.0.2/'), 'http://127.0.0.2/');
  assert.throws(() => assertLoopbackSiteUrl('http://localhost:pw@evil.example/'), { code: 'SITE_URL_NOT_LOOPBACK' });
});
