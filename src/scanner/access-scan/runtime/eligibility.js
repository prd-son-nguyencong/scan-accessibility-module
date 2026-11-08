import { VISIBILITY_MODES } from './constants.js';

/**
 * @param {import('./types.js').SnapshotElement[]} elements
 * @param {{ visibility?: string }=} options
 * @returns {import('./types.js').SnapshotElement[]}
 */
export function filterByEligibility(elements, options = {}) {
  const mode = options.visibility || VISIBILITY_MODES.ACTIVE_CONTENT;

  if (mode === VISIBILITY_MODES.ALL) {
    return elements;
  }

  if (mode === VISIBILITY_MODES.VISIBILITY) {
    return elements.filter((element) => element.visuallyVisible);
  }

  return elements.filter(
    (element) => element.rendered && !element.hiddenFromAT,
  );
}
