import './helpers/hermetic-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closeBrowser } from '../src/scanner/browser.js';
import { requireBrowser } from './helpers/require-browser.js';
import { createFixturePage } from './helpers/access-scan-contract.js';
import { createScanSession } from '../src/scanner/access-scan/runtime/index.js';

const MARKUP = `<main>
  <button id="b-img"><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt="Save" width="9" height="9"></button>
  <button id="b-hidden">Go<span style="display:none"> secret</span></button>
  <a id="a-svg" href="/x"><svg role="img" width="9" height="9"><title>Jobs</title></svg></a>
  <input id="i-submit" type="submit" value="Send">
  <input id="i-text" type="text" value="typed">
  <div id="d-plain">plain subtree text</div>
  <div id="d-role" role="button" tabindex="0">Press</div>
</main>`;

const nameOf = (session, id) => session.snapshot.elements.find((e) => e.attributes.id === id).accessibleName;

test('standards profile takes names from the browser accessibility tree', async (t) => {
  const browser = await requireBrowser(t);
  if (!browser) return;
  t.after(closeBrowser);
  const page = await createFixturePage(browser, `<!doctype html><html lang="en"><head><title>T</title></head><body>${MARKUP}</body></html>`);
  try {
    const session = await createScanSession(page, { profile: 'standards' });
    assert.equal(session.diagnostics.some((d) => d.code === 'accname-cdp-unavailable'), false);
    assert.equal(nameOf(session, 'b-img'), 'Save');
    assert.equal(nameOf(session, 'b-hidden'), 'Go');
    assert.equal(nameOf(session, 'a-svg'), 'Jobs');
    assert.equal(nameOf(session, 'i-submit'), 'Send');
    assert.equal(nameOf(session, 'i-text'), '');
    assert.equal(nameOf(session, 'd-plain'), '');
    assert.equal(nameOf(session, 'd-role'), 'Press');
    // The temporary tagging attribute never survives the pass.
    assert.equal(await page.locator('[data-ada-scan-nid]').count(), 0);

    const legacy = await createScanSession(page, { profile: 'commercial-parity' });
    assert.equal(nameOf(legacy, 'd-plain'), 'plain subtree text');
  } finally {
    await page.context().close();
  }
});
