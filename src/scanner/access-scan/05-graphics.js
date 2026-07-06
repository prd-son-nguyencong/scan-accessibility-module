import { createViolation } from '../../schema.js';

/**
 * 05-graphics: 5 rules (WCAG 2.0)
 *
 * Checks icons, images, and CSS background images for
 * proper alt text and assistive technology hiding.
 */
export async function scanGraphics(page, url, options = {}) {
  const violations = [];

  // IconDiscernible — decorative SVG/icon without aria-hidden
  // Includes parent context in HTML so deduplication keeps separate DOM instances
  // (e.g. 10 identical chevron SVGs in different pagination items stay as 10 violations)
  const exposedIcons = await page.$$eval('svg', (svgs) =>
    svgs
      .filter((s) => {
        const hasLabel = s.getAttribute('aria-label') || s.getAttribute('aria-labelledby') || s.querySelector('title');
        const isHidden = s.getAttribute('aria-hidden') === 'true';
        const isDecorative = s.getAttribute('role') === 'presentation' || s.getAttribute('role') === 'img';
        return !hasLabel && !isHidden && !isDecorative;
      })
      .map((s) => {
        const parent = s.parentElement;
        const parentCtx = parent ? parent.outerHTML.slice(0, 500) : s.outerHTML.slice(0, 500);
        return { html: parentCtx, selector: cssPath(s) };
      })
  );
  for (const el of exposedIcons) {
    violations.push(
      createViolation({
        ruleId: 'IconDiscernible',
        layer: 'accessScan',
        wcagRef: 'WCAG 2.0 A 1.1.1',
        impact: 'serious',
        priority: 11,
        element: { outerHTML: el.html, selector: el.selector },
        source: { mode: 'url', url },
        fix: {
          deterministic: true,
          hint: 'Add aria-hidden="true" to decorative SVGs, or aria-label for meaningful icons.',
        },
      })
    );
  }

  // DecorativeGraphicExposed — small SVG/icon inside interactive element
  // that lacks aria-hidden="true" when parent already has text content
  const decorativeGraphics = await page.$$eval('a svg, button svg, a i, button i', (els) =>
    els.filter((el) => {
      if (el.getAttribute('aria-hidden') === 'true') return false;
      if (el.getAttribute('role') === 'presentation') return false;
      const parent = el.closest('a, button');
      if (!parent) return false;
      const parentText = Array.from(parent.childNodes)
        .filter(n => n.nodeType === 3)
        .map(n => n.textContent.trim())
        .join('');
      if (parentText.length === 0) return false;
      const rect = el.getBoundingClientRect();
      if (rect.width > 24 || rect.height > 24) return false;
      return true;
    })
    .map(el => ({ html: el.outerHTML.slice(0, 500), selector: cssPath(el) }))
  );
  for (const el of decorativeGraphics) {
    violations.push(
      createViolation({
        ruleId: 'DecorativeGraphicExposed',
        layer: 'accessScan',
        wcagRef: 'WCAG 2.0 A 1.1.1',
        impact: 'minor',
        priority: 4,
        element: { outerHTML: el.html, selector: el.selector },
        source: { mode: 'url', url },
        fix: {
          deterministic: true,
          hint: 'Add aria-hidden="true" to decorative icons inside links/buttons that already have text labels.',
        },
      })
    );
  }

  // BackgroundImageDiscernibleImage — functional CSS bg image without role="img"
  const bgImages = await page.evaluate(() => {
    const results = [];
    const allEls = document.querySelectorAll('*');
    for (const el of allEls) {
      const bg = window.getComputedStyle(el).backgroundImage;
      if (bg && bg !== 'none' && bg.includes('url(')) {
        const hasRole = el.getAttribute('role') === 'img';
        const hasAlt = el.getAttribute('aria-label') || el.getAttribute('alt');
        const isDecorative = el.getAttribute('aria-hidden') === 'true';
        if (!hasRole && !hasAlt && !isDecorative && el.offsetWidth > 100 && el.offsetHeight > 100) {
          results.push({ html: el.outerHTML.slice(0, 500), selector: cssPath(el) });
        }
      }
    }
    return results.slice(0, 10);
  });
  for (const el of bgImages) {
    violations.push(
      createViolation({
        ruleId: 'BackgroundImageDiscernibleImage',
        layer: 'accessScan',
        wcagRef: 'WCAG 2.0 A 1.1.1',
        impact: 'moderate',
        priority: 4,
        element: { outerHTML: el.html, selector: el.selector },
        source: { mode: 'url', url },
        fix: {
          deterministic: false,
          hint: 'Add role="img" and aria-label to functional CSS background images.',
        },
      })
    );
  }

  // ImageDiscernible — <img> without alt attribute at all
  const imgNoAlt = await page.$$eval('img', (imgs) =>
    imgs
      .filter((i) => {
        if (i.getAttribute('aria-hidden') === 'true') return false;
        if (i.getAttribute('role') === 'presentation') return false;
        return !i.hasAttribute('alt');
      })
      .map((i) => ({ html: i.outerHTML.slice(0, 500), selector: cssPath(i) }))
  );
  for (const el of imgNoAlt) {
    violations.push(
      createViolation({
        ruleId: 'ImageDiscernible',
        layer: 'accessScan',
        wcagRef: 'WCAG 2.0 A 1.1.1',
        impact: 'serious',
        priority: 2,
        element: { outerHTML: el.html, selector: el.selector },
        source: { mode: 'url', url },
        fix: {
          deterministic: true,
          hint: 'Add an alt attribute to all <img> elements. Use alt="" for decorative images.',
        },
      })
    );
  }

  // ImageDiscernibleCorrectly — <img> with placeholder/generic alt text
  const imgBadAlt = await page.$$eval('img[alt]', (imgs) => {
    const generic = ['image', 'photo', 'picture', 'img', 'icon', 'graphic', 'logo', 'banner', 'placeholder', 'untitled', 'screenshot'];
    return imgs
      .filter((i) => {
        const alt = i.getAttribute('alt').trim().toLowerCase();
        if (!alt) return false;
        return generic.includes(alt) || /^img[-_]?\d*$/.test(alt) || /^image[-_]?\d*$/.test(alt);
      })
      .map((i) => ({ html: i.outerHTML.slice(0, 500), selector: cssPath(i), alt: i.getAttribute('alt') }));
  });
  for (const el of imgBadAlt) {
    violations.push(
      createViolation({
        ruleId: 'ImageDiscernibleCorrectly',
        layer: 'accessScan',
        wcagRef: 'WCAG 2.0 A 1.1.1',
        impact: 'moderate',
        priority: 3,
        element: { outerHTML: el.html, selector: el.selector },
        source: { mode: 'url', url },
        fix: {
          deterministic: false,
          hint: `Alt text "${el.alt}" is generic. Describe the image content meaningfully.`,
        },
      })
    );
  }

  // ImageMisuse — decorative <img> without role="presentation" or empty alt
  const imgDecorative = await page.$$eval('img', (imgs) =>
    imgs
      .filter((i) => {
        if (i.getAttribute('aria-hidden') === 'true') return false;
        if (i.getAttribute('role') === 'presentation') return false;
        if (!i.hasAttribute('alt')) return false;
        const alt = i.getAttribute('alt').trim();
        if (alt === '') return false;
        const w = i.naturalWidth || i.width;
        const h = i.naturalHeight || i.height;
        if (w <= 5 && h <= 5) return true;
        const src = (i.getAttribute('src') || '').toLowerCase();
        return src.includes('spacer') || src.includes('pixel') || src.includes('blank') || src.includes('transparent');
      })
      .map((i) => ({ html: i.outerHTML.slice(0, 500), selector: cssPath(i) }))
  );
  for (const el of imgDecorative) {
    violations.push(
      createViolation({
        ruleId: 'ImageMisuse',
        layer: 'accessScan',
        wcagRef: 'WCAG 2.0 A 1.1.1',
        impact: 'minor',
        priority: 4,
        element: { outerHTML: el.html, selector: el.selector },
        source: { mode: 'url', url },
        fix: {
          deterministic: true,
          hint: 'Set alt="" and role="presentation" on decorative/spacer images.',
        },
      })
    );
  }

  return violations;
}
