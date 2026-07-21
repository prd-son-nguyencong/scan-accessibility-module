import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CASE_ID_PATTERN,
  REVIEWED_SOURCE_HOST_SUFFIXES,
  assertSafeSubresourceUrl,
  assertSafeSourceNavigationUrl,
  validateManifestCaseId,
  validateSourceManifestUrl,
  validateSourceManifestUrlShape,
} from '../scripts/accessscan-corpus/lib/source-url-policy.js';
import { setDnsResolverForTests } from '../scripts/accessscan-corpus/lib/dns-policy.js';
import { loadSourceManifest } from '../scripts/accessscan-corpus/lib/source-manifest.js';
import { installCorpusToolingTestResetHooks } from './helpers/accessscan-corpus-test-reset.js';

installCorpusToolingTestResetHooks();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicResolver = async () => ['8.8.8.8'];

test('CASE_ID_PATTERN accepts opaque site ids and rejects traversal tokens', () => {
  assert.match('site-728', CASE_ID_PATTERN);
  assert.match('neutral-empty-list', CASE_ID_PATTERN);
  assert.doesNotMatch('../escape', CASE_ID_PATTERN);
  assert.doesNotMatch('Site-UPPER', CASE_ID_PATTERN);
  assert.doesNotMatch('site_underscore', CASE_ID_PATTERN);
});

test('validateSourceManifestUrlShape denies unsafe schemes hosts and credentials', () => {
  const denied = [
    'file:///etc/passwd',
    'data:text/html,<script>',
    'http://insecure.example/',
    'https://localhost/',
    'https://127.0.0.1/',
    'https://[::1]/',
    'https://169.254.169.254/latest/meta-data/',
    'https://10.0.0.12/',
    'https://192.168.1.4/',
    'https://172.16.0.2/',
    'https://user:secret@hitachi728.preview.sites.stg.paradox.ai/',
    'https://evil.example/',
    'https://hitachi728.preview.sites.stg.paradox.ai:8080/',
  ];

  for (const url of denied) {
    assert.throws(
      () => validateSourceManifestUrlShape(url),
      /forbidden|disallowed|unsafe|HTTPS|credentials|allowlist/i,
      url,
    );
  }
});

test('validateSourceManifestUrlShape accepts reviewed staging suffixes', () => {
  assert.doesNotThrow(() => validateSourceManifestUrlShape('https://hitachi728.preview.sites.stg.paradox.ai/'));
  assert.doesNotThrow(() => validateSourceManifestUrlShape('https://americold375.sites.stg.paradox.ai/'));
  assert.doesNotThrow(() => validateSourceManifestUrlShape('https://mcdonalds203.preview.sites.stg.mchire.com/'));
});

test('current committed source manifest URLs and case ids pass policy shape checks', () => {
  const manifest = loadSourceManifest();
  const sorted = [...manifest.entries].sort((left, right) => (
    String(left.id).localeCompare(String(right.id))
  ));
  assert.deepEqual(manifest.entries.map((entry) => entry.id), sorted.map((entry) => entry.id));

  for (const entry of manifest.entries) {
    validateManifestCaseId(String(entry.caseId || entry.id));
    validateSourceManifestUrlShape(String(entry.sourceUrl));
  }
});

test('assertSafeSubresourceUrl allows public CDN hosts with DNS resolution', async () => {
  setDnsResolverForTests(publicResolver);
  await assert.doesNotReject(async () => assertSafeSubresourceUrl('https://fonts.googleapis.com/css2?family=Inter'));
  await assert.doesNotReject(async () => assertSafeSubresourceUrl('https://cdnjs.cloudflare.com/ajax/libs/jquery/3.7.1/jquery.min.js'));
});

test('assertSafeSubresourceUrl blocks syntactic private IP literals', async () => {
  setDnsResolverForTests(publicResolver);
  await assert.rejects(
    () => assertSafeSubresourceUrl('https://127.0.0.1/asset.js'),
    /forbidden|unsafe/i,
  );
});

test('assertSafeSourceNavigationUrl blocks DNS-private allowlisted hostnames', async () => {
  setDnsResolverForTests(async () => ['10.0.0.55']);
  await assert.rejects(
    () => assertSafeSourceNavigationUrl('https://hitachi728.preview.sites.stg.paradox.ai/'),
    /private|reserved|forbidden/i,
  );
});

test('validateSourceManifestUrl resolves DNS before accepting navigation URLs', async () => {
  setDnsResolverForTests(publicResolver);
  await assert.doesNotReject(async () => validateSourceManifestUrl(
    'https://hitachi728.preview.sites.stg.paradox.ai/',
    { resolver: publicResolver },
  ));
});

test('REVIEWED_SOURCE_HOST_SUFFIXES remain stable for manifest validation', () => {
  assert.ok(REVIEWED_SOURCE_HOST_SUFFIXES.length >= 3);
  assert.ok(REVIEWED_SOURCE_HOST_SUFFIXES.every((suffix) => suffix.startsWith('.')));
});
