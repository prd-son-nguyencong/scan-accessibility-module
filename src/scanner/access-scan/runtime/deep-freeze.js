/**
 * Recursively freezes plain objects and arrays for immutable snapshots.
 * @param {unknown} value
 * @returns {unknown}
 */
export function deepFreeze(value) {
  if (value === null || typeof value !== 'object') {
    return value;
  }

  Object.freeze(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      if (item !== null && typeof item === 'object' && !Object.isFrozen(item)) {
        deepFreeze(item);
      }
    }
    return value;
  }

  for (const key of Object.keys(value)) {
    const child = /** @type {Record<string, unknown>} */ (value)[key];
    if (child !== null && typeof child === 'object' && !Object.isFrozen(child)) {
      deepFreeze(child);
    }
  }

  return value;
}
