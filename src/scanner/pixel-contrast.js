// Pixel-measured contrast: WCAG maths plus page-screenshot sampling, shared by the keyboard layer (focus ring vs its
// neighbours) and the axe layer (text over image backdrops, where axe answers "incomplete" without a ratio).

// scroll-behavior too: focus or a script scrolling smoothly leaves the element moving while a screenshot is taken.
export const FREEZE_MOTION_CSS = '*, *::before, *::after { transition: none !important; animation: none !important; scroll-behavior: auto !important; }';

/** Freeze CSS motion and finish Web Animations so a measurement sees the resting state (infinite animations cannot finish: cancelled). */
export async function settleMotion(page) {
  await page.evaluate(() => {
    for (const a of document.getAnimations()) { try { a.finish(); } catch { try { a.cancel(); } catch { /* gone */ } } }
    return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }).catch(() => {});
}

// Glyph-pixel verdict thresholds (docs/pixel-contrast.md): confirmed when >= 40% of the glyph area fails, needs-review from 10%.
export const GLYPH_CONFIRM_FRACTION = 0.4;
export const GLYPH_REVIEW_FRACTION = 0.1;
const MAX_CLIP_W = 520;
const MAX_CLIP_H = 260;

// ─── WCAG maths (pure) ───────────────────────────────────────────────────────

export function parseCssColor(css) {
  const m = String(css || '').match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)/);
  if (!m) return null;
  const a = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
  return { rgb: [Math.round(+m[1]), Math.round(+m[2]), Math.round(+m[3])], a };
}

export function relativeLuminance([r, g, b]) {
  return [r, g, b].reduce((sum, c, i) => {
    const s = c / 255;
    return sum + (s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4) * [0.2126, 0.7152, 0.0722][i];
  }, 0);
}

export function contrastRatio(rgb1, rgb2) {
  const [l1, l2] = [relativeLuminance(rgb1), relativeLuminance(rgb2)].sort((a, b) => b - a);
  return (l1 + 0.05) / (l2 + 0.05);
}

export const blend = (fg, a, bg) => fg.map((c, i) => Math.round(c * a + bg[i] * (1 - a)));

const median = (list) => {
  const s = [...list].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN;
};
export const medianColor = (colors) => [0, 1, 2].map((i) => Math.round(median(colors.map((c) => c[i]))));
export const medianOf = median;

/** WCAG 1.4.3 large text: >= 24px, or >= 18.66px (14pt) and bold. */
export const isLargeText = (fontPx, weight) => fontPx >= 24 || (fontPx >= 18.66 && weight >= 700);

/**
 * Verdict for text drawn over a varying backdrop: samples = one { ratio, threshold } per glyph pixel (WCAG ratio against the backdrop pixel under it).
 * confirmed >= 40% of glyph pixels below the threshold, needs-review 10-40%, else pass.
 */
export function classifyGlyphSamples(samples) {
  if (!samples.length) return null;
  const ratios = samples.map((s) => s.ratio);
  const fraction = samples.filter((s) => s.ratio < s.threshold).length / samples.length;
  return {
    verdict: fraction >= GLYPH_CONFIRM_FRACTION ? 'confirmed' : fraction >= GLYPH_REVIEW_FRACTION ? 'needs-review' : 'pass',
    min: Math.min(...ratios), median: median(ratios), failFraction: fraction, pixels: samples.length,
    threshold: Math.max(...samples.map((s) => s.threshold)),
  };
}

/**
 * Focus ring vs the pixels next to it. ring = [r,g,b] (already blended), outside/inside = lists of neighbouring colours (one per side).
 * Not overlapping the element: only the outside counts. Overlapping (negative outline-offset): the ring must stand out from
 * at least one side, so it fails only when it fails both. A ring drawn wholly inside the border box (insideOnly) is judged against
 * its inside neighbour alone: the page outside the border says nothing about whether it shows against the element.
 */
export function ringContrast({ ring, outside, inside = [], insideOnly = false }, min = 3) {
  const ratioOf = (colors) => (colors.length ? median(colors.map((c) => contrastRatio(ring, c))) : null);
  const out = ratioOf(outside);
  const inn = ratioOf(inside);
  if (insideOnly && inn !== null) return { outside: out, inside: inn, pass: inn >= min, ratio: inn };
  if (out === null && inn === null) return null;
  const passes = (out !== null && out >= min) || (inn !== null && inn >= min);
  return { outside: out, inside: inn, pass: passes, ratio: Math.max(out ?? 0, inn ?? 0) };
}

// ─── Screenshot sampling ─────────────────────────────────────────────────────

/** Capture a viewport-coordinate clip as RGBA pixels (CSS-pixel scale). Decoded in the page, so no PNG dependency. */
export async function grabPixels(page, clip) {
  const png = await page.screenshot({ clip, type: 'png', scale: 'css', animations: 'disabled', caret: 'hide' });
  return page.evaluate(async (b64) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const canvas = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0);
    return { w: bmp.width, h: bmp.height, data: Array.from(ctx.getImageData(0, 0, bmp.width, bmp.height).data) };
  }, png.toString('base64'));
}

const pixelAt = (img, x, y) => {
  if (x < 0 || y < 0 || x >= img.w || y >= img.h) return null;
  const i = (y * img.w + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2]];
};

/** Clip around a viewport rect, grown by pad, kept inside the viewport and bounded in size. */
export function clipAround(rect, pad, viewport) {
  const x = Math.max(0, Math.floor(rect.left - pad));
  const y = Math.max(0, Math.floor(rect.top - pad));
  const right = Math.min(viewport.width, Math.ceil(rect.right + pad), x + MAX_CLIP_W);
  const bottom = Math.min(viewport.height, Math.ceil(rect.bottom + pad), y + MAX_CLIP_H);
  return right - x > 0 && bottom - y > 0 ? { x, y, width: right - x, height: bottom - y } : null;
}

/**
 * Colours of the 4 strips lying `e` px outside the border box (negative e = inside), 3 px deep, middle of each side.
 * Sides that fall outside the captured image are skipped.
 */
export function sampleSides(img, clip, rect, e) {
  const cx = Math.round((Math.max(rect.left, clip.x) + Math.min(rect.right, clip.x + clip.width)) / 2);
  const cy = Math.round((Math.max(rect.top, clip.y) + Math.min(rect.bottom, clip.y + clip.height)) / 2);
  const dir = e >= 0 ? 1 : -1;
  const depths = [Math.abs(e) - 1, Math.abs(e), Math.abs(e) + 1]; // 3 px deep, outward for e > 0, inward for e < 0
  const sides = [
    (d) => [cx, Math.round(rect.top) - dir * d],
    (d) => [cx, Math.round(rect.bottom) + dir * d],
    (d) => [Math.round(rect.left) - dir * d, cy],
    (d) => [Math.round(rect.right) + dir * d, cy],
  ];
  const colors = [];
  for (const at of sides) {
    const px = depths.map((d) => at(d)).map(([x, y]) => pixelAt(img, x - clip.x, y - clip.y)).filter(Boolean);
    if (px.length === depths.length) colors.push(medianColor(px));
  }
  return colors;
}

/**
 * Is the ring really painted where its computed style says? True when, on at least one side, a pixel inside the band
 * [inner, outer] px outside the border box (1 px slack for anti-aliasing) is within `tol` per channel of the ring colour.
 * Guards against sampling the wrong place (scroll, moved or blurred element), which would report a bogus ratio such as 1.00:1.
 */
export function ringPresent(img, clip, rect, { inner, outer }, ring, tol = 40) {
  const cx = Math.round((Math.max(rect.left, clip.x) + Math.min(rect.right, clip.x + clip.width)) / 2);
  const cy = Math.round((Math.max(rect.top, clip.y) + Math.min(rect.bottom, clip.y + clip.height)) / 2);
  const sides = [
    (d) => [cx, Math.round(rect.top) - d],
    (d) => [cx, Math.round(rect.bottom) + d],
    (d) => [Math.round(rect.left) - d, cy],
    (d) => [Math.round(rect.right) + d, cy],
  ];
  for (const at of sides) {
    for (let d = Math.floor(inner) - 1; d <= Math.ceil(outer) + 1; d++) {
      const [x, y] = at(d);
      const px = pixelAt(img, x - clip.x, y - clip.y);
      if (px && px.every((v, i) => Math.abs(v - ring[i]) <= tol)) return true;
    }
  }
  return false;
}

// ─── Glyph-pixel contrast for axe "incomplete" colour-contrast nodes ─────────

const HIDE_ATTR = 'data-ada-px';
// keepShadow: leave the element's own text-shadow in place (only the glyph fill changes), so the backdrop includes the shadow.
// The fill is changed through -webkit-text-fill-color alone then, so a currentcolor shadow keeps its colour.
const shadowRule = (keepShadow) => (keepShadow ? '' : 'text-shadow: none !important;');
const hideCss = (keepShadow) => `[${HIDE_ATTR}], [${HIDE_ATTR}] * { ${keepShadow ? '' : 'color: transparent !important;'} -webkit-text-fill-color: transparent !important; ${shadowRule(keepShadow)} text-decoration-color: transparent !important; caret-color: transparent !important; }`;
const probeCss = (c, keepShadow) => `[${HIDE_ATTR}], [${HIDE_ATTR}] * { ${keepShadow ? '' : `color: ${c} !important;`} -webkit-text-fill-color: ${c} !important; ${shadowRule(keepShadow)} text-decoration-color: ${c} !important; }`;

/** In-page: scroll the element to the middle, find its text runs (viewport rects, colour, size) and check nothing covers it. */
function describeTextRuns({ selector }) {
  const el = document.querySelector(selector);
  if (!el) return null;
  el.scrollIntoView({ block: 'center', inline: 'nearest' });
  const runs = [];
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!/\S/.test(n.nodeValue)) continue;
    const owner = n.parentElement;
    const cs = getComputedStyle(owner);
    if (cs.visibility === 'hidden' || cs.display === 'none') continue;
    const range = document.createRange();
    range.selectNodeContents(n);
    for (const r of range.getClientRects()) {
      if (r.width < 1 || r.height < 1) continue;
      let clip = false; // an ancestor paints its background through the glyphs (background-clip:text): hiding the text fill leaves that gradient behind
      for (let e = owner; e; e = e.parentElement) { const c = getComputedStyle(e); if (c.backgroundClip === 'text' || c.webkitBackgroundClip === 'text') { clip = true; break; } }
      runs.push({ clip, fill: cs.webkitTextFillColor, left: r.left, top: r.top, right: r.right, bottom: r.bottom, shadow: cs.textShadow !== 'none', color: cs.color, fontPx: parseFloat(cs.fontSize), weight: parseInt(cs.fontWeight, 10) || 400, opacity: parseFloat(cs.opacity) });
    }
  }
  if (!runs.length) return null;
  const first = runs[0];
  const top = document.elementFromPoint((first.left + first.right) / 2, (first.top + first.bottom) / 2);
  const covered = !top || !(el === top || el.contains(top) || top.contains(el));
  return { runs, covered, viewport: { width: innerWidth, height: innerHeight } };
}

/** Why the glyph pixels cannot be read against a backdrop (null when they can): clipped-background text and transparent text fill are painted by a technique the hide-and-probe screenshots do not see through. */
export function glyphUnmeasurable(runs) {
  if (runs.some((r) => r.clip)) return 'text is painted through background-clip:text (a gradient or image clipped to the glyphs), so the pixels behind the glyphs are the clip itself, not a backdrop';
  if (runs.some((r) => [r.color, r.fill].some((c) => parseCssColor(c)?.a === 0))) return 'the text colour or -webkit-text-fill-color is transparent, so the glyphs are painted by another technique and pixels cannot tell their colour';
  return null;
}

/**
 * Measures one element's text against the pixels behind it. Returns null when it cannot be measured (covered, offscreen, no text),
 * else classifyGlyphRatios() output plus the threshold used.
 * Two screenshots, no layout change: text made transparent (backdrop), and text forced to black/white (glyph mask).
 */
export async function measureGlyphContrast(page, selector) {
  const info = await page.evaluate(describeTextRuns, { selector });
  if (!info || info.covered) return null;
  const { runs, viewport } = info;
  const unmeasurable = glyphUnmeasurable(runs);
  if (unmeasurable) return { unmeasurable };
  const box = runs.reduce((b, r) => ({ left: Math.min(b.left, r.left), top: Math.min(b.top, r.top), right: Math.max(b.right, r.right), bottom: Math.max(b.bottom, r.bottom) }),
    { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity });
  const clip = clipAround(box, 1, viewport);
  if (!clip) return null;
  const tagged = await page.evaluate(({ selector, attr }) => { document.querySelector(selector)?.setAttribute(attr, ''); return true; }, { selector, attr: HIDE_ATTR });
  if (!tagged) return null;
  const style = await page.addStyleTag({ content: hideCss(false) });
  // One pass: backdrop screenshot (text hidden), then two glyph-mask screenshots (text forced black, then white).
  const measure = async (keepShadow) => {
    await style.evaluate((n, text) => { n.textContent = text; }, hideCss(keepShadow));
    const backdrop = await grabPixels(page, clip);
    // Glyph mask: draw the text in black, then in white, so a glyph shows up whichever way the backdrop leans.
    const probes = [];
    for (const [css, rgb] of [['#000', [0, 0, 0]], ['#fff', [255, 255, 255]]]) {
      await style.evaluate((n, text) => { n.textContent = text; }, probeCss(css, keepShadow));
      probes.push({ rgb, img: await grabPixels(page, clip) });
    }
    const samples = [];
    let sizePx = 0;
    for (const run of runs) {
      const fg = parseCssColor(run.color);
      if (!fg) continue;
      const threshold = isLargeText(run.fontPx, run.weight) ? 3 : 4.5;
      sizePx = Math.max(sizePx, run.fontPx);
      const x0 = Math.max(Math.floor(run.left - clip.x), 0), x1 = Math.min(Math.ceil(run.right - clip.x), backdrop.w);
      const y0 = Math.max(Math.floor(run.top - clip.y), 0), y1 = Math.min(Math.ceil(run.bottom - clip.y), backdrop.h);
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
        const b = pixelAt(backdrop, x, y);
        // Glyph pixel = a probe colour covers >= half of the swing between the backdrop and that colour (the larger swing decides).
        let covered = 0;
        for (const { rgb, img } of probes) {
          const swing = b.reduce((sum, c, i) => sum + Math.abs(c - rgb[i]), 0);
          if (swing < 30) continue;
          covered = Math.max(covered, b.reduce((sum, c, i) => sum + Math.abs(c - pixelAt(img, x, y)[i]), 0) / swing);
        }
        if (covered < 0.5) continue;
        const a = fg.a * (Number.isFinite(run.opacity) ? run.opacity : 1);
        samples.push({ ratio: contrastRatio(a < 1 ? blend(fg.rgb, a, b) : fg.rgb, b), threshold });
      }
    }
    const res = classifyGlyphSamples(samples);
    return res && { ...res, fontPx: sizePx };
  };
  try {
    // A text-shadow is part of the backdrop the glyph is read against, so with one the shadowed measurement decides;
    // the plain one is kept for the message so a reader sees what the shadow rescued.
    const hasShadow = runs.some((r) => r.shadow);
    const res = await measure(hasShadow);
    if (res && hasShadow) res.withoutShadow = await measure(false).catch(() => null);
    return res;
  } finally {
    await page.evaluate((attr) => document.querySelector(`[${attr}]`)?.removeAttribute(attr), HIDE_ATTR).catch(() => {});
    await style.evaluate((n) => n.remove()).catch(() => {});
  }
}

const pct = (f) => `${Math.round(f * 100)}%`;
export const glyphMessage = (m) =>
  `Text over a non-solid backdrop, measured from pixels: lowest ${m.min.toFixed(2)}:1, median ${m.median.toFixed(2)}:1; `
  + `${pct(m.failFraction)} of ${m.pixels} glyph pixels are below ${m.threshold}:1 (WCAG 1.4.3)`
  + (m.withoutShadow ? `; with the text-shadow (${pct(m.withoutShadow.failFraction)} fail without it, lowest ${m.withoutShadow.min.toFixed(2)}:1)` : '');

/**
 * axe answers "incomplete" (no ratio) for text over images/gradients. Measure those nodes from pixels and settle them in place:
 * confirmed -> moved into the color-contrast violations, needs-review -> stays incomplete (with the numbers), pass -> dropped.
 * Unmeasurable nodes (covered, in a frame, over the cap) stay incomplete as axe left them.
 */
export async function resolveIncompleteContrast(page, results, { max = 12 } = {}) {
  await settleMotion(page);
  const group = (results.incomplete || []).find((v) => v.id === 'color-contrast');
  if (!group) return;
  const scroll = await page.evaluate(() => [scrollX, scrollY]).catch(() => null);
  const keep = [];
  const confirmed = [];
  let measured = 0;
  for (const node of group.nodes || []) {
    const selector = Array.isArray(node.target) && node.target.length === 1 && typeof node.target[0] === 'string' ? node.target[0] : null;
    let m = null;
    if (selector && measured < max) {
      measured++;
      m = await measureGlyphContrast(page, selector).catch(() => null);
    }
    if (!m) { keep.push(node); continue; }
    if (m.unmeasurable) { // stays incomplete (needs-review) with the reason, never a confirmed ratio
      node.pixelContrast = { method: 'glyph-pixel-sampling', verdict: 'needs-review', message: m.unmeasurable };
      node.failureSummary = m.unmeasurable;
      keep.push(node);
      continue;
    }
    if (m.verdict === 'pass') continue;
    const message = glyphMessage(m);
    node.pixelContrast = { method: 'glyph-pixel-sampling', verdict: m.verdict, min: +m.min.toFixed(2), median: +m.median.toFixed(2), failFraction: +m.failFraction.toFixed(3), pixels: m.pixels, threshold: m.threshold, message };
    node.failureSummary = message;
    if (m.verdict === 'confirmed') { node.impact = 'serious'; confirmed.push(node); } else keep.push(node);
  }
  group.nodes = keep;
  if (!keep.length) results.incomplete = results.incomplete.filter((v) => v !== group);
  if (confirmed.length) {
    const existing = (results.violations || []).find((v) => v.id === 'color-contrast');
    if (existing) existing.nodes.push(...confirmed);
    else (results.violations ||= []).push({ ...group, impact: 'serious', nodes: confirmed });
  }
  if (scroll) await page.evaluate(([x, y]) => scrollTo(x, y), scroll).catch(() => {});
}
