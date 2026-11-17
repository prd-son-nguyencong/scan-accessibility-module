/** @type {import('../../../../src/scanner/access-scan/engine/loader.js').EvaluatorModule} */
export default {
  id: 'invalid-return',
  async evaluate() {
    return null;
  },
};
