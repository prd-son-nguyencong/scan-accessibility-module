// Release hygiene: no customer terms, no secrets, no private files in the tracked tree.
// The denylist (eval/release-denylist.json) holds hashes of lowercase tokens, so it does not reveal the names it blocks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { containsDenied, loadDenylist, hashTerm, safeString, hashString } from '../eval/anonymise.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let tracked = null;
try { tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 26 }).split('\0').filter(Boolean); } catch { /* not a git checkout (npm tarball): the tree checks are skipped */ }
const SKIP_EXT = /\.(png|jpe?g|gif|webp|ico|woff2?|ttf|pdf|zip|gz|mp4)$/i;
const read = (f) => { try { return fs.readFileSync(path.join(root, f), 'utf8'); } catch { return null; } };

test('denylist helper: hashed terms match across spellings and never store the term', () => {
  const d = loadDenylist();
  assert.ok(d.hashes.size > 20, 'denylist is populated');
  assert.ok([...d.hashes].every((h) => /^[0-9a-f]{64}$/.test(h)), 'only sha256 hashes, no readable terms');
  assert.equal(containsDenied('about-us'), false);
  assert.equal(containsDenied('Acme Corp careers /life-at-acme'), false);
  const probe = 'acme-probe-term';
  const synthetic = { salt: d.salt, hashes: new Set([hashTerm(probe, d.salt)]), maxGram: 3, maxLen: 40, memo: new Map() };
  assert.equal(containsDenied('See the Acme Probe Term page', synthetic), true, 'multi word, any separator');
  assert.equal(containsDenied('/acme/probe/term', synthetic), true);
  assert.equal(containsDenied('acme probe other', synthetic), false);
  assert.equal(safeString('/life-at-acme', synthetic), '/life-at-acme');
  assert.match(safeString('/acme-probe-term', synthetic), /^h:[0-9a-f]{16}$/);
  assert.equal(hashString('/x', synthetic), hashString('/x', synthetic));
});

test('no tracked file contains a denylisted customer term', { skip: !tracked }, () => {
  const hits = [];
  for (const f of tracked) {
    if (SKIP_EXT.test(f)) continue;
    const text = read(f);
    if (text == null) continue;
    text.split('\n').forEach((line, i) => { if (containsDenied(line)) hits.push(`${f}:${i + 1}`); });
    if (containsDenied(f)) hits.push(`${f} (file name)`);
  }
  assert.deepEqual(hits, [], `customer terms found (anonymise or replace with synthetic content):\n${hits.slice(0, 40).join('\n')}`);
});

test('no secret pattern is tracked (test TLS keys are the only allowed private keys)', { skip: !tracked }, () => {
  const patterns = [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    /\bAKIA[0-9A-Z]{16}\b/,
    /\bgh[pousr]_[A-Za-z0-9]{30,}/,
    /\bsk-(?:ant-|live-)[A-Za-z0-9_-]{20,}/,
    /\bAIza[0-9A-Za-z_-]{35}\b/,
    /\bxox[abp]-[0-9A-Za-z-]{20,}/,
    /\bBearer\s+[A-Za-z0-9._~+/-]{24,}={0,2}/,
    /["']?(?:api[_-]?key|secret|password|auth[_-]?token)["']?\s*[:=]\s*["'][A-Za-z0-9/+_.-]{20,}["']/i,
  ];
  const allowedKeyDir = 'test/fixtures/cis/tls/';
  const fakeTokenFixtures = new Set(['test/accessscan-corpus-tooling.test.js']); // redaction tests feed a made up JWT on purpose
  const hits = [];
  for (const f of tracked) {
    if (SKIP_EXT.test(f) || f === 'pnpm-lock.yaml' || f === 'test/release-hygiene.test.js') continue;
    const text = read(f);
    if (text == null) continue;
    text.split('\n').forEach((line, i) => {
      for (const p of patterns) {
        if (!p.test(line)) continue;
        if (p === patterns[0] && f.startsWith(allowedKeyDir)) continue;
        if (fakeTokenFixtures.has(f)) continue;
        hits.push(`${f}:${i + 1}`);
      }
    });
  }
  assert.deepEqual(hits, []);
  // the allowed keys belong to a throwaway test CA, and say so
  assert.match(read(`${allowedKeyDir}README.md`) || '', /test only/i);
});

test('no personal absolute path or contact address is tracked', { skip: !tracked }, () => {
  const re = /\/Users\/(?!example\/|x\/)[A-Za-z][\w.-]*\/|\/home\/(?!runner\/)[a-z][\w.-]*\/|@(?:gmail|outlook|hotmail|yahoo)\.com/;
  const hits = [];
  for (const f of tracked) {
    if (SKIP_EXT.test(f) || f === 'pnpm-lock.yaml' || f === 'test/release-hygiene.test.js') continue;
    (read(f) || '').split('\n').forEach((line, i) => { if (re.test(line)) hits.push(`${f}:${i + 1}`); });
  }
  assert.deepEqual(hits, []);
});

test('private working files are ignored and not tracked', { skip: !tracked }, () => {
  const ignore = read('.gitignore') || '';
  const mustIgnore = ['.eval/', 'eval/site-map.local.json', '.env', 'scan-reports/', '.ada-scan/', 'cis-env', 'scripts/accessscan-corpus/source-manifest.local.json'];
  for (const p of mustIgnore) assert.ok(ignore.split('\n').some((l) => l.trim().startsWith(p)), `.gitignore lists ${p}`);
  const bad = tracked.filter((f) => /(^|\/)(\.eval|\.ada-scan|cis-env[^/]*|site-map\.local\.json|\.env(\.[^/]+)?|[^/]*\.local\.json)$/.test(f) && !/\.example(\.json)?$/.test(f) && f !== '.env.example');
  assert.deepEqual(bad, []);
  assert.deepEqual(tracked.filter((f) => /(^|\/)node_modules\//.test(f)), []);
});

test('committed eval corpus uses aliases and only the fields compare.mjs and metrics.mjs need', () => {
  const rows = JSON.parse(read('eval/corpus.json'));
  assert.ok(rows.length > 1000);
  const allowed = new Set(['site', 'route', 'rule', 'selector', 'verdict', 'sourceOk', 'ownerOk', 'reviewedAt', 'via', 'provenance']);
  for (const r of rows) {
    assert.match(r.site, /^s\d{2,}$/);
    for (const k of Object.keys(r)) assert.ok(allowed.has(k), `unexpected field ${k}`);
  }
});
