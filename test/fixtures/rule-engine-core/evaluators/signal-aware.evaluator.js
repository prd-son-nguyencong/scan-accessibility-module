/** @type {import('../../../../src/scanner/access-scan/engine/loader.js').EvaluatorModule} */
export default {
  id: 'signal-aware',
  async evaluate(_context, _check, { signal } = {}) {
    return new Promise((resolve) => {
      const finish = () => {
        resolve({
          status: 'inapplicable',
          candidates: 0,
          findings: [],
          evidence: { sawAbort: Boolean(signal?.aborted) },
        });
      };
      if (signal?.aborted) {
        finish();
        return;
      }
      signal?.addEventListener('abort', finish, { once: true });
    });
  },
};
