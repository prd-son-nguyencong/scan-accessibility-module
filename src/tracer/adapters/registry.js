/**
 * Source adapter contract (one per framework):
 *   id        stable framework id
 *   detect(root) -> boolean
 *   index(root)  -> [{ file, line, tagName }] every element the adapter can locate, project-relative
 *   locate(el)   -> { confidence, candidates: [{ file, line, ... }], reason }  (the traceElement result shape)
 *   supports  -> { local, preview } which scan modes it can trace
 */
const registry = new Map();

export function registerAdapter(adapter) {
  const ok = adapter && typeof adapter.id === 'string' && adapter.id
    && typeof adapter.detect === 'function' && typeof adapter.index === 'function' && typeof adapter.locate === 'function'
    && typeof adapter.supports?.local === 'boolean' && typeof adapter.supports?.preview === 'boolean';
  if (!ok) throw new TypeError('adapter must be { id, detect(root), index(root), locate(el), supports: { local, preview } }');
  registry.set(adapter.id, adapter);
  return adapter;
}

export const getAdapter = (id) => registry.get(id) || null;
export const listAdapters = () => [...registry.values()];
