import './helpers/hermetic-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { closeBrowser } from '../src/scanner/browser.js';
import { checkReferencedDuplicateIds } from '../src/scanner/structure.js';
import { attachDuplicateIdSources } from '../src/tracer/duplicate-id-lines.js';
import { requireBrowser } from './helpers/require-browser.js';

async function read(t, body) {
  const browser = await requireBrowser(t);
  if (!browser) return null;
  t.after(closeBrowser);
  const page = await (await browser.newContext()).newPage();
  try {
    await page.setContent(`<!doctype html><html lang="en"><head><title>t</title></head><body>${body}</body></html>`);
    const violations = [];
    await checkReferencedDuplicateIds(page, violations, []);
    return violations;
  } finally { await page.context().close(); }
}

test('a repeated <symbol id> referenced only by <use href> is not an accessibility reference and yields no finding', async (t) => {
  const violations = await read(t, `<svg style="display:none"><symbol id="i-arrow" viewBox="0 0 1 1"></symbol><symbol id="i-arrow" viewBox="0 0 2 2"></symbol></svg>
    <svg aria-hidden="true"><use href="#i-arrow"></use></svg><svg><use xlink:href="#i-arrow"></use></svg>`);
  if (violations) assert.equal(violations.length, 0);
});

test('the sprite source tracer still lists both authored lines for a row that carries sprite evidence', () => {
  const violations = [{ evidence: { id: 'i-arrow', occurrences: 2, sprite: true } }];
  const root = mkdtempSync(join(tmpdir(), 'ada-sprite-'));
  try {
    for (const [rel, body] of Object.entries({
      'src/partials/icons/sprite.liquid': '<svg>\n<symbol id="i-arrow" viewBox="0 0 1 1"></symbol>\n</svg>\n',
      'src/partials/icons/more.svg': '<svg>\n\n<symbol id="i-arrow" viewBox="0 0 2 2"></symbol></svg>\n',
    })) { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), body); }
    const v = { ruleId: 'duplicate-id-referenced', evidence: violations[0].evidence };
    attachDuplicateIdSources([v], root);
    assert.equal(v.evidence.proof.type, 'measured-fact');
    assert.match(v.evidence.proof.fact, /authored at src\/partials\/icons\/more\.svg:3 and src\/partials\/icons\/sprite\.liquid:2/);
    assert.equal(v.sourceCandidates.length, 2);
    // paired: one definition is not a duplicate in the source; a non-sprite row is untouched
    const single = { ruleId: 'duplicate-id-referenced', evidence: { id: 'nope', occurrences: 2, sprite: true } };
    const plain = { ruleId: 'duplicate-id-referenced', evidence: { id: 'i-arrow', occurrences: 2 } };
    attachDuplicateIdSources([single, plain], root);
    assert.equal(single.evidence.proof, undefined);
    assert.equal(plain.evidence.proof, undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a <use> whose symbol id is unique yields no finding (paired)', async (t) => {
  const violations = await read(t, '<svg style="display:none"><symbol id="a"></symbol><symbol id="b"></symbol></svg><svg><use href="#a"></use></svg>');
  if (violations) assert.equal(violations.length, 0);
});

test('every IDREF reference to a duplicated id is still reported (paired with the sprite case)', async (t) => {
  const shapes = {
    'label for': '<label for="x">Name</label><input id="x"><input id="x">',
    'aria-labelledby': '<h2 id="x">A</h2><h2 id="x">B</h2><div role="region" aria-labelledby="x"></div>',
    'aria-describedby': '<p id="x">A</p><p id="x">B</p><input aria-label="n" aria-describedby="x">',
    'aria-controls': '<div id="x"></div><div id="x"></div><button aria-controls="x">t</button>',
    'aria-activedescendant': '<ul id="lb" role="listbox" tabindex="0" aria-activedescendant="x"><li id="x" role="option">a</li><li id="x" role="option">b</li></ul>',
    headers: '<table><tr><th id="x">a</th><th id="x">b</th></tr><tr><td headers="x">c</td></tr></table>',
    list: '<input list="x"><datalist id="x"></datalist><datalist id="x"></datalist>',
    'skip target': '<a href="#x">Skip</a><main id="x"></main><div id="x"></div>',
  };
  for (const [name, body] of Object.entries(shapes)) {
    const v = await read(t, body);
    if (!v) return;
    assert.equal(v.length >= 1 && v[0].rule === 'duplicate-id-referenced', true, name);
  }
  // guard: unique ids and an unreferenced duplicate stay silent
  const ok = await read(t, '<label for="a">A</label><input id="a"><a href="#a">x</a><div id="d"></div><div id="d"></div>');
  assert.equal(ok.length, 0);
});
