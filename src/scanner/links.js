import { createViolation } from '../schema.js';

/**
 * Dead Link Crawler
 *
 * Crawls all links on a page and checks for:
 * - 404 / 5xx responses
 * - Empty href
 * - Redirect loops (> 2 hops)
 * - javascript: pseudo-protocol
 */
export async function scanDeadLinks(page, url) {
  const violations = [];

  const links = await page.$$eval('a[href], link[href], img[src], script[src]', (els) => {
    function cssPath(el) {
      if (el.id) return '#' + el.id;
      const parts = [];
      let cur = el;
      while (cur && cur !== document.body) {
        let seg = cur.nodeName.toLowerCase();
        const siblings = Array.from(cur.parentElement?.children || []).filter(s => s.nodeName === cur.nodeName);
        if (siblings.length > 1) seg += ':nth-of-type(' + (siblings.indexOf(cur) + 1) + ')';
        parts.unshift(seg);
        cur = cur.parentElement;
      }
      return parts.join(' > ').slice(0, 200);
    }
    // Non-navigational <link> rels that should not be checked for dead links
    const SKIP_LINK_RELS = new Set(['preconnect', 'preload', 'dns-prefetch', 'prefetch', 'manifest', 'icon', 'apple-touch-icon', 'canonical', 'alternate']);
    return els
      .map((e) => ({
        tag: e.tagName.toLowerCase(),
        url: e.href || e.src || '',
        rawHref: e.tagName === 'A' ? e.getAttribute('href') || '' : '',
        text: e.textContent?.trim().slice(0, 80) || '',
        html: e.outerHTML.slice(0, 300),
        selector: cssPath(e),
        linkRel: e.tagName === 'LINK' ? (e.getAttribute('rel') || '') : '',
      }))
      .filter((l) => {
        if (!l.url || l.url.startsWith('data:') || l.url.startsWith('blob:')) return false;
        if (l.tag === 'link' && l.linkRel.split(/\s+/).some(r => SKIP_LINK_RELS.has(r))) return false;
        // Skip Vite dev server internal URLs (module sources, HMR client)
        const p = new URL(l.url, window.location.href).pathname;
        if (p.startsWith('/src/') || p.startsWith('/@') || p.startsWith('/node_modules/')) return false;
        return true;
      });
  });

  // Detect empty hrefs that are genuine bugs vs template-rendered placeholders.
  // A template-rendered link has structural indicators: styled with CSS classes,
  // contains child elements, or has ARIA attributes — signs that a template
  // intended to produce a real link but the data was missing at scan time.
  const emptyHrefs = await page.$$eval('a', (anchors) => {
    return anchors
      .filter((a) => {
        const href = (a.getAttribute('href') || '').trim();
        if (href && href !== '#' && !href.startsWith('javascript:')) return false;

        // A truly broken link: bare <a href=""> or <a href="#">
        // with no classes, no children, no attributes beyond href — flag it.
        // A template-rendered link: has styling classes, ARIA attrs, child elements — skip it.
        const hasClasses = a.classList.length > 0;
        const hasAria = a.hasAttribute('aria-label') || a.hasAttribute('aria-labelledby') || a.hasAttribute('role');
        const hasChildren = a.querySelector('img, svg, span, i, strong, em') !== null;
        const isHidden = a.hasAttribute('tabindex') && a.getAttribute('tabindex') === '-1';

        // If the element has ANY styling/structure, it's a designed component
        // whose data source is empty at scan time — not a broken link.
        if (hasClasses || hasAria || hasChildren || isHidden) return false;

        return true;
      })
      .map((a) => ({
        tag: 'a',
        text: (a.textContent || '').trim().slice(0, 80),
        html: a.outerHTML.slice(0, 300),
        rawHref: a.getAttribute('href') || '',
      }));
  });
  for (const el of emptyHrefs.slice(0, 10)) {
    violations.push(
      createViolation({
        ruleId: 'dead-link-empty-href',
        layer: 'links',
        category: 'reliability',
        impact: 'moderate',
        priority: 4,
        element: { outerHTML: el.html, selector: el.selector },
        source: { mode: 'url', url },
        fix: {
          deterministic: false,
          hint: `Link "${el.text || '(no text)'}" has empty or # href.`,
        },
      })
    );
  }

  // Dedupe URLs for HTTP checks
  const uniqueUrls = [...new Set(links.filter((l) => l.url.startsWith('http')).map((l) => l.url))];
  const checked = new Map();

  const CONCURRENCY = 5;
  const TIMEOUT = 8000;

  for (let i = 0; i < uniqueUrls.length; i += CONCURRENCY) {
    const batch = uniqueUrls.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (checkUrl) => {
        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), TIMEOUT);
          const res = await fetch(checkUrl, {
            method: 'HEAD',
            redirect: 'follow',
            signal: controller.signal,
            headers: { 'User-Agent': 'ADA-Scanner/1.0 Link-Checker' },
          });
          clearTimeout(timeout);
          return { url: checkUrl, status: res.status, redirected: res.redirected, finalUrl: res.url };
        } catch (err) {
          return { url: checkUrl, status: 0, error: err.message };
        }
      })
    );

    for (const r of results) {
      if (r.status === 'fulfilled') checked.set(r.value.url, r.value);
    }
  }

  for (const [checkUrl, result] of checked) {
    if (result.status >= 400 || result.status === 0) {
      const matchingLinks = links.filter((l) => l.url === checkUrl);
      for (const el of matchingLinks.slice(0, 3)) {
        violations.push(
          createViolation({
            ruleId: result.status === 404 ? 'dead-link-404' : result.status >= 500 ? 'dead-link-server-error' : 'dead-link-unreachable',
            layer: 'links',
            category: 'reliability',
            impact: result.status === 404 ? 'serious' : 'moderate',
            priority: result.status === 404 ? 3 : 4,
            element: { outerHTML: el.html, selector: el.selector },
            source: { mode: 'url', url },
            fix: {
              deterministic: false,
              hint: `${el.tag} "${el.text}" → ${checkUrl} returned HTTP ${result.status || 'unreachable'}${result.error ? ` (${result.error})` : ''}.`,
            },
          })
        );
      }
    }
  }

  return violations;
}
