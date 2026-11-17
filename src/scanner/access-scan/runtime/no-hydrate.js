/**
 * Keep local ↔ remote accessScan comparisons fair by preventing Paradox
 * jobs/search/chat widgets from hydrating, then normalizing leftover chrome.
 *
 * Network blocking alone is not enough: staging still leaves empty
 * `main.c-jobs__main` landmarks and entrance-animation inline styles that
 * local Vite builds do not emit the same way.
 */

export const NO_HYDRATE_JOBS_REQUEST_RE = new RegExp([
  String.raw`(?:^|/)job-list\.(?:js|css)(?:\?|$)`,
  String.raw`(?:^|/)jobs-[^/]*\.bundle\.js(?:\?|$)`,
  String.raw`(?:^|/)(?:apply-widget|chat-widget)`,
  String.raw`olivia`,
].join('|'), 'i');

/**
 * @param {import('playwright').Page} page
 * @returns {Promise<void>}
 */
export async function installNoHydrateJobsRoutes(page) {
  await page.route('**/*', (route) => {
    const url = route.request().url();
    if (NO_HYDRATE_JOBS_REQUEST_RE.test(url)) {
      return route.abort();
    }
    return route.continue();
  });
}

/**
 * Strip hydrated (or half-hydrated) jobs/chat chrome and settle entrance
 * animations so both local and remote shells share the same landmark tree.
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<{
 *   mountsCleared: number,
 *   jobsChromeRemoved: number,
 *   widgetsRemoved: number,
 *   animationsReset: number,
 * }>}
 */
export async function stripNoHydrateJobsDom(page) {
  return page.evaluate(() => {
    let mountsCleared = 0;
    let jobsChromeRemoved = 0;
    let widgetsRemoved = 0;
    let animationsReset = 0;

    for (const el of document.querySelectorAll('[data-react-component], [data-component]')) {
      el.innerHTML = '';
      mountsCleared += 1;
    }

    const jobsSelectors = [
      'main.c-jobs__main',
      '.c-jobs',
      '.c-jobs__page-header',
      '.c-jobs__layout',
      '.c-jobs-search-wrap',
      '.jobs-search',
      '.jobs-list',
      '.jobs-list-only',
      '.jobs-pagination',
      '.jobs-filter',
      '.jobs-sort-by',
      '.jobs-current-searches',
      '.jobs-list-header',
      '.jobs-current-location',
      '.jobs-radius',
    ];
    for (const selector of jobsSelectors) {
      for (const el of document.querySelectorAll(selector)) {
        el.remove();
        jobsChromeRemoved += 1;
      }
    }

    for (const el of document.querySelectorAll(
      'apply-widget, #chat-widget, [data-testid^="olivia"], .oliviaButton',
    )) {
      el.remove();
      widgetsRemoved += 1;
    }

    for (const el of document.querySelectorAll('.blur-in-item, [data-scroll], [data-scroll-class]')) {
      el.classList.remove('blur-in-item');
      if (el.hasAttribute('style')) {
        el.removeAttribute('style');
        animationsReset += 1;
      }
    }

    return {
      mountsCleared,
      jobsChromeRemoved,
      widgetsRemoved,
      animationsReset,
    };
  });
}

/**
 * @param {import('playwright').Page} page
 * @returns {Promise<{
 *   mountsCleared: number,
 *   jobsChromeRemoved: number,
 *   widgetsRemoved: number,
 *   animationsReset: number,
 * }>}
 */
export async function prepareNoHydrateJobsPage(page) {
  return stripNoHydrateJobsDom(page);
}
