import { test } from 'node:test';
import assert from 'node:assert/strict';

import { chromium } from 'playwright';

import { setDnsResolverForTests } from '../scripts/accessscan-corpus/lib/dns-policy.js';
import {
  installCorpusPageAndContextGuards,
  navigateToReviewedSource,
} from '../scripts/accessscan-corpus/lib/source-url-policy.js';
import { createScanSession } from '../src/scanner/access-scan/runtime/index.js';
import { installCorpusToolingTestResetHooks } from './helpers/accessscan-corpus-test-reset.js';

installCorpusToolingTestResetHooks();

const publicResolver = async (hostname) => {
  if (hostname === 'private-cdn.test') {
    return ['10.0.0.44'];
  }
  return ['8.8.8.8'];
};

test('corpus network guard allows public CDN subresources on reviewed pages', async () => {
  setDnsResolverForTests(publicResolver);
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await installCorpusPageAndContextGuards(page, context, { resolver: publicResolver });
    const cdnRequest = page.waitForEvent('request', {
      predicate: (request) => request.url().includes('fonts.googleapis.com'),
      timeout: 5000,
    });

    await page.setContent(`
      <!doctype html>
      <html><head>
        <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter">
      </head><body><p>cdn probe</p></body></html>
    `, { waitUntil: 'domcontentloaded' });

    assert.match((await cdnRequest).url(), /fonts\.googleapis\.com/);
  } finally {
    await browser.close();
  }
});

test('corpus network guard aborts DNS-private subresource requests', async () => {
  setDnsResolverForTests(publicResolver);
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await installCorpusPageAndContextGuards(page, context, { resolver: publicResolver });

    const failedRequest = page.waitForEvent('requestfailed', {
      predicate: (request) => request.url().includes('private-cdn.test'),
      timeout: 5000,
    });

    await page.setContent(`
      <!doctype html>
      <html><head>
        <script src="https://private-cdn.test/private.js"></script>
      </head><body>blocked</body></html>
    `, { waitUntil: 'commit' });

    const request = await failedRequest;
    assert.match(request.failure()?.errorText || '', /ERR_BLOCKED_BY_CLIENT/);
  } finally {
    await browser.close();
  }
});

test('behavioral fork installs corpus guard and blocks private subresource requests', async () => {
  setDnsResolverForTests(publicResolver);
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const configureForkedPage = async ({ page: forkPage, context: forkContext }) => {
      await installCorpusPageAndContextGuards(forkPage, forkContext, { resolver: publicResolver });
    };

    await page.setContent('<!doctype html><html><body>main</body></html>', {
      waitUntil: 'domcontentloaded',
    });
    const session = await createScanSession(page, { configureForkedPage });
    const fork = await session.forkBehavioralPage();

    const failedRequest = fork.page.waitForEvent('requestfailed', {
      predicate: (request) => request.url().includes('private-cdn.test'),
      timeout: 5000,
    });

    await fork.page.setContent(`
      <!doctype html><html><head>
      <script src="https://private-cdn.test/fork-private.js"></script>
      </head><body>fork</body></html>
    `, { waitUntil: 'commit' });

    const request = await failedRequest;
    assert.match(request.failure()?.errorText || '', /ERR_BLOCKED_BY_CLIENT/);
    await fork.cleanup();
  } finally {
    await browser.close();
  }
});

test('navigateToReviewedSource rejects DNS-private reviewed hostnames', async () => {
  setDnsResolverForTests(async () => ['192.168.1.50']);
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await assert.rejects(
      () => navigateToReviewedSource(
        page,
        'https://hitachi728.preview.sites.stg.paradox.ai/',
        { resolver: async () => ['192.168.1.50'] },
      ),
      /private|reserved|forbidden/i,
    );
  } finally {
    await browser.close();
  }
});
