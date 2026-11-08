// Decides whether a navigated page is a real scan target. A scan of a 404, a
// bot/WAF challenge page or an unreachable host must never look like a clean pass.

const CHALLENGE_STATUSES = new Set([403, 429, 503]);
const CHALLENGE_TITLE = /just a moment|attention required|pardon our interruption|access denied|are you a robot|checking your browser/i;
const CHALLENGE_BODY = /cf_chl_opt|cf-browser-verification|_Incapsula_Resource|px-captcha|captcha-delivery\.com|errors\.edgesuite\.net/i;

/**
 * Returns null when the page is scannable, else { reason, httpStatus, message }.
 * `allowStatus` lists HTTP statuses the config accepts (e.g. a deliberate 404 page);
 * a challenge page is never accepted.
 */
export function classifyNavigation({ status = null, allowStatus = [], title = '', html = '' } = {}) {
  // A challenge title only counts on an error status; body markers are specific enough for any status.
  const challenge = CHALLENGE_BODY.test(html.slice(0, 50000))
    || (CHALLENGE_TITLE.test(title) && (status == null || CHALLENGE_STATUSES.has(status) || status >= 400));
  if (challenge) {
    return { reason: 'bot-challenge', httpStatus: status, message: `bot/WAF challenge page${status ? ` (HTTP ${status})` : ''}` };
  }
  if (typeof status === 'number' && status >= 400 && !allowStatus.includes(status)) {
    return { reason: 'http-status', httpStatus: status, message: `HTTP ${status}` };
  }
  return null;
}

export const EMPTY_PAGE_NOTE = 'empty template, platform-managed?';

/** True when the navigated document has nothing to scan: no text, no landmarks or headings, only inert body children. */
export function isEmptyPage(page) {
  return page.evaluate(() => {
    const body = document.body;
    if (!body) return true;
    const inert = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT', 'LINK', 'META']);
    return [...body.children].every((c) => inert.has(c.tagName))
      && !(body.innerText || '').trim()
      && !document.querySelector('main, nav, header, footer, aside, h1, h2, h3, h4, h5, h6, [role]');
  });
}

export const UNRENDERABLE_NOTE = 'unrenderable locally: the dev server could not render this template (it needs platform data)';

/** True for the Vite dev-server error overlay (the page that answers a template that threw). */
export const isDevErrorOverlay = (html) => /<vite-error-overlay\b|<script\b[^>]*>[^<]*new ErrorOverlay\(/.test(html || '');

export const DEV_OVERLAY_REASON = 'dev server error overlay: fix the build error first';
// Dev-server overlays are custom elements with a shadow root; none of them is site code.
const DEV_OVERLAY_HOSTS = ['vite-error-overlay', 'webpack-dev-server-client-overlay', 'react-error-overlay'];
// nextjs-portal is the persistent devtools host on every healthy Next dev page: an error only when its shadow root holds a dialog.
const NEXT_ERROR_DIALOG = '[data-nextjs-dialog], [data-nextjs-dialog-overlay]';
const DEV_OVERLAY_IN_ROW = new RegExp([...DEV_OVERLAY_HOSTS, 'nextjs-portal'].join('|'), 'i');

/** True when the live DOM holds a dev-server error overlay (the page is not the site, it is the build error). */
export function hasDevOverlay(page) {
  return page.evaluate(([hosts, dialog]) => hosts.some((h) => document.querySelector(h) || document.getElementById(h))
    || [...document.querySelectorAll('nextjs-portal')].some((p) => p.shadowRoot?.querySelector(dialog)), [DEV_OVERLAY_HOSTS, NEXT_ERROR_DIALOG]).catch(() => false);
}

/** A finding whose element (selector, shadow or frame path, markup) sits inside a dev overlay. */
export const isInDevOverlay = (v) => DEV_OVERLAY_IN_ROW.test(JSON.stringify([v.element?.selector, v.element?.shadowPath, v.element?.framePath, v.element?.outerHTML?.slice(0, 200)]));

/** Drops every finding inside a dev overlay; returns the remaining list. */
export const dropDevOverlayFindings = (violations) => violations.filter((v) => !isInDevOverlay(v));

/** A local (non-deployed) target that answered 5xx or the dev error overlay: the template needs platform data, not a scan failure. */
export const isUnrenderableLocally = (failure, html) => (failure ? failure.reason === 'http-status' && failure.httpStatus >= 500 : false) || isDevErrorOverlay(html);

export function isTimeoutError(err) {
  return /timeout|timed out/i.test(err?.message || '') || err?.name === 'TimeoutError';
}

// Layer errors worth one retry in a fresh context; validation and programming errors are deterministic.
const TRANSIENT_LAYER_ERROR = /Target (page, context or browser )?(has been )?closed|(context|page|browser|frame) (has been |was )?(closed|detached|destroyed)|Execution context was destroyed|Navigation failed|net::ERR_|ECONNRESET|socket hang up/i;

export function isTransientLayerError(err) {
  return isTimeoutError(err) || TRANSIENT_LAYER_ERROR.test(err?.message || '');
}

/**
 * Runs one layer task `(violations, scannerRuns, isRetry)`; a timeout or transient failure
 * (reported as a failed scanner run or thrown) gets one retry. Returns { violations, scannerRuns, attempts, reason? }.
 */
export async function runLayerWithRetry(task, { bound = (work) => work() } = {}) {
  // `bound` limits one attempt (a hard deadline that closes its contexts): a layer that hangs to the deadline is still retried once.
  const attempt = async (isRetry) => {
    const out = { violations: [], scannerRuns: [] };
    await bound(() => task(out.violations, out.scannerRuns, isRetry));
    return out;
  };
  let reason;
  try {
    const out = await attempt(false);
    const failed = out.scannerRuns.find((r) => r.evidence?.transient && INCOMPLETE_RUN.has(r.status));
    if (!failed) return { ...out, attempts: 1 };
    reason = failed.evidence.errorMessage;
  } catch (err) {
    if (!isTransientLayerError(err)) throw err;
    reason = (err.message || '').split('\n')[0];
  }
  return { ...(await attempt(true)), attempts: 2, reason };
}

const TRANSIENT_NAV_ERROR = /ECONNRESET|ERR_CONNECTION_(RESET|CLOSED)|ERR_EMPTY_RESPONSE|socket hang up/i;

/** Worth one retry: timeout, 5xx or a reset connection. DNS errors and 4xx are deterministic. */
export function isTransientFailure(failure) {
  if (!failure) return false;
  if (failure.reason === 'timeout') return true;
  if (failure.reason === 'http-status') return failure.httpStatus >= 500;
  return failure.reason === 'navigation-error' && TRANSIENT_NAV_ERROR.test(failure.message || '');
}

const INCOMPLETE_RUN = new Set(['error', 'timeout', 'skipped']);
// A layer skipped by policy (external services off, private host) is not an incomplete scan.
const POLICY_SKIP = new Set(['external-disabled', 'private-host']);
const isIncomplete = (run) => INCOMPLETE_RUN.has(run.status)
  && !(run.status === 'skipped' && POLICY_SKIP.has(run.evidence?.errorCode));

// Layers that add information but are not what a quality gate decides on: performance (Lighthouse) and the external W3C service.
// A page whose only incomplete layers are these is still reported `partial`, but does not make the scan exit 2 unless `scan.strict`.
export const SUPPLEMENTARY_LAYERS = new Set(['lighthouse', 'w3c']);

/** Why a page is partial: [{ layer, reason, gating }], one per incomplete layer. gating: the layer counts for the exit code (always with `strict`). */
export function partialReasons(scannerRuns = [], { strict = false } = {}) {
  const seen = new Map();
  for (const run of scannerRuns.filter(isIncomplete)) {
    const reason = `${run.status}: ${run.evidence?.errorMessage || run.evidence?.errorCode || 'layer did not complete'}`;
    seen.set(`${run.layer}|${reason}`, { layer: run.layer, reason, gating: strict || !SUPPLEMENTARY_LAYERS.has(run.layer) });
  }
  return [...seen.values()].sort((a, b) => a.layer.localeCompare(b.layer) || a.reason.localeCompare(b.reason));
}

/** ok | partial (a layer errored, timed out or was skipped) | failed (page unusable). */
export function derivePageStatus(failure, scannerRuns = []) {
  if (failure) return 'failed';
  return scannerRuns.some(isIncomplete) ? 'partial' : 'ok';
}
