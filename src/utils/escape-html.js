const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' };

/** Escape text for HTML body and quoted attribute contexts. Call once, at the sink. */
export function escapeHtml(value = '') {
  return String(value ?? '').replace(/[&<>"'`]/g, (ch) => ENTITIES[ch]);
}

/**
 * Strict CSP `<meta>` for a generated report. The only script allowed is the one whose sha256 is given
 * (the report's own inline script; an array allows several scripts); `style-src` keeps 'unsafe-inline' because the reports use style attributes.
 * Nothing remote loads; images are the page's own screenshot files or data: URIs.
 */
export function cspMeta({ scriptSha256 = '' } = {}) {
  const policy = [
    "default-src 'none'",
    [scriptSha256].flat().filter(Boolean).length ? `script-src ${[scriptSha256].flat().filter(Boolean).map((h) => `'sha256-${h}'`).join(' ')}` : "script-src 'none'",
    "style-src 'unsafe-inline'",
    "img-src 'self' data: file:",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
  return `<meta http-equiv="Content-Security-Policy" content="${policy}">`;
}
