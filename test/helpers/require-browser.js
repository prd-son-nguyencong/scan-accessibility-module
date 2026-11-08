import { getBrowser } from '../../src/scanner/browser.js';

/**
 * Launches the shared browser, or skips the test with a reason when none is
 * available locally. Under CI a missing browser is a failure, not a skip.
 * @returns {Promise<import('playwright').Browser | null>} null when skipped
 */
export async function requireBrowser(t) {
  try {
    return await getBrowser();
  } catch (error) {
    if (process.env.CI) throw error;
    t.skip(`Playwright browser unavailable: ${error.message}`);
    return null;
  }
}
