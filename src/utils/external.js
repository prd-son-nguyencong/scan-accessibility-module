import { classifyHost } from './host-classify.js';

export const DEFAULT_W3C_ENDPOINT = 'https://validator.w3.org/nu/';

const announced = new Set();

/**
 * Gate for calls to third-party services (D2). Returns { allowed: true } or { allowed: false, reason }
 * where reason is 'external-disabled' (opt-in missing) or 'private-host' (never sent, even when enabled).
 * The first allowed call per service prints what is sent, once.
 */
export function externalGate(service, pageUrl, config = {}, { sends, endpoint } = {}) {
  if (config.external?.[service] !== true) return { allowed: false, reason: 'external-disabled' };
  if (classifyHost(pageUrl).kind !== 'public') return { allowed: false, reason: 'private-host' };
  if (!announced.has(service)) {
    announced.add(service);
    console.log(`  [external] ${service}: sending ${sends} to ${endpoint}`);
  }
  return { allowed: true };
}

export function resetExternalAnnouncements() {
  announced.clear();
}
