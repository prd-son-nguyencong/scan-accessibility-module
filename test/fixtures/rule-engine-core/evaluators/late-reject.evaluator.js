/** @type {import('../../../../src/scanner/access-scan/engine/loader.js').EvaluatorModule} */
export default {
  id: 'late-reject',
  async evaluate(_context, _check, { signal } = {}) {
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        if (signal?.aborted) {
          reject(new Error('late reject after deadline'));
          return;
        }
        resolve({ status: 'complete', candidates: 0, findings: [] });
      }, 80);
    });
  },
};
