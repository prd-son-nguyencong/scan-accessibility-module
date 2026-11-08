// Scripts that did not load during a scan (offline CDN, blocked host, 4xx/5xx): behaviour they would add (a focus trap, a carousel) was not
// present when a layer measured the page, so a behavioural finding on that page is a question, not a failure.
const MAX_RECORDED = 20;
const tracked = new WeakMap();

/** Starts recording failed script requests of `page` (once per page). */
export function trackBlockedScripts(page) {
  if (tracked.has(page) || typeof page.on !== 'function') return;
  const list = [];
  tracked.set(page, list);
  const add = (url, reason) => { if (list.length < MAX_RECORDED && !list.some((s) => s.url === url)) list.push({ url, reason }); };
  page.on('requestfailed', (req) => { if (req.resourceType() === 'script') add(req.url(), req.failure()?.errorText || 'request failed'); });
  page.on('response', (res) => { if (res.status() >= 400 && res.request().resourceType() === 'script') add(res.url(), `HTTP ${res.status()}`); });
}

/** Scripts that failed to load on `page` so far: [{ url, reason }]. */
export const blockedScriptsOf = (page) => [...(tracked.get(page) || [])];

/** Behavioural rules whose result depends on a page script that may not have loaded. */
export const SCRIPT_DEPENDENT_RULES = new Set(['modal-focus-not-trapped', 'modal-focus-escapes', 'accordion-aria-expanded-not-updated']);
export const isScriptDependentRule = (ruleId) => SCRIPT_DEPENDENT_RULES.has(ruleId) || /^carousel-/.test(ruleId || '');
