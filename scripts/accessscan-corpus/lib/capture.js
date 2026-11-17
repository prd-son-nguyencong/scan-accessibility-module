import { CORPUS_SCHEMA_VERSION } from '../../../src/scanner/access-scan/corpus/constants.js';
import { CorpusToolingError, CORPUS_TOOLING_ERROR_CODES } from './errors.js';
import { snapshotsSemanticallyEqual } from './snapshot-identity.js';

export const DEFAULT_PAGE_STATE = 'initial';
const REQUIRED_CAPTURE_COUNT = 2;

/**
 * @typedef {object} CaptureRequest
 * @property {string=} url
 * @property {string=} route
 * @property {string=} captureState
 * @property {{ width: number, height: number }=} viewport
 * @property {() => Promise<Record<string, unknown>> | Record<string, unknown>} captureAdapter
 * @property {(page: unknown, context: Record<string, unknown>) => Promise<void>=} stateAdapter
 */

/**
 * @param {string | undefined} pageState
 * @param {(page: unknown, context: Record<string, unknown>) => Promise<void> | void | undefined} stateAdapter
 */
export function validateCapturePageState(pageState, stateAdapter) {
  const normalized = String(pageState || DEFAULT_PAGE_STATE);
  if (normalized === DEFAULT_PAGE_STATE) {
    return;
  }
  if (typeof stateAdapter === 'function') {
    return;
  }
  throw new CorpusToolingError(
    CORPUS_TOOLING_ERROR_CODES.UNSUPPORTED_PAGE_STATE,
    `Unsupported page state "${normalized}" without stateAdapter`,
    { pageState: normalized },
  );
}

/**
 * @param {CaptureRequest} request
 * @returns {Promise<Record<string, unknown>>}
 */
export async function captureStableSnapshot(request) {
  if (!request || typeof request.captureAdapter !== 'function') {
    throw new CorpusToolingError(
      CORPUS_TOOLING_ERROR_CODES.INCOMPLETE_REPORT,
      'captureAdapter is required',
    );
  }

  validateCapturePageState(request.captureState, request.stateAdapter);

  /** @type {Record<string, unknown>[]} */
  const captures = [];
  for (let index = 0; index < REQUIRED_CAPTURE_COUNT; index += 1) {
    const snapshot = await request.captureAdapter({
      attempt: index + 1,
      url: request.url,
      route: request.route,
      captureState: request.captureState || DEFAULT_PAGE_STATE,
      viewport: request.viewport,
      stateAdapter: request.stateAdapter,
    });
    if (!snapshot || typeof snapshot !== 'object') {
      throw new CorpusToolingError(
        CORPUS_TOOLING_ERROR_CODES.INCOMPLETE_REPORT,
        `Capture attempt ${index + 1} returned invalid snapshot`,
      );
    }
    captures.push(snapshot);
  }

  for (let index = 1; index < captures.length; index += 1) {
    if (!snapshotsSemanticallyEqual(captures[0], captures[index])) {
      throw new CorpusToolingError(
        CORPUS_TOOLING_ERROR_CODES.UNSTABLE_CAPTURE,
        'Repeated captures are not semantically stable',
        { attempts: captures.length },
      );
    }
  }

  return captures[0];
}

/**
 * @param {Record<string, unknown>} snapshot
 * @returns {Record<string, unknown>}
 */
export function normalizeCapturedSnapshot(snapshot = {}) {
  return {
    schemaVersion: CORPUS_SCHEMA_VERSION,
    elements: Array.isArray(snapshot.elements) ? snapshot.elements : [],
    diagnostics: Array.isArray(snapshot.diagnostics) ? snapshot.diagnostics : [],
    counts: snapshot.counts && typeof snapshot.counts === 'object'
      ? {
        frameCount: Number(snapshot.counts.frameCount || 0),
        shadowRootCount: Number(snapshot.counts.shadowRootCount || 0),
        closedShadowCount: Number(snapshot.counts.closedShadowCount || 0),
      }
      : { frameCount: 0, shadowRootCount: 0, closedShadowCount: 0 },
  };
}

/**
 * @param {import('playwright').Page} page
 * @param {{
 *   url?: string,
 *   viewport?: { width: number, height: number },
 *   captureState?: string,
 *   stateAdapter?: (page: import('playwright').Page, context: Record<string, unknown>) => Promise<void>,
 *   stabilityQuietMs?: number,
 *   stabilityTimeoutMs?: number,
 *   stabilityMinObserveMs?: number,
 * }=} options
 */
export async function captureLiveSnapshot(page, options = {}) {
  if (options.viewport) {
    await page.setViewportSize({
      width: options.viewport.width,
      height: options.viewport.height,
    });
  }

  const captureContext = {
    captureState: options.captureState || DEFAULT_PAGE_STATE,
    viewport: options.viewport,
    stateAdapter: options.stateAdapter,
  };
  validateCapturePageState(captureContext.captureState, options.stateAdapter);
  if (typeof options.stateAdapter === 'function') {
    await options.stateAdapter(page, captureContext);
  }

  const { createScanSession } = await import('../../../src/scanner/access-scan/runtime/session.js');
  const session = await createScanSession(page, {
    url: options.url,
    stabilityQuietMs: options.stabilityQuietMs,
    stabilityTimeoutMs: options.stabilityTimeoutMs,
    stabilityMinObserveMs: options.stabilityMinObserveMs,
  });
  return normalizeCapturedSnapshot(session.snapshot);
}

/**
 * @param {import('playwright').Page} page
 * @param {{
 *   url?: string,
 *   route?: string,
 *   captureState?: string,
 *   viewport?: { width: number, height: number },
 *   stateAdapter?: (page: import('playwright').Page, context: Record<string, unknown>) => Promise<void>,
 *   stabilityQuietMs?: number,
 *   stabilityTimeoutMs?: number,
 *   stabilityMinObserveMs?: number,
 * }=} options
 */
export async function captureLiveStableSnapshot(page, options = {}) {
  return captureStableSnapshot({
    url: options.url,
    route: options.route,
    captureState: options.captureState,
    viewport: options.viewport,
    stateAdapter: options.stateAdapter,
    captureAdapter: async (context) => captureLiveSnapshot(page, {
      url: options.url,
      viewport: context.viewport,
      captureState: context.captureState,
      stateAdapter: options.stateAdapter,
      stabilityQuietMs: options.stabilityQuietMs,
      stabilityTimeoutMs: options.stabilityTimeoutMs,
      stabilityMinObserveMs: options.stabilityMinObserveMs,
    }),
  });
}
