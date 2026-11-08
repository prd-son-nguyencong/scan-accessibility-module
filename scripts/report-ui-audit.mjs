#!/usr/bin/env node
// Layout and accessibility audit of a generated scan-visual.html in Chromium.
// Usage: node scripts/report-ui-audit.mjs [report.html ...] [--widths 320,390,768,1440] [--themes dark,light]
// With no file it builds the neutral fixture report. Exit 0 = clean (or no Chromium: skipped), 1 = findings.
// Checks per width and colour scheme: document and element overflow, words split mid-word, accessible names,
// text contrast (4.5:1 required, 7:1 reported), focus order and visible focus, keyboard shortcuts, axe-core WCAG 2.2 AA.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args.splice(i, 2)[1] : dflt; };
const widths = opt('widths', '320,390,768,1440').split(',').map(Number);
const schemes = opt('themes', opt('schemes', 'dark,light')).split(','); // each theme is chosen through localStorage before load, as a visitor's saved choice would be
let files = args;

let chromium; let AxeBuilder;
try {
  ({ chromium } = await import('playwright'));
  ({ default: AxeBuilder } = await import('@axe-core/playwright'));
} catch (err) {
  console.log(`report-ui-audit: skipped, playwright is not installed (${err.message})`);
  process.exit(0);
}
if (!files.length) {
  const { buildHtml } = await import('../src/reporter/html.js');
  const { buildFixtureReport } = await import('../test/helpers/report-ui-fixture.mjs');
  const dir = mkdtempSync(path.join(tmpdir(), 'ada-report-ui-'));
  const file = path.join(dir, 'scan-visual.html');
  writeFileSync(file, buildHtml(buildFixtureReport()));
  files = [file];
}

let browser;
try { browser = await chromium.launch(); } catch (err) {
  console.log(`report-ui-audit: skipped, Chromium cannot start (${err.message.split('\n')[0]})`);
  process.exit(0);
}

// Runs inside the page. Returns { overflow, split, names, contrast, aaa }.
function inPage() {
  const out = { overflow: [], split: [], names: [], contrast: [], aaa: 0, aaaList: [], sampled: 0 };
  const vis = (el) => { const r = el.getBoundingClientRect(); if (r.width <= 2 || r.height <= 2) return false; const th = el.closest('thead'); if (th && th.getBoundingClientRect().width <= 2) return false; const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && !el.closest('[hidden]') && !el.closest('.sr'); };
  const describe = (el) => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${el.className && typeof el.className === 'string' ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}` : ''} "${(el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40)}"`;
  const all = [...document.body.querySelectorAll('*')].filter(vis);

  // 1. overflow: the document, and any element whose content is wider than its box unless it scrolls on purpose
  const de = document.documentElement;
  if (de.scrollWidth > innerWidth + 1) out.overflow.push(`document scrollWidth ${de.scrollWidth} > viewport ${innerWidth}`);
  for (const el of all) {
    if (el.clientWidth && el.scrollWidth > el.clientWidth + 1) {
      const ox = getComputedStyle(el).overflowX;
      if (!['auto', 'scroll', 'hidden', 'clip'].includes(ox) && !el.closest('pre')) out.overflow.push(`${describe(el)} scrollWidth ${el.scrollWidth} > clientWidth ${el.clientWidth}`);
      else if (ox === 'hidden' || ox === 'clip') { if (!el.matches('.rows, .tbl, .split, .tbl-wrap, .grp')) out.overflow.push(`${describe(el)} clips ${el.scrollWidth - el.clientWidth}px`); }
      else if (ox !== 'hidden' && el.tabIndex < 0 && !el.querySelector('[tabindex]') && !el.closest('pre')) out.overflow.push(`${describe(el)} scrolls but is not keyboard focusable`);
    }
  }
  for (const pre of document.querySelectorAll('pre.codebox')) if (vis(pre) && pre.tabIndex < 0) out.overflow.push(`${describe(pre)} is a scroll container without tabindex`);

  // 2. words split mid-word: a whitespace-delimited word on two lines is fine only at a hyphen, slash, dot or other code boundary
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node; let n = 0;
  const range = document.createRange();
  while ((node = walker.nextNode()) && n < 6000) {
    const el = node.parentElement;
    if (!el || !vis(el) || /^(SCRIPT|STYLE|OPTION|TEXTAREA)$/.test(el.tagName)) continue;
    const text = node.nodeValue;
    if (!text.trim()) continue;
    const inCode = !!el.closest('code, pre, .path, .mono');
    for (const m of text.matchAll(/\S{4,}/g)) {
      n++;
      range.setStart(node, m.index); range.setEnd(node, m.index + m[0].length);
      const rects = [...range.getClientRects()].filter((r) => r.width > 0);
      if (rects.length < 2 || new Set(rects.map((r) => Math.round(r.top))).size < 2) continue;
      // find where the line changes
      let prev = null;
      for (let i = 0; i < m[0].length; i++) {
        range.setStart(node, m.index + i); range.setEnd(node, m.index + i + 1);
        const r = range.getClientRects()[0]; if (!r) continue;
        if (prev && r.top - prev.top > prev.height * 0.6) {
          const before = m[0][i - 1]; const at = m[0][i];
          const boundary = /[-/._:?&=#%,;>+~()[\]*"}]/.test(before) || (inCode && /[a-z0-9]/.test(before) && /[A-Z]/.test(at));
          const run = (m[0].slice(0, i).match(/[A-Za-z0-9%]*$/)[0] + m[0].slice(i).match(/^[A-Za-z0-9%]*/)[0]).length;
          // a hash or percent-encoded run has no boundary to break at
          if (!boundary && !(inCode && run >= 20)) { out.split.push(`"${m[0].slice(0, 60)}" broken before "${at}" in ${describe(el)}`); break; }
        }
        prev = r;
      }
    }
  }

  // 3. accessible names
  const interactive = [...document.body.querySelectorAll('a[href], button, input, select, textarea, summary, [role="button"], [tabindex]:not([tabindex="-1"])')].filter(vis);
  const text = (el) => (el.textContent || '').replace(/\s+/g, ' ').trim();
  for (const el of interactive) {
    let name = el.getAttribute('aria-label') || '';
    const lb = el.getAttribute('aria-labelledby');
    if (!name && lb) name = lb.split(/\s+/).map((id) => text(document.getElementById(id) || document.body.appendChild(document.createElement('i')))).join(' ');
    if (!name && el.labels && el.labels.length) name = [...el.labels].map(text).join(' ');
    if (!name && /^(A|BUTTON|SUMMARY)$/.test(el.tagName)) name = text(el);
    if (!name && el.tagName === 'PRE') name = el.getAttribute('aria-label') || '';
    if (!name) name = el.getAttribute('title') || '';
    if (!name.trim()) out.names.push(describe(el));
  }

  // 4. contrast of text against its effective background
  const cv = document.createElement('canvas'); cv.width = cv.height = 1;
  const g = cv.getContext('2d', { willReadFrequently: true });
  const rgba = (c) => { g.clearRect(0, 0, 1, 1); g.fillStyle = '#000'; g.fillStyle = c; g.fillRect(0, 0, 1, 1); const d = g.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3] / 255]; };
  const lum = ([r, gg, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(gg) + 0.0722 * f(b); };
  const over = (top, bottom) => { const a = top[3]; return [0, 1, 2].map((i) => top[i] * a + bottom[i] * (1 - a)).concat(1); };
  const bgOf = (el) => {
    const chain = []; for (let e = el; e; e = e.parentElement) { const cs = getComputedStyle(e); if (cs.backgroundImage !== 'none') return null; const c = rgba(cs.backgroundColor); if (c[3] > 0) chain.push(c); if (c[3] >= 1) break; }
    let base = [255, 255, 255, 1]; if (!chain.length || chain[chain.length - 1][3] < 1) base = rgba(getComputedStyle(document.documentElement).backgroundColor); if (base[3] < 1) base = [255, 255, 255, 1];
    return chain.reverse().reduce((acc, c) => over(c, acc), base);
  };
  const seen = new Set();
  for (const el of all) {
    const direct = [...el.childNodes].some((c) => c.nodeType === 3 && c.nodeValue.trim());
    if (!direct || el.disabled || seen.has(el)) continue;
    seen.add(el); out.sampled++;
    const cs = getComputedStyle(el);
    const bg = bgOf(el); if (!bg) continue;
    const fg0 = rgba(cs.color); const fg = over([fg0[0], fg0[1], fg0[2], fg0[3] * (parseFloat(cs.opacity) || 1)], bg);
    const L1 = lum(fg); const L2 = lum(bg);
    const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
    const px = parseFloat(cs.fontSize); const bold = parseInt(cs.fontWeight, 10) >= 700;
    const large = px >= 24 || (px >= 18.66 && bold);
    if (ratio < (large ? 3 : 4.5)) out.contrast.push(`${ratio.toFixed(2)}:1 ${describe(el)} (${cs.color} on rgb(${bg.slice(0, 3).map(Math.round)}))`);
    else if (ratio < (large ? 4.5 : 7)) { out.aaa++; out.aaaList.push(`${ratio.toFixed(2)}:1 ${describe(el)}`); }
  }
  return out;
}

const failures = [];
const note = (file, w, scheme, kind, items) => { for (const it of items.slice(0, 6)) failures.push(`${path.basename(file)} ${w}px ${scheme} ${kind}: ${it}`); if (items.length > 6) failures.push(`${path.basename(file)} ${w}px ${scheme} ${kind}: and ${items.length - 6} more`); };
const rows = [];

for (const file of files) {
  const url = pathToFileURL(path.resolve(file)).href;
  for (const scheme of schemes) for (const w of widths) {
    const ctx = await browser.newContext({ viewport: { width: w, height: 900 }, colorScheme: scheme, reducedMotion: 'reduce' });
    await ctx.addInitScript((t) => { try { localStorage.setItem('ada-report-theme', t); } catch (e) { /* storage blocked */ } }, scheme);
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); }); // evidence screenshots are separate files and may be absent from a copied report
    await page.goto(url);
    await page.waitForSelector('html.js');
    const applied = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    if (applied !== scheme) failures.push(`${path.basename(file)} ${w}px ${scheme} theme: data-theme is "${applied}"`);
    // open the first few findings so detail layouts are audited too
    const btns = await page.$$('.row-btn');
    for (const b of btns.slice(0, 3)) await b.click();
    await page.evaluate(() => document.querySelectorAll('details').forEach((d) => { d.open = true; }));
    const r = await page.evaluate(inPage);
    const axe = w === 390 || w === 1440 ? await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice']).analyze() : { violations: [] };
    note(file, w, scheme, 'overflow', r.overflow); note(file, w, scheme, 'split-word', r.split); note(file, w, scheme, 'no-name', r.names); note(file, w, scheme, 'contrast', r.contrast);
    note(file, w, scheme, 'console', errors);
    note(file, w, scheme, 'axe', axe.violations.map((v) => `${v.id}: ${v.nodes.slice(0, 2).map((x) => x.target.join(' ')).join(' | ')}`));

    // focus order and visible focus (desktop and phone are enough)
    if (w === 390 || w === 1440) {
      await page.goto(url);
      await page.waitForSelector('html.js');
      const order = []; let last = null; const bad = [];
      for (let i = 0; i < 40; i++) {
        await page.keyboard.press('Tab');
        const info = await page.evaluate((prev) => {
          const el = document.activeElement; if (!el || el === document.body) return null;
          const cs = getComputedStyle(el);
          const visible = (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0) || cs.boxShadow !== 'none';
          return { id: `${el.tagName}.${(el.className || '').toString().slice(0, 30)} ${(el.textContent || '').trim().slice(0, 24)}`, visible, tabindex: el.tabIndex, pos: prev === null ? 0 : (window.__prevEl ? window.__prevEl.compareDocumentPosition(el) : 0), set: (window.__prevEl = el, 1) };
        }, last);
        if (!info) continue;
        last = 1;
        if (order.length && info.id === order[0]) break; // wrapped around to the start
        if (!info.visible) bad.push(`no visible focus indicator on ${info.id}`);
        if (info.tabindex > 0) bad.push(`positive tabindex on ${info.id}`);
        if (info.pos & 2) bad.push(`focus moved backwards in the document to ${info.id}`);
        order.push(info.id);
      }
      note(file, w, scheme, 'focus', bad);
      if (order.length < 3) failures.push(`${path.basename(file)} ${w}px ${scheme} focus: only ${order.length} tab stops reached`);
    }
    // theme toggle: named, keyboard operable, flips the theme and its name (once per file and theme)
    if (w === 1440) {
      const tg = await page.$('#theme-toggle');
      const before = await tg.getAttribute('aria-label');
      await tg.focus(); await page.keyboard.press('Enter');
      const after = await tg.getAttribute('aria-label');
      const now = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
      if (before === after || now === scheme) failures.push(`${path.basename(file)} ${scheme}: the theme toggle did not switch (${before} -> ${after})`);
      await page.keyboard.press('Enter'); // back, so the checks below run in the theme under test
    }
    // keyboard shortcuts (once per file)
    if (w === 1440 && scheme === schemes[0] && (await page.$('#q'))) { // the explorer's shortcuts exist only on scan-visual.html
      await page.evaluate(() => document.activeElement && document.activeElement.blur());
      await page.keyboard.press('/');
      if (!(await page.evaluate(() => document.activeElement && document.activeElement.id === 'q'))) failures.push(`${path.basename(file)}: "/" does not focus the search`);
      await page.keyboard.press('Escape');
      await page.keyboard.press('?');
      if (!(await page.evaluate(() => document.getElementById('help').open))) failures.push(`${path.basename(file)}: "?" does not open the shortcuts`);
      await page.keyboard.press('Escape');
      await page.keyboard.press('j');
      const onRow = await page.evaluate(() => document.activeElement && document.activeElement.classList.contains('row-btn'));
      if (!onRow && btns.length) failures.push(`${path.basename(file)}: "j" does not focus a finding`);
      if (onRow) {
        const before = await page.evaluate(() => document.activeElement.getAttribute('aria-expanded'));
        await page.keyboard.press('Enter');
        const after = await page.evaluate(() => document.activeElement.getAttribute('aria-expanded'));
        if (before === after) failures.push(`${path.basename(file)}: Enter does not toggle the focused finding`);
      }
    }
    if (process.env.AUDIT_AAA) console.log(r.aaaList.slice(0, 15).join('\n'));
    rows.push(`${path.basename(file)} ${String(w).padStart(4)}px ${scheme.padEnd(5)} sampled ${String(r.sampled).padStart(4)} text nodes, ${r.aaa} below 7:1 (AA met)`);
    await ctx.close();
  }
}
await browser.close();
console.log(rows.join('\n'));
if (failures.length) { console.log(`\n${failures.length} problem${failures.length === 1 ? '' : 's'}:\n${failures.join('\n')}`); process.exit(1); }
console.log('\nreport-ui-audit: clean');
