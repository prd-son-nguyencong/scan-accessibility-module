import { AsyncLocalStorage } from 'node:async_hooks';
import { withTimeout } from './with-timeout.js';

// A scope is the work one scan (or one layer of it) has started. withTimeout and node:test timeouts only abandon work; a
// cancelled scope also closes the contexts that work opened and refuses to open new ones (or to relaunch Chromium after
// closeBrowser), so abandoned work cannot keep driving a page or leave a browser that holds the process open.
const als = new AsyncLocalStorage();
const live = new Set();
const CLOSE_MS = 10_000;

const isCancelled = (s) => !!s && (s.cancelled || isCancelled(s.parent));
const cancelledError = () => Object.assign(new Error('scan scope cancelled'), { name: 'CancelledError' });

export function runInScope(fn) {
  const scope = { cancelled: false, contexts: new Set(), parent: als.getStore() };
  live.add(scope);
  return als.run(scope, async () => {
    try { return await fn(scope); } finally { live.delete(scope); }
  });
}

/** Throws inside a cancelled scope; a no-op outside any scope. */
export function assertNotCancelled() {
  if (isCancelled(als.getStore())) throw cancelledError();
}

/** Remembers a context opened by the current scope so a cancel can close it; a late one in a cancelled scope is closed at once. */
export function trackContext(context) {
  const scope = als.getStore();
  if (!scope) return;
  if (isCancelled(scope)) {
    context.close().catch(() => {});
    throw cancelledError();
  }
  scope.contexts.add(context);
  // shortcut: a context that closes itself stays in the set until the scope ends; closing it again is a no-op
}

export async function cancelScope(scope, ms = CLOSE_MS) {
  scope.cancelled = true;
  const contexts = [...scope.contexts];
  scope.contexts.clear();
  await Promise.all(contexts.map((c) => withTimeout(c.close(), ms, 'context.close').catch(() => {})));
}

/** closeBrowser: everything still running must stop starting browser work. */
export function cancelAllScopes() {
  for (const s of live) s.cancelled = true;
}

/** Runs `work` in its own scope with a hard deadline; on the deadline it is cancelled (its contexts closed) before the TimeoutError propagates. */
export function runBounded(work, ms, label) {
  return runInScope((scope) => withTimeout(work(), ms, label).catch(async (err) => {
    if (err.name === 'TimeoutError') await cancelScope(scope);
    throw err;
  }));
}
