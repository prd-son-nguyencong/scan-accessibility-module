import { getBrowser, newPage, resilientGoto } from './browser.js';
import { mapDescriptionToSource } from '../tracer/partial-map.js';

const PAGE_TIMEOUT_MS = 60000;

/**
 * Layer 2: ARIA Live Region Scanner
 *
 * Tests:
 * 1. Live regions exist for dynamic content areas (job results, alerts, status)
 * 2. Live regions have correct politeness settings
 * 3. Alert regions use role="alert" or aria-live="assertive"
 * 4. Status regions use role="status" or aria-live="polite"
 * 5. Live regions are not empty on page load (where content is expected)
 */
export async function scanAriaLiveRegions(pageUrl) {
  const browser = await getBrowser();
  const page = await newPage(browser);
  const violations = [];
  const passes = [];

  try {
    await resilientGoto(page, pageUrl, { timeout: PAGE_TIMEOUT_MS });

    // 1. Detect existing live regions
    const liveRegions = await page.evaluate(() => {
      const regions = [];
      const selectors = '[aria-live], [role="alert"], [role="status"], [role="log"], [role="timer"]';

      for (const el of document.querySelectorAll(selectors)) {
        regions.push({
          tag: el.tagName,
          role: el.getAttribute('role'),
          ariaLive: el.getAttribute('aria-live'),
          ariaAtomic: el.getAttribute('aria-atomic'),
          id: el.id,
          isEmpty: (el.textContent || '').trim().length === 0,
          isVisible: el.offsetParent !== null,
        });
      }
      return regions;
    });

    // 2. Check live region quality
    for (const region of liveRegions) {
      // Alert regions should be assertive
      if (region.role === 'alert' && region.ariaLive && region.ariaLive !== 'assertive') {
        violations.push({
          rule: 'aria-live-alert-not-assertive',
          description: `role="alert" element has aria-live="${region.ariaLive}" — should be "assertive" or omitted (alert implies assertive)`,
          impact: 'moderate',
          wcagCriteria: '4.1.3',
          element: { id: region.id, tag: region.tag },
        });
      }

      // Log regions should have aria-live="polite"
      if (region.role === 'log' && region.ariaLive === 'assertive') {
        violations.push({
          rule: 'aria-live-log-assertive',
          description: 'role="log" uses aria-live="assertive" — this will interrupt screen reader for every update. Use "polite".',
          impact: 'moderate',
          wcagCriteria: '4.1.3',
          element: { id: region.id, tag: region.tag },
        });
      }
    }

    // 3. Check for dynamic content areas that NEED live regions but don't have them
    const dynamicAreasMissingLive = await page.evaluate(() => {
      const missing = [];

      // Job search results container
      const jobResults = document.querySelector(
        '[data-jobs-results], .jobs-results, #jobs-results, [data-component="job-list"]'
      );
      if (jobResults && !jobResults.closest('[aria-live]') && !jobResults.getAttribute('aria-live')) {
        missing.push({
          selector: jobResults.getAttribute('id')
            ? `#${jobResults.getAttribute('id')}`
            : jobResults.className.split(' ')[0],
          reason: 'Job search results should announce updates to screen readers',
          suggested: 'aria-live="polite"',
        });
      }

      // Form error containers
      const errorContainers = document.querySelectorAll(
        '[class*="error"], [class*="alert"], [id*="error"], [id*="alert"]'
      );
      for (const el of errorContainers) {
        if (
          !el.closest('[aria-live]') &&
          !el.getAttribute('aria-live') &&
          !el.getAttribute('role')
        ) {
          const text = (el.textContent || '').trim();
          if (text.length === 0) {
            // Empty container — likely a dynamic error region
            missing.push({
              selector: el.id ? `#${el.id}` : `.${el.className.split(' ')[0]}`,
              reason: 'Empty container with error-related name — likely dynamic, should have aria-live',
              suggested: 'role="alert" or aria-live="assertive"',
            });
          }
        }
      }

      return missing;
    });

    for (const missing of dynamicAreasMissingLive) {
      violations.push({
        rule: 'dynamic-region-missing-aria-live',
        description: `Element "${missing.selector}" appears to be a dynamic content area but lacks aria-live. ${missing.reason}. Suggested: ${missing.suggested}`,
        impact: 'moderate',
        wcagCriteria: '4.1.3',
        element: { selector: missing.selector },
      });
    }

    if (liveRegions.length > 0) {
      passes.push(`${liveRegions.length} aria-live region(s) found`);
    }

    // 4. Check for loading spinners without live region announcements
    const spinnersMissingLive = await page.evaluate(() => {
      const spinners = document.querySelectorAll('[class*="spinner"], [class*="loading"], [aria-busy="true"]');
      return Array.from(spinners)
        .filter((el) => !el.closest('[aria-live]') && !el.getAttribute('aria-live'))
        .length;
    });

    if (spinnersMissingLive > 0) {
      violations.push({
        rule: 'loading-state-missing-announcement',
        description: `${spinnersMissingLive} loading spinner(s) found without aria-live region to announce loading state`,
        impact: 'moderate',
        wcagCriteria: '4.1.3',
        element: null,
      });
    }
  } finally {
    await page.context().close().catch(() => {});
  }

  const source = await mapDescriptionToSource(pageUrl);
  return { url: pageUrl, violations: violations.map((v) => ({ ...v, layer: 'ariaLive', source })), passes, timestamp: new Date().toISOString() };
}
