import './helpers/hermetic-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderWcagCoverageDoc, rulesBySuccessCriterion } from '../scripts/lib/wcag-coverage-doc.js';
import { WCAG_CRITERIA, COVERAGE_LEVELS, wcagCoverageSummary, wcagCoverageSentence } from '../src/utils/wcag-criteria.js';
import { buildQaModel, renderQaHtml } from '../src/reporter/qa-report.js';
import { buildHtml } from '../src/reporter/html.js';

test('docs/wcag-coverage.md matches the data file and registries (run npm run docs:wcag)', async () => {
  assert.equal(readFileSync(new URL('../docs/wcag-coverage.md', import.meta.url), 'utf8'), await renderWcagCoverageDoc());
});

test('criteria list holds every WCAG 2.2 A and AA criterion (31 A, 24 AA), unique, with valid coverage', () => {
  const count = (level) => WCAG_CRITERIA.filter((c) => c.level === level).length;
  assert.equal(count('A'), 31);
  assert.equal(count('AA'), 24);
  assert.equal(new Set(WCAG_CRITERIA.map((c) => c.id)).size, WCAG_CRITERIA.length);
  for (const c of WCAG_CRITERIA) {
    assert.ok(COVERAGE_LEVELS.includes(c.coverage), `${c.id}: coverage ${c.coverage}`);
    assert.ok(c.title && c.note, `${c.id}: title and note are required`);
  }
});

test('every success criterion a rule declares exists in the criteria list; coverage agrees with the rules', async () => {
  const bySc = await rulesBySuccessCriterion();
  const known = new Map(WCAG_CRITERIA.map((c) => [c.id, c]));
  for (const sc of Object.keys(bySc)) {
    if (sc === 'n/a') continue; // best-practice rules carry no criterion
    assert.ok(known.has(sc), `rule declares unknown WCAG criterion ${sc}`);
  }
  for (const c of WCAG_CRITERIA) {
    const ruleCount = Object.values(bySc[c.id] || {}).reduce((n, list) => n + list.length, 0);
    if (c.coverage === 'full' || c.coverage === 'partial') assert.ok(ruleCount > 0, `${c.id} is ${c.coverage} but no rule covers it`);
    else assert.equal(ruleCount, 0, `${c.id} is ${c.coverage} but ${ruleCount} rule(s) cover it; update the coverage`);
  }
});

test('summary counts partial separately and states the sentence', () => {
  const s = wcagCoverageSummary();
  assert.equal(s.total, 55);
  assert.equal(s.covered, s.full + s.partial);
  assert.equal(s.covered + s.needManual, 55);
  assert.equal(wcagCoverageSentence({ total: 55, full: 2, partial: 20, covered: 22, needManual: 33 }),
    'Automated checks cover 22 of 55 WCAG 2.2 A and AA criteria (2 fully, 20 partially); 33 need manual review. Partial coverage does not replace manual review.');
});

test('QA report and visual report both carry the coverage sentence', () => {
  const sentence = wcagCoverageSentence();
  const qa = renderQaHtml(buildQaModel({ pages: [], summary: {} }));
  assert.ok(qa.includes(sentence.replace(/&/g, '&amp;')));
  const visual = buildHtml({ pages: [], summary: {}, runMetadata: {} });
  assert.ok(visual.includes(sentence));
});
