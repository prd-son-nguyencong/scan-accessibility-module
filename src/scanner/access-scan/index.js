import { scanGeneral } from './01-general.js';
import { scanInteractive } from './02-interactive.js';
import { scanForms } from './03-forms.js';
import { scanLandmarks } from './04-landmarks.js';
import { scanGraphics } from './05-graphics.js';
import { scanDragging } from './06-dragging.js';
import { scanAria } from './07-aria.js';
import { scanLists } from './08-lists.js';
import { scanMetadata } from './09-metadata.js';
import { scanTabs } from './10-tabs.js';
import { scanTables } from './11-tables.js';

const CATEGORIES = [
  { name: 'general', fn: scanGeneral },
  { name: 'interactive', fn: scanInteractive },
  { name: 'forms', fn: scanForms },
  { name: 'landmarks', fn: scanLandmarks },
  { name: 'graphics', fn: scanGraphics },
  { name: 'dragging', fn: scanDragging },
  { name: 'aria', fn: scanAria },
  { name: 'lists', fn: scanLists },
  { name: 'metadata', fn: scanMetadata },
  { name: 'tabs', fn: scanTabs },
  { name: 'tables', fn: scanTables },
];

/**
 * Injects a global cssPath helper into the page context so all
 * browser-side evaluate/$$eval callbacks can generate CSS selectors.
 */
async function injectCssPath(page) {
  await page.addInitScript(() => {
    if (typeof window.cssPath === 'function') return;
    window.cssPath = function cssPath(el) {
      if (!el || el === document.body) return 'body';
      if (el.id) return '#' + el.id;
      const parts = [];
      let cur = el;
      while (cur && cur !== document.body) {
        let seg = cur.nodeName.toLowerCase();
        const siblings = Array.from(cur.parentElement?.children || []).filter(
          (s) => s.nodeName === cur.nodeName
        );
        if (siblings.length > 1) seg += ':nth-of-type(' + (siblings.indexOf(cur) + 1) + ')';
        parts.unshift(seg);
        cur = cur.parentElement;
      }
      return parts.join(' > ').slice(0, 200);
    };
  });
}

/**
 * Runs all 11 accessScan category checks against a Playwright page.
 * Returns a flat Violation[] array (shared schema).
 */
export async function scanWithAccessScan(page, url, options = {}) {
  await injectCssPath(page);
  // Re-navigate so addInitScript takes effect on the current page
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
  } catch (err) {
    if (err.message?.includes('Timeout')) {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(3000);
    } else {
      throw err;
    }
  }

  // Strip Vite dev overlay and error overlay elements before scanning —
  // they inject <a class="file-link"> and other DOM that produces false positives
  await page.evaluate(() => {
    document.querySelectorAll('vite-error-overlay, [data-vite-dev-id], .file-link').forEach((el) => el.remove());
    const overlays = document.querySelectorAll('div');
    overlays.forEach((el) => {
      if (el.shadowRoot) {
        const inner = el.shadowRoot.querySelector('.backdrop, .window');
        if (inner) el.remove();
      }
    });
  }).catch(() => {});

  // Wait for dynamically-loaded third-party widgets (Paradox job list, search, chat)
  // to render before scanning — these inject DOM via client-side JS after page load
  const isRemote = url.startsWith('http') && !url.includes('localhost') && !url.includes('127.0.0.1');
  if (isRemote) {
    await page.waitForSelector('[data-testid]', { timeout: 5000 }).catch(() => {});
  }

  const violations = [];
  const skipRules = new Set(options.skipRules || []);

  const catOptions = { includeThirdParty: options.includeThirdParty ?? false };

  for (const cat of CATEGORIES) {
    try {
      const catViolations = await cat.fn(page, url, catOptions);
      for (const v of catViolations) {
        if (!skipRules.has(v.ruleId)) violations.push(v);
      }
    } catch (err) {
      console.error(`  accessScan/${cat.name}: ${err.message}`);
    }
  }

  return violations;
}
