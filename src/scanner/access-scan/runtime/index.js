export { REQUIRES_ISOLATED_STATE } from './constants.js';
export { createScanSession, installRuntimeHooks } from './session.js';
export { activateDynamicContent } from './page-activation.js';
export { queryGraph, parseGraphSelector, validateGraphSelector, splitSelectorList } from './graph-query.js';
export { filterByEligibility } from './eligibility.js';
export {
  buildSnapshotIndexes,
  getAncestors,
  getDescendants,
  getScopedElements,
  hasAncestor,
  hasNavigationAncestor,
  resolveIdRefs,
  resolveScopedDomId,
  sameScope,
  scopeKey,
  splitIdRefList,
} from './graph-relationships.js';
