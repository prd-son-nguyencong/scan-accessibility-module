import { normalizeText } from '../../evaluators/lib/runtime-context.js';

/**
 * @param {{ visibleText?: string, accessibleName?: string }=} input
 */
export function visibleTextIsInAccessibleName(input = {}) {
  const visible = normalizeText(input.visibleText);
  const accessible = normalizeText(input.accessibleName);
  return Boolean(visible && accessible && accessible.includes(visible));
}
