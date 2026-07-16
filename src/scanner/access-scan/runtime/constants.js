export const REQUIRES_ISOLATED_STATE = true;

export const DEFAULT_STABILITY_QUIET_MS = 50;
export const DEFAULT_STABILITY_TIMEOUT_MS = 3000;
/** Minimum observation window before quiet-period exit; covers typical deferred framework renders (~120ms). */
export const DEFAULT_STABILITY_MIN_OBSERVE_MS = 200;

export const SENSITIVE_ATTRIBUTE_PATTERN = /(?:^|_)(?:token|secret|csrf|password)(?:$|_)/i;

export const VISIBILITY_MODES = Object.freeze({
  ACTIVE_CONTENT: 'active-content',
  VISIBILITY: 'visibility',
  ALL: 'all',
});
