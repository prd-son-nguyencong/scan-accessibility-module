import '../helpers/hermetic-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildScanReportV2 } from '../../src/reporter/report-v2.js';
import { buildTaskSet, parseWcag, writeTaskSet } from '../../src/fix/export/tasks.js';
import { runFixSubcommand } from '../../src/index.js';

const ctx = { generatedAt: '2026-10-27T00:00:00.000Z', producer: { name: 'ada-scan', version: '1.0.1' }, target: { mode: 'url-only', url: 'https://example.test/' } };
const axeRun = { layer: 'axe', engine: { name: 'axe-core', version: '4.12.1' }, status: 'complete' };
const where = { file: 'src/partials/home/hero.liquid', line: 4, confidence: 'medium', mode: 'local', method: 'marker' };
const v = (over) => ({
  ruleId: 'image-alt', layer: 'axe', impact: 'critical', verdict: 'confirmed', wcagRef: 'wcag2a, wcag111',
  element: { selector: 'img.a', outerHTML: '<img class="a" src="a.png">' }, fix: { hint: 'Images need alt text' }, source: where, evidence: { failureSummary: 'Fix any of the following: measured on the live DOM' }, ...over,
});
const pg = (route, violations) => ({ name: route, page: route, url: `https://example.test${route}`, scannerRuns: [axeRun], violations });
const report = buildScanReportV2([
  pg('/', [
    v({}),
    v({ element: { selector: 'img.b', outerHTML: '<img class="b" src="b.png">' } }),
    v({ ruleId: 'button-name', impact: 'serious', wcagRef: 'wcag2a, wcag412', source: undefined, element: { selector: 'button.x', outerHTML: '<button class="x"></button>' } }),
    v({ ruleId: 'color-contrast', impact: 'serious', verdict: 'needs-review', wcagRef: 'wcag2aa, wcag143', element: { selector: 'p.c', outerHTML: '<p class="c">x</p>' } }),
    v({ ruleId: 'aria-widget', impact: 'moderate', evidence: { proof: { type: 'attribute-value', fact: 'measured on the live DOM' } }, element: { selector: 'div.w', outerHTML: '<div data-react-component="Jobs"></div>' } }),
  ]),
  pg('/about', [v({ element: { selector: 'img.a', outerHTML: '<img class="a" src="a.png">' } })]),
], ctx);

const root = mkdtempSync(path.join(tmpdir(), 'ada-export-src-'));
mkdirSync(path.join(root, 'src/partials/home'), { recursive: true });
writeFileSync(path.join(root, where.file), ['<section>', '<h1>Hi</h1>', '<div>', '<img src="a.png">', '</div>', '<p>end</p>', '<p>x</p>'].join('\n'));

test('parseWcag reads axe tags and dotted refs', () => {
  assert.deepEqual(parseWcag('wcag2aa, wcag143'), { criteria: ['1.4.3'], level: 'AA' });
  assert.deepEqual(parseWcag('wcag21aa, wcag1410'), { criteria: ['1.4.10'], level: 'AA' });
  assert.deepEqual(parseWcag('WCAG 4.1.2'), { criteria: ['4.1.2'], level: null });
});

test('same rule + source line is one task with every page; untraced says locate manually; platform is not a task', () => {
  const set = buildTaskSet(report, { sourceRoot: root });
  assert.deepEqual(set.tasks.map((t) => [t.rule, t.severity, t.pages]), [
    ['image-alt', 'critical', ['/', '/about']],
    ['button-name', 'serious', ['/']],
  ]);
  const [img, btn] = set.tasks;
  // two elements on one authoring line are one finding (count 2); every element still counts
  assert.equal(img.occurrences.reduce((n, o) => n + o.count, 0), 3);
  assert.deepEqual(img.wcag, { criteria: ['1.1.1'], level: 'A' });
  assert.deepEqual([img.source.file, img.source.line], ['src/partials/home/hero.liquid', 4]);
  assert.equal(img.source.excerpt, ['     2 | <h1>Hi</h1>', '     3 | <div>', '>    4 | <img src="a.png">', '     5 | </div>', '     6 | <p>end</p>'].join('\n'));
  assert.equal(btn.source, null);
  assert.equal(btn.locateManually.reason, 'unresolved');
  assert.equal(btn.untraced, true);
  assert.equal(img.untraced, undefined);
  assert.deepEqual(set.notActionable.map((n) => [n.rule, n.ownership, n.pages]), [['aria-widget', 'platform', ['/']]]);
  assert.deepEqual(set.omitted, { needsReview: 1, info: 0 });
  assert.match(renderedOf(set, 0), /rule `image-alt` no longer reported on pages \/, \/about for selector pattern `img.a`/);
  assert.match(renderedOf(set, 0), /`src\/partials\/home\/hero.liquid:4` \(trace confidence: medium\)/);
  assert.match(renderedOf(set, 0), /<img src="a.png" alt="<what the image shows/);
  assert.match(renderedOf(set, 1), /Untraced: locate manually\. .*\(unresolved\)/);
});
const renderedOf = (set, i) => readFileSync(path.join(writeTaskSet(set, mkdtempSync(path.join(tmpdir(), 'ada-export-out-'))).dir, `${set.tasks[i].fileBase}.md`), 'utf8');

test('filters: severity (or worse), rule, page, max, needs-review opt-in', () => {
  const rules = (o) => buildTaskSet(report, { sourceRoot: root, ...o }).tasks.map((t) => t.rule);
  assert.deepEqual(rules({ severity: 'critical' }), ['image-alt']);
  assert.deepEqual(rules({ rule: 'button-name' }), ['button-name']);
  assert.deepEqual(rules({ page: '/about/' }), ['image-alt']);
  assert.deepEqual(rules({ max: 1 }), ['image-alt']);
  assert.deepEqual(rules({ includeNeedsReview: true }), ['image-alt', 'button-name', 'color-contrast']);
  assert.equal(buildTaskSet(report, { sourceRoot: root, max: 1 }).totalTasks, 2);
});

test('export is deterministic, never leaves the tasks folder, never overwrites a foreign file, removes stale own files', () => {
  const out = mkdtempSync(path.join(tmpdir(), 'ada-export-out-'));
  const set = buildTaskSet(report, { sourceRoot: root });
  const a = writeTaskSet(set, out);
  const snap = () => Object.fromEntries(readdirSync(a.dir).map((n) => [n, readFileSync(path.join(a.dir, n), 'utf8')]));
  const first = snap();
  writeTaskSet(buildTaskSet(report, { sourceRoot: root }), out);
  assert.deepEqual(snap(), first);
  assert.equal(Object.keys(first).length, 6); // INDEX + not-your-code + 2 x (md, json)
  assert.match(first['not-your-code.md'], /`aria-widget` - Paradox React widget: Jobs - 1 finding\(s\) on \/\n  - Action: Report to the platform team/);
  assert.ok(!JSON.stringify(first).includes(root) && !first['INDEX.md'].includes(tmpdir()));
  assert.match(first['INDEX.md'], /Tasks: 2 \(critical 1, serious 1, moderate 0, minor 0\)/);
  assert.match(first['INDEX.md'], /\[moderate\] `aria-widget` - Paradox React widget: Jobs - 1 finding\(s\) on \//);
  const side = JSON.parse(first[Object.keys(first).find((n) => n.startsWith('image-alt') && n.endsWith('.json'))]);
  assert.deepEqual([side.rule, side.wcag.criteria, side.occurrences.reduce((n, o) => n + o.count, 0)], ['image-alt', ['1.1.1'], 3]);
  // stale own file goes, a user's file stays, a foreign file in a task's name blocks the write
  writeFileSync(path.join(a.dir, 'notes.md'), 'mine');
  writeTaskSet(buildTaskSet(report, { sourceRoot: root, rule: 'button-name' }), out);
  assert.deepEqual(readdirSync(a.dir).sort(), [...Object.keys(first).filter((n) => n.startsWith('button-name')), 'INDEX.md', 'notes.md'].sort());
  writeFileSync(path.join(a.dir, 'INDEX.md'), 'user text');
  assert.throws(() => writeTaskSet(set, out), /not an ada-scan file/);
  assert.equal(readFileSync(path.join(a.dir, 'INDEX.md'), 'utf8'), 'user text');
});

test('fix --export writes tasks under --out-dir from --report and --source', async () => {
  const out = mkdtempSync(path.join(tmpdir(), 'ada-export-cli-'));
  const file = path.join(out, 'report.json');
  writeFileSync(file, JSON.stringify(report));
  await runFixSubcommand(['--export', '--report', file, '--source', root, '--out-dir', out, '--severity', 'critical']);
  const index = readFileSync(path.join(out, 'tasks/INDEX.md'), 'utf8');
  assert.match(index, /Tasks: 1 /);
  assert.ok(existsSync(path.join(out, 'tasks')));
  await assert.rejects(() => runFixSubcommand(['--export', '--report', file, '--max', 'x', '--out-dir', out]), /--max must be a whole number/);
});
