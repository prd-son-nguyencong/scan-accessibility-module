/** @type {import('../../../../src/scanner/access-scan/engine/schema.js').RuleDescriptor} */
export default {
  id: 'ListEmpty',
  status: 'active',
  category: 'lists',
  aliases: ['EmptyList'],
  standard: { version: 'WCAG 2.0', level: 'A', criterion: '1.3.1' },
  severity: { impact: 'moderate', priority: 4 },
  automation: 'deterministic',
  checks: [
    {
      id: 'empty-ul',
      profiles: ['standards', 'commercial-parity'],
      evaluator: 'always-finding',
      target: { selector: 'ul:empty', roots: ['document'], allowPluginFallback: true },
      classification: 'confirmed',
    },
  ],
  reporting: {
    title: 'List should not be empty',
    requirement: 'Empty lists confuse assistive technology.',
    recommendation: 'Populate the list or hide it from assistive technology.',
  },
  fix: { deterministic: true, policy: 'mechanically_safe' },
};
