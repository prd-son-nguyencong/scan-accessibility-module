import { createViolation } from '../../schema.js';

/**
 * 04-landmarks: 10 rules (WCAG 2.0 + Best Practices)
 *
 * Checks navigation landmarks, main/footer contentinfo,
 * search form landmarks, and article/breadcrumb usage.
 */
export async function scanLandmarks(page, url, options = {}) {
  const violations = [];
  const includeThirdParty = options.includeThirdParty ?? false;

  // NavigationMisuse — <nav> without navigation links OR with links but no list structure
  // The commercial accessScan tool flags two patterns:
  //   1. <nav> with zero <a> links (empty nav landmark)
  //   2. <nav> with <a> links but no <ul>/<ol> list structure (poor screen reader experience)
  // Excludes: hidden navs (display:none / aria-hidden), and navs that contain
  // dropdown-toggle buttons (aria-haspopup) — valid patterns even when submenu
  // <a> links haven't rendered yet at scan time.
  const navMisuse = await page.$$eval('nav', (navs) =>
    navs
      .filter((n) => {
        if (n.getAttribute('aria-hidden') === 'true') return false;
        const style = window.getComputedStyle(n);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        if (n.querySelector('button[aria-haspopup]')) return false;
        const links = n.querySelectorAll('a[href]');
        if (links.length === 0) return true;
        const hasList = n.querySelector('ul, ol');
        if (hasList) return false;
        return true;
      })
      .map((n) => {
        const links = n.querySelectorAll('a[href]');
        return {
          html: n.outerHTML.slice(0, 500),
          selector: cssPath(n),
          issue: links.length === 0 ? 'no-links' : 'no-list-structure',
        };
      })
  );
  for (const el of navMisuse) {
    violations.push(
      createViolation({
        ruleId: 'NavigationMisuse',
        layer: 'accessScan',
        wcagRef: 'WCAG 2.0 A 1.3.1',
        impact: 'serious',
        priority: 7,
        element: { outerHTML: el.html, selector: el.selector },
        source: { mode: 'url', url },
        fix: {
          deterministic: false,
          hint:
            el.issue === 'no-links'
              ? 'Remove <nav> wrapper from elements without navigation links, or add links.'
              : 'Navigation landmark should use <ul>/<ol> list markup for proper screen reader announcement of link count.',
        },
      })
    );
  }

  // SearchFormMismatch — search form without role="search" or <search>
  const searchMismatch = await page.$$eval('input[type="search"], input[type="text"]', (inputs) =>
    inputs
      .filter((i) => {
        const placeholder = (i.placeholder || '').toLowerCase();
        const label = (i.getAttribute('aria-label') || '').toLowerCase();
        const isSearch = placeholder.includes('search') || label.includes('search') || i.type === 'search';
        if (!isSearch) return false;
        let parent = i.parentElement;
        while (parent) {
          if (parent.getAttribute('role') === 'search' || parent.tagName === 'SEARCH') return false;
          parent = parent.parentElement;
        }
        return true;
      })
      .map((i) => ({ html: i.outerHTML.slice(0, 500), selector: cssPath(i) }))
  );
  for (const el of searchMismatch) {
    violations.push(
      createViolation({
        ruleId: 'SearchFormMismatch',
        layer: 'accessScan',
        wcagRef: 'WCAG 2.0 A 1.3.1',
        impact: 'serious',
        priority: 8,
        element: { outerHTML: el.html, selector: el.selector },
        source: { mode: 'url', url },
        fix: {
          deterministic: true,
          hint: 'Add role="search" to the search form container or wrap in a <search> element.',
        },
      })
    );
  }

  // SearchFormMismatch (third-party) — search containers without role="search"
  // Only fires with --include-third-party since these are Paradox widget elements
  if (includeThirdParty) {
    const tpSearchMismatch = await page.$$eval(
      '[data-testid*="search_container"], [class*="search-box"], [class*="search-form"]',
      (els) =>
        els
          .filter((e) => {
            let parent = e;
            while (parent) {
              if (parent.getAttribute('role') === 'search' || parent.tagName === 'SEARCH') return false;
              parent = parent.parentElement;
            }
            const hasInput = e.querySelector('input');
            return hasInput;
          })
          .map((e) => ({ html: e.outerHTML.slice(0, 500), selector: cssPath(e) }))
    );
    for (const el of tpSearchMismatch) {
      violations.push(
        createViolation({
          ruleId: 'SearchFormMismatch',
          layer: 'accessScan',
          wcagRef: 'WCAG 2.0 A 1.3.1',
          impact: 'serious',
          priority: 8,
          element: { outerHTML: el.html, selector: el.selector },
          source: { mode: 'url', url },
          fix: {
            deterministic: true,
            hint: 'Add role="search" to the search form container or wrap in a <search> element.',
          },
        })
      );
    }
  }

  // RegionFooterMisuse — non-footer element with role="contentinfo"
  const footerMisuse = await page.$$eval('[role="contentinfo"]', (els) =>
    els
      .filter((e) => e.tagName !== 'FOOTER')
      .map((e) => ({ html: e.outerHTML.slice(0, 500), selector: cssPath(e) }))
  );
  for (const el of footerMisuse) {
    violations.push(
      createViolation({
        ruleId: 'RegionFooterMisuse',
        layer: 'accessScan',
        wcagRef: 'Best Practice',
        impact: 'moderate',
        priority: 9,
        element: { outerHTML: el.html, selector: el.selector },
        source: { mode: 'url', url },
        fix: {
          deterministic: false,
          hint: 'Remove role="contentinfo" from non-footer elements (third-party widget).',
        },
      })
    );
  }

  // RegionFooterSingle — multiple contentinfo landmarks
  const contentinfos = await page.$$eval('footer, [role="contentinfo"]', (els) => els.length);
  if (contentinfos > 1) {
    violations.push(
      createViolation({
        ruleId: 'RegionFooterSingle',
        layer: 'accessScan',
        wcagRef: 'Best Practice',
        impact: 'moderate',
        priority: 10,
        element: { outerHTML: '', selector: '' },
        source: { mode: 'url', url },
        fix: {
          deterministic: false,
          hint: 'Page has multiple contentinfo landmarks — remove role="contentinfo" from duplicates.',
        },
      })
    );
  }

  // RegionFooterMismatch — contentinfo landmark without global site information
  const footerContentMismatch = await page.$$eval('[role="contentinfo"], footer', (els) =>
    els
      .filter((e) => {
        const text = e.textContent.toLowerCase();
        const hasFooterContent = [
          'copyright', '\u00a9', 'privacy', 'terms', 'contact',
          'all rights', 'cookie', 'legal', 'sitemap',
        ].some((k) => text.includes(k));
        const hasFooterLinks = e.querySelectorAll('a[href]').length >= 2;
        return !hasFooterContent && !hasFooterLinks;
      })
      .map((e) => ({ html: e.outerHTML.slice(0, 500), selector: cssPath(e) }))
  );
  for (const el of footerContentMismatch) {
    violations.push(
      createViolation({
        ruleId: 'RegionFooterMismatch',
        layer: 'accessScan',
        wcagRef: 'WCAG 2.0 A 1.3.1',
        impact: 'moderate',
        priority: 9,
        element: { outerHTML: el.html, selector: el.selector },
        source: { mode: 'url', url },
        fix: {
          deterministic: false,
          hint: 'Element tagged as contentinfo/footer does not contain global site information (copyright, privacy, contact links).',
        },
      })
    );
  }

  // ArticleMisuse — <article> without self-contained content
  const articleMisuse = await page.$$eval('article', (articles) =>
    articles
      .filter((a) => {
        const hasHeading = a.querySelector('h1, h2, h3, h4, h5, h6');
        const textLen = a.textContent.trim().length;
        return !hasHeading && textLen < 50;
      })
      .map((a) => ({ html: a.outerHTML.slice(0, 500), selector: cssPath(a) }))
  );
  for (const el of articleMisuse) {
    violations.push(
      createViolation({
        ruleId: 'ArticleMisuse',
        layer: 'accessScan',
        wcagRef: 'WCAG 2.0 A 1.3.1',
        impact: 'moderate',
        priority: 4,
        element: { outerHTML: el.html, selector: el.selector },
        source: { mode: 'url', url },
        fix: {
          deterministic: false,
          hint: 'Remove <article> from non-self-contained content or add heading.',
        },
      })
    );
  }

  // BreadcrumbsMismatch — breadcrumb navigation without an accessible label
  const breadcrumbNoLabel = await page.$$eval('nav', (navs) =>
    navs
      .filter((n) => {
        const hasBreadcrumb = n.querySelector('ol > li > a') || n.querySelector('[aria-label*="readcrumb" i]');
        if (!hasBreadcrumb) return false;
        const label = n.getAttribute('aria-label')?.trim() || n.getAttribute('aria-labelledby');
        return !label;
      })
      .map((n) => ({ html: n.outerHTML.slice(0, 500), selector: cssPath(n) }))
  );
  for (const el of breadcrumbNoLabel) {
    violations.push(
      createViolation({
        ruleId: 'BreadcrumbsMismatch',
        layer: 'accessScan',
        wcagRef: 'WCAG 2.0 A 1.3.1',
        impact: 'moderate',
        priority: 4,
        element: { outerHTML: el.html, selector: el.selector },
        source: { mode: 'url', url },
        fix: {
          deterministic: true,
          hint: 'Add aria-label="Breadcrumb" to the breadcrumb <nav> element.',
        },
      })
    );
  }

  // RegionMainContentMismatch — significant content outside <main>
  const mainContentIssue = await page.evaluate(() => {
    const main = document.querySelector('main');
    if (!main) return null;
    const body = document.body;
    const directChildren = Array.from(body.children);
    const outsideMain = directChildren.filter((c) => {
      if (c === main || c.contains(main)) return false;
      const tag = c.tagName.toLowerCase();
      if (['header', 'footer', 'nav', 'script', 'style', 'link', 'meta', 'noscript'].includes(tag)) return false;
      if (c.getAttribute('aria-hidden') === 'true') return false;
      if (c.getAttribute('role') === 'banner' || c.getAttribute('role') === 'contentinfo' || c.getAttribute('role') === 'navigation') return false;
      const text = c.textContent.trim();
      return text.length > 50;
    });
    if (outsideMain.length === 0) return null;
    return { html: outsideMain[0].outerHTML.slice(0, 500), selector: outsideMain[0].tagName.toLowerCase() };
  });
  if (mainContentIssue) {
    violations.push(
      createViolation({
        ruleId: 'RegionMainContentMismatch',
        layer: 'accessScan',
        wcagRef: 'WCAG 2.0 A 1.3.1',
        impact: 'moderate',
        priority: 4,
        element: { outerHTML: mainContentIssue.html, selector: mainContentIssue.selector },
        source: { mode: 'url', url },
        fix: {
          deterministic: false,
          hint: 'Move significant content inside the <main> landmark so screen readers can locate it.',
        },
      })
    );
  }

  // RegionMainContentMisuse — main landmark with minimal or no meaningful content
  const mainMisuse = await page.evaluate(() => {
    const mains = document.querySelectorAll('main, [role="main"]');
    const results = [];
    for (const m of mains) {
      const text = m.textContent.trim();
      const hasHeading = m.querySelector('h1, h2, h3, h4, h5, h6');
      if (text.length < 50 && !hasHeading) {
        results.push({ html: m.outerHTML.slice(0, 500), selector: cssPath(m) });
      }
    }
    return results;
  });
  for (const el of mainMisuse) {
    violations.push(
      createViolation({
        ruleId: 'RegionMainContentMisuse',
        layer: 'accessScan',
        wcagRef: 'WCAG 2.0 A 1.3.1',
        impact: 'moderate',
        priority: 4,
        element: { outerHTML: el.html, selector: el.selector },
        source: { mode: 'url', url },
        fix: {
          deterministic: false,
          hint: 'Main landmark contains minimal content — remove <main> or add primary page content.',
        },
      })
    );
  }

  // RegionMainContentSingle — multiple <main> landmarks
  const mainCount = await page.$$eval('main, [role="main"]', (els) => els.length);
  if (mainCount > 1) {
    violations.push(
      createViolation({
        ruleId: 'RegionMainContentSingle',
        layer: 'accessScan',
        wcagRef: 'WCAG 2.0 A 1.3.1',
        impact: 'moderate',
        priority: 4,
        element: { outerHTML: '', selector: 'main' },
        source: { mode: 'url', url },
        fix: {
          deterministic: false,
          hint: 'Page has multiple <main> landmarks — use only one per page.',
        },
      })
    );
  }

  return violations;
}
