import { resetAllowedRuleIdsForTests, resetBuiltinAllowedRuleIdsCacheForTests } from './rule-ids.js';
import { resetCommittedFixtureRootForTests } from './paths.js';
import { resetDraftPathGuardForTests } from './draft.js';
import { resetDnsPolicyCacheForTests } from './dns-policy.js';

export function resetAllCorpusToolingTestState() {
  resetAllowedRuleIdsForTests();
  resetBuiltinAllowedRuleIdsCacheForTests();
  resetCommittedFixtureRootForTests();
  resetDraftPathGuardForTests();
  resetDnsPolicyCacheForTests();
}
