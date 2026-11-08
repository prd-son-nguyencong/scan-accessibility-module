import { getDescendants } from '../../runtime/graph-relationships.js';
import { explicitLabelText } from '../../evaluators/lib/visible-label.js';
import { normalizeText } from '../../evaluators/lib/runtime-context.js';
import { SEARCH_TOKEN } from './constants.js';

/**
 * @param {import('../../runtime/types.js').Snapshot} snapshot
 * @param {ReturnType<import('../../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 * @param {import('../../runtime/types.js').SnapshotElement} input
 */
function nearbyContainerText(snapshot, indexes, input) {
  let current = input.parentId != null ? indexes.byElementId.get(input.parentId) : null;
  const parts = [];
  while (current && current.tag !== 'body' && parts.join(' ').length < 200) {
    if (current.visibleText?.trim()) parts.push(current.visibleText.trim());
    if (current.text?.trim()) parts.push(current.text.trim());
    if (current.accessibleName?.trim()) parts.push(current.accessibleName.trim());
    current = current.parentId != null ? indexes.byElementId.get(current.parentId) : null;
  }
  return parts.join(' ');
}

/**
 * @param {import('../../runtime/types.js').Snapshot} snapshot
 * @param {ReturnType<import('../../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 * @param {import('../../runtime/types.js').SnapshotElement} input
 */
export function collectSearchSemantics(snapshot, indexes, input) {
  const chunks = [
    input.accessibleName,
    input.attributes['aria-label'],
    input.attributes.placeholder,
    input.attributes.name,
    explicitLabelText(snapshot, indexes, input),
    nearbyContainerText(snapshot, indexes, input),
  ];
  return normalizeText(chunks.filter(Boolean).join(' '));
}

/**
 * @param {import('../../runtime/types.js').Snapshot} snapshot
 * @param {ReturnType<import('../../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 * @param {import('../../runtime/types.js').SnapshotElement} input
 */
export function isSearchInput(snapshot, indexes, input) {
  if (input.attributes.type === 'search' || input.attributes.role === 'searchbox') {
    return true;
  }
  return SEARCH_TOKEN.test(collectSearchSemantics(snapshot, indexes, input));
}
