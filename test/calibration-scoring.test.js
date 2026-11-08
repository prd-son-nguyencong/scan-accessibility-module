import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreCalibration } from '../scripts/lib/calibration.js';

const f = (route, rule, verdict, extra = {}) => ({ route, nativeRuleId: rule, verdict, origin: { owner: 'site' }, element: { selector: 'x' }, ...extra });

test('a confirmed finding no tp label claims lowers precision; a downgraded known false positive passes', () => {
  const labels = [
    { id: 'tp', kind: 'tp', route: '/a', rule: 'image-alt', expect: { verdict: ['confirmed'], owner: 'site' } },
    { id: 'fp', kind: 'fp', route: '/a', rule: 'ListEmpty', expect: { confirmedSite: false } },
  ];
  const ok = scoreCalibration(labels, [f('/a', 'image-alt', 'confirmed'), f('/a', 'ListEmpty', 'needs-review')]);
  assert.equal(ok.confirmedTier.precision, 1);
  assert.deepEqual(ok.fpConfirmed, []);
  const bad = scoreCalibration(labels, [f('/a', 'image-alt', 'confirmed'), f('/a', 'ListEmpty', 'confirmed'), f('/a', 'stray', 'confirmed')]);
  assert.equal(bad.confirmedTier.precision, 1 / 3);
  assert.equal(bad.fpConfirmed[0].id, 'fp');
});

test('third-party confirmed findings are outside the confirmed tier; owner and max are enforced; a missing true positive is reported', () => {
  const labels = [
    { id: 'vendor', kind: 'fp', route: '/a', rule: 'button-name', expect: { owner: 'third-party' } },
    { id: 'one', kind: 'tp', route: '/a', rule: 'aria-.*', max: 1, expect: { verdict: ['confirmed'], owner: 'site' } },
    { id: 'gone', kind: 'tp', route: '/a', rule: 'target-size', expect: { verdict: ['confirmed'] } },
  ];
  const tp = f('/a', 'button-name', 'confirmed', { origin: { owner: 'third-party' } });
  const r = scoreCalibration(labels, [tp, f('/a', 'aria-allowed-role', 'confirmed'), f('/a', 'aria-required-children', 'confirmed')]);
  assert.equal(r.confirmedTier.total, 2);
  assert.deepEqual(r.results.filter((x) => !x.pass).map((x) => x.id), ['one', 'gone']);
  assert.deepEqual(r.missed.map((x) => x.id), ['one', 'gone']);
  assert.equal(scoreCalibration(labels, [f('/a', 'button-name', 'confirmed')]).fpConfirmed[0].id, 'vendor', 'site-owned vendor expectation violated');
});
