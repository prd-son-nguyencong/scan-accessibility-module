/** @type {import('../engine/schema.js').RuleDescriptor[]} */
export default [
  {
    id: 'VisibleTextPartOfAccessibleName',
    status: 'active',
    category: 'aria',
    standard: { version: 'WCAG 2.1', level: 'A', criterion: '2.5.3' },
    severity: { impact: 'serious', priority: 3 },
    automation: 'heuristic',
    checks: [
      {
        id: 'aria:visible-text-part-of-accessible-name',
        profiles: ['standards'],
        evaluator: 'label-in-name',
        target: { selector: '[aria-label], [aria-labelledby]' },
        classification: 'potential',
      },
      {
        id: 'parity:checkbox-labelledby-value',
        profiles: ['commercial-parity'],
        evaluator: 'commercial-parity',
        options: { mode: 'checkbox-labelledby-value' },
        classification: 'commercial-parity',
      },
    ],
    reporting: {
      title: 'Aria labels should not override or replace visible text',
      requirement: 'Aria labels should describe elements that do not have proper text, such as icons and field labels. They should not override visible element text; additional context is allowed when the visible text remains part of the accessible name.',
      recommendation: 'Ensure the accessible name includes the control\'s visible label text.',
    },
    fix: { deterministic: false, policy: 'manual_only' },
  },
  {
    id: 'AriaLabelledbyContentMismatch',
    status: 'legacy-readable',
    category: 'aria',
    aliases: [],
    standard: { version: 'WCAG 2.1', level: 'A', criterion: '2.5.3' },
    severity: { impact: 'serious', priority: 3 },
    automation: 'manual',
    checks: [],
    reporting: {
      title: 'Legacy aria-labelledby label-in-name finding',
      requirement: 'This deprecated rule remains available for older reports. Current scans evaluate aria-labelledby through VisibleTextPartOfAccessibleName and allow additional accessible-name context.',
      recommendation: 'Verify aria-labelledby references match visible content.',
    },
    fix: { deterministic: false, policy: 'manual_only' },
  },
];
