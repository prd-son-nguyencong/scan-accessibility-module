import { chromium } from 'playwright';

let browser = null;

export async function getBrowser() {
  if (!browser) {
    browser = await chromium.launch({ headless: true });
  }
  return browser;
}

export async function newPage(browserInstance, options = {}) {
  const context = await browserInstance.newContext({
    viewport: options.viewport || { width: 1280, height: 900 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 ADA-Scanner/1.0',
  });
  const page = await context.newPage();
  // Suppress console noise from the scanned page
  page.on('console', () => {});
  page.on('pageerror', () => {});
  return page;
}

/**
 * Navigate to a URL with a resilient fallback strategy.
 * Tries networkidle first; if it times out, falls back to domcontentloaded
 * + a settle delay. Remote sites with chat widgets, analytics, or
 * long-polling connections rarely reach networkidle.
 */
export async function resilientGoto(page, url, { timeout = 60000 } = {}) {
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout });
  } catch (err) {
    if (err.message?.includes('Timeout')) {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
      await page.waitForTimeout(3000);
    } else {
      throw err;
    }
  }
}

export async function closeBrowser() {
  if (browser) {
    await browser.close();
    browser = null;
  }
}
