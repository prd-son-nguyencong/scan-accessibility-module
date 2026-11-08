/** @type {import('../../../../src/scanner/access-scan/engine/loader.js').EvaluatorModule} */
export default {
  id: 'slow',
  async evaluate(_context, _check, { signal } = {}) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        resolve({ status: 'complete', candidates: 0, findings: [] });
      }, 500);
      signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      });
    });
  },
};
