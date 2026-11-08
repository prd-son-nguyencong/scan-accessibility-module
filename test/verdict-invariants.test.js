import './helpers/hermetic-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadBuiltInRuleRegistry } from '../src/scanner/access-scan/engine/builtin-registry.js';
import { toViolation } from '../src/scanner/access-scan/engine/finding.js';
import { BEHAVIORAL_RULES, LIKELY_AT_MOST_IDS, isAdvisoryRule, settleFinding } from '../src/utils/verdict.js';
import { axeToUnified } from '../src/index.js';
import { buildScanReportV2 } from '../src/reporter/report-v2.js';
import { renderVerdictDoc } from '../scripts/lib/verdict-doc.js';

const ORDER = ['minor', 'moderate', 'serious', 'critical'];
const atMost = (impact, max) => ORDER.indexOf(impact) <= ORDER.indexOf(max);
const run = (layer) => ({ layer, engine: { name: layer, version: '1' }, status: 'complete' });
const reportOf = (layer, violations) => buildScanReportV2([{ page: 'p', url: 'https://example.test/', scannerRuns: [run(layer === 'accessScan' ? 'axe' : layer)], violations }], { producer: { version: '0.0.0' }, agreementPolicy: 'off' }).pages[0].findings;
const raw = (over) => ({ layer: 'accessScan', impact: 'critical', element: { selector: 'x', outerHTML: '<x></x>' }, source: {}, fix: { hint: 'h' }, ...over });

test('every registry rule: only a deterministic rule can be confirmed, a heuristic or manual one never, whatever the check says', async () => {
  for (const rule of (await loadBuiltInRuleRegistry()).listRules()) {
    const finding = {
      ruleId: rule.id, violationType: 'confirmed', severity: { impact: 'critical', priority: 1, wcagRef: 'WCAG 2.1 A 1.1.1' },
      element: { outerHTML: '<i></i>', selector: 'i', framePath: [], shadowPath: [] }, recommendation: 'r', evidence: {},
    };
    const [f] = reportOf('accessScan', [toViolation(finding, { rule })]);
    if (rule.kind === 'deterministic') {
      // A behavioural rule has no static rationale: without a measured proof it is downgraded (see confirmed-needs-proof.test.js).
      if (rule.automation === 'behavioral') { assert.equal(f.verdict, 'likely', `${rule.id} behavioural without proof`); continue; }
      // The static fallback (opening tag + rule rationale) is a measurement only when the tag holds a value read from the DOM; a bare tag is a description: needs-review.
      assert.equal(f.verdict, 'needs-review', `${rule.id} deterministic, bare tag`);
      const [g] = reportOf('accessScan', [toViolation({ ...finding, element: { ...finding.element, outerHTML: '<i class="x"></i>' } }, { rule })]);
      // Our own best-practice rules never confirm (needs-review); everything else does.
      if (isAdvisoryRule({ ruleId: rule.id })) { assert.equal(g.verdict, 'needs-review', `${rule.id} advisory`); continue; }
      assert.equal(g.verdict, 'confirmed', `${rule.id} deterministic, tag with an attribute value`);
      assert.ok(g.evidence.proof?.type && g.evidence.proof.fact, `${rule.id}: confirmed finding records a proof`);
    } else {
      assert.equal(f.verdict, 'needs-review', `${rule.id} (${rule.kind}) must not be confirmed`);
      if (rule.kind === 'heuristic') assert.ok(atMost(f.impact, 'moderate'), `${rule.id} impact ${f.impact}`);
      assert.equal(f.evidence.proof, undefined, `${rule.id}: no proof on a guess`);
    }
  }
});

test('every behavioural rule: heuristic ones cannot be confirmed or exceed moderate; deterministic ones carry a proof', () => {
  const layers = { 'focus-indicator-removed': 'keyboard' };
  for (const [ruleId, [kind]] of Object.entries(BEHAVIORAL_RULES)) {
    const layer = layers[ruleId] || 'screenReader';
    // An emitter may stamp 'confirmed' on any violation; the choke point decides what survives.
    const [f] = reportOf(layer, [raw({ ruleId, layer, verdict: 'confirmed', description: 'measured 2 things "x"', evidence: { proof: { type: 'measured-fact', fact: 'measured 2 things "x"' } } })]);
    // Its description alone (digits, a quoted id) is not a proof: without a recorded proof no behavioural rule is confirmed.
    const [bare] = reportOf(layer, [raw({ ruleId, layer, verdict: 'confirmed', description: 'measured 2 things "x"' })]);
    assert.notEqual(bare.verdict, 'confirmed', `${ruleId} without a recorded proof`);
    if (kind === 'heuristic') {
      assert.equal(f.verdict, 'needs-review', ruleId);
      assert.ok(atMost(f.impact, 'moderate'), ruleId);
    } else if (isAdvisoryRule({ layer, ruleId })) {
      assert.equal(f.verdict, 'needs-review', ruleId);
    } else if (LIKELY_AT_MOST_IDS.has(ruleId)) {
      assert.equal(f.verdict, 'likely', ruleId);
    } else {
      assert.equal(f.verdict, 'confirmed', ruleId);
      assert.ok(f.evidence.proof.fact, ruleId);
    }
  }
});

test('a confirmed verdict without a recorded proof is downgraded to likely', () => {
  const [f] = reportOf('custom', [raw({ ruleId: 'no-proof-rule', layer: 'custom', kind: 'deterministic', verdict: 'confirmed' })]);
  assert.equal(f.verdict, 'likely');
  const [g] = reportOf('custom', [raw({ ruleId: 'with-proof', layer: 'custom', kind: 'deterministic', verdict: 'confirmed', evidence: { proof: { type: 'computed-ratio', fact: '2.1' } } })]);
  assert.equal(g.verdict, 'confirmed');
  assert.deepEqual(g.evidence.proof, { type: 'computed-ratio', fact: '2.1' });
});

const axe = (bucket, over = {}) => ({ [bucket]: [{ id: 'aria-required-children', impact: 'critical', tags: ['wcag2a'], help: 'Certain ARIA roles must contain particular children', nodes: [{ html: '<ul role="list"></ul>', target: ['ul'], impact: 'critical', failureSummary: 'Fix any of the following:\n  Element has no children', ...over }] }] });

test('axe incomplete is needs-review at most moderate and says what could not be decided; the same node as a violation stays confirmed critical', () => {
  const [inc] = reportOf('axe', axeToUnified(axe('incomplete'), 'https://example.test/'));
  assert.equal(inc.verdict, 'needs-review');
  assert.ok(atMost(inc.impact, 'moderate'), inc.impact);
  assert.match(inc.evidence.message, /axe could not decide this check \(aria-required-children\)/);
  const [vio] = reportOf('axe', axeToUnified(axe('violations'), 'https://example.test/'));
  assert.equal(vio.verdict, 'confirmed');
  assert.equal(vio.impact, 'critical');
  assert.ok(vio.evidence.proof.fact);
});

test('an axe incomplete result is never confirmed even when its source stamps a confirmed verdict', () => {
  const [v] = axeToUnified(axe('incomplete'), 'https://example.test/');
  const [f] = reportOf('axe', [{ ...v, verdict: 'confirmed' }]);
  assert.equal(f.verdict, 'needs-review');
});

test('rule impact ceilings: duplicate-id-aria serious, dialog-missing-aria-modal below critical', () => {
  const [dup] = reportOf('axe', axeToUnified({ violations: [{ id: 'duplicate-id-aria', impact: 'critical', tags: [], nodes: [{ html: '<div id="a"></div>', target: ['#a'], impact: 'critical', failureSummary: 'Fix any of the following:\n  Document has multiple elements with the same id: a' }] }] }, 'https://example.test/'));
  assert.equal(dup.impact, 'serious');
  assert.equal(dup.verdict, 'confirmed');
  const [dlg] = reportOf('focusTrap', [raw({ ruleId: 'dialog-missing-aria-modal', layer: 'focusTrap' })]);
  assert.ok(atMost(dlg.impact, 'moderate'));
  const [ok] = reportOf('axe', axeToUnified({ violations: [{ id: 'aria-valid-attr-value', impact: 'critical', tags: [], nodes: [{ html: '<div aria-x></div>', target: ['div'], impact: 'critical', failureSummary: 'Fix any of the following:\n  Invalid ARIA attribute value: aria-x' }] }] }, 'https://example.test/'));
  assert.equal(ok.impact, 'critical'); // other deterministic axe rules keep the engine impact
});

const axeRule = (id, tags) => axeToUnified({ violations: [{ id, impact: 'moderate', tags, help: 'h', nodes: [{ html: '<h3>x</h3>', target: ['h3'], impact: 'moderate', failureSummary: 'Fix any of the following:\n  Heading order invalid' }] }] }, 'https://example.test/');

test('advisory axe best-practice rules are likely at most; A/AA rules of neighbouring families stay confirmed (paired)', () => {
  for (const id of ['heading-order', 'page-has-heading-one', 'skip-link', 'region']) {
    assert.equal(reportOf('axe', axeRule(id, ['cat.semantics', 'best-practice']))[0].verdict, 'likely', id);
  }
  // The id list alone is enough when an engine drops the tags.
  assert.equal(reportOf('axe', axeRule('heading-order', []))[0].verdict, 'likely');
  // Real defects: bypass (2.4.1), document-title (2.4.2), color-contrast (1.4.3) and a rule that is both best-practice and A/AA stay confirmed.
  for (const [id, tags] of [['bypass', ['cat.keyboard', 'wcag2a', 'wcag241']], ['document-title', ['wcag2a']], ['color-contrast', ['wcag2aa']], ['landmark-one-main', ['best-practice', 'wcag2a']]]) {
    assert.equal(reportOf('axe', axeRule(id, tags))[0].verdict, 'confirmed', id);
  }
  // The behavioural empty-heading check (a visible heading with no name) is axe best-practice: a recommendation (likely), never confirmed.
  const [empty] = reportOf('screenReader', [raw({ ruleId: 'empty-heading', layer: 'screenReader', verdict: 'confirmed', description: 'heading h2 "" has no text', evidence: { proof: { type: 'measured-fact', fact: 'heading h2 has no text' } } })]);
  assert.equal(empty.verdict, 'likely');
});

test('dead links keep their own category (reliability, not accessibility) and stay confirmed on an http-status proof', () => {
  const [f] = reportOf('links', [raw({ ruleId: 'dead-link-404', layer: 'links', category: 'reliability', verdict: 'confirmed', evidence: { proof: { type: 'http-status', fact: '404 on HEAD and GET' } } })]);
  assert.equal(f.category, 'reliability');
  assert.equal(f.verdict, 'confirmed');
});

test('docs/verdict-matrix.md matches the choke point and registry (run npm run docs:verdicts)', async () => {
  assert.equal(readFileSync(new URL('../docs/verdict-matrix.md', import.meta.url), 'utf8'), await renderVerdictDoc());
});

test('fix --export: a likely finding is exported by default, a needs-review one needs --include-needs-review', async () => {
  const { buildTaskSet } = await import('../src/fix/export/tasks.js');
  const finding = (rule, verdict) => ({ nativeRuleId: rule, canonicalRuleId: rule, verdict, impact: 'moderate', ownership: 'source', message: rule, selector: 'h3', source: { file: 'src/a.liquid', line: 1, confidence: 'high' } });
  const report = { pages: [{ route: '/', name: 'home', url: 'http://x/', findings: [finding('heading-order', 'likely'), finding('region', 'needs-review')] }] };
  const byDefault = buildTaskSet(report);
  assert.deepEqual(byDefault.tasks.map((t) => t.rule), ['heading-order']);
  assert.equal(byDefault.omitted.needsReview, 1);
  assert.equal(buildTaskSet(report, { includeNeedsReview: true }).tasks.length, 2);
  assert.match(await renderVerdictDoc(), /still exported as a task by default/);
});

test('our own best-practice rules (unlabeled navs, landmark-unique, empty list) are needs-review on any layer, never confirmed', () => {
  for (const [layer, ruleId] of [['screenReader', 'multiple-navs-missing-labels'], ['accessScan', 'landmark-unique'], ['accessScan', 'ListEmpty']]) {
    const advisory = isAdvisoryRule({ layer, ruleId });
    assert.equal(advisory, true, ruleId);
    const { verdict } = settleFinding({ kind: 'deterministic', verdict: 'confirmed', impact: 'serious', ruleId, proof: { type: 'measured-fact', fact: '3' }, advisory });
    assert.equal(verdict, 'needs-review', ruleId);
  }
  // missing/multiple main (1.3.6 is AAA), dialog-no-label (axe best-practice) and tabs-missing-aria-controls (APG advice) are not A/AA failures either.
  for (const ruleId of ['missing-main-landmark', 'multiple-main-landmarks', 'dialog-no-label', 'tabs-missing-aria-controls']) assert.equal(isAdvisoryRule({ ruleId }), true, ruleId);
});
