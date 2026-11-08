import './helpers/hermetic-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { rulePrecision, lowPrecisionRules, runLabelSubcommand, runLabelsSubcommand, loadScanLabelContext } from '../src/reporter/labels.js';
import { buildScanReportV2 } from '../src/reporter/report-v2.js';
import { buildQaModel, renderQaHtml } from '../src/reporter/qa-report.js';
import { setReportsDir } from '../src/utils/paths.js';

const tmp = () => mkdtempSync(path.join(tmpdir(), 'ada-labels-'));
const lab = (ruleId, verdict, i, over = {}) => ({ stableId: `${ruleId}-${i}`, ruleId, verdict, labeler: 'Rae', date: '2026-10-01', note: '', stableIdVersion: 2, ...over });
const many = (ruleId, tp, fp, over) => [
  ...Array.from({ length: tp }, (_, i) => lab(ruleId, 'true-positive', `t${i}`, over)),
  ...Array.from({ length: fp }, (_, i) => lab(ruleId, 'false-positive', `f${i}`, over)),
];
const writeStore = (dir, labels) => writeFileSync(path.join(dir, 'labels.json'), JSON.stringify({ owner: 'ada-scan', version: 1, labels }));

test('precision is tp/(tp+fp) per rule; only n>=10 and precision<0.7 qualify (0.7 itself does not)', () => {
  const stats = rulePrecision([...many('a', 7, 3), ...many('b', 6, 4), ...many('c', 2, 8), ...many('d', 1, 4), ...many('e', 10, 0)]);
  assert.deepEqual(stats.map((r) => [r.ruleId, r.tp, r.fp, r.n, r.precision]), [['a', 7, 3, 10, 0.7], ['b', 6, 4, 10, 0.6], ['c', 2, 8, 10, 0.2], ['d', 1, 4, 5, 0.2], ['e', 10, 0, 10, 1]]);
  assert.deepEqual(lowPrecisionRules(stats).map((r) => r.ruleId), ['b', 'c']); // d has precision 0.2 but only 5 labels
});

test('label command: saves, replaces the same stableId, resolves --from-report from latest.json, needs --rule for an unknown id', () => {
  const dir = tmp();
  writeFileSync(path.join(dir, 'latest.json'), JSON.stringify({ stableIdVersion: 2, pages: [{ findings: [{ stableId: 's-1', nativeRuleId: 'image-alt' }] }, { findings: [{ stableId: 's-2', nativeRuleId: 'label' }] }] }));
  const run = (args) => runLabelSubcommand([...args, '--out-dir', dir, '--by', 'Rae', '--date', '2026-10-02']);
  run(['--from-report', '2', '--fp', '--note', 'hidden field']);
  run(['s-2', '--tp']);
  run(['s-1', '--tp']);
  assert.throws(() => run(['s-unknown', '--tp']), /add --rule/);
  assert.throws(() => run(['s-1']), /exactly one of --tp or --fp/);
  assert.throws(() => run(['--from-report', '3', '--tp']), /has 2 finding/);
  run(['s-unknown', '--fp', '--rule', 'link-name']);
  const labels = JSON.parse(readFileSync(path.join(dir, 'labels.json'), 'utf8')).labels;
  assert.deepEqual(labels.map((l) => [l.stableId, l.ruleId, l.verdict, l.stableIdVersion]).sort(), [
    ['s-1', 'image-alt', 'true-positive', 2], ['s-2', 'label', 'true-positive', 2], ['s-unknown', 'link-name', 'false-positive', 2]]);
  assert.deepEqual(readdirSync(dir).sort(), ['labels.json', 'latest.json']);
  setReportsDir(undefined);
});

test('a labels.json that the tool does not own is reported and left untouched', () => {
  const dir = tmp();
  writeFileSync(path.join(dir, 'labels.json'), '{"mine": true}');
  assert.throws(() => runLabelSubcommand(['x', '--tp', '--by', 'Rae', '--rule', 'r', '--out-dir', dir]), /will not overwrite/);
  assert.equal(readFileSync(path.join(dir, 'labels.json'), 'utf8'), '{"mine": true}');
  setReportsDir(undefined);
});

test('labels stats prints exact precision and warns about labels from an old stableId version', () => {
  const dir = tmp();
  writeStore(dir, [...many('b', 6, 4), lab('old', 'true-positive', 'x', { stableIdVersion: 1 })]);
  const out = runLabelsSubcommand(['stats', '--out-dir', dir]);
  assert.match(out, /^b {2}6 {2}4 {2}10 {2}60% {2}\(below threshold\)$/m);
  assert.match(out, /^old {2}1 {2}0 {2}1 {2}100% {2}\(fewer than 10 labels/m);
  assert.match(out, /Warning: 1 label\(s\) were made under another stable-id version/);
  setReportsDir(undefined);
});

test('labels apply writes rule-demotions.json only with --yes, and never over a foreign file', () => {
  const dir = tmp();
  writeStore(dir, [...many('b', 6, 4), ...many('a', 7, 3)]);
  assert.match(runLabelsSubcommand(['apply', '--out-dir', dir]), /b: 60% over 10 labels[\s\S]*Nothing written/);
  assert.equal(existsSync(path.join(dir, 'rule-demotions.json')), false);
  runLabelsSubcommand(['apply', '--yes', '--out-dir', dir]);
  const d = JSON.parse(readFileSync(path.join(dir, 'rule-demotions.json'), 'utf8'));
  assert.equal(d.owner, 'ada-scan');
  assert.deepEqual(d.demotions.map((x) => [x.ruleId, x.tp, x.fp, x.n, x.precision]), [['b', 6, 4, 10, 0.6]]);
  writeFileSync(path.join(dir, 'rule-demotions.json'), '{"mine": 1}');
  assert.throws(() => runLabelsSubcommand(['apply', '--yes', '--out-dir', dir]), /will not overwrite/);
  assert.equal(readFileSync(path.join(dir, 'rule-demotions.json'), 'utf8'), '{"mine": 1}');
  setReportsDir(undefined);
});

test('scan context: applied demotions are loaded; unapplied low-precision rules and old labels warn; bad files warn, never throw', () => {
  const dir = tmp();
  setReportsDir(dir);
  writeStore(dir, [...many('b', 6, 4), ...many('c', 0, 12, { stableIdVersion: 1 })]);
  runLabelsSubcommand(['apply', '--yes', '--out-dir', dir]);
  writeStore(dir, [...many('b', 6, 4), ...many('c', 0, 12, { stableIdVersion: 1 }), ...many('z', 1, 9)]);
  const ctx = loadScanLabelContext();
  assert.deepEqual(ctx.demotions.map((d) => d.ruleId), ['b', 'c']);
  assert.equal(ctx.warnings.length, 2);
  assert.match(ctx.warnings[0], /12 label\(s\) were made under stable-id v1 and cannot be matched to this scan \(v2\)/);
  assert.match(ctx.warnings[1], /1 rule\(s\) have precision below 70% over at least 10 labels \(z 10%\)/);
  writeFileSync(path.join(dir, 'rule-demotions.json'), 'nope');
  assert.match(loadScanLabelContext().warnings[0], /Rule demotions were not applied/);
  setReportsDir(undefined);
});

const ctx = { generatedAt: '2026-10-27T00:00:00.000Z', producer: { name: 'ada-scan', version: '1' }, target: { mode: 'url-only', url: 'https://example.test/' } };
const viol = (ruleId, selector, html) => ({ ruleId, layer: 'axe', impact: 'serious', element: { selector, outerHTML: html }, fix: { hint: 'h' }, evidence: { failureSummary: 'Fix any of the following: x' } });
const build = (extra) => buildScanReportV2([{ page: '/', url: 'https://example.test/', scannerRuns: [{ layer: 'axe', engine: { name: 'axe', version: '1' }, status: 'complete' }], violations: [viol('image-alt', 'img.a', '<img src="a.png">'), viol('button-name', 'button.b', '<button class="b"></button>')] }], { ...ctx, ...extra });

test('a demoted rule becomes needs-review (earlier verdict kept), other rules and the summary follow; no demotions = unchanged', () => {
  const plain = build({});
  assert.equal(plain.runMetadata?.ruleDemotions, undefined);
  assert.equal(plain.summary.verdictCounts.confirmed, 2);
  const r = build({ ruleDemotions: [{ ruleId: 'image-alt', n: 12, precision: 0.5 }] });
  const by = Object.fromEntries(r.pages[0].findings.map((f) => [f.nativeRuleId, f]));
  assert.equal(by['image-alt'].verdict, 'needs-review');
  assert.equal(by['image-alt'].verdictBeforeAgreement, 'confirmed');
  assert.equal(by['image-alt'].demotion, 'rule-precision');
  assert.equal(by['button-name'].verdict, 'confirmed');
  assert.deepEqual(r.summary.verdictCounts, { confirmed: 1, likely: 0, needsReview: 1 });
  assert.deepEqual(r.runMetadata.ruleDemotions, { rules: [{ ruleId: 'image-alt', n: 12, precision: 0.5 }], demotedFindings: 1 });
});

test('findings already needs-review (single-engine under strict) are still counted as affected by a demoted rule', () => {
  const heur = { ruleId: 'color-contrast', layer: 'axe', impact: 'serious', element: { selector: 'p.x', outerHTML: '<p class="x">t</p>' }, fix: { hint: 'h' }, evidence: { failureSummary: 'Fix any of the following: x' } };
  const run = { layer: 'axe', engine: { name: 'axe', version: '1' }, status: 'complete' };
  const r = buildScanReportV2([{ page: '/', url: 'https://example.test/', scannerRuns: [run], violations: [heur, viol('image-alt', 'img.a', '<img src="a.png">')] }], { ...ctx, ruleDemotions: [{ ruleId: 'color-contrast', n: 10, precision: 0.5 }, { ruleId: 'image-alt', n: 10, precision: 0.5 }] });
  const by = Object.fromEntries(r.pages[0].findings.map((f) => [f.nativeRuleId, f]));
  assert.equal(by['color-contrast'].verdict, 'needs-review');
  assert.equal(by['color-contrast'].demotion, 'rule-precision');
  assert.equal(r.runMetadata.ruleDemotions.demotedFindings, 2);
});

test('QA report shows the Rule precision section and a copyable label command per finding, with no script', () => {
  const report = build({});
  const id = report.pages[0].findings.find((f) => f.nativeRuleId === 'image-alt').stableId;
  const html = renderQaHtml(buildQaModel(report, { labels: many('image-alt', 3, 1) }));
  assert.match(html, /<h2 id="prec">Rule precision<\/h2>/);
  assert.match(html, /<th scope="row">image-alt<\/th><td>3<\/td><td>1<\/td><td>4<\/td><td>75% \(under 10 labels, not acted on\)<\/td>/);
  assert.ok(html.includes(`<code>ada-scan label ${id} --tp --by YOUR_NAME</code>`));
  assert.ok(!/<script[^>]*\ssrc=/i.test(html) && !/\son[a-z]+="/i.test(html)); // only the inline theme script, no external script and no inline handlers
  assert.match(renderQaHtml(buildQaModel(report)), /No QA labels yet/);
});
