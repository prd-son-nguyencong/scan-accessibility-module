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
          'email', 'mail',
        ]);
        // Commercial scores the authored/visible label, not aria-label alone —
        // "Send email to…" in aria-label still fails when the visible text is
        // only the address.
        const visible = normalizeText(element.visibleText || element.text || '');
        const warningText = visible || text;
        if (!includesKeyword(warningText, keywords)) {
          findings.push(elementFinding(element, { href, warningInferred: true }));
        }
        continue;
      }

      if (mode === 'pdf-href') {
        const isPdfExtension = /\.pdf(\?|$)/i.test(href);
        const isDocumentPath = /\/document\//i.test(href);
        if (!isPdfExtension && !isDocumentPath) continue;
        const keywords = /** @type {string[]} */ (check.options?.warningKeywords || [
          'pdf', 'document', 'download',
        ]);
        const newWindowKeywords = /** @type {string[]} */ (check.options?.newWindowKeywords || [
          'new window', 'new tab', 'opens in',
        ]);
        const visible = normalizeText(element.visibleText || element.text || '');

        if (isPdfExtension) {
          // Suppress when name already discloses PDF/document download.
          if (includesKeyword(text, keywords) || includesKeyword(visible, keywords)) {
            continue;
          }
          // New-window suppress for ordinary file hosts. Document-library CDNs
          // (…/document/…pdf) still warn even when aria mentions a new tab.
          if (
            includesKeyword(text, newWindowKeywords)
            && !/\/document\//i.test(href)
          ) {
            continue;
          }
          findings.push(elementFinding(element, { href, warningInferred: true }));
          continue;
        }

        // Document-library URLs without .pdf — commercial still flags privacy/terms
        // even when aria only mentions a new tab.
        const aria = normalizeText(element.attributes['aria-label'] || '');
        const label = `${visible} ${text} ${aria}`;
        if (!/(?:privacy|terms|policy|legal|handbook|agreement|cookie)/i.test(label)) {
          continue;
        }
        // Only suppress when the visible label itself discloses document/PDF —
        // aria often repeats the destination without a download cue.
        if (includesKeyword(visible, keywords)) {
          continue;
        }
        findings.push(elementFinding(element, { href, warningInferred: true }));
      }
    }

    return {
      status: 'complete',
      candidatesScanned: candidates.length,
      findings,
    };
  },
};
