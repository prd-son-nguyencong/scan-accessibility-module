const DEFAULT_MAX_STEPS = 32;
const DEFAULT_STEP_RATIO = 0.65;
const DEFAULT_STEP_DELAY_MS = 100;
const DEFAULT_SETTLE_MS = 500;

/**
 * Bounded, selector-free page activation for lazy content and viewport-triggered
 * animations. Every reachable frame is scrolled and restored independently.
 *
 * @param {import('playwright').Page} page
 * @param {{
 *   maxSteps?: number,
 *   stepRatio?: number,
 *   stepDelayMs?: number,
 *   settleMs?: number,
 * }=} options
 */
export async function activateDynamicContent(page, options = {}) {
  const settings = {
    maxSteps: options.maxSteps ?? DEFAULT_MAX_STEPS,
    stepRatio: options.stepRatio ?? DEFAULT_STEP_RATIO,
    stepDelayMs: options.stepDelayMs ?? DEFAULT_STEP_DELAY_MS,
    settleMs: options.settleMs ?? DEFAULT_SETTLE_MS,
  };

  let frameCount = 0;
  let scrollCount = 0;

  for (const frame of page.frames()) {
    try {
      const result = await frame.evaluate(async (activation) => {
        const root = document.scrollingElement || document.documentElement;
        if (!root) return { activated: false, scrollCount: 0 };

        const viewportHeight = Math.max(window.innerHeight || 0, 1);
        const originalX = window.scrollX;
        const originalY = window.scrollY;
        const initialHeight = Math.max(root.scrollHeight, document.body?.scrollHeight || 0);
        if (initialHeight <= viewportHeight + 1) {
          return { activated: false, scrollCount: 0 };
        }

        const sleep = (milliseconds) => new Promise((resolve) => {
          setTimeout(resolve, milliseconds);
        });
        const scrollInstantly = (top) => {
          try {
            window.scrollTo({ left: originalX, top, behavior: 'instant' });
          } catch {
            window.scrollTo(originalX, top);
          }
        };

        if (document.fonts?.ready) {
          await Promise.race([
            document.fonts.ready,
            sleep(1000),
          ]).catch(() => {});
        }

        const stepSize = Math.max(320, Math.floor(viewportHeight * activation.stepRatio));
        let steps = 0;
        let position = 0;
        scrollInstantly(0);

        while (steps < activation.maxSteps) {
          const currentHeight = Math.max(root.scrollHeight, document.body?.scrollHeight || 0);
          const maxScroll = Math.max(0, currentHeight - viewportHeight);
          if (position >= maxScroll) break;
          position = Math.min(maxScroll, position + stepSize);
          scrollInstantly(position);
          steps += 1;
          await sleep(activation.stepDelayMs);
        }

        const finalHeight = Math.max(root.scrollHeight, document.body?.scrollHeight || 0);
        scrollInstantly(Math.max(0, finalHeight - viewportHeight));
        await sleep(activation.settleMs);
        scrollInstantly(originalY);
        await sleep(activation.settleMs);

        return { activated: true, scrollCount: steps + 2 };
      }, settings);

      if (result.activated) frameCount += 1;
      scrollCount += result.scrollCount;
    } catch {
      // Detached, sandboxed, and cross-process frames are diagnostic-only;
      // activation failure must not abort the scan.
    }
  }

  return Object.freeze({ frameCount, scrollCount });
}
