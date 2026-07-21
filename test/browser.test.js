import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newPage } from '../src/scanner/browser.js';

test('newPage applies the requested viewport without changing the scanner user agent', async () => {
  let contextOptions;
  const page = {
    on() {},
  };
  const browser = {
    async newContext(options) {
      contextOptions = options;
      return {
        async newPage() {
          return page;
        },
      };
    },
  };

  const result = await newPage(browser, {
    viewport: { width: 390, height: 844 },
  });

  assert.equal(result, page);
  assert.deepEqual(contextOptions.viewport, { width: 390, height: 844 });
  assert.match(contextOptions.userAgent, /ADA-Scanner\/1\.0/);
});
