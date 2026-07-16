import { getAncestors, getDescendants } from '../runtime/graph-relationships.js';
import {
  elementFinding,
  getIndexes,
  getSnapshot,
  hasAccessibleName,
  normalizeText,
  queryCandidates,
} from './lib/runtime-context.js';

const GENERIC_ALT = new Set([
  'image', 'photo', 'picture', 'img', 'icon', 'graphic', 'logo', 'banner',
  'placeholder', 'untitled', 'screenshot',
]);

/** @type {import('../engine/loader.js').EvaluatorModule} */
export default {
  id: 'graphics',
  async evaluate(context, check) {
    const snapshot = getSnapshot(context);
    const indexes = getIndexes(context);
    const mode = /** @type {string} */ (check.options?.mode);
    const candidates = queryCandidates(context, check);
    /** @type {import('../engine/loader.js').EvaluatorResult['findings']} */
    const findings = [];

    if (mode === 'image-discernible') {
      for (const element of candidates) {
        if (element.attributes['aria-hidden'] === 'true') continue;
        if (element.attributes.role === 'presentation') continue;
        if ('alt' in element.attributes) continue;
        findings.push(elementFinding(element));
      }
      return { status: 'complete', candidatesScanned: candidates.length, findings };
    }

    if (mode === 'image-discernible-correctly') {
      for (const element of candidates) {
        const alt = (element.attributes.alt || '').trim().toLowerCase();
        if (!alt) continue;
        if (GENERIC_ALT.has(alt) || /^img[-_]?\d*$/.test(alt) || /^image[-_]?\d*$/.test(alt)) {
          findings.push(elementFinding(element, { alt: element.attributes.alt }));
        }
      }
      return { status: 'complete', candidatesScanned: candidates.length, findings };
    }

    if (mode === 'image-misuse') {
      for (const element of candidates) {
        if (element.attributes.role !== 'img') continue;
        if (element.tag === 'img' || element.tag === 'svg') continue;
        const bg = element.computedStyle.backgroundImage || '';
        const hasBackgroundGraphic = bg && bg !== 'none' && bg.includes('url(');
        if (hasBackgroundGraphic) continue;
        findings.push(elementFinding(element));
      }
      return { status: 'complete', candidatesScanned: candidates.length, findings };
    }

    if (mode === 'icon-discernible') {
      for (const element of candidates) {
        if (element.tag !== 'svg') continue;
        if (element.attributes.role !== 'img') continue;
        if (element.attributes['aria-hidden'] === 'true') continue;
        if (element.attributes.role === 'presentation') continue;
        const hasLabel = Boolean(
          element.attributes['aria-label']
          || element.attributes['aria-labelledby']
          || getDescendants(snapshot, indexes, element, (child) => child.tag === 'title').length > 0,
        );
        if (hasLabel) continue;
        findings.push(elementFinding(element));
      }
      return { status: 'complete', candidatesScanned: candidates.length, findings };
    }

    if (mode === 'symbol-icon-discernible-parity') {
      for (const element of candidates) {
        if (element.tag !== 'svg' || !element.rendered || element.hiddenFromAT) continue;
        if (element.rect.width <= 0 || element.rect.height <= 0) continue;
        if (element.attributes.role || element.attributes['aria-hidden'] === 'true') continue;
        if (hasAccessibleName(element)) continue;
        if (getDescendants(snapshot, indexes, element, (child) => child.tag === 'title').length > 0) {
          continue;
        }
        if (getDescendants(snapshot, indexes, element, (child) => child.tag === 'use').length === 0) {
          continue;
        }

        const interactive = getAncestors(snapshot, indexes, element).find((ancestor) => (
          ancestor.tag === 'a'
          || ancestor.tag === 'button'
          || ['button', 'link'].includes(ancestor.attributes.role || '')
        ));
        if (interactive && !normalizeText(interactive.text || '')) continue;

        findings.push(elementFinding(element, {
          structuralPattern: 'unlabelled-inline-symbol-instance',
        }));
      }
      return { status: 'complete', candidatesScanned: candidates.length, findings };
    }

    if (mode === 'symbol-image-role-parity') {
      for (const element of candidates) {
        if (element.tag !== 'svg' || !element.rendered || element.hiddenFromAT) continue;
        if (element.attributes.role !== 'img' || !hasAccessibleName(element)) continue;
        if (getDescendants(snapshot, indexes, element, (child) => child.tag === 'use').length === 0) {
          continue;
        }
        findings.push(elementFinding(element, {
          structuralPattern: 'named-inline-symbol-with-image-role',
        }));
      }
      return { status: 'complete', candidatesScanned: candidates.length, findings };
    }

    if (mode === 'decorative-graphic-exposed') {
      for (const element of candidates) {
        if (element.attributes['aria-hidden'] === 'true') continue;
        if (element.attributes.role === 'presentation') continue;
        const parent = element.parentId != null ? indexes.byElementId.get(element.parentId) : null;
        if (!parent || (parent.tag !== 'a' && parent.tag !== 'button')) continue;
        if (!parent.visibleText.trim()) continue;
        if (element.rect.width > 24 || element.rect.height > 24) continue;
        findings.push(elementFinding(element));
      }
      return { status: 'complete', candidatesScanned: candidates.length, findings };
    }

    if (mode === 'background-image-discernible') {
      for (const element of candidates) {
        const bg = element.computedStyle.backgroundImage || '';
        if (!bg || bg === 'none' || !bg.includes('url(')) continue;
        if (element.attributes.role === 'img') continue;
        if (element.attributes['aria-label'] || element.attributes.alt) continue;
        if (element.attributes['aria-hidden'] === 'true') continue;
        if (element.rect.width <= 100 || element.rect.height <= 100) continue;
        findings.push(elementFinding(element));
      }
      return { status: 'complete', candidatesScanned: candidates.length, findings };
    }

    throw Object.assign(new Error(`unsupported graphics mode "${mode}"`), {
      errorCode: 'evaluator_failure',
    });
  },
};
