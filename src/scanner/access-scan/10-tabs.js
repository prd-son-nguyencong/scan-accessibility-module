import { createViolation } from '../../schema.js';

/**
 * 10-tabs: 6 rules (WCAG 2.0)
 *
 * Checks tab interfaces for proper ARIA roles:
 * tablist, tab, tabpanel, aria-selected, aria-controls, aria-labelledby.
 */
export async function scanTabs(page, url) {
  const violations = [];

  // TablistRole — tablist without role="tablist"
  const tabContainers = await page.evaluate(() => {
    const candidates = document.querySelectorAll('[role="tablist"]');
    const results = [];
    for (const c of candidates) {
      const tabs = c.querySelectorAll('[role="tab"]');
      if (tabs.length === 0) {
        results.push({ html: c.outerHTML.slice(0, 500), selector: cssPath(c), issue: 'no-tabs' });
      }
      for (const t of tabs) {
        if (!t.getAttribute('aria-selected')) {
          results.push({ html: t.outerHTML.slice(0, 500), selector: cssPath(t), issue: 'no-aria-selected' });
        }
        if (!t.getAttribute('aria-controls')) {
          results.push({ html: t.outerHTML.slice(0, 500), selector: cssPath(t), issue: 'no-aria-controls' });
        }
      }
    }
    return results;
  });

  for (const el of tabContainers) {
    const ruleId =
      el.issue === 'no-tabs' ? 'TablistRole' : el.issue === 'no-aria-selected' ? 'TabAriaSelected' : 'TabAriaControls';
    violations.push(
      createViolation({
        ruleId,
        layer: 'accessScan',
        wcagRef: 'WCAG 2.0 A 4.1.2',
        impact: 'serious',
        priority: 3,
        element: { outerHTML: el.html, selector: el.selector },
        source: { mode: 'url', url },
        fix: {
          deterministic: true,
          hint:
            el.issue === 'no-tabs'
              ? 'Tablist has no role="tab" children.'
              : el.issue === 'no-aria-selected'
                ? 'Add aria-selected to tab elements.'
                : 'Add aria-controls pointing to the tabpanel ID.',
        },
      })
    );
  }

  // TabPanelRole — tabpanel without aria-labelledby
  const panelIssues = await page.$$eval('[role="tabpanel"]', (panels) =>
    panels
      .filter((p) => !p.getAttribute('aria-labelledby') && !p.getAttribute('aria-label'))
      .map((p) => ({ html: p.outerHTML.slice(0, 500), selector: cssPath(p) }))
  );
  for (const el of panelIssues) {
    violations.push(
      createViolation({
        ruleId: 'TabpanelLabelledBy',
        layer: 'accessScan',
        wcagRef: 'WCAG 2.0 A 4.1.2',
        impact: 'moderate',
        priority: 4,
        element: { outerHTML: el.html, selector: el.selector },
        source: { mode: 'url', url },
        fix: {
          deterministic: true,
          hint: 'Add aria-labelledby referencing the controlling tab element ID.',
        },
      })
    );
  }

  // TabListMisuse — role="tablist" on element with no tab children
  const tablistMisuse = await page.evaluate(() => {
    const tablists = document.querySelectorAll('[role="tablist"]');
    const results = [];
    for (const tl of tablists) {
      const tabs = tl.querySelectorAll('[role="tab"]');
      const hasTabLikeChildren = tl.children.length > 0;
      if (tabs.length === 0 && hasTabLikeChildren) {
        results.push({ html: tl.outerHTML.slice(0, 500), selector: cssPath(tl) });
      }
    }
    return results;
  });
  for (const el of tablistMisuse) {
    violations.push(
      createViolation({
        ruleId: 'TabListMisuse',
        layer: 'accessScan',
        wcagRef: 'WCAG 2.0 A 4.1.2',
        impact: 'serious',
        priority: 3,
        element: { outerHTML: el.html, selector: el.selector },
        source: { mode: 'url', url },
        fix: {
          deterministic: true,
          hint: 'role="tablist" must contain [role="tab"] children — remove it or add proper tab roles.',
        },
      })
    );
  }

  // TabMismatch — tab-like controls missing role="tab"
  const tabMismatch = await page.evaluate(() => {
    const tablists = document.querySelectorAll('[role="tablist"]');
    const results = [];
    for (const tl of tablists) {
      for (const child of tl.children) {
        if (child.getAttribute('role') !== 'tab' && child.tagName !== 'TEMPLATE') {
          results.push({ html: child.outerHTML.slice(0, 500), selector: cssPath(child) });
        }
      }
    }
    return results;
  });
  for (const el of tabMismatch) {
    violations.push(
      createViolation({
        ruleId: 'TabMismatch',
        layer: 'accessScan',
        wcagRef: 'WCAG 2.0 A 4.1.2',
        impact: 'serious',
        priority: 3,
        element: { outerHTML: el.html, selector: el.selector },
        source: { mode: 'url', url },
        fix: {
          deterministic: true,
          hint: 'Direct children of role="tablist" should have role="tab".',
        },
      })
    );
  }

  // TabMisuse — role="tab" outside a tablist
  const tabMisuse = await page.$$eval('[role="tab"]', (tabs) =>
    tabs
      .filter((t) => !t.closest('[role="tablist"]'))
      .map((t) => ({ html: t.outerHTML.slice(0, 500), selector: cssPath(t) }))
  );
  for (const el of tabMisuse) {
    violations.push(
      createViolation({
        ruleId: 'TabMisuse',
        layer: 'accessScan',
        wcagRef: 'WCAG 2.0 A 4.1.2',
        impact: 'serious',
        priority: 3,
        element: { outerHTML: el.html, selector: el.selector },
        source: { mode: 'url', url },
        fix: {
          deterministic: true,
          hint: 'role="tab" must be inside a [role="tablist"] container.',
        },
      })
    );
  }

  // TabPanelMismatch — tab panels missing role="tabpanel"
  const panelMismatch = await page.evaluate(() => {
    const tabs = document.querySelectorAll('[role="tab"][aria-controls]');
    const results = [];
    for (const t of tabs) {
      const panelId = t.getAttribute('aria-controls');
      const panel = panelId ? document.getElementById(panelId) : null;
      if (panel && panel.getAttribute('role') !== 'tabpanel') {
        results.push({ html: panel.outerHTML.slice(0, 500), selector: cssPath(panel) });
      }
    }
    return results;
  });
  for (const el of panelMismatch) {
    violations.push(
      createViolation({
        ruleId: 'TabPanelMismatch',
        layer: 'accessScan',
        wcagRef: 'WCAG 2.0 A 4.1.2',
        impact: 'serious',
        priority: 3,
        element: { outerHTML: el.html, selector: el.selector },
        source: { mode: 'url', url },
        fix: {
          deterministic: true,
          hint: 'Tab-controlled panel must have role="tabpanel".',
        },
      })
    );
  }

  // TabPanelMisuse — role="tabpanel" without associated tab
  const panelMisuse = await page.evaluate(() => {
    const panels = document.querySelectorAll('[role="tabpanel"]');
    const results = [];
    for (const p of panels) {
      const id = p.id;
      if (!id) {
        results.push({ html: p.outerHTML.slice(0, 500), selector: cssPath(p) });
        continue;
      }
      const controllingTab = document.querySelector(`[role="tab"][aria-controls="${id}"]`);
      if (!controllingTab) {
        results.push({ html: p.outerHTML.slice(0, 500), selector: cssPath(p) });
      }
    }
    return results;
  });
  for (const el of panelMisuse) {
    violations.push(
      createViolation({
        ruleId: 'TabPanelMisuse',
        layer: 'accessScan',
        wcagRef: 'WCAG 2.0 A 4.1.2',
        impact: 'moderate',
        priority: 4,
        element: { outerHTML: el.html, selector: el.selector },
        source: { mode: 'url', url },
        fix: {
          deterministic: true,
          hint: 'role="tabpanel" must be linked to a [role="tab"] via aria-controls or remove the role.',
        },
      })
    );
  }

  return violations;
}
