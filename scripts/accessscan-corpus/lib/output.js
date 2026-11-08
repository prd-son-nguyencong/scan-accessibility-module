/**
 * @param {Record<string, unknown>} payload
 * @returns {string}
 */
export function serializeDeterministicJson(payload) {
  return `${JSON.stringify(payload, null, 2)}\n`;
}

/**
 * @param {Record<string, unknown>} payload
 */
export function printDeterministicJson(payload) {
  process.stdout.write(serializeDeterministicJson(payload));
}
