const ABSOLUTE_URL_PATTERN = /https?:\/\/(?:[a-z0-9.-]+\.)+[a-z]{2,}(?::\d+)?(?:\/|\?|#|$)/i;
const PROTOCOL_RELATIVE_URL_PATTERN = /\/\/(?:[a-z0-9.-]+\.)+[a-z]{2,}(?::\d+)?(?:\/|\?|#|$)/i;
const BARE_HOST_PATTERN = /\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/|\?|#|$)/gi;
const NEUTRAL_EVIDENCE_PATH_PATTERN = /^\/neutral-[a-z0-9.-]+$/i;
const LOOPBACK_URL_PATTERN = /https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]|::1)(?::\d+)?/i;
const IPV4_LITERAL_URL_PATTERN = /https?:\/\/(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?/i;
const LOOPBACK_BARE_PATTERN = /\b(?:127\.0\.0\.1|localhost|\[::1\]|::1)(?::\d+)?(?:\/|\?|#|$)/i;
const IPV4_BARE_PATTERN = /\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?(?:\/|\?|#|$)/i;
const BARE_HOST_TLD_BLOCKLIST = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'css', 'js', 'woff', 'woff2', 'ttf', 'eot', 'pdf', 'mp4', 'webm',
]);

/**
 * @param {string} value
 * @returns {boolean}
 */
function hasBareHostLeakage(value = '') {
  for (const match of String(value).matchAll(BARE_HOST_PATTERN)) {
    const segment = match[0];
    if (/^neutral-asset\./i.test(segment)) continue;
    const tld = segment.split('.').pop()?.replace(/(?:\/|\?|#).*$/, '').toLowerCase() || '';
    if (BARE_HOST_TLD_BLOCKLIST.has(tld)) continue;
    return true;
  }
  return false;
}

/**
 * @param {string} value
 * @returns {boolean}
 */
export function containsHostLeakage(value = '') {
  const text = String(value);
  if (!text) return false;
  if (NEUTRAL_EVIDENCE_PATH_PATTERN.test(text.trim())) return false;
  if (LOOPBACK_URL_PATTERN.test(text)) return true;
  if (IPV4_LITERAL_URL_PATTERN.test(text)) return true;
  if (LOOPBACK_BARE_PATTERN.test(text)) return true;
  if (IPV4_BARE_PATTERN.test(text)) return true;
  if (ABSOLUTE_URL_PATTERN.test(text)) return true;
  if (PROTOCOL_RELATIVE_URL_PATTERN.test(text)) return true;
  if (hasBareHostLeakage(text)) return true;
  return false;
}

/**
 * @param {string} value
 * @param {string} label
 * @returns {string | null}
 */
export function hostLeakageError(value, label) {
  return containsHostLeakage(value) ? `${label} contains host or URL leakage` : null;
}
