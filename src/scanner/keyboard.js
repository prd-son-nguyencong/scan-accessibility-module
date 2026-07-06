import { getBrowser, newPage, resilientGoto } from './browser.js';
import { mapDescriptionToSource, mapViolationToSource } from '../tracer/partial-map.js';
import { resolveFromElementText } from '../tracer/resolve-source.js';

const PAGE_TIMEOUT_MS = 60000;
const MAX_TAB_ITERATIONS = 100;
const MIN_FOCUS_CONTRAST = 3.0; // WCAG 2.4.11 focus appearance minimum ratio

/**
 * Layer 2: Keyboard Navigation Scanner
 *
 * Tests:
 * 1. No focus indicator suppressed via outline:none without a replacement
 * 2. All interactive elements are reachable by Tab (deduplication by fingerprint)
 * 3. Each focusable element has a visible focus indicator
 * 4. Focus indicator contrast ratio ≥ 3:1 (WCAG 2.4.11)
 * 5. Focus order is logical (no significant backward jumps)
 * 6. Skip navigation link present as first focusable element
 */
export async function scanKeyboardNavigation(pageUrl) {
  const browser = await getBrowser();
  const page = await newPage(browser);
  const violations = [];
  const passes = [];

  try {
    await resilientGoto(page, pageUrl, { timeout: PAGE_TIMEOUT_MS });

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
    violations.push(...focusCssViolations);

    // 2. Tab traversal — deduplication via element fingerprint
    const focusableCount = await page.evaluate(() =>
      document.querySelectorAll(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      ).length
    );

    const tabOrder = [];
    const seenFingerprints = new Set();
    const reportedObscuredBy = new Set(); // deduplicate sticky-obscure violations per chrome element
    let prevY = -1;
    let orderViolations = 0;
    const iterations = Math.min(focusableCount + 5, MAX_TAB_ITERATIONS);

    for (let i = 0; i < iterations; i++) {
      await page.keyboard.press('Tab');

      const focusData = await page.evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body) return null;
        const rect = el.getBoundingClientRect();
        const styles = window.getComputedStyle(el);

        const hasOutline = styles.outlineStyle !== 'none' && parseFloat(styles.outlineWidth) > 0;
        const hasBoxShadow = styles.boxShadow !== 'none' && styles.boxShadow !== '';
        const hasBorder =
          parseFloat(styles.borderWidth) > 0 &&
          styles.borderStyle !== 'none' &&
          styles.borderStyle !== '';

        // Check if the focused element's center is covered by a sticky/fixed chrome element
        // (WCAG 2.4.11 Focus Not Obscured — sticky headers/footers hiding focused content)
        let obscuredBy = null;
        const chromeEls = Array.from(
          document.querySelectorAll('header, footer, [role="banner"], [role="contentinfo"], [role="navigation"], nav')
        );
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        for (const chrome of chromeEls) {
          if (chrome === el || chrome.contains(el) || el.contains(chrome)) continue;
          const cs = window.getComputedStyle(chrome);
          if (cs.position !== 'fixed' && cs.position !== 'sticky') continue;
          const cr = chrome.getBoundingClientRect();
          if (cr.width === 0 || cr.height === 0) continue;
          if (centerX >= cr.left && centerX <= cr.right && centerY >= cr.top && centerY <= cr.bottom) {
            obscuredBy = {
              tag: chrome.tagName.toLowerCase(),
              id: chrome.id || '',
              className: (chrome.getAttribute('class') || '').slice(0, 60),
              position: cs.position,
            };
            break;
          }
        }

        return {
          tag: el.tagName,
          role: el.getAttribute('role'),
          ariaLabel: el.getAttribute('aria-label'),
          text: (el.textContent || '').trim().slice(0, 80),
          html: el.outerHTML.slice(0, 300),
          x: Math.round(rect.left),
          y: Math.round(rect.top),
          hasOutline,
          hasBoxShadow,
          hasBorder,
          isVisible: rect.width > 0 && rect.height > 0,
          outlineColor: styles.outlineColor,
          backgroundColor: styles.backgroundColor,
          obscuredBy,
        };
      });

      if (!focusData) break;

      // Deduplicate: skip if we have already seen this element in the traversal
      const fingerprint = `${focusData.tag}|${focusData.text}|${focusData.x}|${focusData.y}`;
      if (seenFingerprints.has(fingerprint)) continue;
      seenFingerprints.add(fingerprint);
      tabOrder.push(focusData);

      // Check visible focus indicator
      if (focusData.isVisible && !focusData.hasOutline && !focusData.hasBoxShadow && !focusData.hasBorder) {
        // Cross-origin iframes transfer focus to their internal frame, so getComputedStyle
        // reports outline:none even when a :focus-visible rule exists. Verify via stylesheet scan.
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
          violations.push({
            rule: 'focus-not-visible',
            description: `Interactive element <${focusData.tag.toLowerCase()}> "${focusData.text || focusData.ariaLabel || '(no label)'}" has no visible focus indicator`,
            impact: 'serious',
            wcagCriteria: '2.4.7',
            element: { tag: focusData.tag, text: focusData.text, html: focusData.html },
          });
        }
      } else if (focusData.hasOutline) {
        // Check WCAG 2.4.11 focus contrast ratio
        const contrastViolation = checkFocusContrast(focusData);
        if (contrastViolation) violations.push(contrastViolation);
      }

      // Check focus obscured by sticky/fixed header or footer (WCAG 2.4.11 Focus Not Obscured)
      if (focusData.isVisible && focusData.obscuredBy) {
        const obscureKey = `${focusData.obscuredBy.tag}#${focusData.obscuredBy.id}`;
        if (!reportedObscuredBy.has(obscureKey)) {
          reportedObscuredBy.add(obscureKey);
          violations.push({
            rule: 'focus-obscured-by-sticky',
            description: `Focused <${focusData.tag.toLowerCase()}> "${focusData.text || focusData.ariaLabel || '(no label)'}" is covered by sticky/fixed <${focusData.obscuredBy.tag}>${focusData.obscuredBy.id ? `#${focusData.obscuredBy.id}` : ''} — keyboard users cannot see it (WCAG 2.4.11)`,
            impact: 'serious',
            wcagCriteria: '2.4.11',
            element: { tag: focusData.tag, text: focusData.text, html: focusData.html, obscuredBy: focusData.obscuredBy },
          });
        }
      }

      // Check focus order (large backward jumps indicate a non-sequential order)
      if (prevY > 0 && focusData.y < prevY - 200) {
        orderViolations++;
      }
      prevY = focusData.y;
    }

    if (orderViolations > 2) {
      violations.push({
        rule: 'focus-order-illogical',
        description: `Focus order appears illogical — ${orderViolations} focus jumps went significantly backward in the page`,
        impact: 'moderate',
        wcagCriteria: '2.4.3',
        element: null,
      });
    }

    if (focusableCount > 0 && tabOrder.length > 0) {
      passes.push(`${tabOrder.length} of ~${focusableCount} interactive elements reached by keyboard`);
    }

    // 3. Skip navigation link (must be first focusable element)
    const hasSkipLink = await page.evaluate(() => {
      const first = document.querySelector('a[href], button:not([disabled])');
      if (!first) return false;
      const href = first.getAttribute('href') || '';
      const text = (first.textContent || '').toLowerCase();
      return href.startsWith('#') && (text.includes('skip') || text.includes('main') || text.includes('content'));
    });

    if (!hasSkipLink) {
      violations.push({
        rule: 'skip-link-missing',
        description: 'No skip navigation link found as the first focusable element',
        impact: 'moderate',
        wcagCriteria: '2.4.1',
        element: null,
      });
    } else {
      passes.push('Skip navigation link present');
    }
  } finally {
    await page.context().close().catch(() => {});
  }

  const fallbackSource = await mapDescriptionToSource(pageUrl);
  const enrichedViolations = await Promise.all(
    violations.map(async (v) => {
      let source;
      if (v.element?.html) {
        // Strategy A/B: HTML snippet → partial-file-search or page-html-comment
        source = await mapViolationToSource({ html: v.element.html }, pageUrl);
      } else if (v.element?.tag && v.element?.text) {
        // Strategy C: tag + text fingerprint search in rendered page HTML
        source = (await resolveFromElementText(v.element.tag, v.element.text, pageUrl)) || fallbackSource;
      } else {
        source = fallbackSource;
      }
      return { ...v, layer: 'keyboard', source };
    })
  );
  return { url: pageUrl, violations: enrichedViolations, passes, timestamp: new Date().toISOString() };
}

// ─── WCAG 2.4.11 Focus Contrast Helpers ──────────────────────────────────────

function parseRgb(cssColor) {
  if (!cssColor) return null;
  const m = cssColor.match(/rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)/);
  return m ? [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)] : null;
}

function relativeLuminance([r, g, b]) {
  return [r, g, b].reduce((sum, c, i) => {
    const s = c / 255;
    const lin = s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    return sum + lin * [0.2126, 0.7152, 0.0722][i];
  }, 0);
}

function contrastRatio(rgb1, rgb2) {
  const [l1, l2] = [relativeLuminance(rgb1), relativeLuminance(rgb2)].sort((a, b) => b - a);
  return (l1 + 0.05) / (l2 + 0.05);
}

function checkFocusContrast({ outlineColor, backgroundColor, tag, text, html }) {
  if (!outlineColor || backgroundColor === 'rgba(0, 0, 0, 0)') return null;
  const rgb1 = parseRgb(outlineColor);
  const rgb2 = parseRgb(backgroundColor);
  if (!rgb1 || !rgb2) return null;

  const ratio = contrastRatio(rgb1, rgb2);
  if (ratio < MIN_FOCUS_CONTRAST) {
    return {
      rule: 'focus-indicator-low-contrast',
      description: `Focus indicator contrast ${ratio.toFixed(2)}:1 is below WCAG 2.4.11 minimum ${MIN_FOCUS_CONTRAST}:1 — <${tag.toLowerCase()}> "${(text || '').slice(0, 40)}"`,
      impact: 'serious',
      wcagCriteria: '2.4.11',
      element: { tag, text, html, contrastRatio: ratio.toFixed(2) },
    };
  }
  return null;
}
