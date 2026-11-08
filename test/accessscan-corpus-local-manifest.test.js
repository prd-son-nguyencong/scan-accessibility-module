import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadSourceManifest, SOURCE_MANIFEST_PATH } from '../scripts/accessscan-corpus/lib/source-manifest.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

test('committed source manifest carries opaque ids only', () => {
  const manifest = JSON.parse(readFileSync(SOURCE_MANIFEST_PATH, 'utf8'));
  for (const entry of manifest.entries) {
    assert.equal(entry.label, entry.id);
    assert.ok(entry.sourceUrl.startsWith(`https://${entry.id}.`), entry.sourceUrl);
  }
});

test('local manifest overrides label/sourceUrl by id; a local tokens file extends the forbidden tokens', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ada-local-manifest-'));
  try {
    const committed = JSON.parse(readFileSync(SOURCE_MANIFEST_PATH, 'utf8'));
    const id = committed.entries[0].id;
    const manifestPath = path.join(dir, 'm.json');
    const localPath = path.join(dir, 'm.local.json');
    writeFileSync(manifestPath, JSON.stringify(committed));
    writeFileSync(localPath, JSON.stringify({
      entries: { [id]: { label: 'Acme 1', sourceUrl: 'https://acme1.preview.sites.stg.paradox.ai/' } },
    }));

    const [entry] = loadSourceManifest(manifestPath).entries;
    assert.equal(entry.label, 'Acme 1');
    assert.equal(entry.sourceUrl, 'https://acme1.preview.sites.stg.paradox.ai/');

    const tokensPath = path.join(dir, 'tokens.local.json');
    writeFileSync(tokensPath, JSON.stringify({ forbiddenTokens: ['acme-secret'] }));
    const child = spawnSync(process.execPath, [
      '--input-type=module',
      '-e',
      "import { CORPUS_FORBIDDEN_TOKENS as t } from './src/scanner/access-scan/corpus/constants.js'; console.log(JSON.stringify(t));",
    ], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, ADA_CORPUS_REDACTION_TOKENS: tokensPath } });
    assert.ok(JSON.parse(child.stdout).includes('acme-secret'), child.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Name-agnostic leak guards: need no customer names in the repo.
const SCANNED = ['src', 'test', 'scripts', 'docs', 'README.md', 'CHANGELOG.md'];
const trackedFiles = () => spawnSync('git', ['ls-files', '-z', ...SCANNED], { cwd: ROOT, encoding: 'utf8' })
  .stdout.split('\0').filter((f) => f && !/\.(png|jpe?g|gif|woff2?)$/i.test(f) && existsSync(path.join(ROOT, f)));

test('tracked files only name placeholder staging hosts', () => {
  const hostRe = /(?<![.\w-])([a-z0-9-]+)\.(?:preview\.)?sites\.(?:stg\.)?paradox\.ai/gi;
  const placeholder = /^(site-(?:\d+|NNN)|fake\d+|blocked\d+|customer\d+|acme\d+)$/i;
  for (const file of trackedFiles()) {
    for (const [, label] of readFileSync(path.join(ROOT, file), 'utf8').matchAll(hostRe)) {
      assert.match(label, placeholder, `${file} names non-placeholder staging host "${label}"`);
    }
  }
});

test('tracked files contain none of the local redaction tokens', (t) => {
  const tokensPath = path.join(ROOT, 'scripts/accessscan-corpus/redaction-tokens.local.json');
  if (!existsSync(tokensPath)) return t.skip('no local redaction-tokens file');
  const { forbiddenTokens = [] } = JSON.parse(readFileSync(tokensPath, 'utf8'));
  for (const file of trackedFiles()) {
    const text = readFileSync(path.join(ROOT, file), 'utf8').toLowerCase();
    for (const token of forbiddenTokens) {
      assert.ok(!text.includes(String(token).toLowerCase()), `${file} contains local forbidden token`);
    }
  }
});

test('tracked files contain none of the local reviewed host suffixes', (t) => {
  const localPath = path.join(ROOT, 'scripts/accessscan-corpus/source-manifest.local.json');
  if (!existsSync(localPath)) return t.skip('no local manifest file');
  const { reviewedHostSuffixes = [] } = JSON.parse(readFileSync(localPath, 'utf8'));
  for (const file of trackedFiles()) {
    const text = readFileSync(path.join(ROOT, file), 'utf8').toLowerCase();
    for (const suffix of reviewedHostSuffixes) {
      assert.ok(!text.includes(String(suffix).toLowerCase()), `${file} contains a local reviewed host suffix`);
    }
  }
});
