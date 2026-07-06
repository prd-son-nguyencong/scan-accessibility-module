import { createViolation } from '../../schema.js';

/**
 * 09-metadata: 7 rules (WCAG 2.0 + Best Practices)
 *
 * Checks page language, viewport scaling, meta refresh,
 * page title, text resize, charset, and meta description.
 */
export async function scanMetadata(page, url) {
  const violations = [];

  // MetaViewportScalable — user-scalable=no blocks zoom
  const viewportIssue = await page.$eval('meta[name="viewport"]', (meta) => {
    const content = meta?.getAttribute('content') || '';
    if (content.includes('user-scalable=no') || content.includes('user-scalable=0')) {
      return { html: meta.outerHTML, content };
    }
    const maxScale = content.match(/maximum-scale\s*=\s*([\d.]+)/);
    if (maxScale && parseFloat(maxScale[1]) < 2) {
      return { html: meta.outerHTML, content };
    }
    return null;
  }).catch(() => null);

  if (viewportIssue) {
    violations.push(
      createViolation({
        ruleId: 'MetaViewportScalable',
        layer: 'accessScan',
        wcagRef: 'WCAG 2.0 AA 1.4.4',
        impact: 'critical',
        priority: 2,
        element: { outerHTML: viewportIssue.html, selector: 'meta[name="viewport"]' },
        source: { mode: 'url', url },
        fix: {
          deterministic: true,
          hint: 'Remove user-scalable=no and set maximum-scale to at least 5.0.',
        },
      })
    );
  }

  // PageTitleDescriptive — empty or generic page title
  const titleIssue = await page.$eval('title', (t) => {
    const text = t?.textContent?.trim() || '';
    if (!text) return { html: t?.outerHTML || '<title></title>', reason: 'empty' };
    const generic = ['untitled', 'page', 'home', 'document'];
    if (generic.includes(text.toLowerCase())) return { html: t.outerHTML, reason: 'generic' };
    return null;
  }).catch(() => ({ html: '', reason: 'missing' }));

  if (titleIssue) {
    violations.push(
      createViolation({
        ruleId: 'PageTitleDescriptive',
        layer: 'accessScan',
        wcagRef: 'WCAG 2.0 A 2.4.2',
        impact: 'serious',
        priority: 3,
        element: { outerHTML: titleIssue.html, selector: 'title' },
        source: { mode: 'url', url },
        fix: {
          deterministic: false,
          hint: `Page title is ${titleIssue.reason} — add a descriptive, unique title.`,
        },
      })
    );
  }

  // MetaRefresh — auto-redirect meta tag
  const metaRefresh = await page.$('meta[http-equiv="refresh"]');
  if (metaRefresh) {
    const html = await metaRefresh.evaluate((e) => e.outerHTML);
    violations.push(
      createViolation({
        ruleId: 'MetaRefresh',
        layer: 'accessScan',
        wcagRef: 'WCAG 2.0 A 2.2.1',
        impact: 'critical',
        priority: 1,
        element: { outerHTML: html, selector: 'meta[http-equiv="refresh"]' },
        source: { mode: 'url', url },
        fix: {
          deterministic: true,
          hint: 'Remove meta http-equiv="refresh" — use server-side redirects instead.',
        },
      })
    );
  }

  // MetaDescription — missing meta description
  const hasMetaDesc = await page.$('meta[name="description"]');
  if (!hasMetaDesc) {
    violations.push(
      createViolation({
        ruleId: 'MetaDescription',
        layer: 'accessScan',
        category: 'accessibility',
        wcagRef: 'Best Practice',
        impact: 'minor',
        priority: 5,
        element: { outerHTML: '', selector: '' },
        source: { mode: 'url', url },
        fix: {
          deterministic: false,
          hint: 'Add <meta name="description" content="..."> for SEO and accessibility.',
        },
      })
    );
  }

  // HtmlLang — <html> missing lang attribute
  const htmlLang = await page.$eval('html', (html) => html.getAttribute('lang')).catch(() => null);
  if (!htmlLang) {
    violations.push(
      createViolation({
        ruleId: 'HtmlLang',
        layer: 'accessScan',
        wcagRef: 'WCAG 2.0 A 3.1.1',
        impact: 'serious',
        priority: 2,
        element: { outerHTML: '<html>', selector: 'html' },
        source: { mode: 'url', url },
        fix: {
          deterministic: true,
          hint: 'Add lang attribute to the <html> element (e.g. lang="en").',
        },
      })
    );
  }

  // HtmlLangValid — <html lang> with invalid language code
  if (htmlLang) {
    const validLangs = ['aa','ab','af','ak','am','an','ar','as','av','ay','az','ba','be','bg','bh','bi','bm','bn','bo','br','bs','ca','ce','ch','co','cr','cs','cu','cv','cy','da','de','dv','dz','ee','el','en','eo','es','et','eu','fa','ff','fi','fj','fo','fr','fy','ga','gd','gl','gn','gu','gv','ha','he','hi','ho','hr','ht','hu','hy','hz','ia','id','ie','ig','ii','ik','in','io','is','it','iu','ja','jv','ka','kg','ki','kj','kk','kl','km','kn','ko','kr','ks','ku','kv','kw','ky','la','lb','lg','li','ln','lo','lt','lu','lv','mg','mh','mi','mk','ml','mn','mo','mr','ms','mt','my','na','nb','nd','ne','ng','nl','nn','no','nr','nv','ny','oc','oj','om','or','os','pa','pi','pl','ps','pt','qu','rm','rn','ro','ru','rw','sa','sc','sd','se','sg','sh','si','sk','sl','sm','sn','so','sq','sr','ss','st','su','sv','sw','ta','te','tg','th','ti','tk','tl','tn','to','tr','ts','tt','tw','ty','ug','uk','ur','uz','ve','vi','vo','wa','wo','xh','yi','yo','za','zh','zu'];
    const langCode = htmlLang.trim().toLowerCase().split('-')[0];
    if (!validLangs.includes(langCode)) {
      violations.push(
        createViolation({
          ruleId: 'HtmlLangValid',
          layer: 'accessScan',
          wcagRef: 'Best Practice',
          impact: 'moderate',
          priority: 3,
          element: { outerHTML: `<html lang="${htmlLang}">`, selector: 'html' },
          source: { mode: 'url', url },
          fix: {
            deterministic: true,
            hint: `Language code "${htmlLang}" is not a valid ISO 639-1 code. Use a standard code like "en".`,
          },
        })
      );
    }
  }

  // MetaViewportPresent — page missing meta viewport tag entirely
  const hasViewport = await page.$('meta[name="viewport"]');
  if (!hasViewport) {
    violations.push(
      createViolation({
        ruleId: 'MetaViewportPresent',
        layer: 'accessScan',
        wcagRef: 'Best Practice',
        impact: 'moderate',
        priority: 4,
        element: { outerHTML: '', selector: '' },
        source: { mode: 'url', url },
        fix: {
          deterministic: true,
          hint: 'Add <meta name="viewport" content="width=device-width, initial-scale=1"> for proper mobile layout.',
        },
      })
    );
  }

  // PageTitle — no <title> element at all (empty content is caught by PageTitleDescriptive)
  const hasTitleElement = await page.$('title');
  if (!hasTitleElement) {
    violations.push(
      createViolation({
        ruleId: 'PageTitle',
        layer: 'accessScan',
        wcagRef: 'WCAG 2.0 A 2.4.2',
        impact: 'serious',
        priority: 2,
        element: { outerHTML: '', selector: '' },
        source: { mode: 'url', url },
        fix: {
          deterministic: true,
          hint: 'Add a <title> element to the page head.',
        },
      })
    );
  }

  return violations;
}
