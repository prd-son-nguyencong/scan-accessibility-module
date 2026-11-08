/**
 * @param {string[]} argv
 * @returns {string[]}
 */
export function normalizeCliArgs(argv = []) {
  return argv.filter((arg) => arg !== '--');
}
