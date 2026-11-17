import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { decodePng, diffImages, noiseMargin, comparePerf, extractBackendTokens, extractDesignTokens, diffMultisets, diffLines, evaluateScope, evaluateTargeted, evaluateBuildValidity, decideAcceptance, riskScore } from '../../src/fix/harness/index.js';

function png(w, h, rgba) {
  const rows = [];
  for (let y = 0; y < h; y++) { rows.push(Buffer.from([0]), Buffer.from(rgba.slice(y * w * 4, (y + 1) * w * 4))); }
  const chunk = (type, d) => { const b = Buffer.alloc(12 + d.length); b.writeUInt32BE(d.length, 0); b.write(type, 4, 'latin1'); d.copy(b, 8); return b; };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}

test('png decode round trip and image diff with ignore regions', () => {
  const px = (v) => [v, v, v, 255];
  const a = decodePng(png(2, 2, [...px(0), ...px(10), ...px(20), ...px(30)]));
  assert.deepEqual([a.w, a.h, a.data[4], a.data[12]], [2, 2, 10, 30]);
  const b = { ...a, data: Uint8Array.from(a.data) };
  b.data[0] = 200; // one pixel changed
  assert.equal(diffImages(a, b).diffPixels, 1);
  assert.equal(diffImages(a, b, { ignore: [{ x: 0, y: 0, w: 1, h: 1 }] }).diffPixels, 0);
  assert.equal(diffImages(a, { ...a, h: 1, data: a.data.slice(0, 8) }).diffPixels, 2, 'area present in one image only counts');
});

test('backend tags, pdk attributes and design tokens are extracted as multisets', () => {
  const t = extractBackendTokens('<a data-pdk-x="1">{{ data:job.title }}</a>{{data:job.title}}{{component:foo}}{{snippet:abc}}{{attribute:a}}');
  assert.equal(t.get('{{ data:job.title }}'.replace(/\s+/g, ' ')), 1);
  assert.equal(t.get('{{data:job.title}}'), 1);
  assert.equal(t.size, 6);
  const d = extractDesignTokens('.a{color:#222;border:1px solid #ccc;padding:4px;--brand:#123}<p class="hover:bg-red-500 text-sm opacity-50" style="background-image:url(x.png)">');
  assert.deepEqual([...d.keys()].sort(), ['--brand: #123', 'background-image: url(x.png)', 'border: 1px solid #ccc', 'color: #222', 'tw hover:bg-red-500', 'tw opacity-50']);
  assert.ok(!d.has('padding: 4px'));
  assert.deepEqual(diffMultisets(new Map([['a', 2]]), new Map([['a', 1], ['b', 1]])), { added: ['b'], removed: ['a'] });
});

test('diffLines reports separate hunks and insertions', () => {
  const a = 'a\nb\nc\nd\ne\nf\n', b = 'a\nB\nc\nd\nnew\ne\nf\n';
  assert.deepEqual(diffLines(a, b), [{ aStart: 2, aEnd: 2, bStart: 2, bEnd: 2 }, { aStart: 5, aEnd: 4, bStart: 5, bEnd: 5 }]);
  assert.deepEqual(diffLines(a, a), []);
});

test('scope gate: allowlist lines, forbidden paths, design lock, backend tokens, invalid json', () => {
  const T = (o) => new Map(Object.entries(o).map(([k, v]) => [k, Buffer.from(v)]));
  const before = T({ 'src/a.liquid': 'l1\nl2 {{data:x}}\nl3\n', 'src/a.css': 'p { color: #111; }\n', 'dist/x.html': 'x', 'paradox-export.json': '{}' });
  const edit = (patch) => T({ ...Object.fromEntries([...before].map(([k, v]) => [k, v.toString()])), ...patch });
  const allow = [{ file: 'src/a.liquid', startLine: 3, endLine: 3 }];
  assert.equal(evaluateScope({ beforeTree: before, afterTree: edit({ 'src/a.liquid': 'l1\nl2 {{data:x}}\nl3 ok\n' }), allowlist: allow }).pass, true);
  const kinds = (patch, extra = {}) => evaluateScope({ beforeTree: before, afterTree: edit(patch), allowlist: allow, ...extra }).evidence.map((e) => e.kind);
  assert.ok(kinds({ 'src/a.liquid': 'l1 x\nl2 {{data:x}}\nl3\n' }).includes('LINES_NOT_ALLOWLISTED'));
  assert.ok(kinds({ 'src/a.liquid': 'l1\nl2 {{data:y}}\nl3\n' }).includes('BACKEND_TOKEN_REMOVED_OR_EDITED'));
  assert.ok(kinds({ 'dist/x.html': 'y' }).includes('BUILD_OUTPUT'));
  assert.ok(kinds({ 'paradox-export.json': '{' }).includes('EXPORT_JSON'));
  assert.ok(kinds({ 'src/a.css': 'p { color: #f00; }\n' }, { allowlist: [{ file: 'src/a.css' }] }).includes('DESIGN_TOKEN_ADDED_OR_EDITED'));
  assert.deepEqual(kinds({ 'src/a.css': 'p { color: #f00; }\n' }, { allowlist: [{ file: 'src/a.css' }], designLock: false }), []);
  assert.ok(kinds({ 'src/new.html': 'n' }).includes('FILE_NOT_ALLOWLISTED'));
});

test('G1 targeted fix, G8 build validity, perf noise margin', () => {
  const f = (id, over = {}) => ({ id, rootCauseKey: `rc-${id}`, tier: 'confirmed', route: '/', ...over });
  assert.equal(evaluateTargeted({ targetFindingIds: ['a'], before: [f('a'), f('b')], after: [f('b')] }).pass, true);
  assert.equal(evaluateTargeted({ targetFindingIds: ['a'], before: [f('a')], after: [f('a2', { rootCauseKey: 'rc-a' })] }).pass, false, 'same root cause under a new id still remains');
  assert.equal(evaluateTargeted({ targetFindingIds: ['a'], before: [f('a')], after: [f('n')] }).pass, false, 'new confirmed finding');
  assert.equal(evaluateTargeted({ targetFindingIds: ['a'], before: [f('a')], after: [f('n', { tier: 'advisory' })] }).pass, true);
  assert.equal(evaluateTargeted({ targetFindingIds: [], before: [], after: [] }).pass, false);
  const ok = { build: { ok: true }, htmlValidate: { before: 3, after: 3 }, exportValid: true, formatterClean: true };
  assert.equal(evaluateBuildValidity(ok).pass, true);
  assert.equal(evaluateBuildValidity({ ...ok, htmlValidate: { before: 3, after: 4 } }).pass, false);
  assert.equal(evaluateBuildValidity({ ...ok, exportValid: null }).pass, false);
  assert.equal(noiseMargin([100, 140, 120], 50), 50);
  assert.equal(noiseMargin([100, 300, 120], 50), 200);
  const runs = (tbt, transfer = 1000) => ({ perf: { '/': { runs: [{ tbt, transfer }, { tbt: tbt + 10, transfer }, { tbt: tbt + 5, transfer }] } } });
  assert.equal(comparePerf(runs(100), runs(120)).pass, true);
  assert.equal(comparePerf(runs(100), runs(300)).pass, false);
  assert.equal(comparePerf(runs(100), runs(100, 1030)).pass, false, 'transfer +3%');
  assert.equal(comparePerf(runs(300), runs(100), { requireImprovement: { metric: 'tbt' } }).pass, true);
  assert.equal(comparePerf(runs(100), runs(100), { requireImprovement: { metric: 'tbt' } }).pass, false);
});

test('accept policy', () => {
  const pass = { pass: true, failed: [] }, fail = { pass: false, failed: ['G3'] };
  assert.equal(decideAcceptance({ gateResult: pass, mechanicallySafe: true, changedLines: 80 }).decision, 'auto_accept');
  assert.equal(decideAcceptance({ gateResult: pass, changedLines: 2, files: ['src/partials/header.liquid'] }).decision, 'auto_accept');
  assert.equal(decideAcceptance({ gateResult: pass, changedLines: 2, files: ['a.js'] }).decision, 'human_review');
  assert.deepEqual(decideAcceptance({ gateResult: fail, iteration: 1 }), { decision: 'rollback', retry: true, reason: 'gates failed: G3' });
  assert.equal(decideAcceptance({ gateResult: fail, iteration: 3 }).retry, false);
  assert.ok(riskScore({ changedLines: 2, files: ['src/partials/x.liquid'] }) <= 0.3);
});
