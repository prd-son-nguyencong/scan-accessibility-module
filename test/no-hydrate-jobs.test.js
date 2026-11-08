import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import {
  NO_HYDRATE_JOBS_REQUEST_RE,
  stripNoHydrateJobsDom,
} from '../src/scanner/access-scan/runtime/no-hydrate.js';

test('NO_HYDRATE_JOBS_REQUEST_RE matches jobs bundles and chat hosts', () => {
  assert.equal(NO_HYDRATE_JOBS_REQUEST_RE.test('https://cdn.example/jobs-list-only.bundle.js'), true);
  assert.equal(NO_HYDRATE_JOBS_REQUEST_RE.test('https://site.example/job-list.js'), true);
  assert.equal(NO_HYDRATE_JOBS_REQUEST_RE.test('https://site.example/assets/app.js'), false);
});

test('stripNoHydrateJobsDom clears mounts, jobs chrome, widgets, and blur styles', async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.setContent(`
    <main class="c-jobs__main"><div data-react-component="jobs-list-only"><button>Sort</button></div></main>
    <div class="c-jobs"><div data-component="search-box"><input></div></div>
    <apply-widget></apply-widget>
    <div class="blur-in-item" style="opacity:0;transform:translateY(20px)">Hero</div>
    <main id="page-main"><p>Content</p></main>
  `);

  const stats = await stripNoHydrateJobsDom(page);
  assert.ok(stats.mountsCleared >= 1);
  assert.ok(stats.jobsChromeRemoved >= 1);
  assert.ok(stats.widgetsRemoved >= 1);
  assert.ok(stats.animationsReset >= 1);

  const leftover = await page.evaluate(() => ({
    jobsMain: document.querySelectorAll('main.c-jobs__main, .c-jobs').length,
    widgets: document.querySelectorAll('apply-widget').length,
    blur: document.querySelectorAll('.blur-in-item').length,
    styled: document.querySelectorAll('[style]').length,
    pageMain: Boolean(document.querySelector('#page-main')),
  }));
  assert.equal(leftover.jobsMain, 0);
  assert.equal(leftover.widgets, 0);
  assert.equal(leftover.blur, 0);
  assert.equal(leftover.styled, 0);
  assert.equal(leftover.pageMain, true);
  await browser.close();
});
