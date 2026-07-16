/** @type {import('../../../../src/scanner/access-scan/engine/loader.js').EvaluatorModule} */
export default {
  id: 'candidate-array',
  async evaluate() {
    return [
      {
        violationType: 'confirmed',
        element: {
          outerHTML: '<p>issue</p>',
          selector: 'p',
          framePath: [],
          shadowPath: [],
        },
        evidence: { source: 'array-result' },
      },
    ];
  },
};
