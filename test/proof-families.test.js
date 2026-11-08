import './helpers/hermetic-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildScanReportV2 } from '../src/reporter/report-v2.js';
import { MEASURED_PROOF_TYPES } from '../src/utils/verdict.js';
import { PROOF_FAMILIES, evaluateProofFamilies } from '../scripts/lib/proof-families.js';

const EXPECT = {
  'axe, per-node failure summary': ['measured-fact', 'confirmed'],
  'axe, measured contrast': ['computed-ratio', 'confirmed'],
  'axe, generic help only': ['dom-structure', 'needs-review'],
  'html-validate / w3c, message quotes the value': ['measured-fact', 'confirmed'],
  'html-validate / w3c, rule wording only': ['validator-rule', 'needs-review'],
  'lighthouse, per-node explanation': ['measured-fact', 'confirmed'],
  'lighthouse, rule id only': ['validator-rule', 'needs-review'],
  'visible text vs accessible name captured': ['name-vs-text', 'confirmed'],
  'layer-recorded proof': ['http-status', 'confirmed'],
  'accessScan, measured-fact holding a measured value': ['measured-fact', 'confirmed'],
  'accessScan, measured-fact that is only the rule rationale and the opening tag': ['dom-structure', 'needs-review'],
  'behavioural rule, instance description only (check recorded no proof)': ['dom-structure', 'needs-review'],
  'behavioural rule, proof recorded by the check': ['attribute-value', 'confirmed'],
  'behavioural rule, no instance text': [null, 'likely'],
};

test('every rule family: a confirmed site finding always has a measured proof type; the rest is downgraded', () => {
  const rows = evaluateProofFamilies();
  assert.deepEqual(rows.map((r) => r.family), Object.keys(EXPECT));
  for (const r of rows) {
    assert.deepEqual([r.proofType, r.verdict], EXPECT[r.family], r.family);
    if (r.verdict === 'confirmed') assert.ok(MEASURED_PROOF_TYPES.has(r.proofType), r.family);
  }
});

const run = (layer) => ({ layer, engine: { name: layer, version: '1' }, status: 'complete' });
const build = (v) => buildScanReportV2([{ page: 'p', url: 'https://example.test/', scannerRuns: [run(v.layer === 'accessScan' ? 'axe' : v.layer)], violations: [{
  impact: 'serious', kind: 'deterministic', element: { selector: 'a.x', outerHTML: '<a class="x" aria-label="dismiss">' }, source: {}, fix: { hint: '' }, ...v,
}] }], { producer: { version: '0.0.0' }, agreementPolicy: 'off' }).pages[0].findings[0];

test('end to end, site origin: every family row through buildScanReportV2 is confirmed only with a measured proof', () => {
  for (const { family, v } of PROOF_FAMILIES) {
    const f = build({ ...v, origin: { owner: 'site', kind: 'site-source', label: 'Site source', evidence: [] } });
    if (f.verdict === 'confirmed') assert.ok(MEASURED_PROOF_TYPES.has(f.evidence.proof.type) || f.proof?.type && MEASURED_PROOF_TYPES.has(f.proof.type), family);
    assert.equal(f.verdict === 'confirmed', EXPECT[family][1] === 'confirmed', family);
  }
});

test('an accessScan measured-fact that holds no measured value is a description: needs-review, whatever its owner', async () => {
  const { proofFor, hasMeasuredValue } = await import('../src/utils/verdict.js');
  assert.equal(hasMeasuredValue('<title />: the title element is present and non-empty or not'), false);
  assert.equal(hasMeasuredValue('<a class="x">: target is 12px by 12px'), true);
  assert.equal(proofFor({ layer: 'accessScan', evidence: { proof: { type: 'measured-fact', fact: '<title />: the title element is present' } } }).type, 'dom-structure');
  // A behavioural row's own description is wording, not a measurement: only a proof its check recorded confirms.
  assert.equal(proofFor({ layer: 'keyboard', ruleId: 'page-missing-title', description: 'document.title is empty' }).type, 'dom-structure');
  assert.equal(proofFor({ layer: 'keyboard', ruleId: 'page-missing-title', evidence: { proof: { type: 'measured-fact', fact: 'document.title is ""' } } }).type, 'measured-fact');
});
