import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
const ROOT = path.join(__dirname, '..');
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
    'https://user:secret@site-728.preview.sites.stg.paradox.ai/',
    'https://evil.example/',
    'https://site-728.preview.sites.stg.paradox.ai:8080/',
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
  assert.doesNotThrow(() => validateSourceManifestUrlShape('https://site-728.preview.sites.stg.paradox.ai/'));
  assert.doesNotThrow(() => validateSourceManifestUrlShape('https://site-375.sites.stg.paradox.ai/'));
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
    () => assertSafeSourceNavigationUrl('https://site-728.preview.sites.stg.paradox.ai/'),
    /private|reserved|forbidden/i,
  );
});

test('validateSourceManifestUrl resolves DNS before accepting navigation URLs', async () => {
  setDnsResolverForTests(publicResolver);
  await assert.doesNotReject(async () => validateSourceManifestUrl(
    'https://site-728.preview.sites.stg.paradox.ai/',
    { resolver: publicResolver },
  ));
});

test('REVIEWED_SOURCE_HOST_SUFFIXES remain stable for manifest validation', () => {
  assert.ok(REVIEWED_SOURCE_HOST_SUFFIXES.length >= 2);
  assert.ok(REVIEWED_SOURCE_HOST_SUFFIXES.every((suffix) => suffix.startsWith('.')));
});

test('local manifest may add reviewed host suffixes; none are built in', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ada-suffix-'));
  try {
    const localPath = path.join(dir, 'm.local.json');
    writeFileSync(localPath, JSON.stringify({ reviewedHostSuffixes: ['.preview.sites.stg.example.test', 'no-dot.test'] }));
    const child = spawnSync(process.execPath, [
      '--input-type=module',
      '-e',
      "import { REVIEWED_SOURCE_HOST_SUFFIXES as s } from './scripts/accessscan-corpus/lib/source-url-policy.js'; console.log(JSON.stringify(s));",
    ], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, ADA_CORPUS_SOURCE_MANIFEST_LOCAL: localPath } });
    const suffixes = JSON.parse(child.stdout);
    assert.ok(suffixes.includes('.preview.sites.stg.example.test'), child.stderr);
    assert.ok(!suffixes.includes('no-dot.test'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
