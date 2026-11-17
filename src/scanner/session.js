import { getBrowser, newPage, resilientGoto, CONTEXT_OP_TIMEOUT_MS } from './browser.js';
import { withTimeout } from '../utils/with-timeout.js';
import { classifyNavigation } from './page-health.js';
import { installRuntimeHooks } from './access-scan/runtime/index.js';
import { trackBlockedScripts } from './blocked-scripts.js';
import { installNoHydrateJobsRoutes } from './access-scan/runtime/no-hydrate.js';

const NAV_TIMEOUT_MS = 60000;
const PROBE_TIMEOUT_MS = 10000; // title()/content() evaluate in the page: a hung renderer never answers

// A failed read stays '' (the page may be navigating away); a hung one is a dead renderer and must surface.
const probe = (work, ms, label) => withTimeout(work, ms, label).catch((err) => {
  if (err.name === 'TimeoutError') throw err;
  return '';
});

/**
 * The only place that creates scan contexts/pages: applies UA, viewport, HTTPS
 * tolerance and default timeouts (newPage) plus runtime hooks and, for
 * --no-hydrate-jobs, the jobs/chat route blocking.
 * Returns { page, close }.
 */
export async function createScanContext(browser, { viewport, timeout, noHydrateJobs = false, opTimeoutMs = CONTEXT_OP_TIMEOUT_MS } = {}) {
  const page = await newPage(browser, { viewport, timeout, opTimeoutMs });
  trackBlockedScripts(page);
  const close = () => withTimeout(page.context().close(), opTimeoutMs, 'context.close').catch(() => {});
  try {
    await withTimeout(installRuntimeHooks(page), opTimeoutMs, 'installRuntimeHooks');
    if (noHydrateJobs) await withTimeout(installNoHydrateJobsRoutes(page), opTimeoutMs, 'installNoHydrateJobsRoutes');
  } catch (err) {
    await close();
    throw err;
  }
  return { page, close };
}

/**
 * Fresh context + one navigation + page-health check. Returns
 * { page, close, response, failure }; failure is null for a scannable page.
 * Navigation errors propagate (the context is closed first).
 */
export async function openScanPage(browser, url, { navTimeout = NAV_TIMEOUT_MS, allowStatus = [], probeTimeoutMs = PROBE_TIMEOUT_MS, ...contextOptions } = {}) {
  const ctx = await createScanContext(browser, contextOptions);
  try {
    const response = await resilientGoto(ctx.page, url, { timeout: navTimeout });
    const failure = classifyNavigation({
      status: response?.status() ?? null,
      allowStatus,
      title: await probe(ctx.page.title(), probeTimeoutMs, 'page.title'),
      html: await probe(ctx.page.content(), probeTimeoutMs, 'page.content'),
    });
    return { ...ctx, response, failure };
  } catch (err) {
    await ctx.close();
    throw err;
  }
}

/**
 * Used by the layers: reuses the shared page (`opts.page`, never closed here) or
 * opens an own fresh context. An unscannable page throws, so the layer reports an error.
 */
export async function acquirePage(url, opts = {}) {
  if (opts.page) return { page: opts.page, close: async () => {} };
  const scan = await openScanPage(await getBrowser(), url, opts);
  if (scan.failure) {
    await scan.close();
    throw new Error(`${url}: ${scan.failure.message}`);
  }
  return scan;
}
