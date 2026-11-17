/** @type {import('../../../../src/scanner/access-scan/engine/schema.js').RuleDescriptor} */
export default {
  id: 'ParityOnlyRule',
  status: 'active',
  category: 'interactive',
  aliases: [],
  standard: { version: 'WCAG 2.2', level: 'A', criterion: '2.4.1' },
  severity: { impact: 'moderate', priority: 3 },
  automation: 'heuristic',
  checks: [
    {
      id: 'parity-overlay',
      profiles: ['commercial-parity'],
      evaluator: 'always-finding',
      classification: 'commercial-parity',
    },
  ],
  reporting: {
    title: 'Parity-only heuristic',
    requirement: 'Commercial overlay only.',
    recommendation: 'Review manually.',
  },
  fix: { deterministic: false, policy: 'manual_only' },
};
