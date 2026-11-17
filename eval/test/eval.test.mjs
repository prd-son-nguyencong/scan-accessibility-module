import test from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { compare } from '../compare.mjs';
import { metrics, wilson } from '../metrics.mjs';

const f = (route, rule, selector, verdict = 'confirmed') => ({ route, nativeRuleId: rule, canonicalRuleId: rule, element: { selector }, verdict });
const corpus = [
  { site: 's', route: '/', rule: 'a', selector: '#x', verdict: 'TP' },
  { site: 's', route: '/', rule: 'b', selector: '#y', verdict: 'FP' },
  { site: 's', route: '/', rule: 'c', selector: '#z', verdict: 'TP' },
  { site: 's', route: '/gone', rule: 'a', selector: '#x', verdict: 'TP' },
];
test('compare: exact, route|rule fallback, unreviewed, lost', () => {
  const report = { pages: [{ route: '/', findings: [f('/', 'a', '#x'), f('/', 'b', '#other'), f('/', 'new', '#n'), f('/', 'c', '#z', 'needs-review')] }] };
  const r = compare(report, corpus, 's');
  assert.deepEqual(r.tally, { TP: 1, FP: 1, UNV: 0 });
  assert.equal(r.unreviewed.length, 1);
  assert.deepEqual(r.lost.map((x) => x.rule), ['c']); // '/gone' was not scanned, so not lost
});
test('wilson matches a known value', () => {
  const w = wilson(8, 10);
  assert.ok(Math.abs(w.lo - 0.4902) < 1e-3 && Math.abs(w.hi - 0.9433) < 1e-3);
});
test('metrics: precision and file:line, UNV excluded', () => {
  const m = metrics([{ verdict: 'TP', sourceOk: 'yes' }, { verdict: 'TP', sourceOk: 'no' }, { verdict: 'FP', sourceOk: 'n/a' }, { verdict: 'UNV', sourceOk: 'n/a' }]);
  assert.equal(m.precision.n, 3);
  assert.equal(m.fileLine.k, 1);
  assert.equal(m.fileLine.n, 2);
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { anonymiseRow, committedMaxAlias, containsDenied, hashString, loadDenylist, resolveSite, safeString } from '../anonymise.mjs';
import { aliasOf } from '../metrics.mjs';

test('compare: a corpus row stored with a hashed route or selector still matches the literal report value', () => {
  const route = '/life-at-acme', selector = '#acme-brand-hero';
  const rows = [{ site: 's01', route: hashString(route), rule: 'a', selector: hashString(selector), verdict: 'TP' },
    { site: 's01', route: hashString(route), rule: 'b', selector: hashString('#other'), verdict: 'FP' }];
  const report = { pages: [{ route, findings: [f(route, 'a', selector), f(route, 'b', '#moved')] }] };
  const r = compare(report, rows, 's01');
  assert.deepEqual(r.tally, { TP: 1, FP: 1, UNV: 0 }); // exact via hash, then route|rule fallback via hash
  assert.equal(r.lost.length, 0);
});
test('compare: a hashed TP whose route was scanned and no longer confirms is reported as lost', () => {
  const rows = [{ site: 's01', route: hashString('/x-y'), rule: 'a', selector: '#q', verdict: 'TP' }];
  assert.equal(compare({ pages: [{ route: '/x-y', findings: [] }] }, rows, 's01').lost.length, 1);
});
test('anonymiseRow: alias for the site, no free text, hash only when a denied term is present', () => {
  const map = { sites: {} };
  const row = { site: 'real-name', route: '/about-us', selector: 'main>a', rule: 'r', verdict: 'TP', sourceOk: 'yes', ownerOk: 'yes', reviewedAt: 't', via: 'v', provenance: ['p'], outerHTML: '<a>x</a>', message: 'text' };
  const nn = (n) => `s${String(committedMaxAlias() + n).padStart(2, '0')}`; // new aliases start above the committed corpus
  const a = anonymiseRow(row, map);
  assert.equal(a.site, nn(1));
  assert.equal(a.route, '/about-us');
  assert.equal('outerHTML' in a || 'message' in a, false);
  assert.equal(anonymiseRow({ ...row, site: 'real-name' }, map).site, nn(1), 'alias is stable');
  assert.equal(anonymiseRow({ ...row, site: 'other' }, map).site, nn(2));
  assert.equal(resolveSite('real-name', { sites: { 'real-name': 's01' } }), 's01');
  assert.equal(resolveSite('s07', { sites: {} }), 's07');
});
test('metrics aliasOf: a real name that is not in the private map never prints', () => {
  assert.equal(aliasOf('s03', { sites: {} }), 's03');
  assert.equal(aliasOf('some-customer', { sites: {} }), 'unmapped');
  assert.equal(aliasOf('some-customer', { sites: { 'some-customer': 's09' } }), 's09');
});
test('denylist: generic words pass, the committed list is hashes only', () => {
  assert.equal(containsDenied('about us /careers /jobs main>nav>a'), false);
  assert.equal(safeString('/careers'), '/careers');
  assert.ok(loadDenylist().hashes.size > 20);
});
test('recover-corpus writes aliases, never the real site name', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ada-eval-'));
  const wf = path.join(dir, 'wf_1');
  fs.mkdirSync(wf);
  const site = 'zz-real-customer';
  fs.writeFileSync(path.join(wf, 'agent-1.meta.json'), JSON.stringify({ description: `adjudicate:${site}:x:A` }));
  const id = 'abcde12345';
  const u = { type: 'user', message: { content: `{"id":"${id}","route":"/r","rule":"Rule","x":1,"selector":"main>a"}` } };
  const o = { type: 'assistant', timestamp: '2026-01-01T00:00:00Z', message: { content: [{ type: 'tool_use', name: 'StructuredOutput', input: { verdicts: [{ id, verdict: 'TP', sourceOk: 'yes', ownerOk: 'yes' }] } }] } };
  fs.writeFileSync(path.join(wf, 'agent-1.jsonl'), [u, o].map((x) => JSON.stringify(x)).join('\n'));
  const out = path.join(dir, 'out.json');
  const map = path.join(dir, 'map.json');
  execFileSync(process.execPath, [new URL('../recover-corpus.mjs', import.meta.url).pathname, dir, out], { env: { ...process.env, ADA_EVAL_SITE_MAP: map, ADA_EVAL_CORPUS: path.join(dir, 'none.json') } });
  const rows = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].site, 's01');
  assert.equal(JSON.stringify(rows).includes(site), false);
  assert.equal(JSON.parse(fs.readFileSync(map, 'utf8')).sites[site], 's01');
});

test('anonymise-corpus: with no private map, a new site never reuses an alias of the committed corpus', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ada-eval-'));
  const committed = path.join(dir, 'corpus.json');
  const row = (site) => ({ site, route: '/jobs', rule: 'button-name', selector: 'main>button', verdict: 'TP', sourceOk: 'yes', ownerOk: 'yes', reviewedAt: '2026-11-04T00:00:00Z', via: 'adjudicated', provenance: ['p'] });
  fs.writeFileSync(committed, JSON.stringify([row('s01'), row('s02'), row('s07')]));
  fs.writeFileSync(path.join(dir, 'raw.json'), JSON.stringify([row('new-customer-x'), row('another-new-one')]));
  const map = path.join(dir, 'map.json'); // does not exist: the situation of a developer without the private map
  const r = spawnSync(process.execPath, [new URL('../anonymise-corpus.mjs', import.meta.url).pathname, path.join(dir, 'raw.json'), path.join(dir, 'out.json')], { env: { ...process.env, ADA_EVAL_SITE_MAP: map, ADA_EVAL_CORPUS: committed }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /no private site map/);
  const sites = JSON.parse(fs.readFileSync(path.join(dir, 'out.json'), 'utf8')).map((x) => x.site).sort();
  assert.deepEqual(sites, ['s08', 's09']);
  assert.deepEqual(JSON.parse(fs.readFileSync(map, 'utf8')).sites, { 'another-new-one': 's08', 'new-customer-x': 's09' });
});
test('aliasFor: the next alias is above both the private map and the committed corpus', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ada-eval-'));
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', `import { aliasFor } from ${JSON.stringify(new URL('../anonymise.mjs', import.meta.url).href)};
    const m = { sites: { a: 's12' } }; console.log(aliasFor('b', m), aliasFor('a', m), aliasFor('s03', m));`], { env: { ...process.env, ADA_EVAL_CORPUS: path.join(dir, 'none.json') }, encoding: 'utf8' });
  assert.equal(out.trim(), 's13 s12 s03');
});
