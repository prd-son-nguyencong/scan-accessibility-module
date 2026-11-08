// Round 4 harness noise: defect identity, hunk ownership by id attribute, baseline noise, warnings, report wording.
import '../helpers/hermetic-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkingTreeFixer } from '../../src/fix/harness/fixers/external.js';
import { normalizeTask } from '../../src/fix/harness/runner.js';
import { buildRemainingReport, defectKey } from '../../src/fix/harness/remaining.js';

test('defectKey takes the id from the id part of the selector, never from an attribute value', () => {
  const k1 = defectKey('link-name', '/', '.card:nth-child(1) > a[href="#apply"]');
  assert.notEqual(k1, defectKey('link-name', '/', '.card:nth-child(2) > a[href="#apply"]'), 'distinct elements keep distinct keys');
  assert.notEqual(k1, 'link-name|/|#apply');
  assert.equal(defectKey('link-name', '/', 'section#apply'), 'link-name|/|#apply');
  assert.equal(defectKey('link-name', '/', 'body > header#top > nav#mobile-navigation'), 'link-name|/|#mobile-navigation');
  assert.notEqual(defectKey('link-name', '/', '#apply'), defectKey('link-name', '/', 'a[href="#apply"]'));
});

test('zero-remaining claim does not flip when an unseen finding shares an attribute-value hash with a seen one', () => {
  const f = (id, sel) => ({ stableId: id, nativeRuleId: 'link-name', impact: 'serious', verdict: 'confirmed', ownership: 'source', route: '/', element: { selector: sel } });
  const report = { pages: [{ route: '/', findings: [f('a', '.card:nth-child(1) > a[href="#apply"]'), f('b', '.card:nth-child(2) > a[href="#apply"]')] }] };
  const base = [{ id: 'a', rule: 'link-name', native: 'link-name', route: '/', selector: '.card:nth-child(1) > a[href="#apply"]', tier: 'confirmed' }];
  const r = buildRemainingReport({ report, tasks: [{ id: 't', ids: ['a'], rule: 'link-name' }], results: [{ taskId: 't', outcome: 'accepted' }], baselineFindings: base, finalFindings: [], finalScan: { proved: true }, scanDelta: { before: 1, after: 0, fixed: 1, added: 0 } });
  assert.equal(r.zeroRemainingClaim, false);
  assert.equal(r.notRescanned.length, 1);
});

const git = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
test('a script-traced task does not claim a template hunk that only mentions its id as a bare word (href, class, text)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'j3-'));
  try {
    git(dir, 'init', '-q'); git(dir, 'config', 'user.email', 't@t'); git(dir, 'config', 'user.name', 't');
    mkdirSync(join(dir, 'src/partials'), { recursive: true }); mkdirSync(join(dir, 'src/scripts'), { recursive: true });
    writeFileSync(join(dir, 'src/partials/footer.liquid'), '<footer>\n<a href="/search" class="foot-link">Search jobs</a>\n</footer>\n');
    writeFileSync(join(dir, 'src/scripts/index.js'), `${'//\n'.repeat(9)}document.getElementById('search').addEventListener('click',go);\n`);
    git(dir, 'add', '.'); git(dir, 'commit', '-q', '-m', 'b');
    writeFileSync(join(dir, 'src/partials/footer.liquid'), '<footer>\n<a href="/search" class="foot-link" aria-label="Search jobs">Search jobs</a>\n</footer>\n');
    const fixer = createWorkingTreeFixer({ dir });
    const raw = { id: 'S', rule: 'click-events-have-key-events', source: { file: 'src/scripts/index.js', line: 10 }, element: { html: '<div id="search" class="box">' }, occurrences: [{ selector: '#search' }] };
    fixer.setTasks([normalizeTask(raw)]);
    const t = normalizeTask(fixer.retarget([raw])[0]);
    assert.ok(!t.allowlist.some((e) => e.file === 'src/partials/footer.liquid'), JSON.stringify(t.allowlist));
    assert.ok(fixer.unassigned().every((u) => !u.ownedBy), JSON.stringify(fixer.unassigned()));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- baseline noise ----
import { deflateSync } from 'node:zlib';
import { baselineNoise, compareLayout, compareStyles, compareBehaviour, compareVisual, evaluateTargeted } from '../../src/fix/harness/index.js';
import { unifiedDiff } from '../../src/fix/harness/change.js';
import { sparseOnly, renderRunMarkdown } from '../../src/fix/harness/runner.js';
import { renderRemainingMarkdown } from '../../src/fix/harness/remaining.js';
import { writtenNotice } from '../../src/fix/export/skill/install.js';

const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const t = Buffer.from(type); const l = Buffer.alloc(4); l.writeUInt32BE(data.length); const c = Buffer.alloc(4); c.writeUInt32BE(crc(Buffer.concat([t, data]))); return Buffer.concat([l, t, data, c]); };
/** White png w x h with black pixels at the given [x,y] points. */
const png = (w, h, dots = []) => {
  const raw = Buffer.alloc((w * 3 + 1) * h, 255);
  for (let y = 0; y < h; y++) raw[y * (w * 3 + 1)] = 0;
  for (const [x, y] of dots) { const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = raw[o + 1] = raw[o + 2] = 0; }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
};
const SPAN = 'body:nth(0) > span:nth(0)', BTN = 'body:nth(0) > button:nth(0)';
const baseLayout = () => ({ 'body:nth(0)': { x: 0, y: 0, w: 200, h: 200, hid: false }, [SPAN]: { x: 10, y: 10, w: 20, h: 10, hid: false } });
const cell = (file, o = {}) => ({
  screenshot: { file }, docHeight: 200, docWidth: 200, layout: baseLayout(),
  styles: { [SPAN]: { color: 'red' } }, interactions: { [BTN]: { delta: 2, restored: true, nav: false } },
  tabOrder: [], links: [], console: [], failedRequests: [], ids: {}, ...o,
});
const snap = (dir, c) => ({ version: 2, screenshotDir: dir, truncated: false, routes: { '/': { '375x812': c } }, perf: {} });

test('baseline noise: keys and regions that differ between two baseline captures are ignored by G3, G4, G5 and G6, real changes still fail', () => {
  const dir = mkdtempSync(join(tmpdir(), 'j3n-'));
  try {
    writeFileSync(join(dir, 'a.png'), png(200, 200, [[50, 50]]));
    writeFileSync(join(dir, 'b.png'), png(200, 200, [[51, 50]]));
    writeFileSync(join(dir, 'after.png'), png(200, 200, [[52, 51]]));
    writeFileSync(join(dir, 'real.png'), png(200, 200, [[50, 50], [150, 150]]));
    const base = snap(dir, cell('a.png'));
    const second = snap(dir, cell('b.png', {
      layout: { ...baseLayout(), [SPAN]: { x: 10, y: 10, w: 26, h: 10, hid: false } },
      styles: { [SPAN]: { color: 'blue' } },
      interactions: { [BTN]: { delta: 1, restored: true, nav: false } },
    }));
    base.noise = baselineNoise(base, second);
    const n = base.noise['/']['375x812'];
    assert.deepEqual(n.layout, [SPAN]);
    assert.deepEqual(n.styles, [SPAN]);
    assert.deepEqual(n.interactions, [BTN]);
    assert.ok(n.pixels.length > 0);

    const afterNoisy = snap(dir, cell('after.png', {
      layout: { ...baseLayout(), [SPAN]: { x: 10, y: 10, w: 40, h: 10, hid: false } },
      styles: { [SPAN]: { color: 'green' } },
      interactions: { [BTN]: { delta: 0, restored: true, nav: false } },
    }));
    const strict = { minDiffPixels: 0, maxDiffFraction: 0 };
    assert.equal(compareLayout(base, afterNoisy).pass, true);
    assert.equal(compareStyles(base, afterNoisy).pass, true);
    assert.equal(compareBehaviour(base, afterNoisy).pass, true);
    assert.equal(compareVisual(base, afterNoisy, strict).pass, true, 'speckle inside a noisy region is ignored');
    // The same after-snapshot fails without the stored noise: the verdict comes from the stored baseline.
    const plain = { ...base, noise: undefined };
    assert.equal(compareLayout(plain, afterNoisy).pass, false);
    assert.equal(compareStyles(plain, afterNoisy).pass, false);
    assert.equal(compareBehaviour(plain, afterNoisy).pass, false);
    assert.equal(compareVisual(plain, afterNoisy, strict).pass, false);
    // A real change in a quiet region, or a non-noisy element moving, still fails.
    assert.equal(compareVisual(base, snap(dir, cell('real.png')), strict).pass, false);
    assert.equal(compareLayout(base, snap(dir, cell('a.png', { layout: { ...baseLayout(), 'body:nth(0)': { x: 0, y: 0, w: 200, h: 260, hid: false } } }))).pass, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('sparseOnly: only small pixel diffs and flipped interaction smokes qualify for the one recapture', () => {
  const g = (gate, evidence) => ({ gate, pass: evidence.length === 0, evidence });
  const r = (...gates) => ({ pass: gates.every((x) => x.pass), gates });
  assert.equal(sparseOnly(r(g('G4', [{ kind: 'PIXEL_DIFF', diffPixels: 636, limit: 118 }]), g('G6', [{ kind: 'INTERACTION_CHANGED' }]))), true);
  assert.equal(sparseOnly(r(g('G4', [{ kind: 'PIXEL_DIFF', diffPixels: 5000, limit: 118 }]))), false);
  assert.equal(sparseOnly(r(g('G3', [{ kind: 'MOVED' }]), g('G4', [{ kind: 'PIXEL_DIFF', diffPixels: 50 }]))), false);
  assert.equal(sparseOnly(r(g('G6', [{ kind: 'TAB_ORDER_CHANGED' }]))), false);
  assert.equal(sparseOnly(r(g('G4', []))), false, 'a passing result needs no recapture');
});

test('G1 reports a new likely-tier finding (heading-order after an h1 retag) as a warning without failing the gate', () => {
  const row = (id, tier, rule) => ({ id, route: '/', rule, native: rule, selector: 'h3', tier, rootCauseKey: `${rule}|${id}` });
  const r = evaluateTargeted({ targetFindingIds: ['t'], affectedRoutes: ['/'], before: [row('t', 'confirmed', 'page-has-heading-one')], after: [row('n', 'likely', 'heading-order')] });
  assert.equal(r.pass, true);
  assert.deepEqual(r.warnings.map((w) => [w.rule, w.tier]), [['heading-order', 'likely']]);
  const gated = evaluateTargeted({ targetFindingIds: ['t'], affectedRoutes: ['/'], before: [row('t', 'confirmed', 'x')], after: [row('n', 'confirmed', 'heading-order')] });
  assert.equal(gated.pass, false);
  assert.equal(gated.warnings, undefined);
});

test('unified diff merges hunks whose context overlaps into one block', () => {
  const before = 'a\nb\n<h1>\nx\ny\n</h1>\nz\nq\nr\n';
  const after = before.replace('<h1>', '<h2>').replace('</h1>', '</h2>');
  const d = unifiedDiff([{ path: 'f', before, after }]);
  assert.equal((d.match(/^@@/gm) || []).length, 1, d);
  assert.match(d, /-<h1>\n\+<h2>\n x\n y\n-<\/h1>\n\+<\/h2>/);
  const far = `${before}${'k\n'.repeat(20)}w\n`;
  assert.equal((unifiedDiff([{ path: 'f', before: far, after: far.replace('<h1>', '<h2>').replace('w\n', 'W\n') }]).match(/^@@/gm) || []).length, 2, 'distant hunks stay separate');
});

test('reports: untraced tasks print as untraced, the count reconciles with rescan rows, an unseen layer is named', () => {
  const md = renderRunMarkdown({ status: 'ok', applyStatus: 'none', table: [{ taskId: 'T', rule: 'r', file: 'src/partials/index/hero.liquid', line: 0, outcome: 'accepted', failedGates: [], iterations: 1 }], scanDelta: { before: 162, beforeRows: 164, after: 162, fixed: 0, added: 0 }, accepted: [], gatesSkipped: [], incomplete: [], diff: '', scans: {} });
  assert.match(md, /hero\.liquid \(untraced\)/);
  assert.doesNotMatch(md, /hero\.liquid:0/);
  assert.match(md, /162 before \(164 rows\)/);

  const f = (id, sel, layers) => ({ stableId: id, nativeRuleId: 'svg-sprite-not-hidden', impact: 'moderate', verdict: 'confirmed', ownership: 'source', route: '/', layers, element: { selector: sel } });
  const rep = { pages: [{ route: '/', findings: [f('a', '#s1', ['screenReader']), f('b', '#s2', ['axe', 'screenReader'])] }] };
  const r = buildRemainingReport({ report: rep, tasks: [], results: [], baselineFindings: [], finalFindings: [], finalScan: { proved: true }, scanDelta: { before: 0, after: 0, fixed: 0, added: 0 } });
  const text = renderRemainingMarkdown(r);
  assert.match(text, /#s1.*reported only by the screenReader layer, which the harness rescan does not run/);
  assert.match(text, /#s2.*its layer ran but the rescan did not reproduce it/);
  const dup = { ...r, source: 'final-rescan', totals: { ...r.totals, findings: 162, baselineRescan: 164, finalRescan: 164, notRescanned: 0 }, duplicates: [{}, {}], acceptedTasks: 0, fixedByAcceptedTask: 0, fixedAsSideEffect: 0 };
  assert.match(renderRemainingMarkdown(dup), /Findings: 162 distinct defect\(s\) \(164 baseline rescan row\(s\); 2 merged/);
});

test('fix --export always says where it wrote agent rules in the source tree', () => {
  assert.match(writtenNotice('cursor', { patterns: [] }), /\.cursor\/rules\/ada-scan\.mdc.*already git-ignored/);
  assert.match(writtenNotice('cursor', { patterns: ['x'] }), /not git-ignored, see below/);
  assert.match(writtenNotice('claude', null), /\.claude\/ada-scan\.md.*not a git work tree/);
  assert.equal(writtenNotice('generic', null), null);
});
