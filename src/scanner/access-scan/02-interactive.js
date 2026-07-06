import { createViolation } from '../../schema.js';

/**
 * 02-interactive: 16 rules (WCAG 2.2 + 2.0 + Best Practices)
 *
 * Checks focus visibility, button/link semantics, keyboard accessibility,
 * pointer cancellation, target size, and animation controls.
 */
export async function scanInteractive(page, url) {
  const violations = [];

  // FocusNotObscuredFooter — sticky footer obscures focused elements
  // Detects position:fixed/sticky elements anchored near the viewport bottom,
  // including third-party widgets (Paradox "Powered by" bar) that inject after page load.
  // Also checks role="contentinfo" elements which are semantically footers.
  const footerObscures = await page.evaluate(() => {
    const stickyEls = [...document.querySelectorAll('*')].filter((e) => {
      const s = window.getComputedStyle(e);
      const isFixedOrSticky = s.position === 'fixed' || s.position === 'sticky';
      const isContentInfo = e.getAttribute('role') === 'contentinfo' && !e.closest('footer');
      if (!isFixedOrSticky && !isContentInfo) return false;
      if (e.offsetHeight <= 0) return false;
      const rect = e.getBoundingClientRect();
      return rect.top >= window.innerHeight * 0.7;
    });
    if (stickyEls.length === 0) return [];
    const seen = new Set();
    const results = [];
    for (const s of stickyEls) {
      const key = s.outerHTML.slice(0, 200);
      if (seen.has(key)) continue;
      seen.add(key);
      results.push({ html: s.outerHTML.slice(0, 500), selector: cssPath(s) });
    }
    return results.slice(0, 5);
  });
  for (const el of footerObscures) {
    violations.push(
      createViolation({
        ruleId: 'FocusNotObscuredFooter',
        layer: 'accessScan',
        category: 'accessibility',
        wcagRef: 'WCAG 2.2 AA 2.4.12',
        impact: 'critical',
        priority: 1,
        element: { outerHTML: el.html, selector: el.selector },
        source: { mode: 'url', url },
        fix: {
          deterministic: false,
          hint: 'Add bottom padding so focused elements are never hidden behind the sticky footer.',
        },
      })
    );
  }

  // ButtonMismatch — <a> styled as button but missing role="button"
  const buttonMismatches = await page.$$eval('a', (links) =>
    links
      .filter((a) => {
        const cls = a.className || '';
        return (
          (cls.includes('btn') || cls.includes('button')) &&
          !a.getAttribute('role') &&
          a.getAttribute('href') === '#'
        );
      })
      .map((a) => ({ html: a.outerHTML.slice(0, 500), selector: cssPath(a) }))
  );
  for (const el of buttonMismatches) {
    violations.push(
      createViolation({
        ruleId: 'ButtonMismatch',
        layer: 'accessScan',
        wcagRef: 'WCAG 2.0 A 4.1.2',
        impact: 'serious',
        priority: 4,
        element: { outerHTML: el.html, selector: el.selector },
        source: { mode: 'url', url },
        fix: {
          deterministic: true,
          hint: 'Add role="button" to <a> elements styled as buttons, or change to <button>.',
        },
      })
    );
  }

  // LinkNavigationAmbiguous — identical link text pointing to different URLs
  const ambiguousLinks = await page.$$eval('a[href]', (links) => {
    const textToUrls = new Map();
    for (const a of links) {
      const text = a.textContent.trim().toLowerCase();
      if (!text || text.length < 3) continue;
      const href = a.getAttribute('href');
      if (!textToUrls.has(text)) textToUrls.set(text, new Set());
      textToUrls.get(text).add(href);
    }
    const ambiguous = [];
    for (const [text, urls] of textToUrls.entries()) {
      if (urls.size > 1) {
        const matching = links.filter(
          (a) => a.textContent.trim().toLowerCase() === text && !a.getAttribute('aria-label')
        );
        for (const a of matching) {
          ambiguous.push({ html: a.outerHTML.slice(0, 500), selector: cssPath(a), text });
        }
      }
    }
    return ambiguous;
  });
  for (const el of ambiguousLinks) {
    violations.push(
      createViolation({
        ruleId: 'LinkNavigationAmbiguous',
        layer: 'accessScan',
        wcagRef: 'WCAG 2.0 A 2.4.4',
        impact: 'serious',
        priority: 5,
        element: { outerHTML: el.html, selector: el.selector },
        source: { mode: 'url', url },
        fix: {
          deterministic: false,
          hint: `Add unique aria-label to distinguish "${el.text}" links pointing to different destinations.`,
        },
      })
    );
  }

  // LinkOpensNewWindow — target="_blank" without warning in visible text, aria-label, or sr-only child
  const blankLinks = await page.$$eval('a[target="_blank"]', (links) =>
    links
      .filter((a) => {
        const text = a.textContent.toLowerCase();
        const label = (a.getAttribute('aria-label') || '').toLowerCase();
        const ariaDesc = (a.getAttribute('aria-describedby') ? (document.getElementById(a.getAttribute('aria-describedby'))?.textContent || '') : '').toLowerCase();
        const hasWarning = (s) => s.includes('new window') || s.includes('new tab') || s.includes('opens in');
        return !hasWarning(text) && !hasWarning(label) && !hasWarning(ariaDesc);
      })
      .map((a) => ({ html: a.outerHTML.slice(0, 500), selector: cssPath(a) }))
  );
  for (const el of blankLinks) {
    violations.push(
      createViolation({
        ruleId: 'LinkOpensNewWindow',
        layer: 'accessScan',
        wcagRef: 'WCAG 2.0 AAA 3.2.5',
        impact: 'minor',
        priority: 5,
        element: { outerHTML: el.html, selector: el.selector },
        source: { mode: 'url', url },
        fix: {
          deterministic: true,
          hint: 'Add "(opens in new window)" to aria-label or visible text for target="_blank" links.',
        },
      })
    );
  }

  // TargetSize — interactive elements smaller than 24x24px (WCAG 2.5.8)
  const smallTargets = await page.evaluate(() => {
    const interactive = document.querySelectorAll('a[href], button, input, select, textarea, [role="button"]');
    return [...interactive]
      .filter((e) => {
        const rect = e.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && (rect.width < 24 || rect.height < 24);
      })
      .slice(0, 20)
      .map((e) => ({
        html: e.outerHTML.slice(0, 500),
        selector: cssPath(e),
        width: Math.round(e.getBoundingClientRect().width),
        height: Math.round(e.getBoundingClientRect().height),
      }));
  });
  for (const el of smallTargets) {
    violations.push(
      createViolation({
        ruleId: 'TargetSize',
        layer: 'accessScan',
        wcagRef: 'WCAG 2.2 AA 2.5.8',
        impact: 'moderate',
        priority: 4,
        element: { outerHTML: el.html, selector: el.selector },
        source: { mode: 'url', url },
        fix: {
          deterministic: false,
          hint: `Target size is ${el.width}x${el.height}px — minimum 24x24px required.`,
        },
      })
    );
  }

  // ButtonDiscernible — <button> with no accessible name
  const buttonNoName = await page.$$eval('button', (btns) =>
    btns
      .filter((b) => {
        if (b.getAttribute('aria-hidden') === 'true') return false;
        const style = window.getComputedStyle(b);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        const text = b.textContent.trim();
        const label = b.getAttribute('aria-label')?.trim();
        const labelledBy = b.getAttribute('aria-labelledby');
        const title = b.getAttribute('title')?.trim();
        const imgAlt = b.querySelector('img[alt]')?.getAttribute('alt')?.trim();
        return !text && !label && !labelledBy && !title && !imgAlt;
      })
      .map((b) => ({ html: b.outerHTML.slice(0, 500), selector: cssPath(b) }))
  );
  for (const el of buttonNoName) {
    violations.push(
      createViolation({
        ruleId: 'ButtonDiscernible',
        layer: 'accessScan',
        wcagRef: 'WCAG 2.0 A 4.1.2',
        impact: 'serious',
        priority: 2,
        element: { outerHTML: el.html, selector: el.selector },
        source: { mode: 'url', url },
        fix: {
          deterministic: true,
          hint: 'Add text content, aria-label, or title to <button> elements.',
        },
      })
    );
  }

  // LinkCurrentPage — link to current page missing aria-current="page"
  const currentPageLinks = await page.$$eval('a[href]', (links) => {
    const currentPath = window.location.pathname.replace(/\/$/, '') || '/';
    const currentOrigin = window.location.origin;
    return links
      .filter((a) => {
        const href = a.getAttribute('href') || '';
        if (!href || href === '#' || href.startsWith('#')) return false;
        try {
          const resolved = new URL(href, window.location.href);
          if (resolved.origin !== currentOrigin) return false;
          const resolvedPath = resolved.pathname.replace(/\/$/, '') || '/';
          if (resolvedPath !== currentPath) return false;
        } catch { return false; }
        if (a.getAttribute('aria-current')) return false;
        return a.classList.contains('current') || a.classList.contains('active');
      })
      .slice(0, 10)
      .map((a) => ({ html: a.outerHTML.slice(0, 500), selector: cssPath(a) }));
  });
  for (const el of currentPageLinks) {
    violations.push(
      createViolation({
        ruleId: 'LinkCurrentPage',
        layer: 'accessScan',
        wcagRef: 'WCAG 2.0 A 1.3.1',
        impact: 'moderate',
        priority: 4,
        element: { outerHTML: el.html, selector: el.selector },
        source: { mode: 'url', url },
        fix: {
          deterministic: true,
          hint: 'Add aria-current="page" to links pointing to the current page.',
        },
      })
    );
  }

  // LinkNavigationDiscernible — <a> inside <nav> with empty/missing text
  const navLinksEmpty = await page.$$eval('nav a[href]', (links) =>
    links
      .filter((a) => {
        const text = a.textContent.trim();
        const label = a.getAttribute('aria-label')?.trim();
        const labelledBy = a.getAttribute('aria-labelledby');
        const imgAlt = a.querySelector('img[alt]')?.getAttribute('alt')?.trim();
        return !text && !label && !labelledBy && !imgAlt;
      })
      .map((a) => ({ html: a.outerHTML.slice(0, 500), selector: cssPath(a) }))
  );
  for (const el of navLinksEmpty) {
    violations.push(
      createViolation({
        ruleId: 'LinkNavigationDiscernible',
        layer: 'accessScan',
        wcagRef: 'WCAG 2.0 A 4.1.2',
        impact: 'serious',
        priority: 2,
        element: { outerHTML: el.html, selector: el.selector },
        source: { mode: 'url', url },
        fix: {
          deterministic: true,
          hint: 'Add visible text or aria-label to navigation links.',
        },
      })
    );
  }

  // NoAutofocus — elements with autofocus attribute
  const autofocusEls = await page.$$eval('[autofocus]', (els) =>
    els.map((e) => ({ html: e.outerHTML.slice(0, 500), selector: cssPath(e) }))
  );
  for (const el of autofocusEls) {
    violations.push(
      createViolation({
        ruleId: 'NoAutofocus',
        layer: 'accessScan',
        wcagRef: 'WCAG 2.0 A 3.2.1',
        impact: 'moderate',
        priority: 4,
        element: { outerHTML: el.html, selector: el.selector },
        source: { mode: 'url', url },
        fix: {
          deterministic: true,
          hint: 'Remove autofocus attribute — it causes unexpected focus movement for screen reader users.',
        },
      })
    );
  }

  // MenuTriggerClickable — menu triggers must be keyboard-accessible
  const menuTriggers = await page.$$eval('[aria-haspopup]', (els) =>
    els
      .filter((e) => {
        const tag = e.tagName.toLowerCase();
        if (tag === 'button' || tag === 'a') return false;
        const tabindex = e.getAttribute('tabindex');
        const role = e.getAttribute('role');
        return !tabindex && role !== 'button' && role !== 'menuitem';
      })
      .map((e) => ({ html: e.outerHTML.slice(0, 500), selector: cssPath(e) }))
  );
  for (const el of menuTriggers) {
    violations.push(
      createViolation({
        ruleId: 'MenuTriggerClickable',
        layer: 'accessScan',
        wcagRef: 'WCAG 2.0 A 2.1.1',
        impact: 'serious',
        priority: 2,
        element: { outerHTML: el.html, selector: el.selector },
        source: { mode: 'url', url },
        fix: {
          deterministic: true,
          hint: 'Menu trigger must be a <button> or have tabindex and role="button" for keyboard access.',
        },
      })
    );
  }

  // LinkAnchorDiscernible — anchor links (href="#...") without accessible name
  const anchorNoName = await page.$$eval('a[href^="#"]', (links) =>
    links
      .filter((a) => {
        const href = a.getAttribute('href');
        if (!href || href === '#') return false;
        if (a.getAttribute('aria-hidden') === 'true') return false;
        const text = a.textContent.trim();
        const label = a.getAttribute('aria-label')?.trim();
        const labelledBy = a.getAttribute('aria-labelledby');
        const imgAlt = a.querySelector('img[alt]')?.getAttribute('alt')?.trim();
        return !text && !label && !labelledBy && !imgAlt;
      })
      .map((a) => ({ html: a.outerHTML.slice(0, 500), selector: cssPath(a) }))
  );
  for (const el of anchorNoName) {
    violations.push(
      createViolation({
        ruleId: 'LinkAnchorDiscernible',
        layer: 'accessScan',
        wcagRef: 'WCAG 2.0 A 2.4.4',
        impact: 'serious',
        priority: 2,
        element: { outerHTML: el.html, selector: el.selector },
        source: { mode: 'url', url },
        fix: {
          deterministic: true,
          hint: 'Add visible text or aria-label to anchor links so screen readers announce their destination.',
        },
      })
    );
  }

  // MenuAvoid — role="menu" on navigation elements
  const menuOnNav = await page.$$eval('[role="menu"]', (els) =>
    els
      .filter((e) => e.querySelector('a[href]'))
      .map((e) => ({ html: e.outerHTML.slice(0, 500), selector: cssPath(e) }))
  );
  for (const el of menuOnNav) {
    violations.push(
      createViolation({
        ruleId: 'MenuAvoid',
        layer: 'accessScan',
        wcagRef: 'Best Practice',
        impact: 'moderate',
        priority: 4,
        element: { outerHTML: el.html, selector: el.selector },
        source: { mode: 'url', url },
        fix: {
          deterministic: true,
          hint: 'Remove role="menu" from web navigation — use role="menu" only for desktop-style app menus.',
        },
      })
    );
  }

  // MenuBarAvoid — role="menubar" on navigation elements
  const menuBarOnNav = await page.$$eval('[role="menubar"]', (els) =>
    els
      .filter((e) => e.querySelector('a[href]'))
      .map((e) => ({ html: e.outerHTML.slice(0, 500), selector: cssPath(e) }))
  );
  for (const el of menuBarOnNav) {
    violations.push(
      createViolation({
        ruleId: 'MenuBarAvoid',
        layer: 'accessScan',
        wcagRef: 'Best Practice',
        impact: 'moderate',
        priority: 4,
        element: { outerHTML: el.html, selector: el.selector },
        source: { mode: 'url', url },
        fix: {
          deterministic: true,
          hint: 'Remove role="menubar" from web navigation — use only for desktop-style app menus.',
        },
      })
    );
  }

  // MenuItemAvoid — role="menuitem" on web navigation links
  const menuItemOnNav = await page.$$eval('[role="menuitem"]', (els) =>
    els
      .filter((e) => e.tagName === 'A' && e.getAttribute('href'))
      .map((e) => ({ html: e.outerHTML.slice(0, 500), selector: cssPath(e) }))
  );
  for (const el of menuItemOnNav) {
    violations.push(
      createViolation({
        ruleId: 'MenuItemAvoid',
        layer: 'accessScan',
        wcagRef: 'Best Practice',
        impact: 'moderate',
        priority: 4,
        element: { outerHTML: el.html, selector: el.selector },
        source: { mode: 'url', url },
        fix: {
          deterministic: true,
          hint: 'Remove role="menuitem" from navigation links — use only for desktop-style app menus.',
        },
      })
    );
  }

  // AriaControlsHasReference — aria-controls pointing to non-existent IDs
  const brokenControls = await page.$$eval('[aria-controls]', (els) =>
    els
      .filter((e) => {
        const id = e.getAttribute('aria-controls');
        return id && !document.getElementById(id);
      })
      .map((e) => ({
        html: e.outerHTML.slice(0, 500),
        selector: cssPath(e),
        controls: e.getAttribute('aria-controls'),
      }))
  );
  for (const el of brokenControls) {
    violations.push(
      createViolation({
        ruleId: 'AriaControlsHasReference',
        layer: 'accessScan',
        wcagRef: 'WCAG 2.0 A 1.3.1',
        impact: 'serious',
        priority: 2,
        element: { outerHTML: el.html, selector: el.selector },
        source: { mode: 'url', url },
        fix: {
          deterministic: false,
          hint: `aria-controls="${el.controls}" references a non-existent element ID.`,
        },
      })
    );
  }

  // LinkImageWarning — link opens an image file without warning
  const imgLinks = await page.$$eval('a[href]', (links) =>
    links
      .filter((a) => /\.(jpe?g|png|gif|webp|svg|bmp|ico)(\?|$)/i.test(a.getAttribute('href') || ''))
      .filter((a) => {
        const text = (a.textContent + ' ' + (a.getAttribute('aria-label') || '')).toLowerCase();
        return !text.includes('image') && !text.includes('photo') && !text.includes('opens');
      })
      .map((a) => ({ html: a.outerHTML.slice(0, 500), selector: cssPath(a) }))
  );
  for (const el of imgLinks) {
    violations.push(
      createViolation({
        ruleId: 'LinkImageWarning',
        layer: 'accessScan',
        wcagRef: 'Best Practice',
        impact: 'minor',
        priority: 5,
        element: { outerHTML: el.html, selector: el.selector },
        source: { mode: 'url', url },
        fix: { deterministic: true, hint: 'Warn users that this link opens an image.' },
      })
    );
  }

  // LinkMailtoWarning — mailto link without warning
  const mailtoLinks = await page.$$eval('a[href^="mailto:"]', (links) =>
    links
      .filter((a) => {
        const text = (a.textContent + ' ' + (a.getAttribute('aria-label') || '')).toLowerCase();
        return !text.includes('email') && !text.includes('mail') && !text.includes('contact');
      })
      .map((a) => ({ html: a.outerHTML.slice(0, 500), selector: cssPath(a) }))
  );
  for (const el of mailtoLinks) {
    violations.push(
      createViolation({
        ruleId: 'LinkMailtoWarning',
        layer: 'accessScan',
        wcagRef: 'Best Practice',
        impact: 'minor',
        priority: 5,
        element: { outerHTML: el.html, selector: el.selector },
        source: { mode: 'url', url },
        fix: { deterministic: true, hint: 'Warn users that this link opens a mail application.' },
      })
    );
  }

  // LinkPDFWarning — PDF link without warning
  const pdfLinks = await page.$$eval('a[href]', (links) =>
    links
      .filter((a) => /\.pdf(\?|$)/i.test(a.getAttribute('href') || ''))
      .filter((a) => {
        const text = (a.textContent + ' ' + (a.getAttribute('aria-label') || '')).toLowerCase();
        return !text.includes('pdf') && !text.includes('document') && !text.includes('download');
      })
      .map((a) => ({ html: a.outerHTML.slice(0, 500), selector: cssPath(a) }))
  );
  for (const el of pdfLinks) {
    violations.push(
      createViolation({
        ruleId: 'LinkPDFWarning',
        layer: 'accessScan',
        wcagRef: 'Best Practice',
        impact: 'minor',
        priority: 5,
        element: { outerHTML: el.html, selector: el.selector },
        source: { mode: 'url', url },
        fix: { deterministic: true, hint: 'Warn users that this link opens a PDF file.' },
      })
    );
  }

  return violations;
}
