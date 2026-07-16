import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRuleRouteKey,
  buildVerificationKey,
  compareVerificationFindings,
  stableSelector,
} from '../../src/fix/verify/verification-key.js';

function finding({
  id = null,
  rule = 'ButtonMismatch',
  impact = 'serious',
  selector,
  count,
} = {}) {
  return {
    findingId: id,
    canonicalRuleId: rule,
    impact,
    route: '/',
    pageState: 'initial',
    count,
    element: { selector },
  };
}

test('stableSelector normalizes equivalent child-combinator whitespace', () => {
  assert.equal(
    stableSelector(finding({ selector: 'main > section > a' })),
    stableSelector(finding({ selector: 'main>section>a' })),
  );
});

test('collapsed baseline occurrence counts do not become false regressions', () => {
  const baseline = [
    finding({
      selector: 'main>section:nth-of-type(1)>a',
      count: 2,
    }),
  ];
  const after = [
    finding({ selector: 'main > section:nth-of-type(1) > a' }),
    finding({ selector: 'main > section:nth-of-type(2) > a' }),
  ];

  const delta = compareVerificationFindings(baseline, after);

  assert.deepEqual(delta.newCriticalSerious, []);
});

test('collapsed baseline still detects a true occurrence-count regression', () => {
  const baseline = [
    finding({
      selector: 'main>section:nth-of-type(1)>a',
      count: 2,
    }),
  ];
  const after = [
    finding({ selector: 'main > section:nth-of-type(1) > a' }),
    finding({ selector: 'main > section:nth-of-type(2) > a' }),
    finding({ selector: 'main > section:nth-of-type(3) > a' }),
  ];

  const delta = compareVerificationFindings(baseline, after);

  assert.equal(delta.newCriticalSerious.length, 1);
});

test('line shift with stable selector still matches closure key', () => {
  const baseline = [{
    findingId: 'sha256:old',
    canonicalRuleId: 'button-name',
    route: '/',
    pageState: 'initial',
    selector: '#apply',
    source: { file: 'src/a.liquid', line: 3 },
    impact: 'critical',
  }];
  const after = [{
    findingId: 'sha256:new',
    canonicalRuleId: 'button-name',
    route: '/',
    pageState: 'initial',
    selector: '#apply',
    source: { file: 'src/a.liquid', line: 8 },
    impact: 'critical',
  }];
  assert.equal(buildVerificationKey(baseline[0]), buildVerificationKey(after[0]));
  const unresolved = compareVerificationFindings(baseline, after, ['sha256:old']);
  assert.equal(unresolved.targetsResolved, false);
  const resolved = compareVerificationFindings(baseline, [], ['sha256:old']);
  assert.equal(resolved.targetsResolved, true);
});

test('count increase on same selector is flagged as regression', () => {
  const baseline = [{
    findingId: 'sha256:a1',
    canonicalRuleId: 'button-name',
    route: '/',
    pageState: 'initial',
    selector: '#x',
    impact: 'critical',
  }];
  const after = [
    { findingId: 'sha256:b1', canonicalRuleId: 'button-name', route: '/', pageState: 'initial', selector: '#x', impact: 'critical' },
    { findingId: 'sha256:b2', canonicalRuleId: 'button-name', route: '/', pageState: 'initial', selector: '#x', impact: 'critical' },
  ];
  const delta = compareVerificationFindings(baseline, after, []);
  assert.ok(delta.newCriticalSerious.length > 0);
});

test('nosel findings treat same rule route pageState as unresolved', () => {
  const baseline = [{
    findingId: 'sha256:old',
    canonicalRuleId: 'button-name',
    route: '/',
    pageState: 'initial',
    impact: 'critical',
  }];
  const after = [{
    findingId: 'sha256:new',
    canonicalRuleId: 'button-name',
    route: '/',
    pageState: 'initial',
    impact: 'moderate',
  }];
  const delta = compareVerificationFindings(baseline, after, ['sha256:old']);
  assert.equal(delta.targetsResolved, false);
  assert.equal(buildRuleRouteKey(baseline[0]), buildRuleRouteKey(after[0]));
});
