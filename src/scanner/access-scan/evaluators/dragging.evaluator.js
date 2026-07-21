import { getDescendants, getAncestors } from '../runtime/graph-relationships.js';
import {
  elementFinding,
  getIndexes,
  getSnapshot,
  queryCandidates,
} from './lib/runtime-context.js';

const DIRECTIONAL_LABELS = [
  'increase', 'decrease', 'increment', 'decrement', 'up', 'down', 'left', 'right',
  'next', 'previous', 'plus', 'minus', 'more', 'less',
];

/** @type {import('../engine/loader.js').EvaluatorModule} */
export default {
  id: 'dragging',
  async evaluate(context, check) {
    const snapshot = getSnapshot(context);
    const indexes = getIndexes(context);
    const mode = /** @type {string} */ (check.options?.mode);
    const candidates = queryCandidates(context, check);
    /** @type {import('../engine/loader.js').EvaluatorResult['findings']} */
    const findings = [];

    if (mode === 'dragging-alternative') {
      for (const element of candidates) {
        if (element.tag === 'input' && element.attributes.type === 'range') continue;
        if (hasDirectionalAlternative(snapshot, indexes, element)) continue;
        findings.push(elementFinding(element));
      }
      return { status: 'complete', candidatesScanned: candidates.length, findings };
    }

    throw Object.assign(new Error(`unsupported dragging mode "${mode}"`), {
      errorCode: 'evaluator_failure',
    });
  },
};

/**
 * @param {import('../runtime/types.js').Snapshot} snapshot
 * @param {ReturnType<import('../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 * @param {import('../runtime/types.js').SnapshotElement} element
 */
function hasDirectionalAlternative(snapshot, indexes, element) {
  const container = findAssociationContainer(snapshot, indexes, element);
  const controls = getDescendants(snapshot, indexes, container, (child) => (
    child.tag === 'button'
    || (child.tag === 'input' && ['button', 'submit'].includes(child.attributes.type || 'button'))
    || child.attributes.role === 'button'
  ));

  const directional = controls.filter((control) => isDirectionalControl(control, element));
  return directional.length >= 2;
}

/**
 * @param {import('../runtime/types.js').Snapshot} snapshot
 * @param {ReturnType<import('../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 * @param {import('../runtime/types.js').SnapshotElement} element
 */
function findAssociationContainer(snapshot, indexes, element) {
  const targetId = element.attributes.id || '';
  if (targetId) {
    const controller = snapshot.elements.find((candidate) => {
      const controls = candidate.attributes['aria-controls'] || '';
      return controls.split(/\s+/).includes(targetId);
    });
    if (controller) {
      return getAncestors(snapshot, indexes, controller)[0] || controller;
    }
  }

  const ancestors = [element, ...getAncestors(snapshot, indexes, element)];
  return ancestors.find((ancestor) => (
    ancestor.tag === 'section'
    || ancestor.tag === 'div'
    || ancestor.tag === 'fieldset'
    || ancestor.attributes.role === 'group'
  )) || element;
}

/**
 * @param {import('../runtime/types.js').SnapshotElement} control
 * @param {import('../runtime/types.js').SnapshotElement} target
 */
function isDirectionalControl(control, target) {
  const label = [
    control.attributes['aria-label'],
    control.text,
    control.accessibleName,
    control.attributes.value,
  ].filter(Boolean).join(' ').toLowerCase();

  if (!label.trim()) return false;
  if (DIRECTIONAL_LABELS.some((token) => label.includes(token))) return true;
  if (/[+\-↑↓←→]/.test(label)) return true;

  const controls = control.attributes['aria-controls'] || '';
  const targetId = target.attributes.id || '';
  return Boolean(targetId && controls.split(/\s+/).includes(targetId));
}
