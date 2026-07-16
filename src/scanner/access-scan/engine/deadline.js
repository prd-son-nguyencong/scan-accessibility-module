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
