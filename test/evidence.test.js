import './helpers/hermetic-env.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startParadoxSite } from './helpers/paradox-site-server.js';
import { DEFAULT_CONFIG, validateConfig } from '../src/utils/config.js';
import { scanOnePage } from '../src/index.js';
import { closeBrowser } from '../src/scanner/browser.js';
import { buildScanReportV2 } from '../src/reporter/report-v2.js';
import { buildHtml } from '../src/reporter/html.js';
import { projectReportV1 } from '../src/reporter/report-v2.js';
import { pngSize, reconcileEvidence, wcagCriterion, wcagUnderstandingUrl } from '../src/scanner/evidence.js';

test('a flaky finding spends no screenshot budget; the budget goes to the worst surviving finding; the directory holds exactly the referenced files', { timeout: 120_000 }, async () => {
  let loads = 0;
  const site = await startParadoxSite({
    routes: {
      '/page': (req, res) => {
        loads++;
        // Flaky critical finding first in the DOM, then a serious contrast failure, then a stable critical one.
        const flip = loads === 1 ? '<img id="flip" src="/x.png">' : '';
        res.writeHead(200, { 'content-type': 'text/html' }).end(
          `<!doctype html><html lang="en"><title>T</title><main><h1>Hi</h1>${flip}<p id="faint" style="color:#ccc;background:#fff">faint text here</p><img id="stable" src="/x.png"></main></html>`);
      },
    },
  });
  try {
    const { dir, result } = await scan(`${site.url}/page`, config({ screenshots: { enabled: true, maxPerPage: 1 } }));
    const shot = (sel) => result.violations.find((v) => v.element?.selector?.includes(sel))?.evidence?.capture?.screenshot;
    assert.ok(!result.violations.some((v) => v.element?.selector?.includes('flip')), 'flaky finding excluded');
    assert.ok(shot('stable').file, 'stable critical finding gets the only screenshot');
    assert.equal(shot('faint').skipped, 'budget');
    const files = await readdir(path.join(dir, 'evidence'));
    assert.deepEqual(files, [path.basename(shot('stable').file)]);
  } finally {
    await site.close();
  }
});

test('two elements whose ids differ only in digits get their own screenshot', { timeout: 120_000 }, async () => {
  const site = await startParadoxSite({
    routes: {
      '/jobs': (req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(
        '<!doctype html><html lang="en"><title>T</title><main><h1>Hi</h1><img id="job-1001" src="/x.png" width="40" height="40"><img id="job-2002" src="/x.png" width="80" height="80"></main></html>'),
    },
  });
  let dir;
  try {
    ({ dir } = await scan(`${site.url}/jobs`, config()));
    const files = (await readdir(path.join(dir, 'evidence'))).filter((f) => f.endsWith('.png'));
    assert.equal(files.length, 2);
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
    await site.close();
  }
});

test('reconcileEvidence deletes only unreferenced PNGs and reports the count', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ada-reconcile-'));
  await mkdir(dir, { recursive: true });
  for (const f of ['keep.png', 'orphan.png', 'notes.txt']) await writeFile(path.join(dir, f), 'x');
  const removed = await reconcileEvidence(dir, [{ evidence: { capture: { screenshot: { file: 'evidence/keep.png' } } } }, { evidence: { capture: { screenshot: { skipped: 'budget' } } } }]);
  assert.equal(removed, 1);
  assert.deepEqual((await readdir(dir)).sort(), ['keep.png', 'notes.txt']);
  assert.equal(await reconcileEvidence(path.join(dir, 'missing'), []), 0);
});

after(closeBrowser);

const config = (evidence) => ({
  ...structuredClone(DEFAULT_CONFIG),
  layers: Object.fromEntries(Object.keys(DEFAULT_CONFIG.layers).map((k) => [k, k === 'axe'])),
  axe: { viewports: [{ name: 'desktop', width: 1280, height: 900 }] },
  ...(evidence ? { evidence } : {}),
});

async function scan(url, cfg) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ada-evidence-'));
  const result = await scanOnePage({ name: 'p', url }, cfg, { isUrlMode: true, evidenceDir: path.join(dir, 'evidence') });
  return { dir, result, captureOf: (rule, sel) => result.violations.find((v) => v.ruleId === rule && (!sel || v.element.selector.includes(sel)))?.evidence?.capture };
}

test('seeded defects carry reason, WCAG link, repro, styles, AX name and an outlined screenshot', { timeout: 120_000 }, async () => {
  const site = await startParadoxSite();
  const { dir, result, captureOf } = await scan(`${site.url}/`, config());
  try {
    const contrast = captureOf('color-contrast', 'defect-low-contrast');
    assert.ok(contrast.reason.length > 10);
    assert.deepEqual(contrast.wcag, { criterion: '1.4.3', url: 'https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html' });
    assert.equal(contrast.styles.color, 'rgb(170, 170, 170)'); // #aaa from the fixture CSS
    assert.equal(contrast.styles.backgroundColor, 'rgb(255, 255, 255)');
    assert.equal(contrast.repro.url, `${site.url}/`);
    assert.deepEqual(contrast.repro.viewport, { width: 1280, height: 900 });
    assert.ok(contrast.repro.selector.includes('defect-low-contrast'));
    assert.ok(contrast.geometry.box.width > 0);

    const button = captureOf('button-name', 'defect-icon-button');
    assert.equal(button.ax.role, 'button');
    assert.equal(button.ax.name, '');

    const small = captureOf('target-size', 'defect-small-target');
    assert.ok(small.geometry.box.width < 24);

    // The screenshot fits the budgeted size.
    const report = buildScanReportV2([result], { producer: { version: '0.0.0' } });
    const finding = report.pages[0].findings.find((f) => f.nativeRuleId === 'image-alt');
    const shot = finding.evidence.observations[0].evidence.capture.screenshot;
    assert.match(shot.file, /^evidence\/[a-f0-9]{64}\.png$/);
    const png = await readFile(path.join(dir, shot.file));
    assert.deepEqual(pngSize(png), { width: shot.width, height: shot.height });
    assert.ok(shot.width <= 640 && shot.height <= 400 && shot.width > 0);

    // Only confirmed critical/serious get a picture: moderate findings record why not.
    const moderate = result.violations.find((v) => v.impact === 'moderate' && v.evidence?.capture);
    assert.equal(moderate.evidence.capture.screenshot.skipped, 'impact-below-serious');

    const html = buildHtml(projectReportV1(report));
    // the explorer builds the lazy <img> from the embedded capture record: the screenshot file, its size and the reason travel in the data block
    assert.match(html, /"shot":\["evidence\/[a-f0-9]{64}\.png",\d+,\d+\]/);
    assert.match(html, /"cp":\{"re":/);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await site.close();
  }
});

test('screenshot budget caps files per page and records the reason; disabled writes none', { timeout: 120_000 }, async () => {
  const site = await startParadoxSite();
  const capped = await scan(`${site.url}/`, config({ screenshots: { enabled: true, maxPerPage: 1 } }));
  const off = await scan(`${site.url}/`, config({ screenshots: { enabled: false } }));
  try {
    assert.equal((await readdir(path.join(capped.dir, 'evidence'))).length, 1);
    const reasons = capped.result.violations.map((v) => v.evidence?.capture?.screenshot?.skipped);
    assert.ok(reasons.includes('budget'));
    await assert.rejects(readdir(path.join(off.dir, 'evidence')));
    assert.ok(off.result.violations.every((v) => !v.evidence?.capture || v.evidence.capture.screenshot.skipped === 'disabled'));
    assert.ok(off.result.violations.some((v) => v.evidence?.capture?.reason));
  } finally {
    await rm(capped.dir, { recursive: true, force: true });
    await rm(off.dir, { recursive: true, force: true });
    await site.close();
  }
});

test('form field values never reach a screenshot', { timeout: 120_000 }, async () => {
  const page = (value) => `<!doctype html><html lang="en"><head><title>t</title></head><body><main>
    <img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" width="40" height="40" style="outline:0">
    <input aria-label="secret" value="${value}" style="font-size:24px;width:300px"></main></body></html>`;
  const serve = async (value) => {
    const server = http.createServer((req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(page(value)));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { url: `http://127.0.0.1:${server.address().port}/`, close: () => { server.closeAllConnections(); server.close(); } };
  };
  const shots = [];
  for (const value of ['hunter2-AAAAAAAA', 'zzzzzzzz-BBBBBBBB']) {
    const server = await serve(value);
    const { dir, captureOf } = await scan(server.url, config());
    try {
      const capture = captureOf('image-alt');
      assert.ok(capture.screenshot.file, JSON.stringify(capture.screenshot));
      shots.push(await readFile(path.join(dir, capture.screenshot.file)));
    } finally {
      await rm(dir, { recursive: true, force: true });
      server.close();
    }
  }
  // Same layout, different typed value: identical pixels only if the field is masked.
  assert.ok(shots[0].equals(shots[1]));
});

test('a mobile-only finding records its own viewport and is not measured on the desktop page', { timeout: 120_000 }, async () => {
  const html = `<!doctype html><html lang="en"><head><title>t</title><style>.burger{display:none}@media (max-width:600px){.burger{display:block;width:40px;height:40px}}</style></head>
    <body><main><h1>x</h1><button class="burger"></button><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" width="40" height="40"></main></body></html>`;
  const server = http.createServer((req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(html));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const cfg = { ...config(), axe: structuredClone(DEFAULT_CONFIG.axe) };
  const { dir, captureOf } = await scan(`http://127.0.0.1:${server.address().port}/`, cfg);
  try {
    const burger = captureOf('button-name');
    assert.deepEqual(burger.repro.viewport, { width: 390, height: 844 });
    assert.deepEqual(burger.screenshot, { skipped: 'viewport-mismatch' });
    assert.equal(burger.geometry, null);
    assert.equal(burger.styles, null);
    assert.equal(burger.ax, null);
    // A finding present at the shared desktop viewport is still captured there.
    const img = captureOf('image-alt');
    assert.deepEqual(img.repro.viewport, { width: 1280, height: 900 });
    assert.ok(img.geometry.box.width > 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
    server.closeAllConnections();
    server.close();
  }
});

test('WCAG criterion parsing, Understanding links and evidence config validation', () => {
  assert.equal(wcagCriterion({ wcagRef: 'WCAG 2.2 AA 2.5.8' }), '2.5.8');
  assert.equal(wcagCriterion({ wcagRef: 'WCAG143' }), '1.4.3');
  assert.equal(wcagCriterion({ wcagRef: 'WCAG2AA', evidence: { tags: ['wcag2aa', 'wcag412'] } }), '4.1.2');
  assert.equal(wcagCriterion({ wcagRef: 'Best Practice' }), null);
  assert.equal(wcagUnderstandingUrl('2.5.8'), 'https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html');
  assert.deepEqual(validateConfig({ evidence: { screenshots: { enabled: true, maxPerPage: 5 } } }), []);
  assert.equal(validateConfig({ evidence: { screenshots: { enabled: 'yes', maxPerPage: -1 } } }).length, 2);
});

test('re-verify: a finding that does not reproduce is dropped together with its screenshot; a stable one keeps both', { timeout: 120_000 }, async () => {
  let loads = 0;
  const site = await startParadoxSite({
    routes: {
      '/page': (req, res) => {
        loads++;
        const flip = loads === 1 ? '<img id="flip" src="/x.png">' : '';
        res.writeHead(200, { 'content-type': 'text/html' }).end(
          `<!doctype html><html lang="en"><title>T</title><main><h1>Hi</h1><img id="stable" src="/x.png">${flip}</main></html>`);
      },
    },
  });
  try {
    const { dir, result } = await scan(`${site.url}/page`, config());
    const imgs = result.violations.filter((v) => v.ruleId === 'image-alt');
    assert.ok(imgs.some((v) => v.element.selector.includes('stable')));
    assert.ok(!imgs.some((v) => v.element.selector.includes('flip')), 'flaky finding excluded');
    const files = await readdir(path.join(dir, 'evidence'));
    const kept = imgs.map((v) => path.basename(v.evidence.capture.screenshot.file));
    assert.deepEqual(files.sort(), [...new Set(kept)].sort(), 'no orphan screenshots');
  } finally {
    await site.close();
  }
});
