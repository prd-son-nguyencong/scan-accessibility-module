import { altTextRule } from './alt-text.js';
import { ariaRule } from './aria.js';
import { landmarksRule } from './landmarks.js';
import { fontDisplayRule } from './font-display.js';
import { lazyLoadRule } from './lazy-load.js';
import { scriptsRule } from './scripts.js';
import { headingsRule } from './headings.js';
import { formsRule } from './forms.js';
import { focusRule } from './focus.js';
import { skipLinkRule } from './skip-link.js';
import { langRule } from './lang.js';
import { semanticRule } from './semantic.js';

/**
 * Rule Registry
 *
 * Maps axe/scanner rule IDs to deterministic fixer rules.
 * Rules are applied in priority order (most impactful first).
 */
const ALL_RULES = [
  langRule,       // html[lang] — required for screen readers
  skipLinkRule,   // Skip navigation link — WCAG 2.4.1
  landmarksRule,  // Landmark regions — WCAG 1.3.6
  altTextRule,    // Image alt text — WCAG 1.1.1
  ariaRule,       // ARIA labels/roles — WCAG 4.1.2
  headingsRule,   // Heading order — WCAG 2.4.6
  formsRule,      // Form label associations — WCAG 1.3.1
  semanticRule,   // Semantic emphasis <strong>/<em> — WCAG 1.3.1
  fontDisplayRule,// font-display: swap — Lighthouse perf
  lazyLoadRule,   // loading="lazy" — Lighthouse perf
  scriptsRule,    // defer/async scripts — Lighthouse perf
  focusRule,      // Focus visible CSS — WCAG 2.4.7
];

// Build lookup map: ruleId → fixer
const ruleMap = new Map();
for (const rule of ALL_RULES) {
  for (const handledId of rule.handles) {
    ruleMap.set(handledId, rule);
  }
  ruleMap.set(rule.id, rule);
}

/**
 * Finds the rule that handles a given violation ID.
 * Returns null if no deterministic rule handles it.
 */
export function findRule(violationId) {
  return ruleMap.get(violationId) || null;
}

/**
 * Returns all registered rules.
 */
export function getAllRules() {
  return ALL_RULES;
}
