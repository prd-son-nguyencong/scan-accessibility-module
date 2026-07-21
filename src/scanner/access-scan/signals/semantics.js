import {
  getAncestors, getDescendants, hasAncestor,
} from '../runtime/graph-relationships.js';
import { explicitLabelText, deriveVisibleLabel, isInteractiveControl } from '../evaluators/lib/visible-label.js';
import { normalizeText } from '../evaluators/lib/runtime-context.js';
import { EXCLUDED_HIDDEN_TAGS, SENSITIVE_ATTR_NAMES } from './lib/constants.js';
import {
  findScopedBody, findScopedTitle, isActiveContent, isBanner, isMainLandmark,
} from './lib/dom.js';
import { createDomFact, SIGNAL_FAMILIES } from './types.js';

const LANDMARK_ROLES = new Set([
  'banner', 'complementary', 'contentinfo', 'form', 'main', 'navigation', 'region', 'search',
]);

/**
 * @param {import('../runtime/types.js').SnapshotElement} element
 */
function isLandmark(element) {
  if (['header', 'footer', 'main', 'nav', 'aside', 'form'].includes(element.tag)) {
    return true;
  }
  const role = element.attributes.role;
  return Boolean(role && LANDMARK_ROLES.has(role));
}

function observeGatedEntry(snapshot, indexes) {
  for (const main of snapshot.elements.filter((element) => isMainLandmark(element) && isActiveContent(element))) {
    const gateForm = findCredentialForm(snapshot, indexes, main);
    if (!gateForm) continue;

    const body = findScopedBody(snapshot, main);
    if (!body) continue;

    const shell = findCredentialShell(snapshot, indexes, main, body);
    if (!shell || shell.id === main.id) continue;

    const hasOutsideBanner = snapshot.elements.some((element) => (
      isBanner(element)
      && isActiveContent(element)
      && !hasAncestor(snapshot, indexes, element, (ancestor) => ancestor.id === main.id)
      && hasAncestor(snapshot, indexes, element, (ancestor) => ancestor.id === shell.id)
    ));
    if (!hasOutsideBanner) continue;

    const headingTexts = getDescendants(snapshot, indexes, main, (child) => (
      ['h1', 'h2'].includes(child.tag) && isActiveContent(child)
    )).map((heading) => normalizeText(heading.visibleText || heading.text || ''));

    const title = findScopedTitle(snapshot, main);
    const titleText = title?.text || '';
    const normalizedTitle = normalizeText(titleText);
    const titleTokens = normalizedTitle.match(/[\p{L}\p{N}]+(?:['’.-][\p{L}\p{N}]+)*/gu) || [];
    const titleElement = title && titleTokens.length === 1 && headingTexts.includes(normalizedTitle)
      ? title
      : null;

    return {
      shell,
      main,
      body,
      title: titleElement,
      hiddenElements: collectObservedHiddenElements(snapshot, indexes, shell),
    };
  }

  return null;
}

/**
 * @param {import('../runtime/types.js').Snapshot} snapshot
 * @param {ReturnType<import('../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 * @param {import('../runtime/types.js').SnapshotElement} main
 */

function findCredentialForm(snapshot, indexes, main) {
  return getDescendants(snapshot, indexes, main, (child) => child.tag === 'form' && isActiveContent(child))
    .find((form) => {
      const credential = getDescendants(snapshot, indexes, form, (input) => {
        if (input.tag !== 'input' || !isActiveContent(input)) return false;
        const autocomplete = normalizeText(input.attributes.autocomplete);
        return (
          input.attributes.type === 'password'
          || autocomplete === 'current-password'
          || autocomplete === 'new-password'
        );
      })[0];
      const submit = getDescendants(snapshot, indexes, form, (control) => (
        isActiveContent(control)
        && (
          (control.tag === 'button' && (control.attributes.type === 'submit' || !control.attributes.type))
          || (control.tag === 'input' && control.attributes.type === 'submit')
        )
      ))[0];
      return Boolean(credential && submit);
    }) || null;
}

/**
 * @param {import('../runtime/types.js').Snapshot} snapshot
 * @param {ReturnType<import('../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 * @param {import('../runtime/types.js').SnapshotElement} main
 * @param {import('../runtime/types.js').SnapshotElement} body
 */

function findCredentialShell(snapshot, indexes, main, body) {
  let shell = main;
  while (shell.parentId != null) {
    const parent = indexes.byElementId.get(shell.parentId);
    if (!parent) break;
    if (parent.id === body.id) break;
    if (parent.shadowPath.length === 0 && shell.shadowPath.length > 0) break;
    shell = parent;
  }

  const parent = shell.parentId != null ? indexes.byElementId.get(shell.parentId) : null;
  if (!parent || shell.id === main.id) return null;

  const isDocumentShell = parent.id === body.id;
  const isShadowShell = parent.shadowPath.length === 0 && shell.shadowPath.length > 0;
  return (isDocumentShell || isShadowShell) ? shell : null;
}

/**
 * @param {import('../runtime/types.js').Snapshot} snapshot
 * @param {ReturnType<import('../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 * @param {import('../runtime/types.js').SnapshotElement} shell
 */

function collectObservedHiddenElements(snapshot, indexes, shell) {
  return getDescendants(snapshot, indexes, shell, (element) => {
    if (EXCLUDED_HIDDEN_TAGS.has(element.tag)) return false;
    if (element.tag === 'input' && element.attributes.type === 'hidden') return true;
    if (element.attributes.hidden !== undefined) return true;
    const display = element.computedStyle.display || '';
    const visibility = element.computedStyle.visibility || '';
    return display === 'none' || visibility === 'hidden';
  });
}

/**
 * @param {import('../runtime/types.js').SnapshotElement} element
 */

function redactSensitiveHtml(element) {
  let html = element.outerHTML;
  for (const [name, value] of Object.entries(element.attributes)) {
    if (!shouldRedactAttribute(name, element)) continue;
    const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    html = html
      .replace(new RegExp(`${name}="[^"]*"`, 'gi'), `${name}="[redacted]"`)
      .replace(new RegExp(`${name}='[^']*'`, 'gi'), `${name}='[redacted]'`)
      .replace(new RegExp(`${name}=([^\\s>]+)`, 'gi'), `${name}="[redacted]"`)
      .replace(new RegExp(escaped, 'g'), '[redacted]');
  }
  return html;
}

/**
 * @param {string} name
 * @param {import('../runtime/types.js').SnapshotElement} element
 */

function shouldRedactAttribute(name, element) {
  const lowerName = name.toLowerCase();
  if (SENSITIVE_ATTR_NAMES.test(lowerName)) return true;
  if (lowerName === 'value' && (
    element.attributes.type === 'password' || element.attributes.type === 'hidden'
  )) {
    return true;
  }
  return false;
}

/**
 * @param {import('../runtime/types.js').Snapshot} snapshot
 * @param {ReturnType<import('../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 */

function collectCheckboxLabelAnomalies(snapshot, indexes) {
  /** @type {Array<{ element: import('../runtime/types.js').SnapshotElement, visibleText: string, accessibleName: string }>} */
  const observations = [];

  for (const element of snapshot.elements) {
    if (element.tag !== 'input' || element.attributes.type !== 'checkbox') continue;
    if (!element.attributes['aria-labelledby'] || !isActiveContent(element)) continue;

    const visibleText = normalizeText(element.attributes.value || '');
    if (!visibleText || visibleText === 'on' || visibleText === 'off') continue;

    const accessibleName = normalizeText(element.accessibleName || '');
    if (!accessibleName || accessibleName === visibleText) continue;

    observations.push({ element, visibleText, accessibleName });
  }

  return observations;
}

/**
 * @param {import('../runtime/types.js').Snapshot} snapshot
 * @param {ReturnType<import('../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 */

function collectAccessibleNameObservations(snapshot, indexes) {
  /** @type {Array<{ element: import('../runtime/types.js').SnapshotElement, visibleText: string, accessibleName: string }>} */
  const observations = [];

  for (const element of snapshot.elements) {
    if (isLandmark(element) || !isInteractiveControl(element)) continue;
    if (!element.attributes['aria-label'] && !element.attributes['aria-labelledby']) continue;

    const visibleText = deriveVisibleLabel(snapshot, indexes, element);
    if (!visibleText) continue;

    observations.push({
      element,
      visibleText,
      accessibleName: normalizeText(element.accessibleName || ''),
    });
  }

  return observations;
}

/**
 * @param {import('../runtime/types.js').Snapshot} snapshot
 * @param {ReturnType<import('../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 * @returns {import('./types.js').DomFact[]}
 */
function collectSemanticsFacts(snapshot, indexes) {
  /** @type {import('./types.js').DomFact[]} */
  const facts = [];

  const gate = observeGatedEntry(snapshot, indexes);
  if (gate) {
    const groupKey = gate.shell.id;
    for (const [role, element] of [
      ['shell', gate.shell],
      ['main', gate.main],
      ['body', gate.body],
      ...(gate.title ? [['title', gate.title]] : []),
    ]) {
      facts.push(createDomFact(
        SIGNAL_FAMILIES.SEMANTICS,
        'semantics.gated-entry',
        element,
        { role, groupKey },
      ));
    }
    for (const hidden of collectObservedHiddenElements(snapshot, indexes, gate.shell)) {
      facts.push(createDomFact(
        SIGNAL_FAMILIES.SEMANTICS,
        'semantics.gated-entry.hidden',
        hidden,
        {
          groupKey,
          tag: hidden.tag,
          inputType: hidden.attributes.type || null,
          hiddenKind: hidden.tag === 'input' && hidden.attributes.type === 'hidden'
            ? 'input-hidden'
            : (hidden.attributes.hidden !== undefined ? 'hidden-attr' : 'css-hidden'),
          sensitiveAttributeNames: Object.keys(hidden.attributes).filter(
            (name) => shouldRedactAttribute(name, hidden),
          ),
        },
      ));
    }
  }

  for (const observation of collectAccessibleNameObservations(snapshot, indexes)) {
    facts.push(createDomFact(
      SIGNAL_FAMILIES.SEMANTICS,
      'semantics.accessible-name',
      observation.element,
      {
        visibleText: observation.visibleText,
        accessibleName: observation.accessibleName,
        controlKind: observation.element.tag,
      },
    ));
  }

  for (const observation of collectCheckboxLabelAnomalies(snapshot, indexes)) {
    facts.push(createDomFact(
      SIGNAL_FAMILIES.SEMANTICS,
      'semantics.checkbox-value',
      observation.element,
      {
        visibleText: observation.visibleText,
        accessibleName: observation.accessibleName,
      },
    ));
  }

  return facts;
}

/**
 * @param {import('../runtime/types.js').Snapshot} snapshot
 * @param {ReturnType<import('../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 */

export {
  observeGatedEntry,
  findCredentialForm,
  findCredentialShell,
  collectObservedHiddenElements,
  redactSensitiveHtml,
  shouldRedactAttribute,
  collectCheckboxLabelAnomalies,
  collectAccessibleNameObservations,
  collectSemanticsFacts,
};
