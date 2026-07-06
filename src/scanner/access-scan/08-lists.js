import { createViolation } from '../../schema.js';

/**
 * 08-lists: 2 rules (WCAG 2.2 + 2.0)
 *
 * Checks sticky header focus obscuring and empty list elements.
 */
export async function scanLists(page, url) {
  const violations = [];

  // StickyHeaderObscuresFocus (FocusNotObscuredHeader) — sticky header overlaps focused elements
  // Only skip if scroll-padding-top is >= the header's actual height (sufficient mitigation)
  const headerObscures = await page.evaluate(() => {
    const spt = window.getComputedStyle(document.documentElement).scrollPaddingTop;
    const sptPx = parseInt(spt) || 0;

    const headers = [...document.querySelectorAll('header, [role="banner"]')].filter((e) => {
      const s = window.getComputedStyle(e);
      return s.position === 'fixed' || s.position === 'sticky';
    });
    if (headers.length === 0) return [];
    return headers
      .filter((h) => h.offsetHeight > sptPx)
      .map((h) => ({ html: h.outerHTML.slice(0, 500), selector: cssPath(h) }));
  });
  for (const el of headerObscures) {
    violations.push(
      createViolation({
        ruleId: 'StickyHeaderObscuresFocus',
        layer: 'accessScan',
        wcagRef: 'WCAG 2.2 AA 2.4.11',
        impact: 'critical',
        priority: 1,
        element: { outerHTML: el.html, selector: el.selector },
        source: { mode: 'url', url },
        fix: {
          deterministic: false,
          hint: 'Ensure sticky header does not obscure focused elements — add scroll-padding-top.',
        },
      })
    );
  }

  // ListEmpty — <ul>/<ol> with no <li> children
  const emptyLists = await page.$$eval('ul, ol', (lists) =>
    lists
      .filter((l) => {
        const items = l.querySelectorAll('li');
        return items.length === 0 && !l.getAttribute('aria-hidden');
      })
      .map((l) => ({ html: l.outerHTML.slice(0, 500), selector: cssPath(l) }))
  );
  for (const el of emptyLists) {
    violations.push(
      createViolation({
        ruleId: 'ListEmpty',
        layer: 'accessScan',
        wcagRef: 'WCAG 2.0 A 1.3.1',
        impact: 'moderate',
        priority: 4,
        element: { outerHTML: el.html, selector: el.selector },
        source: { mode: 'url', url },
        fix: {
          deterministic: true,
          hint: 'Add aria-hidden="true" to empty lists, or populate with list items.',
        },
      })
    );
  }

  return violations;
}
