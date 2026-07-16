/** @type {import('../engine/schema.js').RuleDescriptor[]} */
export default [
  {
    id: 'DraggingAlternative',
    status: 'active',
    category: 'dragging',
    standard: { version: 'WCAG 2.2', level: 'AA', criterion: '2.5.7' },
    severity: { impact: 'serious', priority: 3 },
    automation: 'heuristic',
    checks: [{
      id: 'dragging:dragging-alternative',
      profiles: ['standards'],
      evaluator: 'dragging',
      target: { selector: '[role="slider"], [draggable="true"], [aria-grabbed], [data-drag-handle], input[type="range"]' },
      options: { mode: 'dragging-alternative' },
      classification: 'potential',
    }],
    reporting: {
      title: 'A slider should be operated with a single pointer',
      requirement: 'A slider should be operable with a single pointer.',
      recommendation: 'Ensure slider can be operated with a single pointer (no drag required).',
    },
    fix: { deterministic: false, policy: 'manual_only' },
  },
];
