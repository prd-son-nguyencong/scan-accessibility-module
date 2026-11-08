/** @type {import('../../../../src/scanner/access-scan/engine/loader.js').EvaluatorModule} */
export default {
  id: 'inapplicable',
  async evaluate() {
    return { status: 'inapplicable', candidates: 0, findings: [] };
  },
};
