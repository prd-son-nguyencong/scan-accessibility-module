import './helpers/hermetic-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyUnresolvedText, UNRESOLVED_REASON } from '../src/scanner/unresolved-text.js';
import { judgeLabel } from '../src/scanner/measured-checks.js';

const row = (ruleId, html, evidence = {}) => ({ ruleId, layer: 'lighthouse', verdict: 'confirmed', kind: 'deterministic', element: { selector: 'a', outerHTML: html }, evidence: { proof: { type: 'name-vs-text', fact: 'x' }, ...evidence } });

test('label in name on a raw _translate() or {{...}} wrapper is needs-review "text not resolved in local render"', () => {
  const rows = [
    row('label-content-name-mismatch', `<a href="/x" aria-label="_translate(&quot;Acme Community House Charities (Opens in a new tab)&quot;)">_translate("ACHC")</a>`),
    row('VisibleTextPartOfAccessibleName', '<a href="/x" aria-label="Learn more">Franchise</a>', { visibleText: '{{data:label}}', accessibleName: 'Learn more' }),
  ];
  assert.equal(applyUnresolvedText(rows), 2);
  for (const r of rows) assert.deepEqual([r.verdict, r.reason, r.evidence.reviewReason, r.evidence.proof], ['needs-review', UNRESOLVED_REASON, UNRESOLVED_REASON, undefined]);
});

test('paired: resolved text keeps its verdict, other rules are never touched, and punctuation variants are not a mismatch', () => {
  const real = row('label-content-name-mismatch', '<a href="/x" aria-label="Open chat">Start your search</a>', { visibleText: 'Start your search', accessibleName: 'Open chat' });
  const other = row('target-size', '<a aria-label="_translate(&quot;x&quot;)">y</a>');
  assert.equal(applyUnresolvedText([real, other]), 0);
  assert.equal(real.verdict, 'confirmed');
  assert.equal(other.verdict, 'confirmed');
  assert.equal(judgeLabel({ label: "Acme's Belgium", name: 'Learn more about Acme’s Belgium' }), 'pass', 'apostrophe variants');
  assert.equal(judgeLabel({ label: 'Franchise Info', name: 'learn about franchise info.' }), 'pass', 'case and punctuation');
});
