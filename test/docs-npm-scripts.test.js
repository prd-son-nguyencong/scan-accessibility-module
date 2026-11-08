import './helpers/hermetic-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const scripts = JSON.parse(read('../package.json')).scripts;
// eval:truth arrives with branch m1-confirmed-truth-eval: until scripts/eval-truth.js exists it is not checked, once it does it must be a script.
const pending = (name) => name === 'eval:truth' && !existsSync(new URL('../scripts/eval-truth.js', import.meta.url));
const known = (name) => name in scripts || pending(name);

for (const doc of ['../docs/developer-guide.md', '../docs/accuracy-commitments.md']) {
  test(`every "npm run X" in ${doc.slice(3)} is a package.json script`, () => {
    const names = [...read(doc).matchAll(/npm run ([\w:.-]+)/g)].map((m) => m[1]);
    assert.ok(names.length > 0);
    assert.deepEqual(names.filter((n) => !known(n)), []);
  });
}
