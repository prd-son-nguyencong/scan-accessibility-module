/** @type {import('../../../../src/scanner/access-scan/engine/loader.js').EvaluatorModule} */
export default {
  id: 'throws',
  async evaluate() {
    throw new Error('raw evaluator failure with stack');
  },
};
