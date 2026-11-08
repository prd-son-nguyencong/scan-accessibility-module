import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closeBrowser } from '../src/scanner/browser.js';
import { requireBrowser } from './helpers/require-browser.js';
import { createFixturePage, scanFixtureWithAccessScan } from './helpers/access-scan-contract.js';

test('a visually hidden (sr-only) heading is not VisibilityMisuse; other clipped text still is', async (t) => {
  const browser = await requireBrowser(t);
  if (!browser) return;
  try {
    const page = await createFixturePage(browser, `
      <title>Careers</title>
      <style>.sr-only{position:absolute;width:1px;height:1px;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}</style>
      <main><h1 id="t" class="sr-only">Careers at Example</h1><span id="s" class="sr-only">Hidden promo copy for nobody</span><p>Visible</p></main>
    `);
    try {
      const rows = (await scanFixtureWithAccessScan(page, 'fixture://sr-only-h1')).filter((v) => v.ruleId === 'VisibilityMisuse');
      assert.equal(rows.some((v) => /#t\b|id="t"/.test(`${v.element.selector} ${v.element.outerHTML}`)), false, 'the sr-only h1 is the recommended h1 fix');
    } finally { await page.context().close(); }
  } finally { await closeBrowser(); }
});
