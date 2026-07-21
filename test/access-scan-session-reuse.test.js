import { test } from 'node:test';
import assert from 'node:assert/strict';

import { chromium } from 'playwright';
import { getSharedBuiltInRuleRegistry } from '../src/scanner/access-scan/engine/builtin-registry.js';
import { scanWithAccessScan } from '../src/scanner/access-scan/index.js';
import { createScanSession } from '../src/scanner/access-scan/runtime/index.js';

test('scanWithAccessScan reuses provided session without creating a second snapshot session', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<!doctype html><html><body><main><ul id="captured-empty"></ul></main></body></html>');
    const session = await createScanSession(page);

    await page.setContent(`
      <!doctype html>
      <html><body><main><ul id="live-populated"><li>Ready</li></ul></main></body></html>
    `);

    const registry = await getSharedBuiltInRuleRegistry();
    const skipRules = registry.getActiveRuleIds().filter((ruleId) => ruleId !== 'ListEmpty');
    const violations = await scanWithAccessScan(page, 'about:blank', {
      profile: 'standards',
      session,
      skipNavigation: true,
      activateContent: false,
      skipRules,
    });

    const listEmpty = violations.find((violation) => violation.ruleId === 'ListEmpty');
    assert.ok(listEmpty);
    assert.match(listEmpty.element.outerHTML, /captured-empty/);
    assert.doesNotMatch(listEmpty.element.outerHTML, /live-populated/);
  } finally {
    await browser.close();
  }
});
