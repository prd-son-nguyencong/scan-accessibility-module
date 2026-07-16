import {
  elementFinding,
  getSnapshot,
  normalizeText,
  queryCandidates,
} from './lib/runtime-context.js';

const VALID_LANG_CODES = new Set([
  'aa', 'ab', 'af', 'ak', 'am', 'an', 'ar', 'as', 'av', 'ay', 'az', 'ba', 'be', 'bg', 'bh', 'bi', 'bm', 'bn',
  'bo', 'br', 'bs', 'ca', 'ce', 'ch', 'co', 'cr', 'cs', 'cu', 'cv', 'cy', 'da', 'de', 'dv', 'dz', 'ee', 'el',
  'en', 'eo', 'es', 'et', 'eu', 'fa', 'ff', 'fi', 'fj', 'fo', 'fr', 'fy', 'ga', 'gd', 'gl', 'gn', 'gu', 'gv',
  'ha', 'he', 'hi', 'ho', 'hr', 'ht', 'hu', 'hy', 'hz', 'ia', 'id', 'ie', 'ig', 'ii', 'ik', 'in', 'io', 'is',
  'it', 'iu', 'ja', 'jv', 'ka', 'kg', 'ki', 'kj', 'kk', 'kl', 'km', 'kn', 'ko', 'kr', 'ks', 'ku', 'kv', 'kw',
  'ky', 'la', 'lb', 'lg', 'li', 'ln', 'lo', 'lt', 'lu', 'lv', 'mg', 'mh', 'mi', 'mk', 'ml', 'mn', 'mo', 'mr',
  'ms', 'mt', 'my', 'na', 'nb', 'nd', 'ne', 'ng', 'nl', 'nn', 'no', 'nr', 'nv', 'ny', 'oc', 'oj', 'om', 'or',
  'os', 'pa', 'pi', 'pl', 'ps', 'pt', 'qu', 'rm', 'rn', 'ro', 'ru', 'rw', 'sa', 'sc', 'sd', 'se', 'sg', 'sh',
  'si', 'sk', 'sl', 'sm', 'sn', 'so', 'sq', 'sr', 'ss', 'st', 'su', 'sv', 'sw', 'ta', 'te', 'tg', 'th', 'ti',
  'tk', 'tl', 'tn', 'to', 'tr', 'ts', 'tt', 'tw', 'ty', 'ug', 'uk', 'ur', 'uz', 've', 'vi', 'vo', 'wa', 'wo',
  'xh', 'yi', 'yo', 'za', 'zh', 'zu',
]);

/**
 * @param {import('../../runtime/types.js').SnapshotElement | undefined} element
 */
function syntheticElement(element, fallback) {
  return element || {
    outerHTML: fallback.outerHTML,
    selector: fallback.selector,
    framePath: [],
    shadowPath: [],
  };
}

/** @type {import('../../engine/loader.js').EvaluatorModule} */
export default {
  id: 'document-metadata',
  async evaluate(context, check) {
    const snapshot = getSnapshot(context);
    const mode = /** @type {string} */ (check.options?.mode);
    /** @type {import('../../engine/loader.js').EvaluatorResult['findings']} */
    const findings = [];
    let candidatesScanned = 0;

    const html = snapshot.elements.find((element) => element.tag === 'html');
    const head = snapshot.elements.find(
      (element) => element.tag === 'head' && element.parentId === html?.id,
    );
    const headParentId = head?.id ?? html?.id;
    const headChildren = snapshot.elements.filter(
      (element) => element.parentId === headParentId,
    );

    if (mode === 'html-lang-missing') {
      candidatesScanned = 1;
      if (!html?.attributes.lang?.trim()) {
        findings.push(elementFinding(syntheticElement(html, {
          outerHTML: '<html>',
          selector: 'html',
        })));
      }
      return { status: 'complete', candidatesScanned, findings };
    }

    if (mode === 'html-lang-invalid') {
      candidatesScanned = 1;
      const lang = html?.attributes.lang?.trim();
      if (lang) {
        const langCode = lang.toLowerCase().split('-')[0];
        if (!VALID_LANG_CODES.has(langCode)) {
          findings.push(elementFinding(syntheticElement(html, {
            outerHTML: `<html lang="${lang}">`,
            selector: 'html',
          }), { lang }));
        }
      }
      return { status: 'complete', candidatesScanned, findings };
    }

    if (mode === 'meta-description-missing') {
      candidatesScanned = 1;
      const hasDescription = headChildren.some(
        (element) => element.tag === 'meta' && element.attributes.name === 'description',
      );
      if (!hasDescription) {
        findings.push(elementFinding(syntheticElement(undefined, {
          outerHTML: '',
          selector: '',
        })));
      }
      return { status: 'complete', candidatesScanned, findings };
    }

    if (mode === 'meta-refresh-present') {
      const refreshMetas = headChildren.filter(
        (element) => element.tag === 'meta'
          && normalizeText(element.attributes['http-equiv']) === 'refresh',
      );
      candidatesScanned = refreshMetas.length || 1;
      for (const meta of refreshMetas) {
        findings.push(elementFinding(meta));
      }
      return { status: 'complete', candidatesScanned, findings };
    }

    if (mode === 'meta-viewport-missing') {
      candidatesScanned = 1;
      const hasViewport = headChildren.some(
        (element) => element.tag === 'meta' && element.attributes.name === 'viewport',
      );
      if (!hasViewport) {
        findings.push(elementFinding(syntheticElement(undefined, {
          outerHTML: '',
          selector: '',
        })));
      }
      return { status: 'complete', candidatesScanned, findings };
    }

    if (mode === 'meta-viewport-not-scalable') {
      const viewportMetas = headChildren.filter(
        (element) => element.tag === 'meta' && element.attributes.name === 'viewport',
      );
      candidatesScanned = viewportMetas.length || 1;
      for (const meta of viewportMetas) {
        const content = meta.attributes.content || '';
        const blocksScaling = (
          content.includes('user-scalable=no')
          || content.includes('user-scalable=0')
        );
        const maxScale = content.match(/maximum-scale\s*=\s*([\d.]+)/i);
        const maxTooLow = maxScale && parseFloat(maxScale[1]) < 2;
        if (blocksScaling || maxTooLow) {
          findings.push(elementFinding(meta, { content }));
        }
      }
      return { status: 'complete', candidatesScanned, findings };
    }

    if (mode === 'page-title-missing') {
      candidatesScanned = 1;
      const title = headChildren.find((element) => element.tag === 'title');
      if (!title) {
        findings.push(elementFinding(syntheticElement(undefined, {
          outerHTML: '',
          selector: '',
        })));
      }
      return { status: 'complete', candidatesScanned, findings };
    }

    if (mode === 'page-title-not-descriptive') {
      const title = headChildren.find((element) => element.tag === 'title');
      if (!title) {
        return { status: 'complete', candidatesScanned: 0, findings: [] };
      }
      candidatesScanned = 1;
      const text = title.visibleText || title.text?.trim() || '';
      const generic = /** @type {string[]} */ (check.options?.genericTitles || [
        'untitled', 'page', 'home', 'document',
      ]);
      if (!text || generic.includes(text.toLowerCase())) {
        findings.push(elementFinding(title, { reason: !text ? 'empty' : 'generic' }));
      }
      return { status: 'complete', candidatesScanned, findings };
    }

    return { status: 'inapplicable', candidatesScanned: 0, findings: [] };
  },
};
