import { getBrowser, newPage, resilientGoto } from './browser.js';
import { mapDescriptionToSource } from '../tracer/partial-map.js';
import { resolveFromHref } from '../tracer/resolve-source.js';

const PAGE_TIMEOUT_MS = 60000;

/**
 * Layer 3: Screen Reader Accessibility Scanner
 *
 * Uses Playwright's accessibility tree API to simulate common screen reader
 * navigation patterns. Tests:
 * 1. Heading structure — logical outline for heading navigation (H key)
 * 2. Landmark presence — main, nav, header, footer for landmark navigation
 * 3. Link descriptions — no "click here", "read more", "here" link text
 * 4. Form labels — all form fields have announced labels
 * 5. Image alt text — meaningful, not "image", "photo", "picture"
 * 6. Table structure — headers associated with cells
 * 7. Unique page title
 *
 * Uses Playwright's accessibility snapshot API (page.accessibility.snapshot()) which
 * reflects what assistive technology would receive via the platform Accessibility APIs
 * (AXTree on macOS/Linux, IAccessible2 on Windows). This gives higher fidelity than
 * raw DOM queries because it reflects computed accessible names, resolved ARIA, and
 * the flattened reading order as a screen reader would traverse it.
 *
 * Note: @guidepup/virtual-screen-reader targets JSDOM unit environments and cannot
 * attach to a live Playwright browser context — the AT tree API is the right tool here.
 */
export async function scanScreenReaderAccessibility(pageUrl) {
  const browser = await getBrowser();
  const page = await newPage(browser);
  const violations = [];
  const passes = [];

  try {
    await resilientGoto(page, pageUrl, { timeout: PAGE_TIMEOUT_MS });

    // Build the full accessibility tree snapshot once and pass it to checks
    // that need it — avoids multiple round-trips to the browser.
    // page.accessibility was removed in Playwright >=1.40; use ariaSnapshot or DOM fallback.
    let atSnapshot = null;
    if (page.accessibility) {
      atSnapshot = await page.accessibility.snapshot({ interestingOnly: false }).catch(() => null);
    }
    if (!atSnapshot) {
      atSnapshot = await buildDomAtSnapshot(page);
    }

    // 1. Page title
    await checkPageTitle(page, violations, passes);

    // 2. Heading structure — DOM + AT tree cross-check
    await checkHeadingStructure(page, violations, passes, atSnapshot);

    // 3. Landmark regions
    await checkLandmarks(page, violations, passes);

    // 4. Link text quality — AT computed name vs visible text mismatch
    await checkLinkDescriptions(page, violations, passes, atSnapshot);

    // 5. Image alt text quality
    await checkImageAltQuality(page, violations, passes);

    // 6. Table structure
    await checkTableStructure(page, violations, passes);

    // 7. Language attribute
    await checkLanguageAttribute(page, violations, passes);

    // 8. Reading order — DOM order vs visual order (CSS reordering)
    await checkReadingOrder(page, violations, passes);

    // 9. Interactive element announced name vs visible label
    await checkButtonAnnouncedNames(page, violations, passes, atSnapshot);

    // 10. Visually-bold spans without semantic <strong> markup (StrongMismatch)
    await checkSemanticEmphasis(page, violations, passes);

    // 11. SVG sprites and off-screen elements exposed to AT (VisibilityMisuse)
    await checkSvgSpriteVisibility(page, violations, passes);
  } finally {
    await page.context().close().catch(() => {});
  }

  const fallbackSource = await mapDescriptionToSource(pageUrl);
  const enrichedViolations = await Promise.all(
    violations.map(async (v) => {
      let source = fallbackSource;
      if (v._hrefSample) {
        source = (await resolveFromHref(v._hrefSample, pageUrl)) || fallbackSource;
      }
      const { _hrefSample, ...rest } = v;
      return { ...rest, layer: 'screenReader', source };
    })
  );
  return { url: pageUrl, violations: enrichedViolations, passes, timestamp: new Date().toISOString() };
}

async function checkPageTitle(page, violations, passes) {
  const title = await page.title();
  if (!title || title.trim().length === 0) {
    violations.push({
      rule: 'page-missing-title',
      description: 'Page has no <title> element — screen readers announce this first',
      impact: 'serious',
      wcagCriteria: '2.4.2',
      element: { selector: 'head > title' },
    });
  } else {
    passes.push(`Page title: "${title.slice(0, 60)}"`);
  }
}

async function checkHeadingStructure(page, violations, passes, atSnapshot) {
  // Use AT snapshot headings when available — these reflect the computed accessible name,
  // which may differ from textContent when aria-label or aria-labelledby is used.
  let headings;

  if (atSnapshot) {
    headings = flattenAtNodes(atSnapshot)
      .filter((n) => n.role === 'heading' && n.level)
      .map((n) => ({
        level: n.level,
        text: (n.name || '').trim().slice(0, 80),
        isEmpty: !(n.name || '').trim(),
        source: 'at-tree',
      }));
  }

  // Fallback to DOM if AT snapshot returned nothing useful
  if (!headings || headings.length === 0) {
    headings = await page.evaluate(() =>
      Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6')).map((h) => ({
        level: parseInt(h.tagName.slice(1), 10),
        text: (h.textContent || '').trim().slice(0, 80),
        isEmpty: (h.textContent || '').trim().length === 0,
        source: 'dom',
      }))
    );
  }

  if (headings.length === 0) {
    violations.push({
      rule: 'no-headings',
      description: 'Page has no heading elements — screen reader users cannot navigate by heading',
      impact: 'serious',
      wcagCriteria: '2.4.6',
      element: null,
    });
    return;
  }

  // Check for h1
  const h1s = headings.filter((h) => h.level === 1);
  if (h1s.length === 0) {
    violations.push({
      rule: 'missing-h1',
      description: 'Page has no h1 element — every page should have exactly one h1',
      impact: 'moderate',
      wcagCriteria: '2.4.6',
      element: null,
    });
  } else if (h1s.length > 1) {
    violations.push({
      rule: 'multiple-h1',
      description: `Page has ${h1s.length} h1 elements — should have exactly one`,
      impact: 'minor',
      wcagCriteria: '2.4.6',
      element: null,
    });
  }

  // Check for empty headings
  const emptyHeadings = headings.filter((h) => h.isEmpty);
  if (emptyHeadings.length > 0) {
    violations.push({
      rule: 'empty-heading',
      description: `${emptyHeadings.length} empty heading element(s) — screen readers announce empty headings which is confusing`,
      impact: 'moderate',
      wcagCriteria: '2.4.6',
      element: null,
    });
  }

  // Check for skipped heading levels
  let prevLevel = 0;
  for (const h of headings) {
    if (prevLevel > 0 && h.level > prevLevel + 1) {
      violations.push({
        rule: 'heading-level-skipped',
        description: `Heading level skipped: h${prevLevel} → h${h.level} ("${h.text}") — screen reader heading outline has a gap`,
        impact: 'moderate',
        wcagCriteria: '2.4.6',
        element: { text: h.text, level: h.level },
      });
    }
    prevLevel = h.level;
  }

  if (violations.filter((v) => v.rule.includes('heading')).length === 0) {
    passes.push(`Heading structure: ${headings.length} headings with logical outline`);
  }
}

async function checkLandmarks(page, violations, passes) {
  const landmarks = await page.evaluate(() => {
    const found = {
      main: document.querySelectorAll('main, [role="main"]').length,
      nav: document.querySelectorAll('nav, [role="navigation"]').length,
      header: document.querySelectorAll('header, [role="banner"]').length,
      footer: document.querySelectorAll('footer, [role="contentinfo"]').length,
    };

    // Check multiple navs have labels
    const navElements = document.querySelectorAll('nav, [role="navigation"]');
    const navsWithoutLabel = Array.from(navElements).filter(
      (nav) => !nav.getAttribute('aria-label') && !nav.getAttribute('aria-labelledby')
    ).length;

    return { ...found, navsWithoutLabel, totalNavs: navElements.length };
  });

  if (landmarks.main === 0) {
    violations.push({
      rule: 'missing-main-landmark',
      description: 'Page has no <main> landmark — screen reader users cannot jump to main content',
      impact: 'moderate',
      wcagCriteria: '1.3.6',
      element: null,
    });
  } else {
    passes.push('main landmark present');
  }

  if (landmarks.main > 1) {
    violations.push({
      rule: 'multiple-main-landmarks',
      description: `Page has ${landmarks.main} <main> elements — only one is allowed`,
      impact: 'moderate',
      wcagCriteria: '1.3.6',
      element: null,
    });
  }

  if (landmarks.totalNavs > 1 && landmarks.navsWithoutLabel > 0) {
    violations.push({
      rule: 'multiple-navs-missing-labels',
      description: `Page has ${landmarks.totalNavs} navigation regions but ${landmarks.navsWithoutLabel} lack aria-label — screen reader cannot distinguish them`,
      impact: 'moderate',
      wcagCriteria: '2.4.1',
      element: null,
    });
  } else if (landmarks.nav > 0) {
    passes.push(`${landmarks.nav} navigation landmark(s) properly labeled`);
  }
}

async function checkLinkDescriptions(page, violations, passes, atSnapshot) {
  const NON_DESCRIPTIVE = ['click here', 'here', 'read more', 'more', 'learn more', 'link', 'click', 'go', 'this'];

  const linkIssues = await page.evaluate((nonDescriptive) => {
    const issues = [];
    const links = document.querySelectorAll('a[href]');

    for (const link of links) {
      const text = (link.textContent || '').trim().toLowerCase();
      const ariaLabel = (link.getAttribute('aria-label') || '').toLowerCase();
      const effectiveText = ariaLabel || text;

      if (nonDescriptive.includes(effectiveText)) {
        issues.push({
          text: effectiveText,
          href: (link.getAttribute('href') || '').slice(0, 80),
          html: link.outerHTML.slice(0, 300),
        });
      }
    }

    return issues.slice(0, 20); // Limit report size
  }, NON_DESCRIPTIVE);

  if (linkIssues.length > 0) {
    const linkHtmlParts = linkIssues.slice(0, 3).map((l) => l.html || `<a href="${l.href}">${l.text}</a>`).join('\n');
    violations.push({
      rule: 'non-descriptive-link-text',
      description: `${linkIssues.length} link(s) with non-descriptive text (e.g., "${linkIssues[0].text}") — screen reader users navigate by link list and need context`,
      impact: 'serious',
      wcagCriteria: '2.4.4',
      html: linkHtmlParts,
      element: { examples: linkIssues.slice(0, 3), outerHTML: linkHtmlParts },
      _hrefSample: linkIssues[0]?.href || null,
    });
  } else {
    const linkCount = await page.evaluate(() => document.querySelectorAll('a[href]').length);
    if (linkCount > 0) passes.push(`${linkCount} link(s) — all appear descriptive`);
  }
}

async function checkImageAltQuality(page, violations, passes) {
  const MEANINGLESS_ALT = ['image', 'photo', 'picture', 'img', 'graphic', 'icon', 'banner', '.jpg', '.png', '.gif', '.svg', '.webp'];

  const imgIssues = await page.evaluate((meaningless) => {
    const issues = [];
    for (const img of document.querySelectorAll('img')) {
      const alt = img.getAttribute('alt');
      const src = (img.getAttribute('src') || '').split('/').pop().split('?')[0];

      if (alt === null) {
        issues.push({ type: 'missing', src: src.slice(0, 60) });
      } else if (alt.trim() === '' && img.closest('a, button')) {
        // Decorative inside actionable — needs label on parent, not alt=""
        issues.push({ type: 'empty-in-link', src: src.slice(0, 60) });
      } else if (meaningless.some((m) => alt.toLowerCase().trim() === m) || alt === src) {
        issues.push({ type: 'meaningless', alt: alt.slice(0, 60), src: src.slice(0, 60) });
      }
    }
    return issues.slice(0, 10);
  }, MEANINGLESS_ALT);

  if (imgIssues.length > 0) {
    const missing = imgIssues.filter((i) => i.type === 'missing').length;
    const meaningless = imgIssues.filter((i) => i.type === 'meaningless').length;

    if (missing > 0) {
      violations.push({
        rule: 'image-alt-missing-sr',
        description: `${missing} image(s) missing alt attribute — screen readers will read the filename instead`,
        impact: 'critical',
        wcagCriteria: '1.1.1',
        element: { examples: imgIssues.filter((i) => i.type === 'missing').slice(0, 3) },
      });
    }
    if (meaningless > 0) {
      violations.push({
        rule: 'image-alt-not-descriptive',
        description: `${meaningless} image(s) have non-descriptive alt text (e.g., "${imgIssues.find((i) => i.type === 'meaningless')?.alt}") — provide a meaningful description`,
        impact: 'moderate',
        wcagCriteria: '1.1.1',
        element: { examples: imgIssues.filter((i) => i.type === 'meaningless').slice(0, 3) },
      });
    }
  } else {
    const imgCount = await page.evaluate(() => document.querySelectorAll('img').length);
    if (imgCount > 0) passes.push(`${imgCount} image(s) — alt text appears meaningful`);
  }
}

async function checkTableStructure(page, violations, passes) {
  const tableIssues = await page.evaluate(() => {
    const issues = [];
    const tables = document.querySelectorAll('table');

    for (const table of tables) {
      const hasCaption = !!table.querySelector('caption');
      const hasThInThead = table.querySelector('thead th') !== null;
      const hasTh = table.querySelector('th') !== null;
      const hasScope = Array.from(table.querySelectorAll('th')).every((th) => th.getAttribute('scope'));
      const ariaLabel = table.getAttribute('aria-label') || table.getAttribute('aria-labelledby');

      if (!hasCaption && !ariaLabel) {
        issues.push({ rule: 'table-no-caption', description: 'Table has no <caption> or aria-label — screen reader cannot identify table purpose' });
      }
      if (!hasTh) {
        issues.push({ rule: 'table-no-headers', description: 'Data table has no <th> header cells — screen reader cannot associate data with headers' });
      }
      if (hasTh && !hasScope) {
        issues.push({ rule: 'table-th-no-scope', description: 'Table <th> elements are missing scope attribute (col/row/colgroup/rowgroup)' });
      }
    }
    return issues;
  });

  for (const issue of tableIssues) {
    violations.push({
      rule: issue.rule,
      description: issue.description,
      impact: 'serious',
      wcagCriteria: '1.3.1',
      element: null,
    });
  }

  if (tableIssues.length === 0) {
    const tableCount = await page.evaluate(() => document.querySelectorAll('table').length);
    if (tableCount > 0) passes.push(`${tableCount} table(s) have proper header structure`);
  }
}

async function checkLanguageAttribute(page, violations, passes) {
  const langData = await page.evaluate(() => {
    const html = document.documentElement;
    return {
      lang: html.getAttribute('lang'),
      xmlLang: html.getAttribute('xml:lang'),
    };
  });

  if (!langData.lang && !langData.xmlLang) {
    violations.push({
      rule: 'html-missing-lang',
      description: '<html> element is missing lang attribute — screen readers use this to choose the right language engine',
      impact: 'serious',
      wcagCriteria: '3.1.1',
      element: { selector: 'html' },
    });
  } else {
    passes.push(`Language attribute: lang="${langData.lang}"`);
  }
}

// ─── New: Reading Order Check ─────────────────────────────────────────────────

/**
 * Detects CSS-driven visual reordering (flex/grid order property) that diverges
 * from DOM order. Screen readers follow DOM order; if CSS reorders content visually,
 * the reading sequence will differ from the visual sequence (WCAG 1.3.2).
 */
async function checkReadingOrder(page, violations, passes) {
  const reorderIssues = await page.evaluate(() => {
    const issues = [];
    const focusable = Array.from(
      document.querySelectorAll('a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])')
    );

    for (const el of focusable) {
      const styles = window.getComputedStyle(el);
      const order = parseInt(styles.order, 10);
      if (!isNaN(order) && order !== 0) {
        // Has explicit CSS order — check if it differs from DOM position
        const parent = el.parentElement;
        if (parent) {
          const parentStyles = window.getComputedStyle(parent);
          const isFlexOrGrid =
            parentStyles.display === 'flex' ||
            parentStyles.display === 'inline-flex' ||
            parentStyles.display === 'grid' ||
            parentStyles.display === 'inline-grid';

          if (isFlexOrGrid) {
            issues.push({
              tag: el.tagName,
              text: (el.textContent || '').trim().slice(0, 40),
              cssOrder: order,
            });
          }
        }
      }
    }
    return issues.slice(0, 5);
  });

  if (reorderIssues.length > 0) {
    violations.push({
      rule: 'reading-order-css-reordered',
      description: `${reorderIssues.length} interactive element(s) use CSS order property inside flex/grid — visual order differs from DOM/reading order (WCAG 1.3.2). Examples: ${reorderIssues.map((i) => `<${i.tag.toLowerCase()}> "${i.text}" (order:${i.cssOrder})`).join(', ')}`,
      impact: 'moderate',
      wcagCriteria: '1.3.2',
      element: { examples: reorderIssues },
    });
  } else {
    passes.push('Reading order: no CSS order reordering detected on interactive elements');
  }
}

// ─── New: Button/Control Announced Name vs Visible Label ─────────────────────

/**
 * Uses the AT accessibility tree to detect buttons and links whose computed
 * accessible name (what a screen reader announces) differs from their visible
 * text label. This catches aria-label overrides that create confusion
 * for users who switch between visual and non-visual access (WCAG 2.5.3).
 */
async function checkButtonAnnouncedNames(page, violations, passes, atSnapshot) {
  if (!atSnapshot) return;

  const atNodes = flattenAtNodes(atSnapshot).filter((n) => n.role === 'button' || n.role === 'link');

  const atMismatches = [];
  for (const node of atNodes.slice(0, 50)) {
    const atName = (node.name || '').trim().toLowerCase();
    if (!atName || atName.length === 0) continue;

    const description = (node.description || '').trim().toLowerCase();
    // Only flag if the name does NOT contain the description (WCAG 2.5.3 "Label in Name")
    if (description && description !== atName && description.length > 3 &&
        !atName.includes(description) && !description.includes(atName)) {
      atMismatches.push({
        role: node.role,
        announcedName: node.name?.slice(0, 60),
        visibleHint: node.description?.slice(0, 60),
      });
    }
  }

  // Also query DOM directly for elements with aria-label differing from visible text
  const domMismatches = await page.evaluate(() => {
    const results = [];
    const els = document.querySelectorAll('button[aria-label], a[aria-label]');
    for (const el of els) {
      const ariaLabel = (el.getAttribute('aria-label') || '').trim();
      const visibleText = (el.textContent || '').trim().replace(/\s+/g, ' ');
      if (!ariaLabel || !visibleText || visibleText.length < 2) continue;

      const normalAria = ariaLabel.toLowerCase();
      const normalVisible = visibleText.toLowerCase();
      // WCAG 2.5.3: accessible name must CONTAIN the visible label text
      if (normalAria !== normalVisible && !normalAria.includes(normalVisible)) {
        results.push({
          role: el.tagName.toLowerCase() === 'button' ? 'button' : 'link',
          announcedName: ariaLabel.slice(0, 80),
          visibleText: visibleText.slice(0, 80),
          html: el.outerHTML.slice(0, 300),
        });
      }
    }
    return results;
  });

  // Merge: prefer DOM matches (have real outerHTML), fall back to AT matches
  const allMismatches = domMismatches.length > 0 ? domMismatches : atMismatches;

  // If DOM missed some, also query for aria-label elements where label contains extra context
  if (domMismatches.length === 0 && atMismatches.length > 0) {
    const domFallback = await page.evaluate(() => {
      const results = [];
      for (const el of document.querySelectorAll('button[aria-label], a[aria-label]')) {
        const ariaLabel = (el.getAttribute('aria-label') || '').trim();
        const visibleText = (el.textContent || '').trim().replace(/\s+/g, ' ');
        if (!ariaLabel || !visibleText || visibleText.length < 2) continue;
        if (ariaLabel.toLowerCase() !== visibleText.toLowerCase()) {
          results.push({ html: el.outerHTML.slice(0, 300) });
        }
      }
      return results;
    });
    // Enrich AT mismatches with DOM outerHTML
    for (let i = 0; i < allMismatches.length && i < domFallback.length; i++) {
      if (domFallback[i]?.html) allMismatches[i].html = domFallback[i].html;
    }
  }

  if (allMismatches.length > 0) {
    const htmlParts = allMismatches
      .slice(0, 5)
      .map((m) => m.html || `<${m.role === 'link' ? 'a' : m.role} aria-label="${m.announcedName}">${m.visibleHint || ''}</${m.role === 'link' ? 'a' : m.role}>`)
      .join('\n');

    violations.push({
      rule: 'accessible-name-mismatch',
      description: `${allMismatches.length} button(s)/link(s) have an accessible name that differs from visible label — voice control users (Dragon) cannot activate by visible text (WCAG 2.5.3)`,
      impact: 'serious',
      wcagCriteria: '2.5.3',
      html: htmlParts,
      element: {
        examples: allMismatches.slice(0, 5),
        outerHTML: htmlParts,
      },
    });
  } else {
    passes.push('Button/link accessible names match visible labels');
  }
}

// ─── Semantic Emphasis Check ──────────────────────────────────────────────────

/**
 * Detects <span> elements that are visually bold via CSS but lack semantic <strong>
 * markup. Screen readers do not convey visual boldness — only semantic markup
 * (strong/em) is announced as "important" or "emphasised" by AT (WCAG 1.3.1).
 */
async function checkSemanticEmphasis(page, violations, passes) {
  const issues = await page.evaluate(() => {
    const results = [];
    const spans = Array.from(document.querySelectorAll('span'));

    for (const span of spans) {
      // Skip spans already inside semantic emphasis or interactive/heading elements
      if (span.closest('strong, em, b, i, h1, h2, h3, h4, h5, h6, button, a, label, th')) continue;
      // Skip spans that contain block or interactive children (not pure text spans)
      if (span.querySelector('div, p, ul, ol, table, button, a, input, select, textarea')) continue;

      const text = (span.textContent || '').trim();
      if (!text || text.length < 2 || text.length > 300) continue;

      const styles = window.getComputedStyle(span);
      const fontWeight = parseInt(styles.fontWeight, 10);
      if (isNaN(fontWeight) || fontWeight < 700) continue;

      // Only flag when the parent element has lighter weight — span is specifically emphasised
      const parentEl = span.parentElement || document.body;
      const parentWeight = parseInt(window.getComputedStyle(parentEl).fontWeight, 10);
      if (!isNaN(parentWeight) && parentWeight >= 700) continue;

      results.push({
        tag: 'span',
        text: text.slice(0, 60),
        fontWeight,
        suggestion: 'strong',
        html: span.outerHTML.slice(0, 150),
      });
    }

    return results.slice(0, 10);
  });

  if (issues.length > 0) {
    const emphasisHtml = issues.slice(0, 3).map((i) => i.html).filter(Boolean).join('\n');
    violations.push({
      rule: 'semantic-emphasis-missing',
      description: `${issues.length} <span> element(s) are visually bold (font-weight ≥ 700) but lack <strong> markup — screen readers don't announce CSS boldness; use <strong> to convey importance (WCAG 1.3.1)`,
      impact: 'moderate',
      wcagCriteria: '1.3.1',
      html: emphasisHtml,
      element: { examples: issues.slice(0, 3), outerHTML: emphasisHtml },
    });
  } else {
    passes.push('Semantic emphasis: visually-bold text uses <strong> markup');
  }
}

// ─── SVG Sprite / Off-Screen Visibility Check ─────────────────────────────────

/**
 * Detects SVG sprite elements and off-screen content that is not hidden from AT.
 * SVG <symbol> sprites are often positioned off-screen but remain in the AT tree
 * unless aria-hidden="true" is set (VisibilityMisuse, WCAG 1.1.1 / 1.3.1).
 */
async function checkSvgSpriteVisibility(page, violations, passes) {
  const result = await page.evaluate(() => {
    const svgIssues = [];

    for (const svg of document.querySelectorAll('svg')) {
      const hasAriaHidden = svg.getAttribute('aria-hidden') === 'true';
      if (hasAriaHidden) continue;

      const hasSymbols = svg.querySelectorAll('symbol').length > 0;
      const rect = svg.getBoundingClientRect();
      const styles = window.getComputedStyle(svg);
      const isHiddenVisually =
        styles.display === 'none' ||
        styles.visibility === 'hidden' ||
        (rect.width === 0 && rect.height === 0) ||
        rect.left < -500;

      if (hasSymbols || isHiddenVisually) {
        svgIssues.push({
          id: svg.id || '',
          hasSymbols,
          isHiddenVisually,
          html: svg.outerHTML.slice(0, 120),
        });
      }
    }

    // Off-screen elements with text content that lack aria-hidden
    let offScreenCount = 0;
    for (const el of document.querySelectorAll('[class*="sr-only"], [class*="screen-reader"], [class*="visually-hidden"]')) {
      // These are intentionally off-screen for AT — they should NOT have aria-hidden
      // But empty ones exposed to AT are noise — skip if empty
      const text = (el.textContent || '').trim();
      if (!text) offScreenCount++;
    }

    // Elements absolutely positioned far off-screen without aria-hidden
    const offScreenExposed = Array.from(
      document.querySelectorAll('body *:not(script):not(style):not(meta):not(link)')
    ).filter((el) => {
      const rect = el.getBoundingClientRect();
      const styles = window.getComputedStyle(el);
      return (
        (rect.left < -900 || rect.top < -900) &&
        styles.display !== 'none' &&
        styles.visibility !== 'hidden' &&
        !el.getAttribute('aria-hidden') &&
        (el.textContent || '').trim().length > 0 &&
        !el.closest('[aria-hidden="true"]')
      );
    }).length;

    return { svgIssues: svgIssues.slice(0, 5), offScreenExposed };
  });

  if (result.svgIssues.length > 0) {
    const svgHtml = result.svgIssues.slice(0, 3).map((s) => s.html).filter(Boolean).join('\n');
    violations.push({
      rule: 'svg-sprite-not-hidden',
      description: `${result.svgIssues.length} SVG sprite/hidden SVG element(s) lack aria-hidden="true" — AT reads symbol definitions as content (WCAG 1.1.1)`,
      impact: 'moderate',
      wcagCriteria: '1.1.1',
      html: svgHtml,
      element: { examples: result.svgIssues.slice(0, 3), outerHTML: svgHtml },
    });
  }

  if (result.offScreenExposed > 0) {
    violations.push({
      rule: 'off-screen-content-exposed',
      description: `${result.offScreenExposed} element(s) are positioned far off-screen but remain visible to AT — add aria-hidden="true" if content is decorative or duplicated (WCAG 1.3.1)`,
      impact: 'moderate',
      wcagCriteria: '1.3.1',
      element: null,
    });
  }

  if (result.svgIssues.length === 0 && result.offScreenExposed === 0) {
    passes.push('SVG sprites and off-screen elements are properly hidden from AT');
  }
}

// ─── DOM-based AT snapshot fallback (Playwright >= 1.40) ──────────────────────

/**
 * Builds a lightweight AT snapshot from the DOM when page.accessibility is
 * unavailable.  Covers headings (with level), buttons, and links — the three
 * node types consumed by checkHeadingStructure and checkButtonAnnouncedNames.
 */
async function buildDomAtSnapshot(page) {
  const nodes = await page.evaluate(() => {
    const result = [];
    for (const h of document.querySelectorAll('h1,h2,h3,h4,h5,h6')) {
      result.push({
        role: 'heading',
        level: parseInt(h.tagName[1], 10),
        name: (h.getAttribute('aria-label') || h.textContent || '').trim(),
        description: '',
      });
    }
    for (const el of document.querySelectorAll('button, [role="button"]')) {
      const ariaLabel = el.getAttribute('aria-label') || '';
      const text = (el.textContent || '').trim();
      result.push({
        role: 'button',
        name: (ariaLabel || text).slice(0, 120),
        description: ariaLabel && text && ariaLabel.toLowerCase() !== text.toLowerCase() ? text.slice(0, 120) : '',
      });
    }
    for (const el of document.querySelectorAll('a[href]')) {
      const ariaLabel = el.getAttribute('aria-label') || '';
      const text = (el.textContent || '').trim();
      result.push({
        role: 'link',
        name: (ariaLabel || text).slice(0, 120),
        description: ariaLabel && text && ariaLabel.toLowerCase() !== text.toLowerCase() ? text.slice(0, 120) : '',
      });
    }
    return result;
  });
  return { role: 'WebArea', name: '', children: nodes.map((n) => ({ ...n, children: [] })) };
}

// ─── AT Tree Utility ──────────────────────────────────────────────────────────

/**
 * Flattens the nested accessibility snapshot tree into a single array of nodes.
 */
function flattenAtNodes(node, result = []) {
  if (!node) return result;
  result.push(node);
  for (const child of node.children || []) {
    flattenAtNodes(child, result);
  }
  return result;
}
