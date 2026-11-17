import { validateGraphSelector } from '../runtime/graph-query.js';

/** @type {Set<string>} */
export const ALLOWED_TARGET_ROOTS = new Set(['document', 'shadow', 'frame', 'all']);

/**
 * @param {import('./schema.js').RuleCheckDescriptor} check
 * @param {number} checkIndex
 * @returns {import('./schema.js').ValidationError[]}
 */
export function validateCheckTarget(check, checkIndex) {
  /** @type {import('./schema.js').ValidationError[]} */
  const errors = [];
  const target = check.target;
  if (!target) return errors;

  if (target.selector) {
    const validation = validateGraphSelector(target.selector);
    if (!validation.valid && !target.allowPluginFallback) {
      errors.push({
        path: `/checks/${checkIndex}/target/selector`,
        message: validation.diagnostic.message,
      });
    }
  }

  if (Array.isArray(target.roots)) {
    for (const [index, root] of target.roots.entries()) {
      if (!ALLOWED_TARGET_ROOTS.has(root)) {
        errors.push({
          path: `/checks/${checkIndex}/target/roots/${index}`,
          message: `must be one of: ${[...ALLOWED_TARGET_ROOTS].join(', ')}`,
        });
      }
    }
  }

  return errors;
}
