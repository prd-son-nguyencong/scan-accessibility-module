/** @type {import('../../../../src/scanner/access-scan/engine/schema.js').RuleDescriptor} */
export default {
  id: 'AriaLabelledbyContentMismatch',
  status: 'legacy-readable',
  category: 'aria',
  aliases: [],
  standard: { version: 'WCAG 2.1', level: 'A', criterion: '1.3.1' },
  severity: { impact: 'serious', priority: 3 },
  automation: 'manual',
  checks: [],
  reporting: {
    title: 'Aria-labelledby content mismatch',
    requirement: 'Legacy readable metadata only; scanners do not emit this rule.',
    recommendation: 'Verify aria-labelledby references match visible content.',
  },
  fix: { deterministic: false, policy: 'manual_only' },
};
