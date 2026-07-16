/** @type {import('../../../../src/scanner/access-scan/engine/loader.js').EvaluatorModule} */
export default {
  id: 'always-finding',
  async evaluate() {
    return {
      status: 'complete',
      candidates: 1,
      findings: [
        {
          violationType: 'confirmed',
          element: {
            outerHTML: '<button id="x">Go</button>',
            selector: '#x',
            framePath: [],
            shadowPath: [],
          },
          evidence: { reason: 'fixture' },
        },
      ],
    };
  },
};
