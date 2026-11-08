import './helpers/hermetic-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadBuiltInRuleRegistry } from '../src/scanner/access-scan/engine/builtin-registry.js';
import { readFileSync } from 'node:fs';
import { verdictFor, kindForLayer, kindForRule, BEHAVIORAL_RULES } from '../src/utils/verdict.js';
import { toViolation } from '../src/scanner/access-scan/engine/finding.js';
import { evaluateGate, formatGate } from '../src/utils/thresholds.js';
import { computeExitCode, axeToUnified, MAX_AXE_INCOMPLETE_PER_PAGE } from '../src/index.js';
import { buildScanReportV2, projectReportV1 } from '../src/reporter/report-v2.js';
import { buildVerdictSection, verdictSummaryLine } from '../src/reporter/html.js';

const AUTOMATION_TO_KIND = { deterministic: 'deterministic', behavioral: 'deterministic', heuristic: 'heuristic', manual: 'manual' };

test('every registry rule has a kind and a rationale, and the kind cannot outrun the rule automation', async () => {
  const rules = (await loadBuiltInRuleRegistry()).listRules();
  assert.ok(rules.length > 80);
  for (const rule of rules) {
    assert.ok(['deterministic', 'heuristic', 'manual'].includes(rule.kind), `${rule.id}: kind`);
    assert.ok(typeof rule.kindRationale === 'string' && rule.kindRationale.length >= 10, `${rule.id}: kindRationale`);
    assert.equal(rule.kind, AUTOMATION_TO_KIND[rule.automation], `${rule.id}: kind vs automation ${rule.automation}`);
  }
});

test('verdictFor: confirmed only for deterministic + confirmed check', () => {
  assert.equal(verdictFor({ kind: 'deterministic', violationType: 'confirmed' }), 'confirmed');
  assert.equal(verdictFor({ kind: 'deterministic', violationType: 'potential' }), 'likely');
  assert.equal(verdictFor({ kind: 'deterministic', violationType: 'commercial-parity' }), 'likely');
  assert.equal(verdictFor({ kind: 'heuristic', violationType: 'confirmed' }), 'needs-review');
  assert.equal(verdictFor({ kind: 'heuristic', violationType: 'commercial-parity' }), 'needs-review');
  assert.equal(verdictFor({ kind: 'manual' }), 'needs-review');
  assert.equal(verdictFor({ kind: 'deterministic', violationType: 'manual-review' }), 'needs-review');
  assert.equal(verdictFor({ kind: 'deterministic', incomplete: true }), 'needs-review');
  assert.equal(kindForLayer('axe'), 'deterministic');
  assert.equal(kindForLayer('keyboard'), 'heuristic');
  // html-validate is a rule-based offline validator: its errors must fail w3c.errors like Nu's do.
  assert.equal(verdictFor({ kind: kindForLayer('htmlValidate') }), 'confirmed');
});

const finding = (violationType) => ({
  ruleId: 'X', violationType,
  severity: { impact: 'serious', priority: 2, wcagRef: 'WCAG 2.1 A 1.1.1' },
  element: { outerHTML: '<i></i>', selector: 'i', framePath: [], shadowPath: [] },
  recommendation: 'r', evidence: {},
});

test('toViolation stamps kind and verdict from the rule and the check classification', () => {
  const rule = (kind) => ({ kind, fix: { deterministic: false, policy: 'manual_only' } });
  assert.equal(toViolation(finding('confirmed'), { rule: rule('deterministic') }).verdict, 'confirmed');
  assert.equal(toViolation(finding('potential'), { rule: rule('heuristic') }).verdict, 'needs-review');
  assert.equal(toViolation(finding('confirmed'), { rule: { fix: rule().fix } }).verdict, 'needs-review');
});

test('toViolation caps a heuristic rule at moderate impact and leaves deterministic impact alone', () => {
  const rule = (kind) => ({ kind, fix: { deterministic: false, policy: 'manual_only' } });
  assert.equal(toViolation(finding('potential'), { rule: rule('heuristic') }).impact, 'moderate');
  assert.equal(toViolation(finding('confirmed'), { rule: { fix: rule().fix } }).impact, 'moderate');
  assert.equal(toViolation(finding('confirmed'), { rule: rule('deterministic') }).impact, 'serious');
});

test('a heuristic finding from a non-accessScan layer is capped at moderate in the report; deterministic keeps its impact', () => {
  const report = buildScanReportV2([{ page: 'p', url: 'https://example.test/', scannerRuns: [{ layer: 'screenReader', engine: { name: 'sr', version: '1' }, status: 'complete' }], violations: [
    { ruleId: 'semantic-emphasis-missing', layer: 'screenReader', impact: 'serious', element: { selector: 'span.a', outerHTML: '<span class="a"></span>' }, source: {}, fix: { hint: 'h' } },
    { ruleId: 'image-alt-missing-sr', layer: 'screenReader', impact: 'serious', element: { selector: 'img.b', outerHTML: '<img class="b">' }, source: {}, fix: { hint: 'h' } },
  ] }], { producer: { version: '0.0.0' }, agreementPolicy: 'off' });
  const impact = Object.fromEntries(report.pages[0].findings.map((f) => [f.nativeRuleId, f.impact]));
  assert.deepEqual(impact, { 'semantic-emphasis-missing': 'moderate', 'image-alt-missing-sr': 'serious' });
});

test('VisibilityMismatch is a heuristic rule: it can never be confirmed', async () => {
  const rule = (await loadBuiltInRuleRegistry()).listRules().find((r) => r.id === 'VisibilityMismatch');
  assert.equal(rule.kind, 'heuristic');
});

const run = { layer: 'axe', engine: { name: 'axe-core', version: '4.12.1' }, status: 'complete' };
const v = (over) => ({
  ruleId: 'r', layer: 'accessScan', impact: 'critical', element: { selector: 'a', outerHTML: '<a></a>' },
  source: {}, fix: { hint: 'h' }, ...over,
});
const reportOf = (violations) => buildScanReportV2([{ page: 'p', url: 'https://example.test/', scannerRuns: [run], violations }], { producer: { version: '0.0.0' }, agreementPolicy: 'off' }); // these tests pin kind -> verdict; engine-agreement.test.js covers the strict policy

test('report findings carry kind and verdict; summary counts the three verdicts; v1 projection keeps them', () => {
  const report = reportOf([
    v({ ruleId: 'a', element: { selector: 'a1', outerHTML: '<a1></a1>' }, kind: 'deterministic', verdict: 'confirmed', evidence: { proof: { type: 'measured-fact', fact: 'width 12px' } } }),
    v({ ruleId: 'b', element: { selector: 'b1', outerHTML: '<b1></b1>' }, kind: 'heuristic', verdict: 'likely', count: 2 }),
    v({ ruleId: 'c', element: { selector: 'c1', outerHTML: '<c1></c1>' }, kind: 'manual', verdict: 'needs-review' }),
    v({ ruleId: 'image-alt', layer: 'axe', element: { selector: 'd1', outerHTML: '<d1></d1>' }, evidence: { failureSummary: 'Element does not have an alt attribute' } }),
    v({ ruleId: 'focus-order-illogical', layer: 'keyboard', element: { selector: 'e1', outerHTML: '<e1></e1>' } }),
  ]);
  assert.deepEqual(report.summary.verdictCounts, { confirmed: 2, likely: 2, needsReview: 2 });
  const byRule = Object.fromEntries(report.pages[0].findings.map((f) => [f.nativeRuleId, f]));
  assert.equal(byRule['image-alt'].verdict, 'confirmed');
  assert.equal(byRule['image-alt'].kind, 'deterministic');
  assert.equal(byRule['focus-order-illogical'].verdict, 'needs-review');
  assert.equal(projectReportV1(report).pages[0].violations.find((x) => x.ruleId === 'c').verdict, 'needs-review');
});

test('one element seen by a heuristic and a deterministic engine keeps the confirmed verdict', () => {
  const same = { selector: 'x', outerHTML: '<x></x>' };
  const report = reportOf([
    v({ ruleId: 'dup', layer: 'keyboard', element: same }),
    v({ ruleId: 'dup', layer: 'axe', element: same, evidence: { failureSummary: 'Fix any of the following: duplicate' } }),
  ]);
  assert.equal(report.pages[0].findings.length, 1);
  assert.equal(report.pages[0].findings[0].verdict, 'confirmed');
});

const gatePage = (violations) => ({ name: 'p', url: 'http://x/', violations, lighthouseScores: {}, devServer: false });
const metric = (gate, id) => gate.pages[0].metrics.find((m) => m.id === id);

test('gate counts only confirmed findings and reports likely / needs-review separately', () => {
  const items = [
    v({ category: 'accessibility', verdict: 'confirmed' }),
    v({ category: 'accessibility', verdict: 'likely', count: 4 }),
    v({ category: 'accessibility', verdict: 'needs-review', count: 2 }),
  ];
  const gate = evaluateGate([gatePage(items)], { a11y: { critical: 0 } });
  assert.equal(metric(gate, 'a11y.critical').actual, 1);
  assert.equal(metric(gate, 'a11y.likely').actual, 4);
  assert.equal(metric(gate, 'a11y.needsReview').actual, 2);
  assert.equal(metric(gate, 'a11y.likely').status, 'report');
  assert.match(formatGate(gate).join('\n'), /a11y\.needsReview: 2/);
  const onlyGuesses = evaluateGate([gatePage(items.slice(1))], { a11y: { critical: 0 } });
  assert.equal(metric(onlyGuesses, 'a11y.critical').status, 'pass');
  assert.equal(onlyGuesses.failed, false);
});

test('--fail-on-violations exits 1 only for confirmed occurrences', () => {
  const flags = { failOnViolations: true };
  assert.equal(computeExitCode({ occurrenceCount: 5, verdictCounts: { confirmed: 0, likely: 5, needsReview: 0 } }, flags), 0);
  assert.equal(computeExitCode({ occurrenceCount: 5, verdictCounts: { confirmed: 1, likely: 4, needsReview: 0 } }, flags), 1);
  assert.equal(computeExitCode({ occurrenceCount: 5 }, flags), 1);
});

test('HTML lists likely and needs-review findings under their own headings, escaped', () => {
  const items = [
    { ruleId: 'a', impact: 'serious', verdict: 'confirmed', count: 1 },
    { ruleId: 'b', impact: 'moderate', verdict: 'likely', count: 3, element: { selector: '<img onerror=x>' } },
    { ruleId: 'c', impact: 'minor', verdict: 'needs-review', count: 1 },
  ];
  assert.equal(verdictSummaryLine(items), '1 confirmed, 3 likely, 1 need review');
  const html = buildVerdictSection(items);
  assert.match(html, /<h3>Likely issues<\/h3>/);
  assert.match(html, /<h3>Needs review<\/h3>/);
  assert.ok(!html.includes('<img onerror'));
  assert.equal(buildVerdictSection([{ ruleId: 'old', impact: 'minor' }]), '');
});

// ── P4: per-rule kinds for the behavioural layers ────────────────────────────

const BEHAVIORAL_FILES = ['keyboard', 'focus-trap', 'aria-live', 'dynamic-content', 'screen-reader', 'structure', 'links', 'disclosure', 'behavior-checks'];
const emittedRuleIds = () => {
  const ids = new Set();
  for (const f of BEHAVIORAL_FILES) {
    const src = readFileSync(new URL(`../src/scanner/${f}.js`, import.meta.url), 'utf8');
    for (const m of src.matchAll(/\b(?:rule|ruleId): '([a-z0-9-]+)'/g)) ids.add(m[1]);
    // disclosure.js declares its ids as exported constants
    for (const m of src.matchAll(/_RULE = '([a-z0-9-]+)'/g)) ids.add(m[1]);
    // links.js picks the id with a ternary
    for (const m of src.matchAll(/\? '(dead-link-[a-z0-9-]+)'|: '(dead-link-[a-z0-9-]+)'/g)) ids.add(m[1] || m[2]);
  }
  ids.add('broken-link'); // emitted by src/index.js for crawl 404s
  return ids;
};

test('every rule id the behavioural layers emit has an explicit kind and rationale', () => {
  const ids = emittedRuleIds();
  assert.ok(ids.size > 50, `found ${ids.size} emitted ids`);
  for (const id of ids) {
    const entry = BEHAVIORAL_RULES[id];
    assert.ok(entry, `${id}: no entry in BEHAVIORAL_RULES`);
    assert.ok(['deterministic', 'heuristic'].includes(entry[0]), `${id}: kind`);
    assert.ok(entry[1].length >= 10, `${id}: rationale`);
  }
  for (const id of Object.keys(BEHAVIORAL_RULES)) assert.ok(ids.has(id), `${id}: listed but never emitted`);
});

test('deterministic behavioural findings are confirmed, heuristic ones are needs-review; other layers keep their layer kind', () => {
  const rep = reportOf([
    v({ ruleId: 'page-missing-title', layer: 'screenReader', element: { selector: 't', outerHTML: '<t></t>' }, evidence: { proof: { type: 'measured-fact', fact: 'document.title is ""' } } }),
    v({ ruleId: 'missing-h1', layer: 'screenReader', element: { selector: 'h', outerHTML: '<h></h>' } }),
    v({ ruleId: 'dead-link-unreachable', layer: 'links', element: { selector: 'l', outerHTML: '<l></l>' } }),
  ]);
  const byRule = Object.fromEntries(rep.pages[0].findings.map((f) => [f.nativeRuleId, f.verdict]));
  assert.deepEqual(byRule, { 'page-missing-title': 'confirmed', 'missing-h1': 'needs-review', 'dead-link-unreachable': 'needs-review' });
  assert.equal(kindForRule('axe', 'empty-heading'), 'deterministic');
  assert.equal(kindForRule('keyboard', 'unlisted-rule'), 'heuristic');
  const gate = evaluateGate([gatePage(rep.pages[0].findings)], { a11y: { critical: 0, serious: 0, moderate: 0, minor: 0 } });
  const confirmedTotal = ['critical', 'serious', 'moderate', 'minor'].reduce((n, l) => n + metric(gate, `a11y.${l}`).actual, 0);
  assert.equal(confirmedTotal, 1);
});

test('axe incomplete results become needs-review findings tagged axe-incomplete, bounded per page', () => {
  const nodes = Array.from({ length: 15 }, (_, i) => ({ html: `<p id="n${i}">x</p>`, target: [`#n${i}`], impact: null }));
  const result = {
    violations: [{ id: 'image-alt', impact: 'critical', tags: ['wcag2a'], nodes: [{ html: '<img>', target: ['img'], impact: 'critical', failureSummary: 'Fix any of the following:\n  Element does not have an alt attribute' }] }],
    incomplete: [{ id: 'color-contrast', impact: null, tags: ['wcag2aa'], nodes }],
  };
  const out = axeToUnified(result, 'https://example.com', 'url');
  const incomplete = out.filter((f) => f.verdict === 'needs-review');
  assert.equal(incomplete.length, MAX_AXE_INCOMPLETE_PER_PAGE);
  assert.ok(incomplete.every((f) => f.ruleId === 'color-contrast' && f.evidence.tags.includes('axe-incomplete')));
  assert.equal(out.length, MAX_AXE_INCOMPLETE_PER_PAGE + 1);
  const rep = reportOf(out);
  assert.deepEqual(rep.summary.verdictCounts, { confirmed: 1, likely: 0, needsReview: MAX_AXE_INCOMPLETE_PER_PAGE });
  const gate = evaluateGate([gatePage(rep.pages[0].findings)], { a11y: { critical: 0, serious: 0, moderate: 0, minor: 0 } });
  assert.equal(metric(gate, 'a11y.critical').actual, 1);
  assert.equal(metric(gate, 'a11y.moderate').actual, 0);
  assert.equal(metric(gate, 'a11y.needsReview').actual, MAX_AXE_INCOMPLETE_PER_PAGE);
});
