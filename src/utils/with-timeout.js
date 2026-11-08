/**
 * Rejects with a TimeoutError when `work` has not settled after `ms`. Playwright calls that go straight to the
 * browser (newContext, context.close, page.title, page.evaluate) carry no timeout of their own, so a wedged
 * Chromium would otherwise hold the awaiting scan forever. The losing `work` is not cancelled, only abandoned.
 */
export function withTimeout(work, ms, label) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(`${label} timed out after ${ms}ms`), { name: 'TimeoutError' })), ms);
  });
  return Promise.race([Promise.resolve(work), deadline]).finally(() => clearTimeout(timer));
}
