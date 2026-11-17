export const TRUSTED_MODE = 'cis';
const REMOVED_MODES = ['claude', 'codex', 'cursor', 'windsurf', 'vscode'];

/** The message for every legacy write path removed in v2 (flags and --fix-mode values). */
export const removedMessage = (what) => `${what} was removed in v2; use "ada-scan fix --export" or --fix-mode ${TRUSTED_MODE}.`;

/** Error message for a --fix-mode value, or null when it is absent or the trusted mode. */
export function fixModeError(mode) {
  if (mode === undefined || mode === TRUSTED_MODE) return null;
  if (REMOVED_MODES.includes(mode)) return removedMessage(`--fix-mode ${mode}`);
  return `Invalid --fix-mode "${mode}". Valid value: ${TRUSTED_MODE}.`;
}
