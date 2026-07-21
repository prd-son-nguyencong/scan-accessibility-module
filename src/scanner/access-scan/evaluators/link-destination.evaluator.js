import {
  getAncestors,
  getDescendants,
  hasNavigationAncestor,
} from '../runtime/graph-relationships.js';
import {
  normalizeText,
  elementFinding,
  getIndexes,
  getScanUrl,
  getSnapshot,
  queryCandidates,
} from './lib/runtime-context.js';

/** @type {import('../engine/loader.js').EvaluatorModule} */
export default {
  id: 'link-destination',
  async evaluate(context, check) {
    const snapshot = getSnapshot(context);
    const indexes = getIndexes(context);
    const mode = /** @type {string} */ (check.options?.mode);
    const candidates = queryCandidates(context, check);
    /** @type {import('../engine/loader.js').EvaluatorResult['findings']} */
    const findings = [];

    if (mode === 'link-navigation-ambiguous') {
      /** @type {Map<string, Set<string>>} */
      const textToHrefs = new Map();
      for (const element of candidates) {
        if (isActionOnlyHref(element.attributes.href || '')) continue;
        const purpose = getLinkPurpose(snapshot, indexes, element);
        if (!purpose.text || purpose.text.length < 3) continue;
        const href = element.attributes.href || '';
        if (!textToHrefs.has(purpose.key)) textToHrefs.set(purpose.key, new Set());
        textToHrefs.get(purpose.key).add(href);
      }
      for (const element of candidates) {
        if (isActionOnlyHref(element.attributes.href || '')) continue;
        const purpose = getLinkPurpose(snapshot, indexes, element);
        if (!purpose.text) continue;
        const hrefs = textToHrefs.get(purpose.key);
        if (!hrefs || hrefs.size <= 1) continue;
        findings.push(elementFinding(element, { duplicateText: purpose.text }));
      }
      return { status: 'complete', candidatesScanned: candidates.length, findings };
    }

    if (mode === 'link-navigation-ambiguous-parity') {
      const linkCandidates = collectAmbiguousLinkCandidates(snapshot, indexes, candidates);
      // Include opacity-deferred carousel CTAs (rendered but opacity 0) — commercial
      // still scores repeated "Learn More" across inactive slides. Pure hover twins
      // (visibility:hidden copies of the same destination) stay filtered out below.
      const scoreableLinkCandidates = linkCandidates.filter((element) => (
        isVisuallyAvailableLink(element) || isOpacityDeferredLink(snapshot, indexes, element)
      ));
      /** @type {Map<string, Set<string>>} */
      const hrefsByPurpose = new Map();
      /** @type {Map<string, number>} */
      const occurrencesByPurpose = new Map();
      for (const element of scoreableLinkCandidates) {
        if (isActionOnlyHref(element.attributes.href || '')) continue;
        const purpose = getGlobalLinkPurpose(element);
        if (purpose.length < 3 || !isGenericLinkPurpose(purpose)) continue;
        const hrefs = hrefsByPurpose.get(purpose) || new Set();
        hrefs.add(element.attributes.href || '');
        hrefsByPurpose.set(purpose, hrefs);
        occurrencesByPurpose.set(purpose, (occurrencesByPurpose.get(purpose) || 0) + 1);
      }

      /** @type {Set<number>} */
      const reported = new Set();
      for (const element of scoreableLinkCandidates) {
        if (isActionOnlyHref(element.attributes.href || '')) continue;
        const purpose = getGlobalLinkPurpose(element);
        if (!isGenericLinkPurpose(purpose)) continue;
        const distinctDestinations = hrefsByPurpose.get(purpose)?.size || 0;
        if (
          distinctDestinations <= 1
          || distinctDestinations !== occurrencesByPurpose.get(purpose)
        ) {
          continue;
        }
        reported.add(element.id);
        findings.push(elementFinding(element, {
          structuralPattern: 'repeated-link-purpose-with-distinct-destinations',
          duplicateText: purpose,
        }));
      }

      // Standalone deictic CTAs ("Sign up here") remain ambiguous even when unique.
      // Inventory CTAs like "Search Jobs Now" / "View All Jobs" are likewise
      // destination-agnostic even as a single occurrence. Decorative-arrow
      // generics ("Learn More ›") are also flagged uniquely by commercial.
      /** @type {Set<string>} */
      const inventoryKeys = new Set();
      for (const element of linkCandidates) {
        if (reported.has(element.id)) continue;
        if (isActionOnlyHref(element.attributes.href || '')) continue;
        if (!isVisuallyAvailableLink(element) && !isDeferredVisualLink(snapshot, indexes, element)) {
          continue;
        }
        const rawPurpose = normalizeText(
          element.accessibleName
          || element.attributes['aria-label']
          || element.visibleText
          || element.text
          || '',
        );
        const purpose = normalizeLinkPurpose(rawPurpose);
        const inventory = isInventoryJobCtaPurpose(purpose);
        const decorated = isDecoratedGenericCta(rawPurpose, purpose);
        if (!isDeicticLinkPurpose(purpose) && !inventory && !decorated) continue;
        if (inventory || decorated) {
          if (!isVisuallyAvailableLink(element)) continue;
          const key = `${purpose}::${element.attributes.href || ''}`;
          if (inventoryKeys.has(key)) continue;
          inventoryKeys.add(key);
        }
        reported.add(element.id);
        findings.push(elementFinding(element, {
          structuralPattern: inventory
            ? 'inventory-job-cta-without-destination-context'
            : decorated
              ? 'decorated-generic-cta-without-destination-context'
              : 'deictic-link-purpose-without-destination-context',
          duplicateText: purpose,
        }));
      }
      return { status: 'complete', candidatesScanned: linkCandidates.length, findings };
    }

    if (mode === 'link-current-page') {
      const pageUrl = getScanUrl(context);
      if (!pageUrl || pageUrl === 'about:blank' || pageUrl.startsWith('about:')) {
        return { status: 'inapplicable', candidatesScanned: 0, findings: [] };
      }

      let pageOrigin;
      let pagePath;
      try {
        const parsed = new URL(pageUrl);
        pageOrigin = parsed.origin;
        pagePath = normalizePath(parsed.pathname);
      } catch {
        return { status: 'inapplicable', candidatesScanned: 0, findings: [] };
      }

      for (const element of candidates) {
        const href = element.attributes.href || '';
        if (!href || href === '#' || href.startsWith('#')) continue;
        if (element.attributes['aria-current']) continue;
        if (!hasNavigationAncestor(snapshot, indexes, element)) continue;

        const resolved = resolveHref(href, pageUrl);
        if (!resolved) continue;
        if (resolved.origin !== pageOrigin) continue;
        if (resolved.pathname !== pagePath) continue;
        findings.push(elementFinding(element));
      }
      return { status: 'complete', candidatesScanned: candidates.length, findings };
    }

    throw Object.assign(new Error(`unsupported link-destination mode "${mode}"`), {
      errorCode: 'evaluator_failure',
    });
  },
};

/**
 * @param {import('../runtime/types.js').Snapshot} snapshot
 * @param {ReturnType<import('../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 * @param {import('../runtime/types.js').SnapshotElement} element
 */
function getLinkPurpose(snapshot, indexes, element) {
  const text = normalizeText(
    element.accessibleName
    || element.attributes['aria-label']
    || element.visibleText
    || element.text
    || '',
  );
  const context = findLinkPurposeContext(snapshot, indexes, element);
  if (!context) return { key: text, text };

  return {
    key: `${text}::context-${context.id}`,
    text,
  };
}

/**
 * Link purpose may use the nearest list/card or a compact heading-labelled
 * content block. Page chrome and whole-document containers are not context.
 *
 * @param {import('../runtime/types.js').Snapshot} snapshot
 * @param {ReturnType<import('../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 * @param {import('../runtime/types.js').SnapshotElement} element
 */
function findLinkPurposeContext(snapshot, indexes, element) {
  return getAncestors(snapshot, indexes, element).find((ancestor) => {
    if (ancestor.tag === 'li' || ancestor.tag === 'article') return true;
    if (['html', 'body', 'main', 'header', 'nav', 'footer'].includes(ancestor.tag)) {
      return false;
    }
    const headings = getDescendants(
      snapshot,
      indexes,
      ancestor,
      (child) => /^h[1-6]$/.test(child.tag),
    );
    return headings.length === 1;
  }) || null;
}

/**
 * Commercial parity compares the authored link purpose globally rather than
 * incorporating card or list-item context.
 *
 * @param {import('../runtime/types.js').SnapshotElement} element
 */
function getGlobalLinkPurpose(element) {
  return normalizeLinkPurpose(
    element.accessibleName
    || element.attributes['aria-label']
    || element.visibleText
    || element.text
    || '',
  );
}

/**
 * Strip trailing decorative arrow glyphs commercial still treats as part of the
 * visible CTA ("Learn More ›" → "learn more").
 *
 * @param {string} value
 */
function normalizeLinkPurpose(value) {
  return normalizeText(value).replace(/[\s›»→▸►>]+$/u, '').trim();
}

/**
 * Commercial ambiguity findings target context-dependent action phrases, not
 * repeated descriptive names such as job titles or account destinations.
 *
 * @param {string} purpose
 */
function isGenericLinkPurpose(purpose) {
  if (/^(?:(?:learn|read|view|see|find out|discover|explore)\s+(?:more|details)|(?:apply|view jobs?|see jobs|search jobs)(?:\s+now)?|view all jobs|more|details|click here|here)$/.test(
    purpose,
  )) {
    return true;
  }
  if (/^(?:sign\s+up|register|join\s+us|get\s+started)$/.test(purpose)) {
    return true;
  }
  return isDeicticLinkPurpose(purpose) || isInventoryJobCtaPurpose(purpose);
}

/**
 * Job-listing CTAs that never name a department/role remain ambiguous even as
 * unique links — commercial accessScan flags these alongside card "View Jobs"
 * clusters. Bare "Search Jobs" (without Now/All) is left to the repeated-purpose
 * path so single search entry points do not become EXTRAs.
 *
 * @param {string} purpose
 */
function isInventoryJobCtaPurpose(purpose) {
  return /^(?:search\s+jobs\s+now|view\s+all\s+jobs|see\s+jobs)$/.test(purpose);
}

/**
 * Unique "Learn more" is usually fine, but decorative-arrow CTAs ("Learn More ›")
 * are still scored as ambiguous by commercial accessScan.
 *
 * @param {string} rawPurpose
 * @param {string} normalizedPurpose
 */
function isDecoratedGenericCta(rawPurpose, normalizedPurpose) {
  if (!/[\u203a›»→▸►]/.test(rawPurpose)) return false;
  return isGenericLinkPurpose(normalizedPurpose);
}

/**
 * @param {import('../runtime/types.js').SnapshotElement} element
 */
function isVisuallyAvailableLink(element) {
  return (
    element.rendered
    && element.computedStyle.visibility !== 'hidden'
    && element.effectiveOpacity > 0.1
  );
}

/**
 * Deictic link text ("… here") cannot convey destination without surrounding
 * visual context — commercial scanners flag these even as unique CTAs.
 *
 * @param {string} purpose
 */
function isDeicticLinkPurpose(purpose) {
  if (!purpose || purpose.length < 4) return false;
  if (/^(?:click|tap)\s+here$/.test(purpose)) return true;
  // Require the deictic phrase to be the entire accessible name. Longer labels
  // such as "Current Employees Apply Here" are destination-specific, not bare CTAs.
  if (/^(?:sign\s+up|register|join(?:\s+us)?|apply|learn\s+more|read\s+more)\s+here$/.test(purpose)) {
    return true;
  }
  // Short bare "... here" (start here, go here) — at most one token before here.
  return /^(?:\w+\s+)?here$/.test(purpose);
}

/**
 * Include deferred visual CTAs (visibility:hidden / opacity fades) that remain
 * authored in the DOM — commercial accessScan still samples these.
 *
 * @param {import('../runtime/types.js').Snapshot} snapshot
 * @param {ReturnType<import('../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 * @param {import('../runtime/types.js').SnapshotElement[]} candidates
 */
function collectAmbiguousLinkCandidates(snapshot, indexes, candidates) {
  /** @type {Map<number, import('../runtime/types.js').SnapshotElement>} */
  const byId = new Map();
  for (const element of candidates) {
    byId.set(element.id, element);
  }

  for (const element of snapshot.elements) {
    if (byId.has(element.id)) continue;
    if (element.tag !== 'a' || !element.attributes.href) continue;
    // Skip explicitly inert/ARIA-hidden hosts; CSS visibility fades still count.
    if (element.attributes['aria-hidden'] === 'true') continue;
    if (getAncestors(snapshot, indexes, element).some((ancestor) => (
      ancestor.attributes['aria-hidden'] === 'true'
      || ancestor.attributes.inert !== undefined
      || ancestor.attributes.hidden !== undefined
    ))) {
      continue;
    }
    if (isActionOnlyHref(element.attributes.href || '')) continue;
    if (!isDeferredVisualLink(snapshot, indexes, element)) continue;
    if (!getGlobalLinkPurpose(element)) continue;
    byId.set(element.id, element);
  }

  return [...byId.values()];
}

/**
 * @param {import('../runtime/types.js').Snapshot} snapshot
 * @param {ReturnType<import('../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 * @param {import('../runtime/types.js').SnapshotElement} element
 */
function isDeferredVisualLink(snapshot, indexes, element) {
  if (element.computedStyle.display === 'none') return false;
  if (getAncestors(snapshot, indexes, element).some((ancestor) => (
    ancestor.computedStyle.display === 'none'
  ))) {
    return false;
  }
  // Carousel slides often stay `rendered` with opacity 0 / visibility hidden.
  if (element.rendered) {
    return (
      element.computedStyle.visibility === 'hidden'
      || element.effectiveOpacity <= 0.1
    );
  }
  return (
    element.computedStyle.visibility === 'hidden'
    || element.effectiveOpacity <= 0.1
  );
}

/**
 * Opacity-faded but still-rendered links (inactive carousel CTAs).
 *
 * @param {import('../runtime/types.js').Snapshot} snapshot
 * @param {ReturnType<import('../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 * @param {import('../runtime/types.js').SnapshotElement} element
 */
function isOpacityDeferredLink(snapshot, indexes, element) {
  if (!element.rendered) return false;
  if (isVisuallyAvailableLink(element)) return false;
  return isDeferredVisualLink(snapshot, indexes, element);
}

/**
 * @param {string} href
 */
function isActionOnlyHref(href) {
  const value = href.trim().toLowerCase();
  return value === '' || value === '#' || value.startsWith('javascript:');
}

/**
 * @param {string} href
 * @param {string} pageUrl
 * @returns {{ origin: string, pathname: string } | null}
 */
function resolveHref(href, pageUrl) {
  try {
    const url = new URL(href, pageUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return {
      origin: url.origin,
      pathname: normalizePath(url.pathname),
    };
  } catch {
    return null;
  }
}

/**
 * @param {string} value
 */
function normalizePath(value) {
  const trimmed = String(value || '').replace(/\/$/, '') || '/';
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}
