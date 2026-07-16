import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getBrowser, closeBrowser } from '../src/scanner/browser.js';
import {
  createFixturePage,
  scanFixtureWithAccessScan,
} from './helpers/access-scan-contract.js';

test('production engine detects missing tablist semantics on roleless tab interfaces', async (t) => {
  let browser;
  try {
    browser = await getBrowser();
  } catch (error) {
    t.skip(`Playwright browser unavailable: ${error.message}`);
    return;
  }

  try {
    const page = await createFixturePage(browser, `
      <div class="tabs">
        <button id="tab-one" role="tab" aria-selected="true" aria-controls="panel-one">One</button>
        <button id="tab-two" role="tab" aria-selected="false" aria-controls="panel-two">Two</button>
        <div id="panel-one">One panel</div>
        <div id="panel-two">Two panel</div>
      </div>
    `);
    try {
      const violations = await scanFixtureWithAccessScan(page, 'fixture://tabs', {
        skipRules: ['HtmlLang', 'MetaDescription', 'MetaViewportPresent', 'PageTitleDescriptive', 'PageTitle'],
      });
      assert.ok(violations.some(({ ruleId }) => ruleId === 'TablistRole'));
      assert.ok(violations.some(({ ruleId }) => ruleId === 'TabPanelMismatch'));
    } finally {
      await page.context().close();
    }
  } finally {
    await closeBrowser();
  }
});

test('production engine ignores accordion and listbox widgets when scanning tabs', async (t) => {
  let browser;
  try {
    browser = await getBrowser();
  } catch (error) {
    t.skip(`Playwright browser unavailable: ${error.message}`);
    return;
  }

  try {
    const accordion = await createFixturePage(browser, `
      <div class="accordion">
        <button aria-expanded="true" aria-controls="section-one">One</button>
        <button aria-expanded="false" aria-controls="section-two">Two</button>
        <div id="section-one">One section</div>
        <div id="section-two">Two section</div>
      </div>
    `);
    try {
      const violations = await scanFixtureWithAccessScan(accordion, 'fixture://accordion', {
        skipRules: ['HtmlLang', 'MetaDescription', 'MetaViewportPresent', 'PageTitleDescriptive', 'PageTitle'],
      });
      assert.equal(violations.some(({ ruleId }) => ruleId.startsWith('Tab')), false);
    } finally {
      await accordion.context().close();
    }

    const listbox = await createFixturePage(browser, `
      <div class="tabs-sort">
        <button aria-haspopup="listbox" aria-controls="options">Sort</button>
        <ul id="options" role="listbox"><li role="option">Date</li></ul>
      </div>
    `);
    try {
      const violations = await scanFixtureWithAccessScan(listbox, 'fixture://listbox', {
        skipRules: ['HtmlLang', 'MetaDescription', 'MetaViewportPresent', 'PageTitleDescriptive', 'PageTitle'],
      });
      assert.equal(violations.some(({ ruleId }) => ruleId.startsWith('Tab')), false);
    } finally {
      await listbox.context().close();
    }
  } finally {
    await closeBrowser();
  }
});
