import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getBrowser, closeBrowser } from '../src/scanner/browser.js';
import {
  createFixturePage,
  scanFixtureWithAccessScan,
} from './helpers/access-scan-contract.js';

test('production engine flags nested main landmarks and empty main misuse', async (t) => {
  let browser;
  try {
    browser = await getBrowser();
  } catch (error) {
    t.skip(`Playwright browser unavailable: ${error.message}`);
    return;
  }

  try {
    const page = await createFixturePage(browser, `
      <main>
        <h1>Outer</h1>
        <main id="inner-main">
          <h2>Inner</h2>
          <p>Nested primary content.</p>
        </main>
      </main>
    `);
    try {
      const violations = await scanFixtureWithAccessScan(page, 'fixture://landmarks', {
        skipRules: ['HtmlLang', 'MetaDescription', 'MetaViewportPresent', 'PageTitleDescriptive', 'PageTitle'],
      });
      const mainRules = violations
        .filter(({ ruleId }) => ruleId.startsWith('RegionMainContent'))
        .map(({ ruleId }) => ruleId)
        .sort();
      assert.deepEqual(mainRules, ['RegionMainContentMisuse', 'RegionMainContentSingle'].sort());
    } finally {
      await page.context().close();
    }
  } finally {
    await closeBrowser();
  }
});

test('production engine preserves empty-main detection semantics', async (t) => {
  let browser;
  try {
    browser = await getBrowser();
  } catch (error) {
    t.skip(`Playwright browser unavailable: ${error.message}`);
    return;
  }

  try {
    const page = await createFixturePage(browser, `
      <main id="empty-main"></main>
    `);
    try {
      const violations = await scanFixtureWithAccessScan(page, 'fixture://empty-main', {
        skipRules: ['HtmlLang', 'MetaDescription', 'MetaViewportPresent', 'PageTitleDescriptive', 'PageTitle'],
      });
      assert.ok(violations.some(({ ruleId }) => ruleId === 'RegionMainContentMisuse'));
    } finally {
      await page.context().close();
    }
  } finally {
    await closeBrowser();
  }
});
