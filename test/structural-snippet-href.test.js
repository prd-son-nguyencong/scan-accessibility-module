import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { installRuntimeHooks, createScanSession } from '../src/scanner/access-scan/runtime/index.js';

test('structural snippets keep child href/src literals', async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await installRuntimeHooks(page);
  await page.setContent(`
    <div class="flex items-center gap-[1.4rem]">
      <a href="/our-sectors" class="nav-link">Our Sectors</a>
      <button type="button" aria-label="Toggle">…</button>
      <img src="/logo.png" alt="">
    </div>
  `);
  const session = await createScanSession(page, { stabilityMinObserveMs: 50 });
  const div = session.snapshot.elements.find((element) => (
    element.tag === 'div'
    && /gap-\[1\.4rem\]/.test(element.attributes.class || '')
  ));
  assert.ok(div, 'expected breadcrumb-like wrapper');
  assert.match(div.outerHTML, /<a href="\/our-sectors">Our Sectors<\/a>/);
  assert.match(div.outerHTML, /<img src="\/logo\.png">…<\/img>/);
  assert.ok(!/<a>Our Sectors<\/a>/.test(div.outerHTML));
  await browser.close();
});
