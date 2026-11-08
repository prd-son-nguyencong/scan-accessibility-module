import { afterEach } from 'node:test';

import { resetAllCorpusToolingTestState } from '../../scripts/accessscan-corpus/lib/test-state.js';

/**
 * Resets module-level corpus tooling overrides after every test.
 */
export function installCorpusToolingTestResetHooks() {
  afterEach(() => {
    resetAllCorpusToolingTestState();
  });
}
