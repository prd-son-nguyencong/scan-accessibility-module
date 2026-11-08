import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closeBrowser } from '../src/scanner/browser.js';
import { requireBrowser } from './helpers/require-browser.js';
import {
  createFixturePage,
  scanFixtureWithAccessScan,
} from './helpers/access-scan-contract.js';

test('production engine flags nested main landmarks and empty main misuse', async (t) => {
  const browser = await requireBrowser(t);
  if (!browser) return;

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
  const browser = await requireBrowser(t);
  if (!browser) return;

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

test('a main whose only content is screen-reader-only text is still thin content', async (t) => {
  const browser = await requireBrowser(t);
  if (!browser) return;

  try {
    const srOnly = 'position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0';
    const page = await createFixturePage(browser, `
      <main id="sr-main"><h1 style="${srOnly}">Careers at our company</h1><p style="${srOnly}">Find open roles and apply to join the team today</p></main>
    `);
    try {
      const violations = await scanFixtureWithAccessScan(page, 'fixture://sr-main', {
        skipRules: ['HtmlLang', 'MetaDescription', 'MetaViewportPresent', 'PageTitleDescriptive', 'PageTitle'],
      });
      assert.ok(violations.some(({ ruleId }) => ruleId === 'RegionMainContentMisuse'), 'sr-only heading and text do not make the main substantial');
    } finally {
      await page.context().close();
    }
    const visible = await createFixturePage(browser, `
      <main id="vis-main"><h1>Careers at our company</h1></main>
    `);
    try {
      const violations = await scanFixtureWithAccessScan(visible, 'fixture://vis-main', {
        skipRules: ['HtmlLang', 'MetaDescription', 'MetaViewportPresent', 'PageTitleDescriptive', 'PageTitle'],
      });
      assert.ok(!violations.some(({ ruleId }) => ruleId === 'RegionMainContentMisuse'), 'a visible heading still counts');
    } finally {
      await visible.context().close();
    }
  } finally {
    await closeBrowser();
  }
});
