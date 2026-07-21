#!/usr/bin/env node
/**
 * Scrape live accessScan (acsbace iframe + get-scan-details API).
 * Does NOT click Escape/X on gated popups — removes popup nodes instead.
 *
 * Usage:
 *   node scripts/scrape-accessscan-dom.mjs --url https://example.com/ --out docs/accessscan-example-dom-scrape.json
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

function argValue(flag, fallback = null) {
  const idx = process.argv.indexOf(flag);
  return idx !== -1 ? process.argv[idx + 1] : fallback;
}

const target = argValue('--url');
const outPath = argValue(
  '--out',
  path.join('docs', `accessscan-dom-scrape-${Date.now()}.json`),
);
if (!target) {
  console.error('Usage: node scripts/scrape-accessscan-dom.mjs --url <target> [--out <file>]');
  process.exit(1);
}

const accessScanUrl = `https://accessibe.com/accessscan?website=${encodeURIComponent(target)}`;
const POPUP_SELECTOR = [
  '[data-element="gated-popup"]',
  '.gated-popup',
  '.scan-popup.gated-popup',
  '.scan-popup.popup-get-report',
  '.scan-popup[role="dialog"]',
  '[aria-label="Download PDF Popup"]',
].join(', ');

const browser = await chromium.launch({
  channel: 'chrome',
  headless: false,
});
const page = await browser.newPage({ viewport: { width: 1512, height: 982 } });

/** @type {Record<string, unknown> | null} */
let apiPayload = null;
/** @type {Record<string, unknown> | null} */
let apiReports = null;

page.on('response', async (response) => {
  if (!response.url().includes('/get-scan-details?')) return;
  try {
    const json = await response.json();
    if (json?.scanStatus === 'success' && json?.result?.reports) {
      apiPayload = json;
      apiReports = json.result.reports;
    }
  } catch {
    /* ignore parse races */
  }
});

console.log(`Opening ${accessScanUrl}`);
await page.goto(accessScanUrl, { waitUntil: 'domcontentloaded', timeout: 120_000 });

const aceFrame = () => page.frames().find((frame) => /acsbace\.com/i.test(frame.url()));

const waitStarted = Date.now();
while (Date.now() - waitStarted < 180_000) {
  const frame = aceFrame();
  if (frame && apiReports) {
    const ready = await frame.evaluate(() => {
      const gated = document.querySelector(
        '[data-element="gated-popup"], .gated-popup--fail, .gated-popup',
      );
      return document.body?.getAttribute('data-status') === 'result' && Boolean(gated);
    }).catch(() => false);
    if (ready) break;
  }
  await page.waitForTimeout(1000);
}

const frame = aceFrame();
if (!frame) {
  await browser.close();
  throw new Error('acsbace iframe not found');
}
if (!apiReports) {
  await browser.close();
  throw new Error('get-scan-details API payload not captured');
}

const popupRemovals = [];
await frame.evaluate(({ selector }) => {
  const clear = (reason) => {
    const removed = [];
    for (const el of document.querySelectorAll(selector)) {
      removed.push({
        reason,
        className: el.className || '',
        ariaLabel: el.getAttribute('aria-label'),
        text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 160),
      });
      el.remove();
    }
    document.body.classList.remove('lockscroll');
    document.documentElement.classList.remove('lockscroll');
    document.body.style.overflow = 'auto';
    return removed;
  };

  const initial = clear('initial');
  const observer = new MutationObserver(() => {
    clear('mutation');
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  window.__accessScanPopupKiller = { observer, clear, initial };
  return initial;
}, { selector: POPUP_SELECTOR }).then((initial) => {
  popupRemovals.push(...initial);
});

const expandLog = [];
for (let round = 0; round < 16; round += 1) {
  const stats = await frame.evaluate(async ({ selector }) => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const clear = window.__accessScanPopupKiller?.clear;
    if (typeof clear === 'function') clear('expand-round');

    const collapsed = [...document.querySelectorAll('[aria-expanded="false"]')];
    let clicks = 0;
    for (const el of collapsed) {
      const text = (el.textContent || '').trim();
      if (/get full report|download pdf|submit|login|book a demo|unlock your/i.test(text)) {
        continue;
      }
      try {
        el.scrollIntoView({ block: 'center' });
        el.click();
        clicks += 1;
        await sleep(20);
      } catch {
        /* ignore */
      }
    }

    if (typeof clear === 'function') clear('post-expand');
    return {
      clicks,
      falseLeft: document.querySelectorAll('[aria-expanded="false"]').length,
      trueCount: document.querySelectorAll('[aria-expanded="true"]').length,
      activeLines: document.querySelectorAll('.scan-result__line.js-ace-active, .scan-result__line.result.js-ace-active').length,
      totalLines: document.querySelectorAll('.scan-result__line').length,
      popupVisible: Boolean(document.querySelector(selector)),
    };
  }, { selector: POPUP_SELECTOR });

  expandLog.push({ round, ...stats });
  console.log(`expand round ${round}:`, stats);
  if (stats.clicks === 0 || stats.falseLeft <= 2) break;
  await page.waitForTimeout(250);
}

const mutationRemovals = await frame.evaluate(() => {
  const killer = window.__accessScanPopupKiller;
  const removed = typeof killer?.clear === 'function' ? killer.clear('final') : [];
  try {
    killer?.observer?.disconnect();
  } catch {
    /* ignore */
  }
  return removed;
});
popupRemovals.push(...mutationRemovals);

const failedRulesDom = await frame.evaluate(() => {
  const lines = [...document.querySelectorAll('.scan-result__line.js-ace-active, .scan-result__line.result.js-ace-active, .scan-result__line')];
  const out = [];
  for (const line of lines) {
    const text = (line.innerText || line.textContent || '').replace(/\s+/g, ' ').trim();
    if (!/Bad Score|Failures\s+\d+/i.test(text) && !/fail/i.test(line.className || '')) {
      continue;
    }
    const titleEl = line.querySelector('.scan-result__title, .result__title, h3, h4, [class*="title"]')
      || line.querySelector('[aria-expanded]');
    const title = (titleEl?.textContent || '').replace(/\s+/g, ' ').trim()
      || text.split('Requirement:')[0]?.replace(/^(Bad|Good)\s+Score/i, '').trim().slice(0, 240);

    const failuresMatch = text.match(/Failures?\s+(\d+)/i);
    const snippets = [...line.querySelectorAll('code, pre, .code, .snippet, [class*="snapshot"] code, [class*="snippet"]')]
      .map((node) => (node.textContent || '').trim())
      .filter((value) => value.startsWith('<'))
      .slice(0, 24)
      .map((value) => value.slice(0, 240));

    if (!title && snippets.length === 0) continue;
    out.push({
      title,
      failures: failuresMatch ? Number(failuresMatch[1]) : null,
      active: line.classList.contains('js-ace-active') || line.classList.contains('result'),
      htmlSnippets: snippets,
      preview: text.slice(0, 360),
    });
  }

  // Prefer unique titles with highest failures
  const byTitle = new Map();
  for (const row of out) {
    const key = row.title || row.preview.slice(0, 80);
    const prev = byTitle.get(key);
    if (!prev || (row.failures || 0) >= (prev.failures || 0) || (row.htmlSnippets?.length || 0) > (prev.htmlSnippets?.length || 0)) {
      byTitle.set(key, row);
    }
  }
  return [...byTitle.values()];
});

const accordionState = await frame.evaluate(() => ({
  ariaExpandedFalse: document.querySelectorAll('[aria-expanded="false"]').length,
  ariaExpandedTrue: document.querySelectorAll('[aria-expanded="true"]').length,
  activeLines: document.querySelectorAll('.scan-result__line.js-ace-active, .scan-result__line.result.js-ace-active').length,
  totalLines: document.querySelectorAll('.scan-result__line').length,
  popupLeft: Boolean(document.querySelector(
    '[data-element="gated-popup"], .gated-popup, .scan-popup.popup-get-report',
  )),
  lockscroll: document.body.classList.contains('lockscroll'),
}));

const byCategory = {};
let totalFailures = 0;
for (const [category, rules] of Object.entries(apiReports || {})) {
  const bucket = {};
  for (const [ruleId, report] of Object.entries(rules || {})) {
    const failures = Number(report?.failures || 0);
    if (failures <= 0 || report?.skipReporting === true) continue;
    totalFailures += failures;
    bucket[ruleId] = {
      failures,
      snippets: (report.failuresHtml || [])
        .slice(0, 8)
        .map((entry) => {
          try {
            return decodeURIComponent(entry).slice(0, 160);
          } catch {
            return String(entry).slice(0, 160);
          }
        }),
    };
  }
  if (Object.keys(bucket).length > 0) byCategory[category] = bucket;
}

const artifact = {
  scrapedAt: new Date().toISOString(),
  target,
  accessScanUrl,
  method: [
    'wait iframe data-status=result + gated popup',
    'remove gated popup (initial + unlock report) via MutationObserver',
    'remove lockscroll',
    'ONE-WAY expand [aria-expanded=false] only',
    'scrape failed .scan-result__line snippets',
    'authoritative counts from get-scan-details API',
  ],
  popupRemovals,
  popupRemovalCount: popupRemovals.length,
  expandLog,
  accordionState,
  failedRulesDom,
  api: {
    totalFailures,
    byCategory,
    website: apiPayload?.result?.website || null,
    score: apiPayload?.result?.score ?? null,
  },
};

writeFileSync(outPath, `${JSON.stringify(artifact, null, 2)}\n`);
console.log(JSON.stringify({
  outPath,
  totalFailures,
  ruleGroups: Object.values(byCategory).reduce((n, rules) => n + Object.keys(rules).length, 0),
  accordionState,
}, null, 2));

await browser.close();
