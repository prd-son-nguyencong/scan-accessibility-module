import './helpers/hermetic-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closeBrowser } from '../src/scanner/browser.js';
import { requireBrowser } from './helpers/require-browser.js';
import { createFixturePage, scanFixtureWithAccessScan } from './helpers/access-scan-contract.js';

// The static markup has empty href/aria-label (what a template-less build snapshot looks like); script fills them, as the live page does.
const MARKUP = `<main><h1>T</h1>
<a id="vid" target="_blank" href="" aria-label="">Watch</a>
<a id="plain" target="_blank" href="/x">Plain link text</a>
<script>
  const a = document.getElementById('vid');
  a.setAttribute('href', '/live-video'); a.setAttribute('aria-label', 'Watch the culture video');
</script></main>`;

test('evidence outerHTML comes from the live DOM at detection time, not from the static markup', async (t) => {
  const browser = await requireBrowser(t);
  if (!browser) return;
  try {
    const page = await createFixturePage(browser, MARKUP);
    try {
      const found = (await scanFixtureWithAccessScan(page, 'fixture://live-evidence', { profile: 'standards' }))
        .filter((v) => v.ruleId === 'LinkOpensNewWindow');
      const vid = found.find((v) => /live-video/.test(v.element.outerHTML));
      assert.ok(vid, `a LinkOpensNewWindow finding on the populated link; got ${JSON.stringify(found.map((v) => v.element.outerHTML))}`);
      assert.match(vid.element.outerHTML, /aria-label="Watch the culture video"/);
      assert.doesNotMatch(vid.element.outerHTML, /href=""/);
      // Paired: a link that has no new-window notice at all is still reported.
      assert.ok(found.some((v) => /Plain link text/.test(v.element.outerHTML) || /href="\/x"/.test(v.element.outerHTML)));
    } finally { await page.context().close(); }
  } finally { await closeBrowser(); }
});
