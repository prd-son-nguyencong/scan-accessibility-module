#!/usr/bin/env node
// Synthetic-DOM benchmark for accessScan: node scripts/bench/access-scan-bench.js [--n=36000]
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { createScanSession } from '../../src/scanner/access-scan/runtime/index.js';
import { scanWithAccessScan } from '../../src/scanner/access-scan/index.js';
import { getSharedBuiltInRuleRegistry } from '../../src/scanner/access-scan/engine/builtin-registry.js';

/**
 * Roughly `n` elements: nested divs holding label/input pairs and links, plus a few
 * iframes under different parents (the first element of each of two sections).
 * @param {number} n
 */
export function buildSyntheticHtml(n) {
  const unit = 6; // div > label + input + span + a (+ nested div counted once)
  const units = Math.max(1, Math.floor(n / unit));
  const perSection = 200;
  let html = '<!doctype html><html lang="en"><head><title>Bench</title></head><body><main>';
  for (let i = 0; i < units; i += 1) {
    if (i % perSection === 0) {
      const open = i === 0 ? '' : '</div></section>';
      html += `${open}<section><h2>Section ${i / perSection}</h2><div class="wrap">`;
      if (i === 0 || i === perSection) {
        html += `<iframe title="frame ${i}" srcdoc="<p>frame ${i}</p><label for='x'>X</label><input id='x'>"></iframe>`;
      }
    }
    html += `<div><div><label for="f${i}">Field ${i}</label><input id="f${i}" type="text"><span>t${i}</span><a href="/p/${i}">Link ${i}</a></div></div>`;
  }
  return `${html}</div></section></main></body></html>`;
}

/**
 * @param {number} n
 * @returns {Promise<{ n: number, elements: number, snapshotMs: number, scanMs: number, violations: number, statuses: Record<string, number>, slowest: Array<[string, number]> }>}
 */
export async function runBench(n) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(buildSyntheticHtml(n), { waitUntil: 'load' });
    let t = Date.now();
    const session = await createScanSession(page);
    const snapshotMs = Date.now() - t;
    // Focus obscuration rules wait two paint frames per focusable (real time, not CPU; rewrite is plan task 2.2), so it is excluded here.
    const registry = await getSharedBuiltInRuleRegistry();
    const skipRules = registry.getActiveRuleIds().filter((id) => /^(FocusNotObscuredFooter|StickyHeaderObscuresFocus)$/.test(id));
    /** @type {any[]} */
    let records = [];
    t = Date.now();
    const violations = await scanWithAccessScan(page, 'about:blank', {
      session,
      skipNavigation: true,
      activateContent: false,
      skipRules,
      onExecutionRecords: (r) => { records = r; },
    });
    const scanMs = Date.now() - t;
    /** @type {Record<string, number>} */
    const statuses = {};
    for (const r of records) statuses[r.status] = (statuses[r.status] || 0) + 1;
    const slowest = records
      .map((r) => /** @type {[string, number]} */ ([r.ruleId, r.durationMs]))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);
    return { n, elements: session.snapshot.elements.length, snapshotMs, scanMs, violations: violations.length, statuses, slowest };
  } finally {
    await browser.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = process.argv.find((a) => a.startsWith('--n='));
  const result = await runBench(arg ? Number(arg.slice(4)) : 36000);
  console.log(JSON.stringify(result, null, 2));
}
