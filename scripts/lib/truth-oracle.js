// Deterministic oracles for fixture truth: plain DOM geometry and computed-style code, no LLM, no scanner code.
// Each runs on a Playwright page that has the fixture loaded and answers one question per viewport. They are written from the
// WCAG text (2.5.8, 2.5.3, 2.4.7 with 1.4.11's 3:1) and share nothing with src/, so agreement with the tool is evidence, not circularity.

export const VIEWPORTS = [{ name: 'desktop', width: 1280, height: 900 }, { name: 'mobile', width: 390, height: 844 }];

/** WCAG 2.5.8: an undersized (< 24px) target passes when the 24px circle on its box centre meets no other target. Runs in the page. */
function measureTargetSize() {
  const TARGET = 'a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button], [role=link], [role=checkbox], [role=radio], [role=tab], [role=switch]';
  const MIN = 24;
  const R = MIN / 2;
  const targets = [...document.querySelectorAll(TARGET)].filter((el) => {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return !el.disabled && r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && el.checkVisibility();
  }).map((el) => {
    const r = el.getBoundingClientRect();
    return { el, x: r.left, y: r.top, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2, small: r.width < MIN || r.height < MIN };
  });
  const sel = (el) => el.tagName.toLowerCase() + (el.id ? `#${el.id}` : '') + (el.getAttribute('aria-label') ? `[${el.getAttribute('aria-label')}]` : '');
  const dist = (a, b) => Math.hypot(a.cx - b.cx, a.cy - b.cy);
  // Distance from a circle centre to a box (0 inside).
  const toBox = (c, b) => Math.hypot(Math.max(b.x - c.cx, 0, c.cx - (b.x + b.w)), Math.max(b.y - c.cy, 0, c.cy - (b.y + b.h)));
  const failing = [];
  for (const t of targets) {
    if (!t.small) continue;
    // Another undersized target's circle, or a full-size target's box, inside this circle by more than touching.
    const clash = targets.find((u) => u !== t && !u.el.contains(t.el) && !t.el.contains(u.el) && (u.small ? dist(t, u) < MIN - 1e-6 : toBox(t, u) < R - 1e-6));
    if (clash) failing.push(`${sel(t.el)} vs ${sel(clash.el)}`);
  }
  return { targets: targets.length, failing };
}

/** WCAG 2.5.3: the visible label must be a contiguous run of the accessible name. Runs in the page. */
function measureLabelInName() {
  const norm = (s) => s.normalize('NFKC').toLowerCase().replace(/&/g, ' and ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const idText = (id) => { const n = document.getElementById(id); return n ? n.textContent : ''; };
  const failing = [];
  for (const el of document.querySelectorAll('a[href], button, input[type=button], input[type=submit], [role=button], [role=link]')) {
    if (!el.checkVisibility()) continue;
    const visible = el.matches('input') ? el.value : el.innerText;
    const label = norm(visible || '');
    if (!label) continue;
    const labelledby = (el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean).map(idText).join(' ');
    const name = norm(labelledby || el.getAttribute('aria-label') || visible || '');
    if (!` ${name} `.includes(` ${label} `)) failing.push(`${el.tagName.toLowerCase()} "${(visible || '').trim()}" named "${name}"`);
  }
  return { failing };
}

/**
 * WCAG 2.4.7 (and 1.4.11's 3:1 for the indicator): each focusable element, focused with the keyboard, must show an outline or a
 * box-shadow ring whose colour has at least 3:1 against the background behind it. No indicator counts as ratio 1. Runs in the page
 * for one element that is already focused by the keyboard.
 */
function readFocusIndicator() {
  // Relative luminance and contrast ratio per WCAG 2.x, from computed rgb(a) strings (inline: page.evaluate sends this function alone).
  const parse = (s) => { const m = /rgba?\(([^)]+)\)/.exec(s); if (!m) return null; const [r, g, b, a = 1] = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r, g, b, a }; };
  const lin = (c) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const lum = ({ r, g, b }) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  const ratio = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
  const backdrop = (el) => {
    for (let n = el; n; n = n.parentElement) { const c = parse(getComputedStyle(n).backgroundColor); if (c && c.a > 0.5) return c; }
    return { r: 255, g: 255, b: 255, a: 1 };
  };
  const el = document.activeElement;
  if (!el || el === document.body) return null;
  const cs = getComputedStyle(el);
  const bg = backdrop(el.parentElement || el);
  const sources = [];
  if (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0) { const c = parse(cs.outlineColor); if (c && c.a > 0) sources.push(ratio(c, bg)); }
  for (const part of cs.boxShadow === 'none' ? [] : cs.boxShadow.split(/,(?![^(]*\))/)) {
    if (/inset/.test(part)) continue;
    const c = parse(part);
    const nums = (part.replace(/rgba?\([^)]*\)/, '').match(/-?\d+(\.\d+)?px/g) || []).map(parseFloat);
    if (c && c.a > 0 && nums.some((n, i) => i >= 2 && n > 0)) sources.push(ratio(c, bg)); // blur or spread greater than zero
  }
  return { name: el.tagName.toLowerCase() + (el.textContent.trim() ? `"${el.textContent.trim().slice(0, 20)}"` : ''), ratio: sources.length ? Math.max(...sources) : 1 };
}

/** Sets each viewport in turn, runs `fn` in the page, restores nothing (the caller loads a fresh page per fixture). */
async function perViewport(page, viewports, fn) {
  const out = {};
  for (const vp of viewports) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    out[vp.name] = await fn();
  }
  return out;
}

export const oracleTargetSize = (page, viewports = VIEWPORTS) => perViewport(page, viewports, () => page.evaluate(measureTargetSize));
export const oracleLabelInName = (page, viewports = VIEWPORTS) => perViewport(page, viewports, () => page.evaluate(measureLabelInName));

/** Tabs through every focusable element at each viewport and reports the indicator contrast; failing = ratio under 3. */
export async function oracleFocusIndicator(page, viewports = VIEWPORTS) {
  return perViewport(page, viewports, async () => {
    await page.evaluate(() => document.activeElement?.blur());
    const count = await page.evaluate(() => [...document.querySelectorAll('a[href], button, input:not([type=hidden]), select, textarea, [tabindex]')].filter((e) => e.checkVisibility() && !e.disabled && e.tabIndex >= 0).length);
    const stops = [];
    for (let i = 0; i < count; i++) {
      await page.keyboard.press('Tab');
      const s = await page.evaluate(readFocusIndicator);
      if (s) stops.push(s);
    }
    return { stops: stops.length, failing: stops.filter((s) => s.ratio < 3).map((s) => `${s.name} ratio ${s.ratio.toFixed(2)}`) };
  });
}

export const ORACLES = { targetSize: oracleTargetSize, labelInName: oracleLabelInName, focusIndicator: oracleFocusIndicator };

/** true when the oracle finds a failure at any viewport. */
export const oracleFails = (perViewportResult) => Object.values(perViewportResult).some((r) => r.failing.length > 0);
