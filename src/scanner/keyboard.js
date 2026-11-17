import { acquirePage } from './session.js';
import { mapDescriptionToSource, mapViolationToSource } from '../tracer/partial-map.js';
import { resolveFromElementText, toSource } from '../tracer/resolve-source.js';
import { getProjectRoot } from '../utils/paths.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { FREEZE_MOTION_CSS, blend, contrastRatio, clipAround, grabPixels, medianColor, parseCssColor, ringContrast, ringPresent, sampleSides } from './pixel-contrast.js';

// Tab stops traversed per page: ~25 ms each plus the screenshot budgets below, so a long PDK page stays within a few tens of seconds. A page with more stops gets a note in `passes`.
const MAX_TAB_ITERATIONS = 400;
// shortcut: a skip link must be among the first 10 focusable stops (room for a consent banner before the header); upgrade to the first stop outside injected widgets if sites bury it deeper.
const SKIP_LINK_WINDOW = 10;
const INVISIBLE_TAB_WINDOW = 40; // Tab presses watched for focus landing on an invisible element
const MIN_FOCUS_CONTRAST = 3.0; // WCAG 1.4.11 non-text contrast (focus ring vs adjacent pixels); the fill-only change check uses it as the 2.4.13 (AAA) change-of-contrast bar
const MAX_PROOF_SAMPLES = 80; // focused-vs-blurred screenshot pairs for the no-indicator proof per page
const MAX_RING_SAMPLES = 60; // screenshots taken for focus-ring sampling per page (bounds runtime)
const MOBILE_FOCUS_VIEWPORT = { name: 'mobile', width: 390, height: 844 }; // a toggle that only renders below the desktop breakpoint (hamburger) is Tab-focused here
const MAX_MOBILE_FOCUS_STOPS = 12;
const TABBABLE = 'a[href], button:not([disabled]), input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex^="-"])';


/**
 * Runs in the page (injected as source): why an element that is in the tab order cannot be seen, or null. Display none, visibility hidden,
 * inert and aria-hidden are not here (they leave the tab order or are other rules). Evaluated at the element's focus state, so a skip link
 * that appears on focus is visible.
 */
export function invisibleReason(el) {
  if (el.closest('[inert], [aria-hidden="true"]')) return null; // a separate rule (aria-hidden-focus) owns these
  let opacity = 1;
  for (let n = el; n && n.nodeType === 1; n = n.parentElement) opacity *= parseFloat(getComputedStyle(n).opacity);
  if (opacity === 0) return 'opacity 0';
  const cs = getComputedStyle(el);
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return 'zero size';
  if (/rect\(\s*(?:0|1)(?:px)?[\s,]+(?:0|1)(?:px)?[\s,]+(?:0|1)(?:px)?[\s,]+(?:0|1)(?:px)?\s*\)/.test(cs.clip) || /inset\(\s*(?:50|100)%/.test(cs.clipPath)) return 'clipped';
  if (r.width <= 1 && r.height <= 1) return 'clipped to 1px';
  const root = document.scrollingElement || document.documentElement;
  const x = r.left + window.scrollX;
  const y = r.top + window.scrollY;
  if (x + r.width <= 0 || y + r.height <= 0 || x >= Math.max(root.scrollWidth, window.innerWidth)) return 'offscreen';
  return null;
}

/** Runs in the page: tabbable elements that are not visible, with a short selector and the reason each is invisible. */
function collectInvisibleStops(reasonSrc) {
  const reasonOf = new Function(`return ${reasonSrc}`)();
  const selectorOf = (el) => {
    if (el.id) return `${el.tagName.toLowerCase()}#${CSS.escape(el.id)}`;
    const cls = [...el.classList].slice(0, 2).map((c) => `.${CSS.escape(c)}`).join('');
    const same = el.parentElement ? [...el.parentElement.children].filter((c) => c.tagName === el.tagName) : [];
    return `${el.tagName.toLowerCase()}${cls}${same.length > 1 ? `:nth-of-type(${same.indexOf(el) + 1})` : ''}`;
  };
  const isSkip = (el) => el.tagName === 'A' && (el.getAttribute('href') || '').startsWith('#') && /\b(skip|jump)\b|^(go to )?(the )?(main )?content$/i.test(`${el.textContent || ''} ${el.getAttribute('aria-label') || ''}`.trim());
  const stops = [...document.querySelectorAll('a[href], button:not([disabled]), input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex^="-"])')]
    .filter((el) => el.checkVisibility({ visibilityProperty: true }) && !el.closest('[inert], [aria-hidden="true"]') && !isSkip(el));
  return stops.map((el) => ({ el, reason: reasonOf(el) })).filter((x) => x.reason)
    .map(({ el, reason }) => ({ selector: selectorOf(el), container: selectorOf(el.closest('ul, ol, nav, [class*="menu"], [class*="drawer"], [class*="dropdown"]') || el.parentElement || el), reason, tag: el.tagName, text: (el.textContent || '').trim().slice(0, 80), html: el.outerHTML.slice(0, 300) }));
}

/** "in ul.menu (17), nav.drawer (4)": the invisible stops grouped by the container that holds them, so one closed menu reads as one cause. */
function containerCounts(stops) {
  const by = new Map();
  for (const s of stops) by.set(s.container || 'document', (by.get(s.container || 'document') || 0) + 1);
  return `in ${[...by].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([c, n]) => `${c} (${n})`).join(', ')}`;
}

/**
 * Layer 2: Keyboard Navigation Scanner
 *
 * Tests:
 * 1. No focus indicator suppressed via outline:none without a replacement
 * 2. All interactive elements are reachable by Tab (deduplication by fingerprint)
 * 3. Each focusable element's style changes on focus (compared with its unfocused state)
 * 4. Focus indicator contrast ≥ 3:1 against the pixels next to the ring (WCAG 1.4.11); a ring clipped by an overflow ancestor is a separate note
 * 5. Focus order follows the DOM order (no backward jumps from tabindex/reordering)
 * 6. Skip navigation link present as first focusable element, and its #target exists
 */
export async function scanKeyboardNavigation(pageUrl, opts = {}) {
  const { page, close } = await acquirePage(pageUrl, opts);
  const violations = [];
  const passes = [];

  try {
    // An empty page (no content elements) has nothing to tab through or skip: other layers classify it.
    const empty = await page.evaluate(() => !document.body || (!document.body.innerText.trim()
      && Array.from(document.body.children).every((c) => ['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'LINK'].includes(c.tagName))));
    if (empty) return { url: pageUrl, violations: [], passes: [], timestamp: new Date().toISOString() };

    // 1. Detect CSS focus indicator suppression
    const focusCssViolations = await page.evaluate(() => {
      const results = [];
      for (const sheet of document.styleSheets) {
        try {
          // Skip external stylesheets (different origin) — not under project control
          const sheetHref = sheet.href || '';
          if (sheetHref && !sheetHref.startsWith(location.origin)) continue;

          for (const rule of sheet.cssRules) {
            const text = rule.cssText || '';
            if (
              (text.includes(':focus') || text.includes(':focus-visible')) &&
              (text.includes('outline: none') ||
                text.includes('outline:none') ||
                text.includes('outline: 0') ||
                text.includes('outline:0'))
            ) {
              // :focus:not(:focus-visible) { outline:none } is the standard progressive
              // enhancement pattern — keyboard users get :focus-visible, mouse users don't.
              if (text.includes(':focus:not(:focus-visible)')) continue;

              // Check if the selector targets elements that are actually authored by the project.
              // Strip pseudo-classes/pseudo-elements to get a valid querySelector string.
              const rawSelector = (rule.selectorText || '').replace(/:[\w-]+(\([^)]*\))?/g, '').trim();
              if (rawSelector) {
                try {
                  const matched = document.querySelectorAll(rawSelector);
                  // If no elements match, or all matched elements are inside a runtime-injected
                  // widget (no data-scan-id ancestor → not from our Liquid templates), skip.
                  const isProjectAuthored = Array.from(matched).some(
                    (el) => el.closest('[data-scan-id]') || el.hasAttribute('data-scan-id')
                  );
                  if (!isProjectAuthored) continue;
                } catch {
                  // Invalid selector after stripping — skip
                }
              }

              // Only a real violation if no replacement indicator is present
              if (
                !text.includes('box-shadow') &&
                !text.includes('border') &&
                !text.includes('background') &&
                !text.includes('ring')
              ) {
                results.push({
                  rule: 'focus-indicator-removed',
                  description: 'Focus indicator suppressed without replacement',
                  matchSelector: rawSelector,
                  snippet: text.slice(0, 200),
                  impact: 'serious',
                  wcagCriteria: '2.4.7',
                });
              }
            }
          }
        } catch {
          // Cross-origin stylesheets throw SecurityError — skip silently
        }
      }
      return results;
    });
    // A stylesheet rule cannot show that nothing replaces the ring (a `:focus-visible { box-shadow }` rule or a utility class elsewhere does): a question until the
    // Tab pass below measures an element this selector matches with identical pixels focused vs blurred.
    for (const v of focusCssViolations) {
      v.verdict = 'needs-review';
      v.description += ' (stylesheet only: no focused element matching this selector was measured without a visible cue)';
    }
    violations.push(...focusCssViolations);

    // 2. Tab traversal — deduplication via element fingerprint
    const focusableCount = await page.evaluate(() =>
      document.querySelectorAll(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      ).length
    );

    // Transitions would leave the focused/unfocused style comparison mid-animation.
    await page.addStyleTag({ content: FREEZE_MOTION_CSS });

    const invisibleStops = await page.evaluate(`(${collectInvisibleStops.toString()})(${JSON.stringify(invisibleReason.toString())})`);
    const landedInvisible = [];
    const tabOrder = [];
    let ringSamples = 0;
    let proofSamples = 0;
    const reportedClipped = new Set();
    const reportedObscuredBy = new Set(); // deduplicate sticky-obscure violations per chrome element
    let orderViolations = 0;
    const iterations = Math.min(focusableCount + 5, MAX_TAB_ITERATIONS);
    await page.evaluate(() => { window.__adaScanSeen = new WeakSet(); });

    for (let i = 0; i < iterations; i++) {
      await page.keyboard.press('Tab');

      const focusData = await page.evaluate((reasonSrc) => {
        const el = document.activeElement;
        if (!el || el === document.body) return null;
        const rect = el.getBoundingClientRect();
        const styles = window.getComputedStyle(el);

        // Focus indicator = a visual property that differs from the unfocused element.
        // A static border or shadow that is always there is not an indicator.
        const PROPS = [
          'outlineStyle', 'outlineWidth', 'outlineColor', 'boxShadow', 'backgroundColor', 'color',
          'borderTopColor', 'borderRightColor', 'borderBottomColor', 'borderLeftColor',
          'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
          'textDecorationLine', 'textDecorationColor', 'textDecorationThickness',
        ];
        const snap = () => PROPS.map((p) => window.getComputedStyle(el)[p]);
        // The cue may sit on a wrapper (:focus-within) or a sibling label (custom checkbox): their style change means the focus is shown elsewhere.
        const related = [el.parentElement, el.parentElement?.parentElement, el.previousElementSibling, el.nextElementSibling].filter((n) => n && n !== document.body && n !== document.documentElement);
        const snapRelated = () => related.map((n) => PROPS.map((p) => window.getComputedStyle(n)[p]).join('|'));
        const focused = snap();
        // A transparent fill sits on the nearest ancestors' backdrop: flatten it so a translucent baseline is measured, not skipped. Null when a gradient or image is behind.
        const flatFill = (own) => {
          const num = (c) => { const v = (c.match(/[\d.]+/g) || []).map(Number); return { rgb: v.slice(0, 3), a: v.length > 3 ? v[3] : 1 }; };
          const layers = [num(own)];
          for (let n = el.parentElement; n && layers[layers.length - 1].a < 1; n = n.parentElement) {
            const cs = window.getComputedStyle(n);
            if (cs.backgroundImage !== 'none') return null;
            layers.push(num(cs.backgroundColor));
          }
          let out = [255, 255, 255];
          for (const l of layers.reverse()) out = out.map((v, i) => Math.round(l.rgb[i] * l.a + v * (1 - l.a)));
          return `rgb(${out.join(', ')})`;
        };
        const fillFocusedFlat = flatFill(focused[4]);
        const relatedFocused = snapRelated();
        // Loop and duplicate detection by element identity: two controls with the same text at the same spot (stacked slides, mobile and desktop copies) are distinct stops.
        const seenSet = window.__adaScanSeen || (window.__adaScanSeen = new WeakSet());
        const alreadySeen = seenSet.has(el);
        seenSet.add(el);
        const focusedShadow = styles.boxShadow;
        const outlineShown = styles.outlineStyle !== 'none' && parseFloat(styles.outlineWidth) > 0;
        const { outlineColor, outlineStyle, outlineWidth, outlineOffset } = styles;
        el.blur();
        const baseline = snap();
        const baselineShadow = window.getComputedStyle(el).boxShadow;
        const fillBaselineFlat = flatFill(baseline[4]);
        const relatedAfter = snapRelated();
        const changedNodes = related.filter((n, i) => relatedAfter[i] !== relatedFocused[i]);
        const relatedChanged = changedNodes.length > 0;
        el.focus({ preventScroll: true });
        const hasIndicator = focused.some((v, i) => v !== baseline[i]);
        // A background change as the only cue (no outline, ring, border, underline or text colour change): weak, measured against the unfocused fill in Node.
        const fillOnly = hasIndicator && focused[4] !== baseline[4] && focused.every((v, i) => i === 4 || v === baseline[i]);
        const hasOutline = outlineShown && (focused[0] !== baseline[0] || focused[1] !== baseline[1] || focused[2] !== baseline[2]);

        // Document-order position: did focus move backward in the DOM relative to the previous stop?
        const prev = window.__adaScanPrevFocus;
        const prevRel = prev && prev.isConnected && prev !== el ? prev.compareDocumentPosition(el) : 0;
        const domBackward = !(prevRel & Node.DOCUMENT_POSITION_DISCONNECTED) && !!(prevRel & Node.DOCUMENT_POSITION_PRECEDING);
        window.__adaScanPrevFocus = el;

        // WCAG 2.4.11 Focus Not Obscured: what is actually painted at the element's centre and corners (elementFromPoint is
        // stacking- and z-index-aware). A fixed/sticky element that covers the centre hides the focus; a covered corner alone does not.
        const coverOf = (x, y) => {
          if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return null;
          const top = document.elementFromPoint(x, y);
          if (!top || top === el || el.contains(top) || top.contains(el)) return null;
          for (let n = top; n && n !== document.documentElement; n = n.parentElement) {
            const p = window.getComputedStyle(n).position;
            if (p === 'fixed' || p === 'sticky') return n;
          }
          return null;
        };
        const centreCover = () => {
          const r = el.getBoundingClientRect();
          return coverOf(r.left + r.width / 2, r.top + r.height / 2);
        };
        // A fixed/sticky control is the overlay itself, and a page with no scrollable overflow never scrolls focus clear of anything: neither is measured.
        let fixedSelf = false;
        for (let n = el; n && n !== document.documentElement; n = n.parentElement) if (['fixed', 'sticky'].includes(window.getComputedStyle(n).position)) fixedSelf = true;
        const scroller = document.scrollingElement || document.documentElement;
        const scrollable = scroller.scrollHeight > window.innerHeight + 1;
        let cover = rect.width > 0 && rect.height > 0 && scrollable && !fixedSelf ? centreCover() : null;
        if (cover) {
          // Focus scrolling already ran; scrollIntoView honours the page's scroll-padding/-margin the same way. Covered after both = real.
          el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
          cover = centreCover();
        }
        const obscuredBy = cover ? {
          tag: cover.tagName.toLowerCase(),
          id: cover.id || '',
          className: (cover.getAttribute('class') || '').slice(0, 60),
          position: window.getComputedStyle(cover).position,
          viewport: `${innerWidth}x${innerHeight}`,
          scrollPaddingTop: window.getComputedStyle(document.documentElement).scrollPaddingTop,
        } : null;

        let crossOriginFrame = false;
        if (el.tagName === 'IFRAME') {
          try { crossOriginFrame = !el.contentDocument; } catch { crossOriginFrame = true; }
        }
        const finalRect = el.getBoundingClientRect(); // after any scroll above
        // The pixel comparison covers the control and every wrapper or sibling whose style changed on focus: that is where a cue would be drawn.
        const compareRect = { left: finalRect.left, top: finalRect.top, right: finalRect.right, bottom: finalRect.bottom };
        for (const n of changedNodes) {
          const b = n.getBoundingClientRect();
          compareRect.left = Math.min(compareRect.left, b.left); compareRect.top = Math.min(compareRect.top, b.top);
          compareRect.right = Math.max(compareRect.right, b.right); compareRect.bottom = Math.max(compareRect.bottom, b.bottom);
        }

        return {
          tag: el.tagName,
          role: el.getAttribute('role'),
          ariaLabel: el.getAttribute('aria-label'),
          title: el.getAttribute('title'),
          text: (el.textContent || '').trim().slice(0, 80),
          html: el.outerHTML.slice(0, 300),
          x: Math.round(finalRect.left + window.scrollX),
          y: Math.round(finalRect.top + window.scrollY),
          rect: { left: finalRect.left, top: finalRect.top, right: finalRect.right, bottom: finalRect.bottom },
          compareRect,
          alreadySeen,
          hasIndicator,
          fillOnly,
          fillFocused: fillFocusedFlat || focused[4],
          fillBaseline: fillBaselineFlat || baseline[4],
          relatedChanged,
          hasOutline,
          isVisible: rect.width > 0 && rect.height > 0,
          outline: { style: outlineStyle, width: parseFloat(outlineWidth) || 0, offset: parseFloat(outlineOffset) || 0, color: outlineColor },
          boxShadow: focusedShadow,
          baselineBoxShadow: baselineShadow,
          domBackward,
          obscuredBy,
          crossOriginFrame,
          invisible: new Function(`return ${reasonSrc}`)()(el),
          // Custom checkboxes and radios are often drawn on their label: the input itself is invisible by design, a question not a failure.
          customControl: el.tagName === 'INPUT' && /^(checkbox|radio|file)$/.test(el.type),
        };
      }, invisibleReason.toString());

      if (!focusData) break;

      // Tab wrapped around to a stop already measured: skip it
      if (focusData.alreadySeen) continue;
      tabOrder.push(focusData);
      if (focusData.invisible && i < INVISIBLE_TAB_WINDOW) landedInvisible.push(focusData);

      const label = focusData.text || focusData.ariaLabel || focusData.title || '(no label)';
      const tagLc = focusData.tag.toLowerCase();

      // Check visible focus indicator
      if (focusData.isVisible && !focusData.hasIndicator) {
        if (focusData.crossOriginFrame) {
          // Focus moves into the frame; its own ring cannot be inspected from here, so this is a question, not a failure.
          violations.push({
            rule: 'focus-in-cross-origin-frame',
            description: `Cannot verify the focus indicator inside the cross-origin frame <${tagLc}> "${label}" (cross-origin: its content cannot be inspected); check it by keyboard`,
            impact: 'minor',
            wcagCriteria: '2.4.7',
            element: { tag: focusData.tag, text: focusData.text || focusData.title || '', html: focusData.html },
          });
        } else {
          // A same-origin iframe transfers focus to its inner document, so the element itself reports outline:none even when a
          // :focus-visible rule exists. Verify via stylesheet scan.
          let hasCssRule = false;
          if (focusData.tag === 'IFRAME') {
            hasCssRule = await page.evaluate(() => {
              for (const sheet of document.styleSheets) {
                try {
                  for (const rule of sheet.cssRules) {
                    const sel = rule.selectorText || '';
                    const text = rule.cssText || '';
                    if (sel.includes('iframe') && sel.includes('focus') &&
                        (text.includes('outline') || text.includes('box-shadow') || text.includes('border'))) {
                      return true;
                    }
                  }
                } catch { /* cross-origin sheet */ }
              }
              return false;
            });
          }
          if (!hasCssRule) {
            // Confirmed only when the pixels around the element (and around any wrapper or sibling whose style changed on focus) are identical focused and blurred:
            // identical pixels prove no visible cue whatever the computed styles say.
            const pixelsSame = !focusData.customControl && proofSamples < MAX_PROOF_SAMPLES
              ? (proofSamples++, await focusPixelsUnchanged(page, focusData.compareRect || focusData.rect)) : null;
            const o = focusData.outline;
            const measured = `focused by Tab: outline ${o.style} ${o.width}px, box-shadow ${focusData.boxShadow}, border, background and text style unchanged`
              + (focusData.relatedChanged && pixelsSame !== true ? '; the style of its wrapper or a sibling changes on focus (cue may be shown there)' : pixelsSame === true ? `; pixels around the element${focusData.relatedChanged ? ' and the wrapper or a sibling whose style changes on focus' : ''} are identical focused and blurred` : pixelsSame === false ? '; pixels around the element differ focused vs blurred (cue not in its own styles)' : '; pixels not compared');
            if (pixelsSame === true && focusCssViolations.length) {
              // This element has no visible cue: a stripped-outline rule that selects it is now measured, not guessed.
              const hit = await page.evaluate((sels) => sels.map((q) => { try { return Boolean(q) && document.activeElement?.matches(q); } catch { return false; } }), focusCssViolations.map((v) => v.matchSelector));
              hit.forEach((h, k) => {
                const v = focusCssViolations[k];
                if (!h || v.verdict === 'confirmed') return;
                v.verdict = 'confirmed';
                v.description = `Focus indicator suppressed without replacement: \`${v.matchSelector}\` matches the focused <${tagLc}> "${label}" and ${measured}`;
              });
            }
            violations.push({
              rule: 'focus-not-visible',
              description: `Interactive element <${tagLc}> "${label}" has no visible focus indicator (${measured})`,
              impact: 'serious',
              wcagCriteria: '2.4.7',
              verdict: pixelsSame === true ? 'confirmed' : 'needs-review',
              element: { tag: focusData.tag, text: focusData.text, html: focusData.html },
            });
          }
        }
      } else if (focusData.fillOnly && focusData.isVisible) {
        const a = parseCssColor(focusData.fillFocused);
        const b = parseCssColor(focusData.fillBaseline);
        // Opaque fills only: a translucent fill needs the backdrop, which is not measured here.
        const ratio = a && b && a.a === 1 && b.a === 1 ? contrastRatio(a.rgb, b.rgb) : null;
        if (ratio !== null && ratio < MIN_FOCUS_CONTRAST) {
          violations.push({
            rule: 'focus-indicator-low-contrast',
            // This compares the focused fill with the same element unfocused: the change-of-contrast test of 2.4.13 Focus Appearance (AAA), not 1.4.11 (indicator vs adjacent colours).
            description: `The only focus cue of <${tagLc}> "${label}" is a background change ${focusData.fillBaseline} to ${focusData.fillFocused}, ${ratio.toFixed(2)}:1 against the unfocused state, below the ${MIN_FOCUS_CONTRAST}:1 change-of-contrast bar of WCAG 2.4.13 Focus Appearance, level AAA (no outline, ring, border or underline); not a failure of an A or AA criterion`,
            impact: 'minor',
            wcagCriteria: '2.4.13',
            element: { tag: focusData.tag, text: focusData.text, html: focusData.html, contrastRatio: ratio.toFixed(2) },
          });
        }
      } else if (focusData.hasIndicator && focusData.isVisible && ringSamples < MAX_RING_SAMPLES) {
        const candidates = ringCandidates(focusData);
        if (candidates.length > 0 && !candidates.some((c) => c.kind === 'ua-auto')) {
          ringSamples++;
          const found = await checkFocusRing(page, focusData, candidates, label, reportedClipped);
          if (found) violations.push(found);
        }
      }

      // Check focus obscured by sticky/fixed header or footer (WCAG 2.4.11 Focus Not Obscured)
      if (focusData.isVisible && focusData.obscuredBy) {
        const by = focusData.obscuredBy;
        const obscureKey = `${by.tag}#${by.id}.${by.className}`;
        if (!reportedObscuredBy.has(obscureKey)) {
          reportedObscuredBy.add(obscureKey);
          violations.push({
            rule: 'focus-obscured-by-sticky',
            description: `Focused <${tagLc}> "${label}" is covered by ${by.position} <${by.tag}>${by.id ? `#${by.id}` : ''} — keyboard users cannot see it (WCAG 2.4.11; viewport ${by.viewport}px)`,
            impact: 'serious',
            wcagCriteria: '2.4.11',
            element: { tag: focusData.tag, text: focusData.text, html: focusData.html, obscuredBy: by },
          });
        }
      }

      // Focus order: a stop that comes before the previous one in the DOM means tabindex or
      // reordering broke the sequence (scroll position and viewport coordinates do not matter).
      if (focusData.domBackward) orderViolations++;
    }

    if (orderViolations > 2) {
      violations.push({
        rule: 'focus-order-illogical',
        description: `Focus order appears illogical — ${orderViolations} focus stops moved backward relative to the DOM order`,
        impact: 'moderate',
        wcagCriteria: '2.4.3',
        element: null,
      });
    }

    // Invisible focus stops (WCAG 2.4.7): tabbable but not visible (closed menu links at opacity 0, clipped, offscreen). Confirmed when focus really lands on one
    // during the Tab simulation (measured at its focus state); a stop only listed from the static pass (focus never reached it) is a question.
    if (invisibleStops.length || landedInvisible.length) {
      const named = (list) => list.slice(0, 5).map((x) => `${x.selector || `${x.tag.toLowerCase()} "${x.text}"`} (${x.invisible || x.reason})`).join(', ');
      const landed = landedInvisible.filter((x) => !x.customControl);
      const first = landed[0] || landedInvisible[0] || invisibleStops[0];
      violations.push({
        rule: 'focus-invisible-stop',
        description: `${invisibleStops.length} tabbable element${invisibleStops.length === 1 ? ' is' : 's are'} not visible (opacity 0, clipped, offscreen or zero size) yet stay${invisibleStops.length === 1 ? 's' : ''} in the tab order`
          + `${invisibleStops.length ? `, first: ${named(invisibleStops)}; ${containerCounts(invisibleStops)}` : ''}. Focus landed on ${landedInvisible.length} invisible element${landedInvisible.length === 1 ? '' : 's'} in the first ${INVISIBLE_TAB_WINDOW} Tab presses`
          + `${landedInvisible.length ? `: ${named(landedInvisible.map((x) => ({ ...x, selector: x.tag.toLowerCase() + (x.text ? ` "${x.text.slice(0, 30)}"` : '') })))}` : ''} (WCAG 2.4.7, 2.4.11)`,
        impact: 'serious',
        wcagCriteria: '2.4.7',
        verdict: landed.length ? 'confirmed' : 'needs-review',
        element: { tag: first.tag, text: first.text || '', html: first.html, selector: first.selector },
      });
    }

    if (focusableCount > 0 && tabOrder.length > 0) {
      passes.push(`${tabOrder.length} of ~${focusableCount} interactive elements reached by keyboard${focusableCount + 5 > MAX_TAB_ITERATIONS ? ` (Tab traversal is capped at ${MAX_TAB_ITERATIONS} presses: later stops were not measured)` : ''}`);
    }

    // 3. Skip navigation link: an in-page link named skip/main/content among the first few focusable elements (a consent banner or other injected widget
    // placed before the header may own the first stops), and its #target must exist in the DOM.
    const skip = await page.evaluate((window_) => {
      const stops = [...document.querySelectorAll('a[href], button:not([disabled]), input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex^="-"])')]
        .filter((el) => el.checkVisibility() && !el.closest('[aria-hidden="true"], [inert]'))
        .slice(0, window_);
      const nameOf = (el) => `${el.textContent || ''} ${el.getAttribute('aria-label') || ''}`.trim();
      // A skip link names the bypass ("Skip to main content", "Main content", "Jump to content") and has a real fragment: "Main menu" or href="#" is navigation.
      const isSkipName = (t) => /\b(skip|jump)\b/i.test(t) || /^(go to )?(the )?(main|page)?\s*content$|^(go to )?(the )?main( content)?$/i.test(t.trim());
      const first = stops.find((el) => el.tagName === 'A' && (el.getAttribute('href') || '').length > 1 && el.getAttribute('href').startsWith('#') && isSkipName(nameOf(el)));
      if (!first) {
        // What a bypass would skip: header/nav blocks holding several stops before the content, and something to skip to (a main landmark or headings).
        const visibleStops = [...document.querySelectorAll('a[href], button:not([disabled]), input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex^="-"])')]
          .filter((el) => el.checkVisibility() && !el.closest('[aria-hidden="true"], [inert]'));
        const chrome = visibleStops.filter((el) => el.closest('header, nav, [role="banner"], [role="navigation"]'));
        const mainEl = document.querySelector('main, [role="main"]');
        const beforeMain = mainEl ? chrome.filter((el) => !mainEl.contains(el) && (el.compareDocumentPosition(mainEl) & Node.DOCUMENT_POSITION_FOLLOWING)) : chrome;
        const describe = (el) => `${el.tagName.toLowerCase()} "${nameOf(el).replace(/\s+/g, ' ').trim().slice(0, 40) || '(no name)'}"${el.getAttribute('href') ? ` -> ${el.getAttribute('href').slice(0, 60)}` : ''}`;
        return {
          present: false, checked: stops.length,
          firstStops: stops.slice(0, 5).map(describe),
          repeatedStops: beforeMain.length,
          hasTarget: Boolean(mainEl || document.querySelector('h1, h2')),
          // Landmarks and headings are bypass techniques of their own (ARIA11, H69): a page that has either is not a 2.4.1 failure.
          hasBypassStructure: Boolean(mainEl || document.querySelector('h1, h2, h3, h4, h5, h6, [role="heading"]')),
        };
      }
      const href = first.getAttribute('href') || '';
      const text = nameOf(first);
      let id = '';
      try { id = decodeURIComponent(href.slice(1)); } catch { id = href.slice(1); }
      // #top and an empty fragment scroll to the top of the document without a target element.
      const targetMissing = id !== '' && id.toLowerCase() !== 'top'
        && !document.getElementById(id) && document.getElementsByName(id).length === 0;
      return { present: true, targetMissing, id, text: text.slice(0, 80), html: first.outerHTML.slice(0, 300), tag: first.tagName };
    }, SKIP_LINK_WINDOW);

    if (!skip.present) {
      // Confirmed only when no bypass mechanism exists at all: no skip link, no main landmark, no headings, and a repeated block (3+ header/nav stops).
      // A page with a main landmark or headings passes 2.4.1 through landmark navigation, so the missing skip link is a recommendation (likely).
      const repeated = skip.repeatedStops >= 3;
      const verdict = repeated && !skip.hasBypassStructure ? 'confirmed' : repeated && skip.hasTarget ? 'likely' : 'needs-review';
      violations.push({
        rule: 'skip-link-missing',
        description: `No skip navigation link found among the first ${SKIP_LINK_WINDOW} focusable elements (bypass blocks, WCAG 2.4.1). First ${skip.firstStops.length} focusable stops: ${skip.firstStops.join('; ')}. `
          + `${skip.repeatedStops} header/nav stop${skip.repeatedStops === 1 ? '' : 's'} come before the content; ${skip.hasTarget ? 'a main landmark or heading is there to skip to' : 'no main landmark or heading to skip to'}`,
        impact: 'moderate',
        wcagCriteria: '2.4.1',
        verdict,
        element: null,
      });
    } else if (skip.targetMissing) {
      violations.push({
        rule: 'skip-link-target-missing',
        canonicalRuleId: 'skip-link', // same canonical id as the axe and Lighthouse skip-link rules, so the reports merge them
        description: `Skip link "${skip.text}" points to #${skip.id}, but no element with that id exists on the page (WCAG 2.4.1)`,
        impact: 'serious',
        wcagCriteria: '2.4.1',
        element: { tag: skip.tag, text: skip.text, html: skip.html },
        pageLevel: true, // the missing target is a page defect (the page's <main>), not the layout's skip link
      });
    } else {
      passes.push('Skip navigation link present');
    }

    // Controls that only render below the desktop breakpoint (a hamburger) have no desktop Tab stop: measured at the mobile width, then the viewport is restored.
    // Identity is the element object (kept in the page) or tag + id + name + href, never its markup: a focus handler, a resize handler or an autoplay script rewrites classes and attributes.
    try { violations.push(...await scanMobileOnlyFocus(page)); } catch { /* skip this pass, keep the desktop results */ }
  } finally {
    await close();
  }

  const fallbackSource = await mapDescriptionToSource(pageUrl);
  const enrichedViolations = await Promise.all(
    violations.map(async (v) => {
      let source;
      if (v.pageLevel) {
        source = await pageTemplateSource(pageUrl, fallbackSource);
      } else if (v.element?.html) {
        // Strategy A/B: HTML snippet → partial-file-search or page-html-comment
        source = await mapViolationToSource({ html: v.element.html }, pageUrl);
      } else if (v.element?.tag && v.element?.text) {
        // Strategy C: tag + text fingerprint search in rendered page HTML
        source = toSource(await resolveFromElementText(v.element.tag, v.element.text, pageUrl)) || fallbackSource;
      } else {
        source = fallbackSource;
      }
      return { ...v, layer: 'keyboard', source };
    })
  );
  return { url: pageUrl, violations: enrichedViolations, passes, timestamp: new Date().toISOString() };
}

/** Page template for a defect that lives in the page, with the line of its <main> when readable. */
async function pageTemplateSource(pageUrl, fallbackSource) {
  const source = { ...fallbackSource };
  try {
    const text = readFileSync(path.join(getProjectRoot(), source.file), 'utf8');
    const index = text.search(/<main\b/i);
    if (index >= 0) { source.line = text.slice(0, index).split('\n').length; source.confidence = 'medium'; }
  } catch { /* no source project or file: keep the page-level guess */ }
  return source;
}

// ─── Focus indicator contrast (WCAG 1.4.11) ──────────────────────────────────

function splitShadows(css) {
  const parts = [];
  let depth = 0, start = 0;
  for (let i = 0; i < css.length; i++) {
    if (css[i] === '(') depth++;
    else if (css[i] === ')') depth--;
    else if (css[i] === ',' && depth === 0) { parts.push(css.slice(start, i)); start = i + 1; }
  }
  parts.push(css.slice(start));
  return parts.map((p) => p.trim()).filter((p) => p && p !== 'none');
}

/** Computed box-shadow value -> [{ color, dx, dy, blur, spread, inset, raw }]. */
export function parseBoxShadows(css) {
  return splitShadows(css || '').map((raw) => {
    const color = parseCssColor(raw.match(/rgba?\([^)]*\)/)?.[0]);
    const nums = (raw.replace(/rgba?\([^)]*\)/, '').match(/-?[\d.]+px|\b0\b/g) || []).map(parseFloat);
    return { raw, color, dx: nums[0] || 0, dy: nums[1] || 0, blur: nums[2] || 0, spread: nums[3] || 0, inset: /\binset\b/.test(raw) };
  });
}

/**
 * The rings the focus state adds: the outline, and solid box-shadow rings that are new since blur. Each has the band it covers,
 * measured outward from the border box (negative = inside). A UA `auto` outline is the browser's two-tone ring: always fine.
 */
export function ringCandidates(fd) {
  const out = [];
  const o = fd.outline;
  if (fd.hasOutline && o.style !== 'none' && o.width > 0) {
    if (o.style === 'auto') out.push({ kind: 'ua-auto' });
    else out.push({ kind: 'outline', color: parseCssColor(o.color), inner: o.offset, outer: o.offset + o.width, label: `${o.width}px ${o.style} outline, offset ${o.offset}px` });
  }
  const before = new Set(parseBoxShadows(fd.baselineBoxShadow).map((s) => s.raw));
  for (const s of parseBoxShadows(fd.boxShadow)) {
    if (before.has(s.raw) || s.inset || s.dx !== 0 || s.dy !== 0 || s.blur > 1 || s.spread <= 0 || !s.color) continue;
    out.push({ kind: 'box-shadow', color: s.color, inner: 0, outer: s.spread, label: `${s.spread}px box-shadow ring` });
  }
  return out.filter((c) => c.kind === 'ua-auto' || c.color);
}

/** In-page: does an overflow ancestor cut the ring (rect grown by reach px)? Returns the clipping ancestor or null. */
function findRingClipper(reach) {
  const el = document.activeElement;
  if (!el) return null;
  const r = el.getBoundingClientRect();
  for (let p = el.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
    const cs = getComputedStyle(p);
    if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue;
    const pr = p.getBoundingClientRect();
    const eps = 0.5;
    const clipX = cs.overflowX !== 'visible' && (r.left - reach < pr.left + p.clientLeft - eps || r.right + reach > pr.left + p.clientLeft + p.clientWidth + eps);
    const clipY = cs.overflowY !== 'visible' && (r.top - reach < pr.top + p.clientTop - eps || r.bottom + reach > pr.top + p.clientTop + p.clientHeight + eps);
    if (clipX || clipY) return { tag: p.tagName.toLowerCase(), id: p.id || '', cls: (p.getAttribute('class') || '').slice(0, 60) };
  }
  return null;
}

/**
 * focus-not-visible for tabbable controls that exist only at the mobile width (not rendered at the loaded desktop width): focus each in the keyboard modality, compare the styles of the
 * control and of its wrapper or siblings focused vs blurred and, when none changes, the pixels around it. Confirmed only when the pixels are identical (the same proof as the desktop pass).
 */
export async function scanMobileOnlyFocus(page) {
  const original = page.viewportSize();
  if (!original || original.width <= MOBILE_FOCUS_VIEWPORT.width) return [];
  const out = [];
  try {
    // The desktop stops, recorded after the Tab walk and before the resize.
    await page.evaluate((sel) => {
      const keyOf = (n) => [n.localName, n.id, n.getAttribute('aria-label') || '', (n.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80), n.getAttribute('href') || ''].join('|');
      const els = [...document.querySelectorAll(sel)].filter((el) => el.checkVisibility({ visibilityProperty: true }) && !el.closest('[inert], [aria-hidden="true"]'));
      window.__adaDesktopStops = { refs: new WeakSet(els), keys: new Set(els.map(keyOf)) };
    }, TABBABLE);
    await page.setViewportSize({ width: MOBILE_FOCUS_VIEWPORT.width, height: MOBILE_FOCUS_VIEWPORT.height });
    await page.waitForTimeout(350);
    const stops = await page.evaluate(({ sel, max }) => {
      const keyOf = (n) => [n.localName, n.id, n.getAttribute('aria-label') || '', (n.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80), n.getAttribute('href') || ''].join('|');
      const desktop = window.__adaDesktopStops;
      window.__adaMobileStops = [...document.querySelectorAll(sel)]
        .filter((el) => el.checkVisibility({ visibilityProperty: true }) && !el.closest('[inert], [aria-hidden="true"]') && !desktop.refs.has(el) && !desktop.keys.has(keyOf(el)) && el.getBoundingClientRect().width > 0)
        .slice(0, max);
      return window.__adaMobileStops.length;
    }, { sel: TABBABLE, max: MAX_MOBILE_FOCUS_STOPS });
    for (let i = 0; i < stops; i++) {
      await page.keyboard.press('Shift'); // keyboard modality: :focus-visible rules apply to the focus that follows
      const fd = await page.evaluate((idx) => {
        const el = window.__adaMobileStops[idx];
        if (!el?.isConnected) return null;
        el.scrollIntoView({ block: 'center', inline: 'nearest' });
        const PROPS = ['outlineStyle', 'outlineWidth', 'outlineColor', 'boxShadow', 'backgroundColor', 'color', 'borderTopColor', 'borderRightColor', 'borderBottomColor', 'borderLeftColor', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'textDecorationLine', 'textDecorationColor', 'textDecorationThickness'];
        const snap = (n) => PROPS.map((p) => window.getComputedStyle(n)[p]).join('|');
        const related = [el.parentElement, el.parentElement?.parentElement, el.previousElementSibling, el.nextElementSibling].filter((n) => n && n !== document.body && n !== document.documentElement);
        el.focus({ preventScroll: true });
        if (document.activeElement !== el) return null;
        const own = PROPS.map((p) => window.getComputedStyle(el)[p]);
        const cs = window.getComputedStyle(el);
        const outline = { style: cs.outlineStyle, width: parseFloat(cs.outlineWidth) || 0 };
        const boxShadow = cs.boxShadow;
        const rel = related.map(snap);
        el.blur();
        const ownBlur = PROPS.map((p) => window.getComputedStyle(el)[p]);
        const changed = related.filter((n, k) => snap(n) !== rel[k]);
        el.focus({ preventScroll: true });
        window.__adaScanPrevFocus = el;
        const r = el.getBoundingClientRect();
        const box = { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
        for (const n of changed) { const b = n.getBoundingClientRect(); box.left = Math.min(box.left, b.left); box.top = Math.min(box.top, b.top); box.right = Math.max(box.right, b.right); box.bottom = Math.max(box.bottom, b.bottom); }
        const css = (n) => { if (n.id) return `#${CSS.escape(n.id)}`; const parts = []; for (let x = n; x && x.nodeType === 1 && x !== document.documentElement; x = x.parentElement) { const k = [...x.parentElement.children].filter((c) => c.localName === x.localName).indexOf(x) + 1; parts.unshift(`${x.localName}:nth-of-type(${k})`); if (x.id) { parts[0] = `#${CSS.escape(x.id)}`; break; } } return parts.join('>'); };
        return {
          tag: el.tagName, text: (el.textContent || '').trim().slice(0, 80), label: el.getAttribute('aria-label') || el.getAttribute('title') || '', html: el.outerHTML.slice(0, 300), selector: css(el),
          hasIndicator: own.some((v, k) => v !== ownBlur[k]), relatedChanged: changed.length > 0, outline, boxShadow, box, visible: r.width > 0 && r.height > 0,
          customControl: el.tagName === 'INPUT' && /^(checkbox|radio|file)$/.test(el.type),
        };
      }, i);
      if (!fd || !fd.visible || fd.hasIndicator || fd.customControl) continue;
      const pixelsSame = await focusPixelsUnchanged(page, fd.box);
      const label = fd.text || fd.label || '(no label)';
      const where = `at viewport ${MOBILE_FOCUS_VIEWPORT.width}x${MOBILE_FOCUS_VIEWPORT.height} (not rendered at ${original.width}x${original.height})`;
      const measured = `focused by keyboard ${where}: outline ${fd.outline.style} ${fd.outline.width}px, box-shadow ${fd.boxShadow}, border, background and text style unchanged`
        + (pixelsSame === true ? `; pixels around the element${fd.relatedChanged ? ' and the wrapper or a sibling whose style changes on focus' : ''} are identical focused and blurred` : pixelsSame === false ? '; pixels around the element differ focused vs blurred (cue not in its own styles)' : '; pixels not compared');
      out.push({
        rule: 'focus-not-visible',
        description: `Interactive element <${fd.tag.toLowerCase()}> "${label}" has no visible focus indicator (${measured})`,
        impact: 'serious',
        wcagCriteria: '2.4.7',
        verdict: pixelsSame === true ? 'confirmed' : 'needs-review',
        element: { tag: fd.tag, text: fd.text, html: fd.html, selector: fd.selector },
        evidence: { viewports: [{ name: MOBILE_FOCUS_VIEWPORT.name, width: MOBILE_FOCUS_VIEWPORT.width, height: MOBILE_FOCUS_VIEWPORT.height }] },
      });
    }
  } finally {
    await page.evaluate(() => { delete window.__adaMobileStops; delete window.__adaDesktopStops; }).catch(() => {});
    await page.setViewportSize(original).catch(() => {});
  }
  return out;
}

/** Screenshots the focused element and its surroundings, blurs it, screenshots again, refocuses. true = identical, null = not measurable. */
async function focusPixelsUnchanged(page, rect) {
  const viewport = page.viewportSize() || (await page.evaluate(() => ({ width: innerWidth, height: innerHeight })));
  const clip = clipAround(rect, 12, viewport);
  if (!clip) return null;
  // clipAround caps the clip size: a large element would be compared only at its top-left, a cue elsewhere would go unseen.
  const covered = clip.x + clip.width >= Math.min(viewport.width, Math.ceil(rect.right + 12)) && clip.y + clip.height >= Math.min(viewport.height, Math.ceil(rect.bottom + 12));
  if (!covered) return null;
  const shot = () => page.screenshot({ clip, type: 'png', scale: 'css', animations: 'disabled', caret: 'hide' });
  try {
    if (!(await page.evaluate(() => document.activeElement === window.__adaScanPrevFocus))) return null;
    const settle = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    await settle(); // a scroll or repaint still running would differ between the two shots
    const focused = await shot();
    await page.evaluate(() => window.__adaScanPrevFocus.blur());
    await settle();
    const blurred = await shot();
    await page.evaluate(() => window.__adaScanPrevFocus.focus({ preventScroll: true }));
    return focused.equals(blurred);
  } catch {
    return null;
  }
}

/**
 * Compares the focus ring with the pixels next to it in a screenshot of the focused element (outside the ring, and inside it
 * when a negative outline-offset overlaps the element), never with the element's own fill. Passes if any ring is visible enough.
 */
async function checkFocusRing(page, fd, candidates, label, reportedClipped) {
  const reach = Math.max(...candidates.map((c) => Math.max(c.outer, 0)));
  const clipper = await page.evaluate(findRingClipper, reach).catch(() => null);
  if (clipper) {
    const key = `${clipper.tag}#${clipper.id}.${clipper.cls}`;
    if (reportedClipped.has(key)) return null;
    reportedClipped.add(key);
    return {
      rule: 'focus-indicator-clipped',
      description: `The focus ring of <${fd.tag.toLowerCase()}> "${label}" is cut off by the overflow of <${clipper.tag}>${clipper.id ? `#${clipper.id}` : ''}; part of the indicator is not visible (WCAG 2.4.7)`,
      impact: 'minor',
      wcagCriteria: '2.4.7',
      element: { tag: fd.tag, text: fd.text, html: fd.html },
    };
  }
  // Settle first: a scroll still running (script-driven smooth scroll) would put the ring somewhere else than where it was read.
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))).catch(() => {});
  // Re-read the rect only from the element that was measured: if focus moved or blurred meanwhile, its ring is gone, so there is nothing to sample.
  const rect = await page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el !== window.__adaScanPrevFocus) return null;
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  }).catch(() => fd.rect);
  if (!rect) return null;
  const viewport = page.viewportSize() || (await page.evaluate(() => ({ width: innerWidth, height: innerHeight })));
  const clip = clipAround(rect, reach + 4, viewport);
  if (!clip) return null;
  const img = await grabPixels(page, clip);
  // Focus lost while the screenshot was taken (the ring may be missing from it): nothing to judge.
  if (!(await page.evaluate(() => document.activeElement === window.__adaScanPrevFocus).catch(() => false))) return null;
  let best = null;
  let notFound = false;
  for (const c of candidates) {
    const outside = sampleSides(img, clip, rect, c.outer + 2);
    const inside = c.inner < 0 ? sampleSides(img, clip, rect, c.inner - 2) : [];
    if (!outside.length && !inside.length) continue;
    const { rgb, a } = c.color;
    const ring = a < 1 ? blend(rgb, a, outside.length ? medianColor(outside) : medianColor(inside)) : rgb;
    if (!ringPresent(img, clip, rect, c, ring)) { notFound = true; continue; }
    const res = ringContrast({ ring, outside, inside, insideOnly: c.inner < 0 && c.outer <= 0 }, MIN_FOCUS_CONTRAST);
    if (!res) continue;
    if (res.pass) return null;
    if (!best || res.ratio > best.res.ratio) best = { res, c };
  }
  if (!best && notFound) {
    return {
      rule: 'focus-indicator-unverified',
      description: `The focus ring of <${fd.tag.toLowerCase()}> "${(label || '').slice(0, 40)}" was not found in the screenshot where its styles put it, so its contrast was not measured; check it by keyboard`,
      impact: 'minor',
      wcagCriteria: '1.4.11',
      element: { tag: fd.tag, text: fd.text, html: fd.html },
    };
  }
  if (!best) return null;
  const ratio = best.res.ratio;
  const where = best.res.inside !== null ? 'the pixels outside and inside the ring' : 'the pixels next to the ring';
  return {
    rule: 'focus-indicator-low-contrast',
    description: `Focus indicator (${best.c.label}) has ${ratio.toFixed(2)}:1 contrast against ${where}, below the WCAG 1.4.11 minimum ${MIN_FOCUS_CONTRAST}:1 — <${fd.tag.toLowerCase()}> "${(label || '').slice(0, 40)}"`,
    impact: 'serious',
    wcagCriteria: '1.4.11',
    element: { tag: fd.tag, text: fd.text, html: fd.html, contrastRatio: ratio.toFixed(2) },
  };
}
