import { createHash } from 'node:crypto';

/**
 * Canonical route: hash dropped, trailing slash and /index.html folded, locale prefixes untouched.
 * The query is kept by default (same path + different query = different page).
 */
export function normalizeRoute(input = '/', { keepQuery = true } = {}) {
  const s = String(input || '/').trim();
  let u;
  try { u = new URL(/^https?:\/\//i.test(s) ? s : `http://x/${s.replace(/^\/+/, '')}`); } catch { return '/'; }
  const pathname = u.pathname.replace(/\/index(?:\.html)?$/i, '/').replace(/(.)\/+$/, '$1') || '/';
  return keepQuery ? pathname + u.search : pathname;
}

/**
 * URL safe to print or store: no userinfo, no fragment, each query value replaced by `r-` + 8 hex of its sha256
 * (names kept; same value = same key, so pages that differ only by query stay distinct and a re-scan keeps its
 * stableIds). `keepQuery` keeps the query as is (--keep-query).
 */
export function redactUrl(input, { keepQuery = false } = {}) {
  if (typeof input !== 'string' || !input) return input;
  const absolute = /^[a-z][a-z0-9+.-]*:/i.test(input);
  // Nothing to redact: keep the caller's exact spelling (an attested deploymentUrl has no trailing slash).
  if (absolute && !/[?#@]/.test(input)) return input;
  let u;
  try { u = new URL(input, 'http://redact.invalid'); } catch { return input; }
  u.username = '';
  u.password = '';
  u.hash = '';
  if (!keepQuery) for (const k of new Set(u.searchParams.keys())) u.searchParams.set(k, 'r-' + createHash('sha256').update(u.searchParams.getAll(k).join('\0')).digest('hex').slice(0, 8));
  return absolute ? u.href : u.pathname + u.search;
}

/** Deep copy of `value` with every http(s) URL inside any string redacted (failure messages, evidence, finalUrl). */
export function scrubUrls(value, opts = {}) {
  if (typeof value === 'string') return value.replace(/https?:\/\/[^\s"'<>\\)\]]+/gi, (m) => redactUrl(m, opts));
  if (Array.isArray(value)) return value.map((v) => scrubUrls(v, opts));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrubUrls(v, opts)]));
  return value;
}
