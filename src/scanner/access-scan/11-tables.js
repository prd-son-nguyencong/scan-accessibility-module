import { createViolation } from '../../schema.js';

/**
 * 11-tables: 5 rules (WCAG 2.0)
 *
 * Checks table headers, nesting, roles, summary, and captions.
 */
export async function scanTables(page, url) {
  const violations = [];

  // TableHeaders — table without <th> or scope attributes
  const missingHeaders = await page.$$eval('table', (tables) =>
    tables
      .filter((t) => {
        const ths = t.querySelectorAll('th');
        if (ths.length > 0) return false;
        const rows = t.querySelectorAll('tr');
        return rows.length > 1;
      })
      .map((t) => ({ html: t.outerHTML.slice(0, 500), selector: cssPath(t) }))
  );
  for (const el of missingHeaders) {
    violations.push(
      createViolation({
        ruleId: 'TableHeaders',
        layer: 'accessScan',
        wcagRef: 'WCAG 2.0 A 1.3.1',
        impact: 'serious',
        priority: 3,
        element: { outerHTML: el.html, selector: el.selector },
        source: { mode: 'url', url },
        fix: {
          deterministic: false,
          hint: 'Add <th> header cells to data tables for screen reader row/column association.',
        },
      })
    );
  }

  // TableNesting — nested <table> inside <table>
  const nestedTables = await page.$$eval('table table', (tables) =>
    tables.map((t) => ({ html: t.outerHTML.slice(0, 300), selector: cssPath(t) }))
  );
  for (const el of nestedTables) {
    violations.push(
      createViolation({
        ruleId: 'TableNesting',
        layer: 'accessScan',
        wcagRef: 'WCAG 2.0 A 1.3.1',
        impact: 'serious',
        priority: 3,
        element: { outerHTML: el.html, selector: el.selector },
        source: { mode: 'url', url },
        fix: {
          deterministic: false,
          hint: 'Flatten nested tables — screen readers struggle with nested table structures.',
        },
      })
    );
  }

  // TableRoles — layout table with data table markup
  const layoutTables = await page.$$eval('table', (tables) =>
    tables
      .filter((t) => {
        if (t.getAttribute('role') === 'presentation' || t.getAttribute('role') === 'none') return false;
        const cells = t.querySelectorAll('td');
        const isLayout = cells.length <= 2 && !t.querySelector('th') && !t.querySelector('caption');
        return isLayout && cells.length > 0;
      })
      .map((t) => ({ html: t.outerHTML.slice(0, 500), selector: cssPath(t) }))
  );
  for (const el of layoutTables) {
    violations.push(
      createViolation({
        ruleId: 'TableRoles',
        layer: 'accessScan',
        wcagRef: 'WCAG 2.0 A 1.3.1',
        impact: 'moderate',
        priority: 4,
        element: { outerHTML: el.html, selector: el.selector },
        source: { mode: 'url', url },
        fix: {
          deterministic: true,
          hint: 'Add role="presentation" to layout tables so screen readers skip table semantics.',
        },
      })
    );
  }

  // TableCaption — data table without <caption>
  const missingCaption = await page.$$eval('table', (tables) =>
    tables
      .filter((t) => {
        if (t.getAttribute('role') === 'presentation' || t.getAttribute('role') === 'none') return false;
        const hasTh = t.querySelector('th');
        const hasCaption = t.querySelector('caption');
        const hasAriaLabel = t.getAttribute('aria-label') || t.getAttribute('aria-labelledby');
        return hasTh && !hasCaption && !hasAriaLabel;
      })
      .map((t) => ({ html: t.outerHTML.slice(0, 300), selector: cssPath(t) }))
  );
  for (const el of missingCaption) {
    violations.push(
      createViolation({
        ruleId: 'TableCaption',
        layer: 'accessScan',
        wcagRef: 'WCAG 2.0 A 1.3.1',
        impact: 'moderate',
        priority: 4,
        element: { outerHTML: el.html, selector: el.selector },
        source: { mode: 'url', url },
        fix: {
          deterministic: false,
          hint: 'Add <caption> or aria-label to data tables for screen reader context.',
        },
      })
    );
  }

  // TableHeaderEmpty — <th> with no text content
  const emptyHeaders = await page.$$eval('th', (ths) =>
    ths
      .filter((th) => {
        const text = th.textContent.trim();
        const img = th.querySelector('img[alt]');
        const ariaLabel = th.getAttribute('aria-label')?.trim();
        return !text && !img && !ariaLabel;
      })
      .map((th) => ({ html: th.outerHTML.slice(0, 500), selector: cssPath(th) }))
  );
  for (const el of emptyHeaders) {
    violations.push(
      createViolation({
        ruleId: 'TableHeaderEmpty',
        layer: 'accessScan',
        wcagRef: 'WCAG 2.0 A 1.3.1',
        impact: 'serious',
        priority: 3,
        element: { outerHTML: el.html, selector: el.selector },
        source: { mode: 'url', url },
        fix: {
          deterministic: false,
          hint: 'Empty <th> cells confuse screen readers — add descriptive header text.',
        },
      })
    );
  }

  // TableMisuse — layout table with data-table markup (has <th>, <caption>, or summary but used for layout)
  const tableMisuse = await page.$$eval('table', (tables) =>
    tables
      .filter((t) => {
        if (t.getAttribute('role') === 'presentation' || t.getAttribute('role') === 'none') return false;
        if (t.querySelector('th') || t.querySelector('caption')) return false;
        const hasSummary = t.getAttribute('summary');
        const hasRoleTable = t.getAttribute('role') === 'table' || t.getAttribute('role') === 'grid';
        const rows = t.querySelectorAll('tr');
        const maxCols = Math.max(...[...rows].map((r) => r.cells.length));
        const isSingleColumn = maxCols <= 1;
        return (hasSummary || hasRoleTable) && (rows.length <= 1 || isSingleColumn);
      })
      .map((t) => ({ html: t.outerHTML.slice(0, 500), selector: cssPath(t) }))
  );
  for (const el of tableMisuse) {
    violations.push(
      createViolation({
        ruleId: 'TableMisuse',
        layer: 'accessScan',
        wcagRef: 'WCAG 2.0 A 1.3.1',
        impact: 'moderate',
        priority: 4,
        element: { outerHTML: el.html, selector: el.selector },
        source: { mode: 'url', url },
        fix: {
          deterministic: true,
          hint: 'Layout table has data-table markup (role/summary) — remove data-table semantics or use CSS for layout.',
        },
      })
    );
  }

  // TableRowHeaderMismatch — row headers without scope="row"
  const rowHeaderNoScope = await page.$$eval('th', (ths) =>
    ths
      .filter((th) => {
        const scope = th.getAttribute('scope');
        if (scope) return false;
        const row = th.parentElement;
        if (!row) return false;
        const isFirstCell = row.cells[0] === th;
        const tableHasColHeaders = th.closest('table')?.querySelector('thead th');
        return isFirstCell && tableHasColHeaders;
      })
      .map((th) => ({ html: th.outerHTML.slice(0, 500), selector: cssPath(th) }))
  );
  for (const el of rowHeaderNoScope) {
    violations.push(
      createViolation({
        ruleId: 'TableRowHeaderMismatch',
        layer: 'accessScan',
        wcagRef: 'WCAG 2.0 A 1.3.1',
        impact: 'moderate',
        priority: 4,
        element: { outerHTML: el.html, selector: el.selector },
        source: { mode: 'url', url },
        fix: {
          deterministic: true,
          hint: 'Add scope="row" to row header cells so screen readers announce proper associations.',
        },
      })
    );
  }

  return violations;
}
