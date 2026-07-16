import { deriveAccessibleWarningText } from './lib/visible-label.js';
import {
  elementFinding,
  getIndexes,
  normalizeText,
  queryCandidates,
} from './lib/runtime-context.js';

/**
 * @param {string} text
 * @param {string[]} keywords
 */
function includesKeyword(text, keywords) {
  return keywords.some((keyword) => text.includes(keyword));
}

/** @type {import('../../engine/loader.js').EvaluatorModule} */
export default {
  id: 'link-warnings',
  async evaluate(context, check) {
    const indexes = getIndexes(context);
    const mode = /** @type {string} */ (check.options?.mode);
    const candidates = queryCandidates(context, check);
    /** @type {import('../../engine/loader.js').EvaluatorResult['findings']} */
    const findings = [];

    for (const element of candidates) {
      const href = element.attributes.href || '';
      const text = deriveAccessibleWarningText(element, indexes);

      if (mode === 'new-window') {
        if (element.attributes.target !== '_blank') continue;
        const keywords = /** @type {string[]} */ (check.options?.warningKeywords || [
          'new window', 'new tab', 'opens in',
        ]);
        if (!includesKeyword(text, keywords)) {
          findings.push(elementFinding(element, { href, warningInferred: true }));
        }
        continue;
      }

      if (mode === 'image-href') {
        const pattern = new RegExp(
          /** @type {string} */ (check.options?.hrefPattern || '\\.(jpe?g|png|gif|webp|svg|bmp|ico)(\\?|$)'),
          'i',
        );
        if (!pattern.test(href)) continue;
        const keywords = /** @type {string[]} */ (check.options?.warningKeywords || [
          'image', 'photo', 'opens',
        ]);
        if (!includesKeyword(text, keywords)) {
          findings.push(elementFinding(element, { href, warningInferred: true }));
        }
        continue;
      }

      if (mode === 'mailto-href') {
        if (!href.toLowerCase().startsWith('mailto:')) continue;
        const keywords = /** @type {string[]} */ (check.options?.warningKeywords || [
          'email', 'mail', 'contact',
        ]);
        if (!includesKeyword(text, keywords)) {
          findings.push(elementFinding(element, { href, warningInferred: true }));
        }
        continue;
      }

      if (mode === 'pdf-href') {
        const pattern = new RegExp(
          /** @type {string} */ (check.options?.hrefPattern || '\\.pdf(\\?|$)'),
          'i',
        );
        if (!pattern.test(href)) continue;
        const keywords = /** @type {string[]} */ (check.options?.warningKeywords || [
          'pdf', 'document', 'download',
        ]);
        if (!includesKeyword(text, keywords)) {
          findings.push(elementFinding(element, { href, warningInferred: true }));
        }
      }
    }

    return {
      status: 'complete',
      candidatesScanned: candidates.length,
      findings,
    };
  },
};
