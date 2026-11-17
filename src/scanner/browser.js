import { chromium } from 'playwright';
import { killBrowserChildren } from '../utils/process-tree.js';
import { withTimeout } from '../utils/with-timeout.js';
import { assertNotCancelled, cancelAllScopes, trackContext } from '../utils/scan-scope.js';

let browserPromise = null;
const CLOSE_TIMEOUT_MS = 10_000;
export const CONTEXT_OP_TIMEOUT_MS = 90_000; // 90 s: a 30 s bound failed under full-suite starvation; newContext/newPage have no Playwright timeout; a wedged Chromium would hang them forever

// Memoizes the launch promise (no double Chromium on concurrent callers) and relaunches after a crash.
export async function getBrowser() {
  assertNotCancelled(); // work abandoned before closeBrowser must not relaunch a Chromium nobody will close
  if (!browserPromise) {
    const launched = chromium.launch({ headless: true }).then((b) => {
      b.on('disconnected', () => {
        if (browserPromise === launched) browserPromise = null;
      });
      return b;
    });
    browserPromise = launched;
    launched.catch(() => {
      if (browserPromise === launched) browserPromise = null;
    });
  }
  return browserPromise;
}

export async function newPage(browserInstance, options = {}) {
  assertNotCancelled();
  const opMs = options.opTimeoutMs ?? CONTEXT_OP_TIMEOUT_MS;
  const contextPromise = browserInstance.newContext({
    viewport: options.viewport || { width: 1280, height: 900 },
    ignoreHTTPSErrors: true,
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 ADA-Scanner/1.0',
  });
  let context;
  try {
    context = await withTimeout(contextPromise, opMs, 'browser.newContext');
  } catch (err) {
    contextPromise.then((late) => late.close()).catch(() => {}); // a context that opens after we gave up must not leak
    throw err;
  }
  trackContext(context);
  context.setDefaultTimeout(options.timeout ?? 5000);
  let page;
  try {
    page = await withTimeout(context.newPage(), opMs, 'context.newPage');
  } catch (err) {
    await withTimeout(context.close(), opMs, 'context.close').catch(() => {}); // a failed newPage must not leave its context open
    throw err;
  }
  // Suppress console noise from the scanned page
  page.on('console', () => {});
  page.on('pageerror', () => {});
  return page;
}

const IDLE_WAIT_MS = 5000;

/**
 * Navigate to a URL: waits for `load`, then a bounded wait for network idle.
 * Chat widgets, analytics and long-polling rarely reach idle, so the idle
 * wait is best-effort and never triggers a second navigation.
 * Returns the main-document Response (null for about:blank/same-document navigations).
 */
export async function resilientGoto(page, url, { timeout = 60000 } = {}) {
  let doc = null;
  const onResponse = (r) => { if (!doc && r.request().isNavigationRequest() && r.frame() === page.mainFrame()) doc = r; };
  page.on?.('response', onResponse);
  await releaseRefreshGuard(page); // an explicit navigation is never blocked
  try {
    const response = await page.goto(url, { waitUntil: 'load', timeout });
    await guardTimedRefresh(page, response); // before the idle wait: a short refresh must not fire while the scan reads the page
    await page.waitForLoadState('networkidle', { timeout: IDLE_WAIT_MS }).catch(() => {});
    return response;
  } catch (err) {
    // A stalled subresource (video, tag, widget) keeps `load` from firing; the document is scannable once DOMContentLoaded has fired.
    if (!/Timeout/i.test(err.message) || !doc) throw err;
    await page.waitForLoadState('domcontentloaded', { timeout: IDLE_WAIT_MS }).catch(() => { throw err; });
    page.adaLoadTimedOut = true;
    await guardTimedRefresh(page, doc);
    return doc;
  } finally {
    page.off?.('response', onResponse);
  }
}

/**
 * The target of a timed refresh (`<meta http-equiv="refresh" content="N; url=...">` or a `Refresh` header with N > 0) as an absolute URL, else null.
 * An immediate redirect (N = 0) and a refresh of the page itself are not timed changes of content and are left alone.
 */
export function timedRefreshTarget(html, headers, baseUrl) {
  const contents = [headers?.refresh];
  for (const tag of String(html ?? '').match(/<meta\b[^>]*>/gi) ?? []) {
    if (/\bhttp-equiv\s*=\s*["']?\s*refresh\b/i.test(tag)) contents.push(/\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag)?.slice(1).find((x) => x !== undefined));
  }
  for (const c of contents) {
    const m = /^\s*(\d+(?:\.\d+)?)\s*[;,]\s*(?:url\s*=\s*)?["']?([^"']+?)["']?\s*$/i.exec(c ?? '');
    if (!m || !(Number(m[1]) > 0)) continue;
    try {
      const target = new URL(m[2], baseUrl);
      const self = new URL(baseUrl);
      target.hash = self.hash = ''; // the request URL never carries a fragment, so page.route would not match one
      if (/^https?:$/.test(target.protocol) && target.href !== self.href) return target.href;
    } catch { /* not a URL: nothing to guard */ }
  }
  return null;
}

// Chromium follows a refresh timer on its own, so a 3 to 10 second refresh used to move the scan to another page mid-run and attribute that
// page's findings to this URL. The document the scan was asked for is read before the timer fires and the target answers 204 (no navigation),
// so the page stays and its meta tag stays in the DOM for MetaRefresh. shortcut: the guard matches the target URL only, a refresh to the page itself is not stopped.
async function guardTimedRefresh(page, response) {
  try {
    const target = response && timedRefreshTarget(await response.text(), await response.allHeaders(), response.url());
    if (!target) return;
    const handler = (route) => (route.request().isNavigationRequest() ? route.fulfill({ status: 204 }) : route.fallback());
    await page.route(target, handler);
    page.adaRefreshGuard = { target, handler };
  } catch { /* an unreadable body (a download, a closed page) has no refresh to guard */ }
}

async function releaseRefreshGuard(page) {
  const g = page.adaRefreshGuard;
  if (!g) return;
  page.adaRefreshGuard = null;
  await page.unroute(g.target, g.handler).catch(() => {});
}

// Playwright's Browser has no process handle, so when close() hangs the Chromium children of this process are killed by pid.
export async function closeBrowser({ timeoutMs = CLOSE_TIMEOUT_MS } = {}) {
  cancelAllScopes();
  const pending = browserPromise;
  browserPromise = null;
  const browser = pending && (await pending.catch(() => null));
  if (!browser) return;
  let timer;
  let timedOut = false;
  await Promise.race([browser.close().catch(() => {}), new Promise((r) => { timer = setTimeout(() => { timedOut = true; r(); }, timeoutMs); })]);
  clearTimeout(timer);
  if (timedOut) killBrowserChildren();
}
