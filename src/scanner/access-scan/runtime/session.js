import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_STABILITY_MIN_OBSERVE_MS,
  DEFAULT_STABILITY_QUIET_MS,
  DEFAULT_STABILITY_TIMEOUT_MS,
  REQUIRES_ISOLATED_STATE,
} from './constants.js';
import { deepFreeze } from './deep-freeze.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BROWSER_RUNTIME_SOURCE = readFileSync(
  path.join(__dirname, 'runtime.browser.js'),
  'utf8',
);

/**
 * Installs browser runtime hooks before document scripts execute when possible.
 *
 * @param {import('playwright').Page} page
 */
export async function installRuntimeHooks(page) {
  await page.addInitScript({ content: BROWSER_RUNTIME_SOURCE });
  await page.evaluate((source) => {
    if (!globalThis.__adaScanRuntime) {
      (0, eval)(source);
    }
  }, BROWSER_RUNTIME_SOURCE);
}

/**
 * aria-labelledby IDREF resolution is scoped to the element's root node
 * (document, shadow root, or frame document). References never leak across
 * frame boundaries.
 *
 * Behavioral forks create a separate BrowserContext seeded with the source
 * context storageState when available so auth cookies/localStorage baseline
 * is preserved while subsequent mutations stay isolated. Callers must invoke
 * the returned cleanup() to close the owned page and context.
 *
 * @param {import('playwright').Page} page
 * @param {{
 *   url?: string,
 *   stabilityQuietMs?: number,
 *   stabilityTimeoutMs?: number,
 *   stabilityMinObserveMs?: number,
 *     Bounded minimum observation window before quiet-period exit (default 200ms).
 *     Override for faster static pages or longer deferred-render tolerance.
 *   configureForkedPage?: (request: {
 *     page: import('playwright').Page,
 *     context: import('playwright').BrowserContext | null,
 *   }) => Promise<void>,
 * }=} options
 */
export async function createScanSession(page, options = {}) {
  /** @type {import('./types.js').Snapshot | null} */
  let cachedSnapshot = null;

  const metrics = {
    navigationCount: 0,
    runtimeInstallCount: 0,
    snapshotCount: 0,
    elementCount: 0,
    frameCount: 0,
    shadowRootCount: 0,
  };

  const hadRuntime = await page.evaluate(() => Boolean(globalThis.__adaScanRuntime));
  if (!hadRuntime) {
    await installRuntimeHooks(page);
    await page.evaluate(() => {
      globalThis.__adaScanRuntime?.markLateObservation?.();
    });
    metrics.runtimeInstallCount = 1;
  }

  if (options.url) {
    await page.evaluate(() => {
      globalThis.__adaScanRuntime?.resetForNavigation?.();
    });
    await page.goto(options.url, { waitUntil: 'domcontentloaded' });
    metrics.navigationCount = 1;
  }

  const quietMs = options.stabilityQuietMs ?? DEFAULT_STABILITY_QUIET_MS;
  const timeoutMs = options.stabilityTimeoutMs ?? DEFAULT_STABILITY_TIMEOUT_MS;
  const minObserveMs = options.stabilityMinObserveMs ?? DEFAULT_STABILITY_MIN_OBSERVE_MS;

  const payload = await page.evaluate(async ({ quietMs, timeoutMs, minObserveMs }) => {
    const runtime = globalThis.__adaScanRuntime;
    await runtime.waitForDomStability({ quietMs, timeoutMs, minObserveMs });
    const snapshot = runtime.buildSnapshot();
    return {
      snapshot,
      diagnostics: snapshot.diagnostics,
      counts: snapshot.counts,
    };
  }, { quietMs, timeoutMs, minObserveMs });

  cachedSnapshot = /** @type {import('./types.js').Snapshot} */ (deepFreeze({
    elements: payload.snapshot.elements,
    diagnostics: payload.snapshot.diagnostics,
    counts: { ...payload.snapshot.counts },
  }));

  metrics.snapshotCount = 1;
  metrics.elementCount = cachedSnapshot.elements.length;
  metrics.frameCount = cachedSnapshot.counts.frameCount;
  metrics.shadowRootCount = cachedSnapshot.counts.shadowRootCount;

  const getSnapshot = async () => cachedSnapshot;

  const forkBehavioralPage = async () => {
    const sourceContext = page.context();
    const browser = sourceContext.browser();
    /** @type {import('playwright').BrowserContext | null} */
    let forkContext = null;
    /** @type {import('playwright').Page | null} */
    let forkedPage = null;
    /** @type {'isolated-context' | 'shared-context-fallback'} */
    let isolationMode = 'shared-context-fallback';

    try {
      if (browser) {
        const storageState = await sourceContext.storageState();
        forkContext = await browser.newContext({
          viewport: { width: 1280, height: 900 },
          storageState,
        });
        forkedPage = await forkContext.newPage();
        forkedPage.on('console', (message) => {
          if (message.type() === 'error' || message.type() === 'warning') {
            process.stderr.write(`[ada-scan:fork:console:${message.type()}] ${message.text()}\n`);
          }
        });
        forkedPage.on('pageerror', (error) => {
          process.stderr.write(`[ada-scan:fork:pageerror] ${error.message}\n`);
        });
        isolationMode = 'isolated-context';
      } else {
        forkedPage = await sourceContext.newPage();
        forkedPage.on('console', (message) => {
          if (message.type() === 'error' || message.type() === 'warning') {
            process.stderr.write(`[ada-scan:fork:console:${message.type()}] ${message.text()}\n`);
          }
        });
        forkedPage.on('pageerror', (error) => {
          process.stderr.write(`[ada-scan:fork:pageerror] ${error.message}\n`);
        });
      }

      const sourceUrl = page.url();
      const canNavigate = (
        sourceUrl
        && !sourceUrl.startsWith('about:blank')
        && sourceUrl !== 'about:blank'
      );

      if (canNavigate) {
        await installRuntimeHooks(forkedPage);
        if (options.configureForkedPage) {
          await options.configureForkedPage({ page: forkedPage, context: forkContext });
        }
        await forkedPage.goto(sourceUrl, { waitUntil: 'domcontentloaded' });
      } else {
        await installRuntimeHooks(forkedPage);
        if (options.configureForkedPage) {
          await options.configureForkedPage({ page: forkedPage, context: forkContext });
        }
        const html = await page.content();
        await forkedPage.setContent(html, { waitUntil: 'domcontentloaded' });
      }

      const scanSession = await createScanSession(forkedPage);

      return {
        page: forkedPage,
        context: forkContext,
        scanSession,
        requiresIsolatedState: REQUIRES_ISOLATED_STATE,
        isolationMode,
        cleanup: async () => {
          if (forkedPage) await forkedPage.close();
          if (forkContext) await forkContext.close();
        },
      };
    } catch (error) {
      if (forkedPage) await forkedPage.close().catch(() => {});
      if (forkContext) await forkContext.close().catch(() => {});
      throw error;
    }
  };

  return {
    snapshot: cachedSnapshot,
    url: page.url(),
    diagnostics: [...cachedSnapshot.diagnostics],
    metrics: { ...metrics },
    getSnapshot,
    forkBehavioralPage,
    requiresIsolatedState: REQUIRES_ISOLATED_STATE,
  };
}
