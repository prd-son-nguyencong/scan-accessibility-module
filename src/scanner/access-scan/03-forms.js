import { createViolation } from '../../schema.js';

/**
 * 03-forms: 6 rules (WCAG 2.0)
 *
 * Checks form field labels, required field indicators,
 * context change warnings, and submit button types.
 */
export async function scanForms(page, url) {
  const violations = [];

  // RequiredFormFieldAriaRequired — required fields missing required/aria-required
  const missingRequired = await page.$$eval('input, select, textarea', (fields) =>
    fields
      .filter((f) => {
        const label = document.querySelector(`label[for="${f.id}"]`);
        const labelText = label ? label.textContent : '';
        const isVisuallyRequired = labelText.includes('*') || f.placeholder?.includes('*');
        const hasRequiredAttr = f.hasAttribute('required') || f.getAttribute('aria-required') === 'true';
        return isVisuallyRequired && !hasRequiredAttr;
      })
      .map((f) => ({ html: f.outerHTML.slice(0, 500), selector: cssPath(f) }))
  );
  for (const el of missingRequired) {
    violations.push(
      createViolation({
        ruleId: 'RequiredFormFieldAriaRequired',
        layer: 'accessScan',
        wcagRef: 'WCAG 2.0 A 3.3.2',
        impact: 'serious',
        priority: 6,
        element: { outerHTML: el.html, selector: el.selector },
        source: { mode: 'url', url },
        fix: {
          deterministic: true,
          hint: 'Add required or aria-required="true" to visually required fields.',
        },
      })
    );
  }

  // FormSubmitButtonMismatch — form without type="submit" button
  const formsMissingSubmit = await page.$$eval('form', (forms) =>
    forms
      .filter((f) => {
        const btns = f.querySelectorAll('button, input[type="submit"]');
        return btns.length > 0 && ![...btns].some((b) => b.type === 'submit');
      })
      .map((f) => ({ html: f.outerHTML.slice(0, 300), selector: cssPath(f) }))
  );
  for (const el of formsMissingSubmit) {
    violations.push(
      createViolation({
        ruleId: 'FormSubmitButtonMismatch',
        layer: 'accessScan',
        wcagRef: 'WCAG 2.0 A 3.2.2',
        impact: 'moderate',
        priority: 4,
        element: { outerHTML: el.html, selector: el.selector },
        source: { mode: 'url', url },
        fix: {
          deterministic: true,
          hint: 'Add type="submit" to the form submission button.',
        },
      })
    );
  }

  // CheckboxDiscernible — checkbox without associated label
  const checkboxNoLabel = await page.$$eval('input[type="checkbox"]', (cbs) =>
    cbs
      .filter((cb) => {
        if (cb.getAttribute('aria-hidden') === 'true') return false;
        const id = cb.id;
        const hasLabel = (id && document.querySelector(`label[for="${id}"]`)) || cb.closest('label');
        const hasAriaLabel = cb.getAttribute('aria-label')?.trim() || cb.getAttribute('aria-labelledby');
        const hasTitle = cb.getAttribute('title')?.trim();
        return !hasLabel && !hasAriaLabel && !hasTitle;
      })
      .map((cb) => ({ html: cb.outerHTML.slice(0, 500), selector: cssPath(cb) }))
  );
  for (const el of checkboxNoLabel) {
    violations.push(
      createViolation({
        ruleId: 'CheckboxDiscernible',
        layer: 'accessScan',
        wcagRef: 'WCAG 2.0 A 1.3.1',
        impact: 'serious',
        priority: 2,
        element: { outerHTML: el.html, selector: el.selector },
        source: { mode: 'url', url },
        fix: {
          deterministic: true,
          hint: 'Add a <label> element associated with the checkbox, or use aria-label.',
        },
      })
    );
  }

  // RadioDiscernible — radio button without associated label
  const radioNoLabel = await page.$$eval('input[type="radio"]', (radios) =>
    radios
      .filter((r) => {
        if (r.getAttribute('aria-hidden') === 'true') return false;
        const id = r.id;
        const hasLabel = (id && document.querySelector(`label[for="${id}"]`)) || r.closest('label');
        const hasAriaLabel = r.getAttribute('aria-label')?.trim() || r.getAttribute('aria-labelledby');
        const hasTitle = r.getAttribute('title')?.trim();
        return !hasLabel && !hasAriaLabel && !hasTitle;
      })
      .map((r) => ({ html: r.outerHTML.slice(0, 500), selector: cssPath(r) }))
  );
  for (const el of radioNoLabel) {
    violations.push(
      createViolation({
        ruleId: 'RadioDiscernible',
        layer: 'accessScan',
        wcagRef: 'WCAG 2.0 A 1.3.1',
        impact: 'serious',
        priority: 2,
        element: { outerHTML: el.html, selector: el.selector },
        source: { mode: 'url', url },
        fix: {
          deterministic: true,
          hint: 'Add a <label> element associated with the radio button, or use aria-label.',
        },
      })
    );
  }

  // FormContextChangeWarning — select with onchange causing context change
  const contextChangeSelects = await page.$$eval('select', (selects) =>
    selects
      .filter((s) => {
        const hasOnchange = s.getAttribute('onchange') || s.getAttribute('onChange');
        if (!hasOnchange) return false;
        const form = s.closest('form');
        const hasSubmit = form?.querySelector('button[type="submit"], input[type="submit"]');
        return !hasSubmit;
      })
      .map((s) => ({ html: s.outerHTML.slice(0, 500), selector: cssPath(s) }))
  );
  for (const el of contextChangeSelects) {
    violations.push(
      createViolation({
        ruleId: 'FormContextChangeWarning',
        layer: 'accessScan',
        wcagRef: 'WCAG 2.0 A 3.2.2',
        impact: 'serious',
        priority: 3,
        element: { outerHTML: el.html, selector: el.selector },
        source: { mode: 'url', url },
        fix: {
          deterministic: false,
          hint: 'Avoid auto-submitting forms on select change — provide an explicit submit button.',
        },
      })
    );
  }

  // MainNavigationMismatch — main navigation without <nav> or role="navigation"
  const navMismatch = await page.$$eval('ul, div', (els) =>
    els
      .filter((e) => {
        const links = e.querySelectorAll('a[href]');
        if (links.length < 3) return false;
        if (e.closest('nav, [role="navigation"]')) return false;
        if (e.closest('footer')) return false;
        const cls = (e.className || '').toLowerCase();
        const id = (e.id || '').toLowerCase();
        return cls.includes('nav') || cls.includes('menu') || id.includes('nav') || id.includes('menu');
      })
      .map((e) => ({ html: e.outerHTML.slice(0, 500), selector: cssPath(e) }))
  );
  for (const el of navMismatch) {
    violations.push(
      createViolation({
        ruleId: 'MainNavigationMismatch',
        layer: 'accessScan',
        wcagRef: 'Best Practice',
        impact: 'moderate',
        priority: 4,
        element: { outerHTML: el.html, selector: el.selector },
        source: { mode: 'url', url },
        fix: {
          deterministic: true,
          hint: 'Wrap main navigation in <nav> or add role="navigation" for screen reader landmark access.',
        },
      })
    );
  }

  return violations;
}
