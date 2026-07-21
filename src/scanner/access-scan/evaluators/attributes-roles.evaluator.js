import { getDescendants } from '../runtime/graph-relationships.js';
import {
  deriveVisibleLabel,
  hasExplicitOrImplicitLabel,
  isInteractiveControl,
} from './lib/visible-label.js';
import {
  elementFinding,
  getIndexes,
  getSnapshot,
  normalizeText,
  queryCandidates,
} from './lib/runtime-context.js';

/** @type {import('../../engine/loader.js').EvaluatorModule} */
export default {
  id: 'attributes-roles',
  async evaluate(context, check) {
    const snapshot = getSnapshot(context);
    const indexes = getIndexes(context);
    const mode = /** @type {string} */ (check.options?.mode);
    const candidates = queryCandidates(context, check);
    /** @type {import('../../engine/loader.js').EvaluatorResult['findings']} */
    const findings = [];

    if (mode === 'misplaced-alt') {
      const excludeTags = new Set(
        /** @type {string[]} */ (check.options?.excludeTags || ['img', 'area']),
      );
      const excludeShadowRoots = check.options?.excludeShadowRoots === true;
      for (const element of candidates) {
        if (excludeTags.has(element.tag)) continue;
        if (excludeShadowRoots && element.shadowPath.length > 0) continue;
        if (element.tag === 'input' && element.attributes.type === 'image') continue;
        if (!('alt' in element.attributes)) continue;
        findings.push(elementFinding(element));
      }
      return { status: 'complete', candidatesScanned: candidates.length, findings };
    }

    if (mode === 'forbidden-role') {
      const role = /** @type {string} */ (check.options?.role || 'application');
      for (const element of candidates) {
        if (element.attributes.role === role) {
          findings.push(elementFinding(element));
        }
      }
      return { status: 'complete', candidatesScanned: candidates.length, findings };
    }

    if (mode === 'title-only-primary-label') {
      for (const element of candidates) {
        const title = element.attributes.title?.trim();
        if (!title || !isInteractiveControl(element)) continue;
        const visibleLabel = deriveVisibleLabel(snapshot, indexes, element);
        if (visibleLabel) continue;
        if (hasExplicitOrImplicitLabel(snapshot, indexes, element)) continue;
        findings.push(elementFinding(element, { title, primaryLabelSource: 'title-only' }));
      }
      return { status: 'complete', candidatesScanned: candidates.length, findings };
    }

    if (mode === 'title-duplicates-visible') {
      for (const element of candidates) {
        const title = element.attributes.title?.trim();
        const visibleLabel = deriveVisibleLabel(snapshot, indexes, element);
        if (title && visibleLabel && normalizeText(title) === visibleLabel) {
          findings.push(elementFinding(element, { advisory: true }));
        }
      }
      return { status: 'complete', candidatesScanned: candidates.length, findings };
    }

    if (mode === 'figure-missing-caption') {
      for (const element of candidates) {
        const hasCaption = getDescendants(snapshot, indexes, element, (child) => child.tag === 'figcaption').length > 0;
        const hasAriaLabel = Boolean(element.attributes['aria-label']?.trim());
        const hasAriaLabelledby = Boolean(element.attributes['aria-labelledby']?.trim());
        if (!hasCaption && !hasAriaLabel && !hasAriaLabelledby) {
          findings.push(elementFinding(element));
        }
      }
      return { status: 'complete', candidatesScanned: candidates.length, findings };
    }

    if (mode === 'iframe-missing-title') {
      for (const element of candidates) {
        if (element.attributes['aria-hidden'] === 'true') continue;
        if (element.attributes.role === 'presentation') continue;
        if (!element.rendered) continue;
        if (!element.attributes.title?.trim()) {
          findings.push(elementFinding(element));
        }
      }
      return { status: 'complete', candidatesScanned: candidates.length, findings };
    }

    if (mode === 'menu-on-navigation') {
      for (const element of candidates) {
        const hasNavLink = getDescendants(
          snapshot,
          indexes,
          element,
          (child) => child.tag === 'a' && Boolean(child.attributes.href),
        ).length > 0;
        if (hasNavLink) findings.push(elementFinding(element));
      }
      return { status: 'complete', candidatesScanned: candidates.length, findings };
    }

    if (mode === 'menubar-on-navigation') {
      for (const element of candidates) {
        const hasNavLink = getDescendants(
          snapshot,
          indexes,
          element,
          (child) => child.tag === 'a' && Boolean(child.attributes.href),
        ).length > 0;
        if (hasNavLink) findings.push(elementFinding(element));
      }
      return { status: 'complete', candidatesScanned: candidates.length, findings };
    }

    if (mode === 'menuitem-on-navigation') {
      for (const element of candidates) {
        if (element.tag === 'a' && element.attributes.href) {
          findings.push(elementFinding(element));
        }
      }
      return { status: 'complete', candidatesScanned: candidates.length, findings };
    }

    if (mode === 'haspopup-not-interactive') {
      for (const element of candidates) {
        if (element.tag === 'button' || element.tag === 'a') continue;
        const role = element.attributes.role;
        const tabindex = element.attributes.tabindex;
        const isInteractive = (
          tabindex !== undefined && tabindex !== '-1'
        ) || role === 'button' || role === 'menuitem';
        if (!isInteractive) {
          findings.push(elementFinding(element));
        }
      }
      return { status: 'complete', candidatesScanned: candidates.length, findings };
    }

    if (mode === 'has-autofocus') {
      for (const element of candidates) {
        if ('autofocus' in element.attributes) {
          findings.push(elementFinding(element));
        }
      }
      return { status: 'complete', candidatesScanned: candidates.length, findings };
    }

    return { status: 'inapplicable', candidatesScanned: 0, findings: [] };
  },
};
