/** @type {import('../../../../src/scanner/access-scan/engine/schema.js').RuleDescriptor} */
export default {
  id: 'ErrorRule',
  status: 'active',
  category: 'general',
  aliases: [],
  standard: { version: 'WCAG 2.0', level: 'A', criterion: '1.1.1' },
  severity: { impact: 'serious', priority: 2 },
  automation: 'deterministic',
  checks: [
    {
      id: 'throws-check',
      profiles: ['standards'],
      evaluator: 'throws',
    },
    {
      id: 'continues-check',
      profiles: ['standards'],
      evaluator: 'always-finding',
    },
  ],
  reporting: {
    title: 'Error isolation fixture',
    requirement: 'One check throws; another continues.',
    recommendation: 'Fix the broken check.',
  },
  fix: { deterministic: false, policy: 'unsupported' },
};
