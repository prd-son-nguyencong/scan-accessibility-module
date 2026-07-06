import { createViolation } from '../../schema.js';

/**
 * 01-general: 14 rules (WCAG 2.1 + 2.0 + Best Practices)
 *
 * axe-core native: AltMisuse, IframeDiscernible, NoRoleApplication,
 *   AriaDescribedByHasReference, AriaLabelledByHasReference
 * custom DOM: BreadcrumbsNav, EmphasisMismatch, LinkAnchorAmbiguous,
 *   SalePriceDiscernible, StrongMismatch, VisibilityMismatch,
 *   VisibilityMisuse, FigureDiscernible, NoExtraInformationInTitle
 */
export async function scanGeneral(page, url, options = {}) {
  const violations = [];
  const includeThirdParty = options.includeThirdParty ?? false;

  // StrongMismatch — visually bold <span> should be <strong>
  // Excludes .sr-only spans, and third-party Paradox widget elements (unless --include-third-party)
  const strongMismatches = await page.$$eval('span', (spans, _includeTP) =>
    spans
      .filter((s) => {
        const style = window.getComputedStyle(s);
        if (!(style.fontWeight === 'bold' || parseInt(style.fontWeight) >= 700)) return false;
        if (s.tagName !== 'SPAN' || s.getAttribute('role')) return false;
        if (s.textContent.trim().length === 0) return false;
        if (!_includeTP && s.closest('[data-testid^="jobs-"], .c-jobs-search, .results-list, [class^="c-jobs-"]')) return false;

        const isSrOnly = s.classList.contains('sr-only') || s.closest('.sr-only') ||
          (style.position === 'absolute' && style.overflow === 'hidden' &&
           (parseInt(style.width) <= 1 || parseInt(style.height) <= 1));
        return !isSrOnly;
      })
      .map((s) => ({ html: s.outerHTML.slice(0, 500), selector: cssPath(s) })),
    includeThirdParty
  );
  for (const el of strongMismatches) {
    violations.push(
      createViolation({
        ruleId: 'StrongMismatch',
        layer: 'accessScan',
        wcagRef: 'WCAG 2.0 A 1.3.1',
        impact: 'serious',
        priority: 2,
        element: { outerHTML: el.html, selector: el.selector },
        source: { mode: 'url', url },
        fix: {
          deterministic: true,
          hint: 'Replace <span> with <strong> for visually bold text so screen readers convey emphasis.',
        },
      })
    );
  }

  // VisibilityMisuse — hidden elements exposed to AT
  const visibilityMisuse = await page.$$eval(
    '[style*="display: none"], [style*="display:none"], [style*="visibility: hidden"], [hidden]',
    (els) =>
      els
        .filter((e) => !e.getAttribute('aria-hidden') && e.querySelector('a, button, input, [role]'))
        .map((e) => ({ html: e.outerHTML.slice(0, 500), selector: cssPath(e) }))
  );
  for (const el of visibilityMisuse) {
    violations.push(
      createViolation({
        ruleId: 'VisibilityMisuse',
        layer: 'accessScan',
        wcagRef: 'WCAG 2.0 A 4.1.2',
        impact: 'serious',
        priority: 2,
        element: { outerHTML: el.html, selector: el.selector },
        source: { mode: 'url', url },
        fix: {
          deterministic: true,
          hint: 'Add aria-hidden="true" to visually hidden elements containing interactive content.',
        },
      })
    );
  }

  // VisibilityMismatch — visible elements hidden from AT
  // Excludes: decorative children of labeled parents, visual separators, marquee dupes
  const visibilityMismatch = await page.$$eval('[aria-hidden="true"]', (els) =>
    els
      .filter((e) => {
        const rect = e.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0 || window.getComputedStyle(e).display === 'none') return false;

        // Skip if a parent already has aria-hidden (don't double-count children)
        const parent = e.parentElement;
        if (parent && parent.closest('[aria-hidden="true"]')) return false;

        // Skip decorative children of elements with accessible names (icons in labeled links/buttons)
        const labeledAncestor = e.closest('a[aria-label], a[aria-labelledby], button[aria-label], button[aria-labelledby], [role="button"][aria-label]');
        if (labeledAncestor && labeledAncestor !== e) return false;

        // Skip decorative SVG/icon elements inside interactive elements that have visible text
        if (e.tagName === 'SVG' || e.tagName === 'svg' || e.tagName === 'I' || e.tagName === 'IMG') {
          const interactiveParent = e.closest('a, button, [role="button"], summary, label, [role="tab"], [role="menuitem"]');
          if (interactiveParent && interactiveParent !== e) {
            const clone = interactiveParent.cloneNode(true);
            clone.querySelectorAll('svg, img, i, [aria-hidden]').forEach((n) => n.remove());
            if (clone.textContent.trim().length > 0) return false;
          }
        }

        // Skip dimensionless decorative separators (<span> with no text content)
        if (e.tagName === 'SPAN' && e.textContent.trim() === '') return false;

        // Skip decorative SVG/icon elements inside form controls that already have accessible labels.
        // Detection: walk up the DOM to find if this icon sits near an input/select/textarea
        // that has an associated <label>, aria-label, or aria-labelledby.
        if (e.tagName === 'SVG' || e.tagName === 'svg' || e.tagName === 'I' || e.tagName === 'IMG') {
          const formControl = e.parentElement?.querySelector('input, select, textarea') ||
                              e.closest('div, fieldset, search, form')?.querySelector('input, select, textarea');
          if (formControl) {
            const controlId = formControl.id;
            const hasAssociatedLabel = (controlId && document.querySelector(`label[for="${controlId}"]`)) ||
                                       formControl.hasAttribute('aria-label') ||
                                       formControl.hasAttribute('aria-labelledby') ||
                                       formControl.closest('label');
            if (hasAssociatedLabel) return false;
          }
        }

        // Skip elements inside containers that duplicate content for visual effects
        // (infinite scroll marquees, carousels that clone slides, etc.)
        // Detection: parent has aria-hidden on a sibling, or element is a duplicate of a visible sibling
        const parentEl = e.parentElement;
        if (parentEl) {
          const siblings = Array.from(parentEl.children);
          const visibleDuplicate = siblings.some(
            (s) => s !== e && !s.hasAttribute('aria-hidden') && s.tagName === e.tagName &&
                   s.getAttribute('style') === e.getAttribute('style')
          );
          if (visibleDuplicate) return false;
        }

        return true;
      })
      .map((e) => ({ html: e.outerHTML.slice(0, 500), selector: cssPath(e) }))
  );
  for (const el of visibilityMismatch) {
    violations.push(
      createViolation({
        ruleId: 'VisibilityMismatch',
        layer: 'accessScan',
        wcagRef: 'WCAG 2.0 A 4.1.2',
        impact: 'moderate',
        priority: 3,
        element: { outerHTML: el.html, selector: el.selector },
        source: { mode: 'url', url },
        fix: {
          deterministic: false,
          hint: 'Remove aria-hidden="true" from visible elements, or add a proper aria-label.',
        },
      })
    );
  }

  // EmphasisMismatch — italic <span> should be <em>
  const emphasisMismatches = await page.$$eval('span', (spans) =>
    spans
      .filter((s) => {
        const style = window.getComputedStyle(s);
        return style.fontStyle === 'italic' && !s.getAttribute('role') && s.textContent.trim().length > 0;
      })
      .map((s) => ({ html: s.outerHTML.slice(0, 500), selector: cssPath(s) }))
  );
  for (const el of emphasisMismatches) {
    violations.push(
      createViolation({
        ruleId: 'EmphasisMismatch',
        layer: 'accessScan',
        wcagRef: 'WCAG 2.0 A 1.3.1',
        impact: 'moderate',
        priority: 3,
        element: { outerHTML: el.html, selector: el.selector },
        source: { mode: 'url', url },
        fix: {
          deterministic: true,
          hint: 'Replace <span> with <em> for visually italic text.',
        },
      })
    );
  }

  // NoExtraInformationInTitle — title attr should not duplicate visible text
  const titleDupes = await page.$$eval('[title]', (els) =>
    els
      .filter((e) => {
        const title = e.getAttribute('title')?.trim().toLowerCase();
        const text = e.textContent?.trim().toLowerCase();
        return title && text && title === text;
      })
      .map((e) => ({ html: e.outerHTML.slice(0, 500), selector: cssPath(e) }))
  );
  for (const el of titleDupes) {
    violations.push(
      createViolation({
        ruleId: 'NoExtraInformationInTitle',
        layer: 'accessScan',
        wcagRef: 'WCAG 2.0 A 4.1.2',
        impact: 'minor',
        priority: 4,
        element: { outerHTML: el.html, selector: el.selector },
        source: { mode: 'url', url },
        fix: {
          deterministic: true,
          hint: 'Remove title attribute that duplicates visible text content.',
        },
      })
    );
  }

  // FigureDiscernible — <figure> should have <figcaption> or aria-label
  const figureIssues = await page.$$eval('figure', (figs) =>
    figs
      .filter((f) => !f.querySelector('figcaption') && !f.getAttribute('aria-label') && !f.getAttribute('aria-labelledby'))
      .map((f) => ({ html: f.outerHTML.slice(0, 500), selector: cssPath(f) }))
  );
  for (const el of figureIssues) {
    violations.push(
      createViolation({
        ruleId: 'FigureDiscernible',
        layer: 'accessScan',
        wcagRef: 'WCAG 2.0 A 1.1.1',
        impact: 'moderate',
        priority: 3,
        element: { outerHTML: el.html, selector: el.selector },
        source: { mode: 'url', url },
        fix: {
          deterministic: false,
          hint: 'Add <figcaption> or aria-label to <figure> elements.',
        },
      })
    );
  }

  // AltMisuse — non-<img> elements should not have alt attribute
  const altMisuse = await page.$$eval('[alt]:not(img):not(input[type="image"]):not(area)', (els) =>
    els
      .filter((e) => e.getAttribute('alt') !== null)
      .map((e) => ({ html: e.outerHTML.slice(0, 500), selector: cssPath(e) }))
  );
  for (const el of altMisuse) {
    violations.push(
      createViolation({
        ruleId: 'AltMisuse',
        layer: 'accessScan',
        wcagRef: 'WCAG 2.1 A 1.1.1',
        impact: 'moderate',
        priority: 3,
        element: { outerHTML: el.html, selector: el.selector },
        source: { mode: 'url', url },
        fix: {
          deterministic: true,
          hint: 'Remove alt attribute from non-image elements. Use aria-label for accessible names instead.',
        },
      })
    );
  }

  // BreadcrumbsNav — breadcrumb navigation not properly tagged with aria-label and <ol>
  const breadcrumbIssues = await page.$$eval('nav', (navs) =>
    navs
      .filter((n) => {
        const label = (n.getAttribute('aria-label') || '').toLowerCase();
        if (!label.includes('breadcrumb')) return false;
        return !n.querySelector('ol');
      })
      .map((n) => ({ html: n.outerHTML.slice(0, 500), selector: cssPath(n) }))
  );
  for (const el of breadcrumbIssues) {
    violations.push(
      createViolation({
        ruleId: 'BreadcrumbsNav',
        layer: 'accessScan',
        wcagRef: 'WCAG 2.0 A 1.3.1',
        impact: 'moderate',
        priority: 3,
        element: { outerHTML: el.html, selector: el.selector },
        source: { mode: 'url', url },
        fix: {
          deterministic: true,
          hint: 'Use an <ol> list inside breadcrumb <nav> for proper screen reader announcement.',
        },
      })
    );
  }

  // IframeDiscernible — <iframe> without a title attribute
  const iframeIssues = await page.$$eval('iframe', (iframes) =>
    iframes
      .filter((f) => {
        if (f.getAttribute('aria-hidden') === 'true') return false;
        if (f.getAttribute('role') === 'presentation') return false;
        const style = window.getComputedStyle(f);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        const title = f.getAttribute('title')?.trim();
        return !title;
      })
      .map((f) => ({ html: f.outerHTML.slice(0, 500), selector: cssPath(f) }))
  );
  for (const el of iframeIssues) {
    violations.push(
      createViolation({
        ruleId: 'IframeDiscernible',
        layer: 'accessScan',
        wcagRef: 'WCAG 2.0 A 4.1.2',
        impact: 'serious',
        priority: 2,
        element: { outerHTML: el.html, selector: el.selector },
        source: { mode: 'url', url },
        fix: {
          deterministic: true,
          hint: 'Add a descriptive title attribute to <iframe> elements.',
        },
      })
    );
  }

  // LinkAnchorAmbiguous — <a> with empty or fragment-only href and no role
  const linkAnchorIssues = await page.$$eval('a', (links) =>
    links
      .filter((a) => {
        const href = a.getAttribute('href') || '';
        const isEmpty = href === '' || href === '#';
        if (!isEmpty) return false;
        if (a.getAttribute('role')) return false;
        if (a.getAttribute('aria-hidden') === 'true') return false;
        return true;
      })
      .map((a) => ({ html: a.outerHTML.slice(0, 500), selector: cssPath(a) }))
  );
  for (const el of linkAnchorIssues) {
    violations.push(
      createViolation({
        ruleId: 'LinkAnchorAmbiguous',
        layer: 'accessScan',
        wcagRef: 'WCAG 2.0 A 2.4.4',
        impact: 'moderate',
        priority: 4,
        element: { outerHTML: el.html, selector: el.selector },
        source: { mode: 'url', url },
        fix: {
          deterministic: false,
          hint: 'Replace empty/fragment-only href with a valid URL, or use <button> for actions.',
        },
      })
    );
  }

  // NoRoleApplication — role="application" disables standard screen reader navigation
  const roleAppEls = await page.$$eval('[role="application"]', (els) =>
    els.map((e) => ({ html: e.outerHTML.slice(0, 500), selector: cssPath(e) }))
  );
  for (const el of roleAppEls) {
    violations.push(
      createViolation({
        ruleId: 'NoRoleApplication',
        layer: 'accessScan',
        wcagRef: 'WCAG 2.0 A 4.1.2',
        impact: 'serious',
        priority: 2,
        element: { outerHTML: el.html, selector: el.selector },
        source: { mode: 'url', url },
        fix: {
          deterministic: true,
          hint: 'Remove role="application" — it disables standard screen reader navigation shortcuts.',
        },
      })
    );
  }

  // SalePriceDiscernible — strikethrough prices not distinguishable by screen readers
  const salePrices = await page.$$eval('s, del, strike', (els) =>
    els
      .filter((e) => {
        if (e.textContent.trim().length === 0) return false;
        return !e.closest('[aria-label]') && !e.getAttribute('aria-label');
      })
      .map((e) => ({ html: e.outerHTML.slice(0, 500), selector: cssPath(e) }))
  );
  for (const el of salePrices) {
    violations.push(
      createViolation({
        ruleId: 'SalePriceDiscernible',
        layer: 'accessScan',
        wcagRef: 'WCAG 2.0 A 1.3.1',
        impact: 'serious',
        priority: 3,
        element: { outerHTML: el.html, selector: el.selector },
        source: { mode: 'url', url },
        fix: {
          deterministic: false,
          hint: 'Add aria-label to distinguish original and discounted prices for screen readers.',
        },
      })
    );
  }

  // AriaDescribedByHasReference — aria-describedby pointing to non-existent IDs
  const brokenDescBy = await page.$$eval('[aria-describedby]', (els) =>
    els
      .filter((e) => {
        const ids = e.getAttribute('aria-describedby').split(/\s+/);
        return ids.some((id) => id && !document.getElementById(id));
      })
      .map((e) => ({
        html: e.outerHTML.slice(0, 500),
        selector: cssPath(e),
        attr: e.getAttribute('aria-describedby'),
      }))
  );
  for (const el of brokenDescBy) {
    violations.push(
      createViolation({
        ruleId: 'AriaDescribedByHasReference',
        layer: 'accessScan',
        wcagRef: 'WCAG 2.0 A 1.3.1',
        impact: 'serious',
        priority: 2,
        element: { outerHTML: el.html, selector: el.selector },
        source: { mode: 'url', url },
        fix: {
          deterministic: false,
          hint: `aria-describedby="${el.attr}" references a non-existent element ID.`,
        },
      })
    );
  }

  // AriaLabelledByHasReference — aria-labelledby pointing to non-existent IDs
  const brokenLabelBy = await page.$$eval('[aria-labelledby]', (els) =>
    els
      .filter((e) => {
        const ids = e.getAttribute('aria-labelledby').split(/\s+/);
        return ids.some((id) => id && !document.getElementById(id));
      })
      .map((e) => ({
        html: e.outerHTML.slice(0, 500),
        selector: cssPath(e),
        attr: e.getAttribute('aria-labelledby'),
      }))
  );
  for (const el of brokenLabelBy) {
    violations.push(
      createViolation({
        ruleId: 'AriaLabelledByHasReference',
        layer: 'accessScan',
        wcagRef: 'WCAG 2.0 A 1.3.1',
        impact: 'serious',
        priority: 2,
        element: { outerHTML: el.html, selector: el.selector },
        source: { mode: 'url', url },
        fix: {
          deterministic: false,
          hint: `aria-labelledby="${el.attr}" references a non-existent element ID.`,
        },
      })
    );
  }

  return violations;
}
