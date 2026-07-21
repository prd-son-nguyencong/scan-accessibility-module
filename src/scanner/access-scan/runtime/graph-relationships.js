/**
 * @typedef {import('./types.js').Snapshot} Snapshot
 * @typedef {import('./types.js').SnapshotElement} SnapshotElement
 */

/**
 * @param {SnapshotElement} element
 * @returns {string}
 */
export function scopeKey(element) {
  return `f:${element.framePath.join('.')}|s:${element.shadowPath.join('.')}`;
}

/**
 * @param {SnapshotElement} a
 * @param {SnapshotElement} b
 * @returns {boolean}
 */
export function sameScope(a, b) {
  return scopeKey(a) === scopeKey(b);
}

/**
 * @param {Snapshot} snapshot
 * @returns {{
 *   byElementId: Map<number, SnapshotElement>,
 *   byScopedDomId: Map<string, Map<string, SnapshotElement>>,
 *   ambiguousDomIds: Map<string, Set<string>>,
 *   childrenByParentId: Map<number, SnapshotElement[]>,
 * }}
 */
export function buildSnapshotIndexes(snapshot) {
  /** @type {Map<number, SnapshotElement>} */
  const byElementId = new Map();
  /** @type {Map<string, Map<string, SnapshotElement>>} */
  const byScopedDomId = new Map();
  /** @type {Map<string, Set<string>>} */
  const ambiguousDomIds = new Map();
  /** @type {Map<number, SnapshotElement[]>} */
  const childrenByParentId = new Map();

  for (const element of snapshot.elements) {
    byElementId.set(element.id, element);

    const domId = element.attributes.id;
    if (domId) {
      const sk = scopeKey(element);
      if (!byScopedDomId.has(sk)) {
        byScopedDomId.set(sk, new Map());
      }
      const scopeMap = byScopedDomId.get(sk);
      if (!scopeMap.has(domId)) {
        scopeMap.set(domId, element);
      } else {
        if (!ambiguousDomIds.has(sk)) {
          ambiguousDomIds.set(sk, new Set());
        }
        ambiguousDomIds.get(sk).add(domId);
      }
    }

    if (element.parentId != null) {
      const siblings = childrenByParentId.get(element.parentId) || [];
      siblings.push(element);
      childrenByParentId.set(element.parentId, siblings);
    }
  }

  return { byElementId, byScopedDomId, ambiguousDomIds, childrenByParentId };
}

/**
 * @param {ReturnType<typeof buildSnapshotIndexes>} indexes
 * @param {SnapshotElement} element
 * @param {string} domId
 * @returns {SnapshotElement | undefined}
 */
export function resolveScopedDomId(indexes, element, domId) {
  if (!domId) return undefined;
  return indexes.byScopedDomId.get(scopeKey(element))?.get(domId);
}

/**
 * @param {Snapshot} snapshot
 * @param {ReturnType<typeof buildSnapshotIndexes>} indexes
 * @param {SnapshotElement} element
 * @returns {SnapshotElement[]}
 */
export function getAncestors(snapshot, indexes, element) {
  /** @type {SnapshotElement[]} */
  const ancestors = [];
  let parentId = element.parentId;
  while (parentId != null) {
    const parent = indexes.byElementId.get(parentId);
    if (!parent || !sameScope(parent, element)) break;
    ancestors.push(parent);
    parentId = parent.parentId;
  }
  return ancestors;
}

/**
 * @param {Snapshot} snapshot
 * @param {ReturnType<typeof buildSnapshotIndexes>} indexes
 * @param {SnapshotElement} element
 * @param {(candidate: SnapshotElement) => boolean=} predicate
 * @returns {SnapshotElement[]}
 */
export function getDescendants(snapshot, indexes, element, predicate) {
  /** @type {SnapshotElement[]} */
  const descendants = [];
  /** @type {number[]} */
  const queue = [element.id];
  const seen = new Set(queue);

  while (queue.length > 0) {
    const parentId = queue.shift();
    const children = indexes.childrenByParentId.get(parentId) || [];
    for (const child of children) {
      if (!sameScope(child, element) || seen.has(child.id)) continue;
      seen.add(child.id);
      if (!predicate || predicate(child)) {
        descendants.push(child);
      }
      queue.push(child.id);
    }
  }

  return descendants;
}

/**
 * @param {Snapshot} snapshot
 * @param {ReturnType<typeof buildSnapshotIndexes>} indexes
 * @param {SnapshotElement} element
 * @param {(ancestor: SnapshotElement) => boolean} predicate
 * @returns {boolean}
 */
export function hasAncestor(snapshot, indexes, element, predicate) {
  return getAncestors(snapshot, indexes, element).some(predicate);
}

/**
 * @param {SnapshotElement} element
 * @param {string} attributeName
 * @returns {string[]}
 */
export function splitIdRefList(element, attributeName) {
  const raw = element.attributes[attributeName];
  if (!raw) return [];
  return raw.split(/\s+/).map((part) => part.trim()).filter(Boolean);
}

/**
 * @param {SnapshotElement} element
 * @param {ReturnType<typeof buildSnapshotIndexes>} indexes
 * @param {string} attributeName
 * @returns {{ missing: string[], resolved: SnapshotElement[] }}
 */
export function resolveIdRefs(element, indexes, attributeName) {
  const ids = splitIdRefList(element, attributeName);
  /** @type {string[]} */
  const missing = [];
  /** @type {SnapshotElement[]} */
  const resolved = [];

  for (const domId of ids) {
    const target = resolveScopedDomId(indexes, element, domId);
    if (target) {
      resolved.push(target);
    } else {
      missing.push(domId);
    }
  }

  return { missing, resolved };
}

/**
 * @param {SnapshotElement} element
 * @returns {boolean}
 */
export function isNavigationLandmark(element) {
  return element.tag === 'nav' || element.attributes.role === 'navigation';
}

/**
 * @param {Snapshot} snapshot
 * @param {ReturnType<typeof buildSnapshotIndexes>} indexes
 * @param {SnapshotElement} element
 * @returns {boolean}
 */
export function hasNavigationAncestor(snapshot, indexes, element) {
  return hasAncestor(snapshot, indexes, element, isNavigationLandmark);
}

/**
 * @param {Snapshot} snapshot
 * @param {SnapshotElement} element
 * @returns {SnapshotElement[]}
 */
export function getScopedElements(snapshot, element) {
  const sk = scopeKey(element);
  return snapshot.elements.filter((candidate) => scopeKey(candidate) === sk);
}
