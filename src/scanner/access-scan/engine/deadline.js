import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * @typedef {'rule_timeout' | 'scan_cancelled'} DeadlineReason
 */

/**
 * @param {{
 *   timeoutMs: number,
 *   parentSignal?: AbortSignal,
 * }} options
 */
export function createRuleDeadline({ timeoutMs, parentSignal }) {
  const combinedController = new AbortController();
  /** @type {DeadlineReason | null} */
  let reason = null;

  const abortCombined = (nextReason) => {
    if (combinedController.signal.aborted) return;
    reason = nextReason;
    combinedController.abort();
  };

  const expiresAt = Date.now() + timeoutMs;
  const timer = setTimeout(() => abortCombined('rule_timeout'), timeoutMs);

  const onParentAbort = () => abortCombined('scan_cancelled');
  if (parentSignal) {
    if (parentSignal.aborted) {
      onParentAbort();
    } else {
      parentSignal.addEventListener('abort', onParentAbort, { once: true });
    }
  }

  return {
    signal: combinedController.signal,

    /**
     * Cooperative check for synchronous loops, where the timer cannot fire: compares the clock itself.
     * Throws the same error `run` rejects with.
     */
    check() {
      if (!combinedController.signal.aborted && Date.now() >= expiresAt) abortCombined('rule_timeout');
      if (combinedController.signal.aborted) {
        throw Object.assign(new DOMException('Aborted', 'AbortError'), { errorCode: reason || 'rule_timeout' });
      }
    },

    /**
     * Runs an evaluator promise under the combined deadline and contains late rejections.
     *
     * @template T
     * @param {Promise<T>} evaluatePromise
     * @returns {Promise<T>}
     */
    async run(evaluatePromise) {
      let settled = false;

      const contained = new Promise((resolve, reject) => {
        Promise.resolve(evaluatePromise).then(
          (value) => {
            if (!settled) {
              settled = true;
              resolve(value);
            }
          },
          (error) => {
            if (!settled) {
              settled = true;
              reject(error);
            }
          },
        );
      });

      const abortPromise = new Promise((_, reject) => {
        combinedController.signal.addEventListener('abort', () => {
          settled = true;
          const errorCode = reason
            || (parentSignal?.aborted ? 'scan_cancelled' : 'rule_timeout');
          reject(Object.assign(new DOMException('Aborted', 'AbortError'), { errorCode }));
        }, { once: true });
      });

      try {
        return await Promise.race([contained, abortPromise]);
      } finally {
        clearTimeout(timer);
        parentSignal?.removeEventListener('abort', onParentAbort);
      }
    },
  };
}

/** Deadline of the check currently being evaluated, visible to the hot loops without threading it through every signature. */
export const deadlineStorage = new AsyncLocalStorage();

// shortcut: only loops that call checkDeadline/withDeadline can be interrupted; one long non-yielding
// loop still runs to its end. Upgrade to a worker per evaluator (plan task 3.5) if that bites.
export function checkDeadline() {
  deadlineStorage.getStore()?.check();
}

/**
 * Iterates `items`, checking the active deadline every 64 items.
 * @template T
 * @param {Iterable<T>} items
 * @returns {Generator<T>}
 */
export function* withDeadline(items) {
  let n = 0;
  for (const item of items) {
    if ((n++ & 63) === 0) checkDeadline();
    yield item;
  }
}
