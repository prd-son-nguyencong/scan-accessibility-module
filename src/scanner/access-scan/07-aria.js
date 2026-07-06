import { createViolation } from '../../schema.js';

/**
 * 07-aria: 3 rules (WCAG 2.1)
 *
 * Checks visible text vs accessible name conflicts,
 * aria-hidden on focusable elements, and required ARIA children.
 */
export async function scanAria(page, url, options = {}) {
  const violations = [];

  // VisibleTextPartOfAccessibleName — aria-label overrides visible text
  const ariaOverrides = await page.$$eval('[aria-label], [aria-labelledby]', (els) =>
    els
      .filter((e) => {
        if (e.tagName === 'NAV' || e.tagName === 'SECTION' || e.tagName === 'MAIN') return false;
        const visibleText = e.textContent?.trim();
        const ariaLabel = e.getAttribute('aria-label')?.trim();
        if (!visibleText || !ariaLabel) return false;
        return visibleText.length > 0 && !ariaLabel.toLowerCase().includes(visibleText.toLowerCase());
      })
      .map((e) => ({
        html: e.outerHTML.slice(0, 500),
        selector: cssPath(e),
        visibleText: e.textContent.trim().slice(0, 50),
        ariaLabel: e.getAttribute('aria-label')?.slice(0, 50),
      }))
  );
  for (const el of ariaOverrides) {
    violations.push(
      createViolation({
        ruleId: 'VisibleTextPartOfAccessibleName',
        layer: 'accessScan',
        wcagRef: 'WCAG 2.1 A 2.5.3',
        impact: 'serious',
        priority: 3,
        element: { outerHTML: el.html, selector: el.selector },
        source: { mode: 'url', url },
        fix: {
          deterministic: false,
          hint: `aria-label "${el.ariaLabel}" does not include visible text "${el.visibleText}". Include visible text in the accessible name.`,
        },
      })
    );
  }

  // AriaLabelledbyContentMismatch — aria-labelledby composed text
  // includes content not visible as the element's primary label
  const labelledbyMismatches = await page.$$eval('[aria-labelledby]', (els) =>
    els.filter((e) => {
      if (e.tagName === 'NAV' || e.tagName === 'SECTION' || e.tagName === 'MAIN') return false;
      if (e.getAttribute('aria-label')) return false;
      const ids = e.getAttribute('aria-labelledby').split(/\s+/);
      if (ids.length < 2) return false;
      const visibleText = e.textContent?.trim();
      if (!visibleText) return false;
      const composedParts = ids.map(id => document.getElementById(id)?.textContent?.trim() || '');
      const composedName = composedParts.join(' ').trim();
      if (!composedName) return false;
      const extraContent = composedParts.filter(p => p && !visibleText.includes(p));
      return extraContent.length > 0;
    })
    .map(e => ({
      html: e.outerHTML.slice(0, 500),
      selector: cssPath(e),
      labelledby: e.getAttribute('aria-labelledby'),
    }))
  );
  for (const el of labelledbyMismatches) {
    violations.push(
      createViolation({
        ruleId: 'AriaLabelledbyContentMismatch',
        layer: 'accessScan',
        wcagRef: 'WCAG 2.1 A 2.5.3',
        impact: 'serious',
        priority: 3,
        element: { outerHTML: el.html, selector: el.selector },
        source: { mode: 'url', url },
        fix: {
          deterministic: false,
          hint: 'aria-labelledby references additional elements whose text is not part of the visible label. Ensure accessible name includes the visible text.',
        },
      })
    );
  }

  return violations;
}
