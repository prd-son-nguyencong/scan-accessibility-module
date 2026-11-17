import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { violationStableId } from '../reporter/report-v2.js';
import { canonicalSha256 } from '../reporter/fingerprint.js';
import { getSharedBuiltInRuleRegistry } from './access-scan/engine/builtin-registry.js';

const DEFAULT_MAX_SCREENSHOTS = 20;
const MAX_DETAILED = 200; // keeps AX lookups cheap on pages with thousands of findings
const SHOT_MAX = { width: 640, height: 400 };

// WCAG 2.2 success criterion -> Understanding page slug.
const SLUGS = `1.1.1 non-text-content|1.2.1 audio-only-and-video-only-prerecorded|1.2.2 captions-prerecorded|1.2.3 audio-description-or-media-alternative-prerecorded|1.2.4 captions-live|1.2.5 audio-description-prerecorded|1.2.6 sign-language-prerecorded|1.2.7 extended-audio-description-prerecorded|1.2.8 media-alternative-prerecorded|1.2.9 audio-only-live|1.3.1 info-and-relationships|1.3.2 meaningful-sequence|1.3.3 sensory-characteristics|1.3.4 orientation|1.3.5 identify-input-purpose|1.3.6 identify-purpose|1.4.1 use-of-color|1.4.2 audio-control|1.4.3 contrast-minimum|1.4.4 resize-text|1.4.5 images-of-text|1.4.6 contrast-enhanced|1.4.7 low-or-no-background-audio|1.4.8 visual-presentation|1.4.9 images-of-text-no-exception|1.4.10 reflow|1.4.11 non-text-contrast|1.4.12 text-spacing|1.4.13 content-on-hover-or-focus|2.1.1 keyboard|2.1.2 no-keyboard-trap|2.1.3 keyboard-no-exception|2.1.4 character-key-shortcuts|2.2.1 timing-adjustable|2.2.2 pause-stop-hide|2.2.3 no-timing|2.2.4 interruptions|2.2.5 re-authenticating|2.2.6 timeouts|2.3.1 three-flashes-or-below-threshold|2.3.2 three-flashes|2.3.3 animation-from-interactions|2.4.1 bypass-blocks|2.4.2 page-titled|2.4.3 focus-order|2.4.4 link-purpose-in-context|2.4.5 multiple-ways|2.4.6 headings-and-labels|2.4.7 focus-visible|2.4.8 location|2.4.9 link-purpose-link-only|2.4.10 section-headings|2.4.11 focus-not-obscured-minimum|2.4.12 focus-not-obscured-enhanced|2.4.13 focus-appearance|2.5.1 pointer-gestures|2.5.2 pointer-cancellation|2.5.3 label-in-name|2.5.4 motion-actuation|2.5.5 target-size-enhanced|2.5.6 concurrent-input-mechanisms|2.5.7 dragging-movements|2.5.8 target-size-minimum|3.1.1 language-of-page|3.1.2 language-of-parts|3.1.3 unusual-words|3.1.4 abbreviations|3.1.5 reading-level|3.1.6 pronunciation|3.2.1 on-focus|3.2.2 on-input|3.2.3 consistent-navigation|3.2.4 consistent-identification|3.2.5 change-on-request|3.2.6 consistent-help|3.3.1 error-identification|3.3.2 labels-or-instructions|3.3.3 error-suggestion|3.3.4 error-prevention-legal-financial-data|3.3.5 help|3.3.6 error-prevention-all|3.3.7 redundant-entry|3.3.8 accessible-authentication-minimum|3.3.9 accessible-authentication-enhanced|4.1.1 parsing|4.1.2 name-role-value|4.1.3 status-messages`;
const WCAG_SLUG = new Map(SLUGS.split('|').map((entry) => entry.split(' ')));

/** Success criterion ("1.4.3") from "WCAG 2.2 AA 1.4.3", "WCAG143" (axe tag) or axe evidence tags. */
export function wcagCriterion(violation) {
  const tag = (violation.evidence?.tags || []).map((t) => /^wcag(\d)(\d)(\d{1,2})$/.exec(t)).find(Boolean);
  if (tag) return `${tag[1]}.${tag[2]}.${tag[3]}`;
  const ref = String(violation.wcagRef || '');
  const dotted = /\b(\d\.\d\.\d{1,2})\b/.exec(ref);
  if (dotted) return dotted[1];
  const packed = /^WCAG(\d)(\d)(\d{1,2})$/i.exec(ref);
  return packed ? `${packed[1]}.${packed[2]}.${packed[3]}` : null;
}

export function wcagUnderstandingUrl(criterion) {
  const slug = WCAG_SLUG.get(criterion);
  return slug ? `https://www.w3.org/WAI/WCAG22/Understanding/${slug}.html` : null;
}

const IMPACT_RANK = (v) => { const i = ['critical', 'serious', 'moderate', 'minor'].indexOf(v.impact); return i < 0 ? 9 : i; };
const isConfirmed = (v) => (v.evidence?.violationType ?? 'confirmed') === 'confirmed';
// manual-review findings are questions for a human, not findings the evidence should defend.
const wantsEvidence = (v) => v.evidence?.violationType !== 'manual-review' && v.element?.selector;
const isContrast = (v, criterion) => /contrast/i.test(v.ruleId) || ['1.4.3', '1.4.6', '1.4.11'].includes(criterion);

/** Width and height from a PNG header (no decoder needed). */
export function pngSize(buffer) {
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

// One round trip for every selector: geometry and the computed styles the rules care about.
function measure(selectors) {
  return selectors.map((selector) => {
    let el;
    try { el = document.querySelector(selector); } catch { return { error: 'invalid-selector' }; }
    if (!el) return { error: 'element-not-found' };
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    let background = null;
    for (let n = el; n && !background; n = n.parentElement) {
      const c = getComputedStyle(n).backgroundColor;
      if (c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent') background = c;
    }
    return {
      box: { x: Math.round(r.x + scrollX), y: Math.round(r.y + scrollY), width: Math.round(r.width * 10) / 10, height: Math.round(r.height * 10) / 10 },
      styles: {
        color: cs.color, backgroundColor: background, fontSize: cs.fontSize, fontWeight: cs.fontWeight,
        display: cs.display, visibility: cs.visibility, opacity: cs.opacity,
      },
    };
  });
}

// Scrolls the element into view, draws the outline overlay and returns the crop (viewport coordinates).
function outline({ selector, max }) {
  const el = document.querySelector(selector);
  el.scrollIntoView({ block: 'center', inline: 'center' });
  const r = el.getBoundingClientRect();
  const box = document.createElement('div');
  box.setAttribute('data-ada-evidence-outline', '');
  box.style.cssText = `position:fixed;left:${r.left - 3}px;top:${r.top - 3}px;width:${r.width + 6}px;height:${r.height + 6}px;`
    + 'outline:3px solid #e0115f;box-sizing:border-box;pointer-events:none;z-index:2147483647';
  document.documentElement.appendChild(box);
  const width = Math.min(max.width, innerWidth);
  const height = Math.min(max.height, innerHeight);
  const clamp = (v, hi) => Math.max(0, Math.min(Math.round(v), hi));
  return {
    x: clamp(r.left + r.width / 2 - width / 2, innerWidth - width),
    y: clamp(r.top + r.height / 2 - height / 2, innerHeight - height),
    width,
    height,
  };
}

async function axInfo(cdp, selector) {
  try {
    const { root } = await cdp.send('DOM.getDocument', { depth: 0 });
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector });
    if (!nodeId) return null;
    const { nodes } = await cdp.send('Accessibility.getPartialAXTree', { nodeId, fetchRelatives: false });
    const ax = nodes[0];
    return ax ? { role: ax.role?.value ?? null, name: String(ax.name?.value ?? '').replace(/\s+/g, ' ').trim(), ignored: Boolean(ax.ignored) } : null;
  } catch {
    return null;
  }
}

async function reasonFor(violation, registry) {
  const descriptor = violation.layer === 'accessScan' ? registry?.getRule?.(violation.ruleId) : null;
  return descriptor?.reporting?.requirement || violation.evidence?.help || violation.fix?.hint || '';
}

async function screenshot(page, selector, file) {
  let shot;
  try {
    const clip = await page.evaluate(outline, { selector, max: SHOT_MAX });
    // Values typed into form fields must never end up in a saved image.
    const buffer = await page.screenshot({
      clip, scale: 'css', timeout: 5000,
      mask: [page.locator('input, textarea, select, [contenteditable]')], maskColor: '#555555',
    });
    await writeFile(file, buffer);
    shot = pngSize(buffer);
  } finally {
    await page.evaluate(() => document.querySelectorAll('[data-ada-evidence-outline]').forEach((n) => n.remove())).catch(() => {});
  }
  return shot;
}

/**
 * Lazily attaches `evidence.capture` to the page's violations once the layers are done, on the shared page:
 * reason, WCAG link, repro recipe, geometry, relevant styles, role and name from the AX tree, and a
 * screenshot crop with the element outlined for confirmed critical/serious findings (budgeted per page).
 * Never throws: a failure only means less evidence.
 */
export async function attachEvidence(page, violations, { dir, pageUrl, screenshots = {} }) {
  // Severity first, so the screenshot budget goes to the worst findings.
  const targets = violations.filter(wantsEvidence).sort((a, b) => IMPACT_RANK(a) - IMPACT_RANK(b) || (a.priority ?? 9) - (b.priority ?? 9)).slice(0, MAX_DETAILED);
  if (!targets.length) return;
  const viewport = page && !page.isClosed() ? page.viewportSize() : null;
  const shotsOn = screenshots.enabled !== false;
  const maxShots = screenshots.maxPerPage ?? DEFAULT_MAX_SCREENSHOTS;
  const registry = await getSharedBuiltInRuleRegistry().catch(() => null);
  const open = page && !page.isClosed();
  // A finding detected at another viewport (e.g. mobile-only) cannot be measured on the shared page.
  const detectedAt = (v) => v.evidence?.viewports?.[0] || viewport;
  const mismatch = (v) => Boolean(viewport) && (detectedAt(v).width !== viewport.width || detectedAt(v).height !== viewport.height);
  let measured = [];
  let cdp = null;
  try {
    if (open) {
      const fits = targets.map((v, i) => i).filter((i) => !mismatch(targets[i]));
      const results = await page.evaluate(measure, fits.map((i) => targets[i].element.selector));
      measured = targets.map(() => null);
      fits.forEach((i, k) => { measured[i] = results[k]; });
      measured.forEach((m, i) => { if (!m && mismatch(targets[i])) measured[i] = { mismatch: true }; });
      cdp = await page.context().newCDPSession(page);
    }
    if (shotsOn) await mkdir(dir, { recursive: true });
    const shotsByFile = new Map();
    let taken = 0;
    for (const [i, v] of targets.entries()) {
      const m = measured[i];
      const criterion = wcagCriterion(v);
      const capture = {
        reason: await reasonFor(v, registry),
        wcag: criterion ? { criterion, url: wcagUnderstandingUrl(criterion) } : null,
        repro: { url: pageUrl, viewport: v.evidence?.viewports?.[0] ? { width: detectedAt(v).width, height: detectedAt(v).height } : viewport, selector: v.element.selector, state: v.pageState || 'initial' },
        geometry: m?.box ? { box: m.box } : null,
        styles: null,
        ax: null,
      };
      if (m?.styles) {
        capture.styles = isContrast(v, criterion)
          ? Object.fromEntries(['color', 'backgroundColor', 'fontSize', 'fontWeight'].map((k) => [k, m.styles[k]]))
          : Object.fromEntries(['display', 'visibility', 'opacity'].map((k) => [k, m.styles[k]]));
        capture.ax = await axInfo(cdp, v.element.selector);
      }
      let skipped = m?.mismatch ? 'viewport-mismatch' : null;
      if (skipped) { /* recorded as is */ }
      else if (!shotsOn) skipped = 'disabled';
      else if (!open) skipped = 'page-closed';
      else if (!isConfirmed(v)) skipped = 'not-confirmed';
      else if (!['critical', 'serious'].includes(v.impact)) skipped = 'impact-below-serious';
      else if (!m) skipped = 'measure-failed';
      else if (m.error) skipped = m.error;
      else if (!m.box.width || !m.box.height) skipped = 'element-not-visible';
      if (!skipped) {
        // The raw selector is part of the name: stableId collapses run-specific ids, which must not hand one element's PNG to another.
        const name = `${canonicalSha256([violationStableId(v, pageUrl), v.element.selector, v.element.framePath, v.element.shadowPath]).replace(/^sha256:/, '')}.png`;
        if (shotsByFile.has(name)) capture.screenshot = shotsByFile.get(name);
        else if (taken >= maxShots) skipped = 'budget';
        else {
          try {
            const size = await screenshot(page, v.element.selector, path.join(dir, name));
            taken += 1;
            capture.screenshot = { file: `evidence/${name}`, ...size };
            shotsByFile.set(name, capture.screenshot);
          } catch (err) {
            skipped = `capture-failed: ${err.message.split('\n')[0]}`;
          }
        }
      }
      if (skipped) capture.screenshot = { skipped };
      v.evidence = { ...v.evidence, capture };
    }
  } catch (err) {
    console.log(`  evidence: skipped (${err.message.split('\n')[0]})`);
  } finally {
    await cdp?.detach().catch(() => {});
  }
}

/** Deletes PNGs in `dir` that no finding references (flaky, deduplicated or earlier-run leftovers); returns how many. */
export async function reconcileEvidence(dir, violations) {
  const referenced = new Set(violations.map((v) => v.evidence?.capture?.screenshot?.file).filter(Boolean).map((f) => path.basename(f)));
  const stale = (await readdir(dir).catch(() => [])).filter((f) => f.endsWith('.png') && !referenced.has(f));
  await Promise.all(stale.map((f) => rm(path.join(dir, f), { force: true })));
  return stale.length;
}
