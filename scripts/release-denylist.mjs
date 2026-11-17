#!/usr/bin/env node
// Maintain eval/release-denylist.json (hashes only). usage: node scripts/release-denylist.mjs add <term> [term...]
// Each term is stored hyphen-joined ("Foo Bar" -> foo-bar) and also run together (foobar). Terms are never written to the file.
import fs from 'node:fs';
import { DENYLIST_PATH, normaliseTerm, tokensOf } from '../eval/anonymise.mjs';
import crypto from 'node:crypto';

const [cmd, ...terms] = process.argv.slice(2);
if (cmd !== 'add' || !terms.length) { console.error('usage: release-denylist.mjs add <term> [term...]'); process.exit(2); }
const file = DENYLIST_PATH.pathname;
const j = JSON.parse(fs.readFileSync(file, 'utf8'));
const set = new Set(j.hashes);
const h = (s) => crypto.createHash('sha256').update(`${j.salt}:${s}`).digest('hex');
for (const t of terms) {
  const n = normaliseTerm(t);
  if (!n) continue;
  set.add(h(n));
  set.add(h(tokensOf(t).join('')));
  j.maxGram = Math.max(j.maxGram, tokensOf(t).length);
  j.maxLen = Math.max(j.maxLen, n.length);
}
j.hashes = [...set].sort();
fs.writeFileSync(file, JSON.stringify(j, null, 1) + '\n');
console.log(`denylist now holds ${j.hashes.length} hashes`);
