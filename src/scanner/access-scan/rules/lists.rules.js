/** @type {import('../engine/schema.js').RuleDescriptor[]} */
export default [
  {
    id: 'ListEmpty',
    status: 'active',
    category: 'lists',
    standard: { version: 'WCAG 2.0', level: 'A', criterion: '1.3.1' },
    severity: { impact: 'moderate', priority: 4 },
    automation: 'deterministic',
    checks: [{
      id: 'lists:list-empty',
      profiles: ['standards', 'commercial-parity'],
      evaluator: 'list-structure',
      target: { selector: 'ul, ol' },
      classification: 'confirmed',
    }],
    reporting: {
      title: 'Lists should contain at least one list item',
      requirement: 'An empty list will still be announced by screen readers, which may confuse users, leaving them unsure if the list is empty or an issue prevents the screen reader from announcing the list items.',
      recommendation: 'Add aria-hidden="true" to empty lists, or populate with list items.',
    },
    fix: { deterministic: true, policy: 'mechanically_safe' },
  },
  {
    id: 'StickyHeaderObscuresFocus',
    status: 'active',
    category: 'lists',
    publicCategory: 'interactive',
    standard: { version: 'WCAG 2.2', level: 'AA', criterion: '2.4.11' },
    severity: { impact: 'critical', priority: 1 },
    automation: 'behavioral',
    checks: [
      {
        id: 'lists:sticky-header-obscures-focus',
        profiles: ['standards'],
        evaluator: 'focus-obscuration',
        options: { mode: 'sticky-header-obscures-focus' },
        classification: 'confirmed',
      },
      {
        id: 'parity:sticky-header-semantic',
        profiles: ['commercial-parity'],
        evaluator: 'commercial-parity',
        options: { mode: 'sticky-header-semantic' },
        classification: 'commercial-parity',
      },
    ],
    reporting: {
      title: 'Focused elements should not be obscured by a sticky header',
      requirement: 'A sticky header remains anchored to the top of the screen while the rest of the page content can be scrolled. If it is not offset from interactive elements, it can overlap and obscure the item in focus.',
      recommendation: 'Add top padding or adjust sticky header behavior so focused controls remain visible.',
    },
    fix: { deterministic: false, policy: 'manual_only' },
  },
];
