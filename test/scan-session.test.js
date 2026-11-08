import './helpers/hermetic-env.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { PARADOX_SITE_DIR } from './helpers/paradox-site-server.js';
import { DEFAULT_CONFIG } from '../src/utils/config.js';
import { scanOnePage } from '../src/index.js';
import { closeBrowser } from '../src/scanner/browser.js';

after(closeBrowser);

// Fixture home page plus a /job-list.js request the --no-hydrate-jobs routes must block.
// Browser requests carry sec-fetch-dest; node fetches (w3c raw source, link checker) do not and are not contexts.
async function startCountingServer() {
  const counts = { documents: 0, jobList: 0 };
  const html = (await readFile(path.join(PARADOX_SITE_DIR, 'index.html'), 'utf8')).replace('</body>', '<script src="/job-list.js"></script></body>');
  const server = http.createServer(async (req, res) => {
    const { pathname } = new URL(req.url, 'http://x');
    if (pathname === '/job-list.js') { if (req.headers['sec-fetch-dest'] === 'script') counts.jobList += 1; return res.writeHead(200, { 'content-type': 'text/javascript' }).end(''); }
    if (pathname === '/styles.css') return res.writeHead(200, { 'content-type': 'text/css' }).end(await readFile(path.join(PARADOX_SITE_DIR, 'styles.css')));
    if (pathname !== '/') return res.writeHead(404).end('nope');
    if (req.headers['sec-fetch-dest'] === 'document') counts.documents += 1;
    res.writeHead(200, { 'content-type': 'text/html' }).end(html);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { counts, url: `http://127.0.0.1:${server.address().port}/`, close: () => { server.closeAllConnections(); return new Promise((r) => server.close(r)); } };
}

const config = (layers, extra = {}) => ({
  ...structuredClone(DEFAULT_CONFIG),
  layers: Object.fromEntries(Object.keys(DEFAULT_CONFIG.layers).map((k) => [k, layers.includes(k)])),
  ...extra,
});
// w3c is left off: it calls the public Nu validator; lighthouse runs separately and is excluded from the budget.
const ALL_BROWSER_LAYERS = ['axe', 'accessScan', 'links', 'keyboard', 'ariaLive', 'focusTrap', 'dynamicContent', 'screenReader'];

test('navigations per page stay within 1 + mutating contexts, and --no-hydrate-jobs blocks every layer', { timeout: 240_000 }, async () => {
  const site = await startCountingServer();
  try {
    const cfg = config(ALL_BROWSER_LAYERS);
    // the budget is for the first pass; re-verification (on by default) opens extra contexts on purpose
    const baseline = await scanOnePage({ name: 'home', url: site.url }, cfg, { isUrlMode: true, reverify: false });
    assert.ok(baseline.scannerRuns.length >= ALL_BROWSER_LAYERS.length);
    // shared page + mobile axe viewport + keyboard + focusTrap + dynamicContent (+ reloads focusTrap does per modal trigger, max 3)
    assert.ok(site.counts.documents <= 1 + 1 + 3 + 3, `document requests: ${site.counts.documents}`);
    assert.ok(site.counts.jobList > 0, 'control: job-list.js loads without the flag');

    site.counts.jobList = 0;
    await scanOnePage({ name: 'home', url: site.url }, cfg, { isUrlMode: true, noHydrateJobs: true });
    assert.equal(site.counts.jobList, 0, 'job-list.js must be blocked in every layer context');
  } finally {
    await site.close();
  }
});

test('a throwing layer becomes an error run and keeps its siblings', { timeout: 120_000 }, async () => {
  const site = await startCountingServer();
  try {
    // A zero-width viewport makes axe's extra context fail; screenReader/ariaLive must survive.
    const cfg = config(['axe', 'screenReader', 'ariaLive'], { axe: { viewports: [{ name: 'bad', width: -1, height: -1 }] } });
    const result = await scanOnePage({ name: 'home', url: site.url }, cfg, { isUrlMode: true });
    const status = Object.fromEntries(result.scannerRuns.map((r) => [r.layer ?? r.id ?? r.name, r.status]));
    assert.equal(status.axe, 'error');
    assert.equal(status.screenReader, 'complete');
    assert.equal(status.ariaLive, 'complete');
  } finally {
    await site.close();
  }
});
