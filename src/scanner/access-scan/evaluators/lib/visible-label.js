import {
  getAncestors,
  getScopedElements,
  resolveIdRefs,
} from '../../runtime/graph-relationships.js';
import { normalizeText } from './runtime-context.js';

/**
 * @param {import('../../runtime/types.js').SnapshotElement} element
 */
export function elementVisibleText(element) {
  return typeof element.visibleText === 'string'
    ? element.visibleText
    : (element.text || '');
}

/**
 * @param {import('../../runtime/types.js').Snapshot} snapshot
 * @param {ReturnType<import('../../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 * @param {import('../../runtime/types.js').SnapshotElement} element
 */
export function explicitLabelText(snapshot, indexes, element) {
  const domId = element.attributes.id;
  if (domId) {
    const label = getScopedElements(snapshot, element).find(
      (candidate) => candidate.tag === 'label' && candidate.attributes.for === domId,
    );
    if (label) return elementVisibleText(label);
  }
  const labelAncestor = getAncestors(snapshot, indexes, element)
    .find((ancestor) => ancestor.tag === 'label');
  return labelAncestor ? elementVisibleText(labelAncestor) : '';
}

/**
 * @param {import('../../runtime/types.js').SnapshotElement} element
 * @param {ReturnType<import('../../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 * @param {{ visibleOnly?: boolean }=} options
 */
export function referencedLabelText(element, indexes, options = {}) {
  const refs = resolveIdRefs(element, indexes, 'aria-labelledby').resolved;
  const parts = refs
    .filter((target) => (
      !options.visibleOnly
      || (
        target.rendered
        && target.effectiveOpacity > 0
        && target.rect.width > 0
        && target.rect.height > 0
      )
    ))
    .map((target) => elementVisibleText(target));
  return parts.join(' ');
}

/**
 * @param {import('../../runtime/types.js').Snapshot} snapshot
 * @param {ReturnType<import('../../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 * @param {import('../../runtime/types.js').SnapshotElement} element
 */
export function deriveVisibleLabel(snapshot, indexes, element) {
  const ownText = normalizeText(elementVisibleText(element));
  if (ownText) return ownText;

  const associatedText = normalizeText([
    explicitLabelText(snapshot, indexes, element),
    referencedLabelText(element, indexes, { visibleOnly: true }),
  ].filter(Boolean).join(' '));
  if (associatedText) return associatedText;

  const inputType = (element.attributes.type || '').toLowerCase();
  if (
    element.tag === 'input'
    && ['button', 'submit', 'reset'].includes(inputType)
  ) {
    return normalizeText(element.attributes.value || '');
  }

  return '';
}

/**
 * @param {import('../../runtime/types.js').SnapshotElement} element
 * @param {ReturnType<import('../../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 */
export function deriveAccessibleWarningText(element, indexes) {
  const chunks = [
    elementVisibleText(element),
    element.accessibleName || '',
    element.attributes['aria-label'] || '',
    referencedLabelText(element, indexes),
    resolveIdRefs(element, indexes, 'aria-describedby').resolved
      .map((target) => elementVisibleText(target))
      .join(' '),
  ];
  return normalizeText(chunks.filter(Boolean).join(' '));
}

/**
 * @param {import('../../runtime/types.js').Snapshot} snapshot
 * @param {ReturnType<import('../../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 * @param {import('../../runtime/types.js').SnapshotElement} element
 */
export function hasExplicitOrImplicitLabel(snapshot, indexes, element) {
  if (explicitLabelText(snapshot, indexes, element).trim()) return true;
  if (element.attributes['aria-label']?.trim()) return true;
  if (element.attributes['aria-labelledby']?.trim()) return true;
  return false;
}

/**
 * @param {import('../../runtime/types.js').SnapshotElement} element
 */
export function isInteractiveControl(element) {
  const nativeInteractive = (
    element.tag === 'button'
    || (element.tag === 'a' && 'href' in element.attributes)
    || ['input', 'select', 'textarea', 'summary'].includes(element.tag)
  );
  const interactiveRoles = new Set([
    'button', 'link', 'tab', 'checkbox', 'radio', 'menuitem', 'option', 'switch',
  ]);
  const role = element.attributes.role || '';
  const tabindex = element.attributes.tabindex;
  const keyboardInteractive = tabindex !== undefined && tabindex !== '-1' && Number(tabindex) >= 0;
  return nativeInteractive || interactiveRoles.has(role) || keyboardInteractive;
}
