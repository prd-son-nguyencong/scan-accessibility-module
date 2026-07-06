import { createViolation } from '../../schema.js';

/**
 * 06-dragging: 1 rule (WCAG 2.2)
 *
 * Checks that sliders/draggable elements can be operated with a single pointer.
 */
export async function scanDragging(page, url) {
  const violations = [];

  // DraggingAlternative — slider without keyboard alternative
  const sliders = await page.$$eval('input[type="range"], [role="slider"]', (els) =>
    els
      .filter((e) => {
        const tabindex = e.getAttribute('tabindex');
        return tabindex === '-1' || (!e.matches(':focus-visible') && e.tagName !== 'INPUT');
      })
      .map((e) => ({ html: e.outerHTML.slice(0, 500), selector: cssPath(e) }))
  );
  for (const el of sliders) {
    violations.push(
      createViolation({
        ruleId: 'DraggingAlternative',
        layer: 'accessScan',
        wcagRef: 'WCAG 2.2 AA 2.5.7',
        impact: 'serious',
        priority: 3,
        element: { outerHTML: el.html, selector: el.selector },
        source: { mode: 'url', url },
        fix: {
          deterministic: false,
          hint: 'Ensure slider can be operated with a single pointer (no drag required).',
        },
      })
    );
  }

  return violations;
}
