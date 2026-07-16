import { getDescendants, hasAncestor } from '../runtime/graph-relationships.js';
import {
  elementFinding,
  getIndexes,
  getSemanticSubtreeText,
  getSnapshot,
  queryCandidates,
} from './lib/runtime-context.js';

const TABLE_ROLES = new Set(['table', 'grid']);
const ROW_ROLES = new Set(['row', 'rowgroup']);
const CELL_ROLES = new Set(['cell', 'gridcell', 'columnheader', 'rowheader']);

/** @type {import('../engine/loader.js').EvaluatorModule} */
export default {
  id: 'table-graph',
  async evaluate(context, check) {
    const snapshot = getSnapshot(context);
    const indexes = getIndexes(context);
    const mode = /** @type {string} */ (check.options?.mode);
    const candidates = queryCandidates(context, check);
    /** @type {import('../engine/loader.js').EvaluatorResult['findings']} */
    const findings = [];

    if (mode === 'table-headers') {
      for (const element of candidates) {
        if (isPresentationTable(element)) continue;
        if (hasColumnHeaders(snapshot, indexes, element)) continue;
        const rows = getTableRows(snapshot, indexes, element);
        if (rows.length <= 1) continue;
        findings.push(elementFinding(element));
      }
      return { status: 'complete', candidatesScanned: candidates.length, findings };
    }

    if (mode === 'table-nesting') {
      for (const element of candidates) {
        if (!hasAncestor(snapshot, indexes, element, (ancestor) => (
          ancestor.tag === 'table' || TABLE_ROLES.has(ancestor.attributes.role || '')
        ))) continue;
        findings.push(elementFinding(element));
      }
      return { status: 'complete', candidatesScanned: candidates.length, findings };
    }

    if (mode === 'table-roles') {
      for (const element of candidates) {
        const role = element.attributes.role;
        if (!TABLE_ROLES.has(role || '')) continue;
        const rows = getDescendants(snapshot, indexes, element, (child) => (
          ROW_ROLES.has(child.attributes.role || '')
        ));
        const cells = getDescendants(snapshot, indexes, element, (child) => (
          CELL_ROLES.has(child.attributes.role || '')
        ));
        if (rows.length === 0 || cells.length === 0) {
          findings.push(elementFinding(element, { issue: 'missing-row-or-cell-roles' }));
        }
      }
      return { status: 'complete', candidatesScanned: candidates.length, findings };
    }

    if (mode === 'table-caption') {
      for (const element of candidates) {
        if (isPresentationTable(element)) continue;
        if (!hasColumnHeaders(snapshot, indexes, element)) continue;
        const caption = getDescendants(snapshot, indexes, element, (child) => child.tag === 'caption');
        const hasName = element.attributes['aria-label'] || element.attributes['aria-labelledby'];
        if (caption.length > 0 || hasName) continue;
        findings.push(elementFinding(element));
      }
      return { status: 'complete', candidatesScanned: candidates.length, findings };
    }

    if (mode === 'table-header-empty') {
      for (const element of candidates) {
        const text = getSemanticSubtreeText(snapshot, indexes, element).trim();
        const hasImgAlt = getDescendants(snapshot, indexes, element, (child) => (
          child.tag === 'img' && child.attributes.alt
        )).length > 0;
        if (text || hasImgAlt || element.attributes['aria-label']?.trim()) continue;
        findings.push(elementFinding(element));
      }
      return { status: 'complete', candidatesScanned: candidates.length, findings };
    }

    if (mode === 'table-misuse') {
      for (const element of candidates) {
        if (element.tag !== 'table') continue;
        if (isPresentationTable(element)) continue;
        const ths = getDescendants(snapshot, indexes, element, (child) => child.tag === 'th');
        const caption = getDescendants(snapshot, indexes, element, (child) => child.tag === 'caption');
        if (ths.length > 0 || caption.length > 0) continue;
        const rows = getTableRows(snapshot, indexes, element);
        const maxCols = Math.max(
          0,
          ...rows.map((row) => getDescendants(snapshot, indexes, row, (child) => (
            child.tag === 'td' || child.tag === 'th'
          )).length),
        );
        const isSingleColumn = maxCols <= 1;
        if (rows.length <= 1 || isSingleColumn) {
          findings.push(elementFinding(element));
        }
      }
      return { status: 'complete', candidatesScanned: candidates.length, findings };
    }

    if (mode === 'table-row-header-mismatch') {
      for (const element of candidates) {
        if (element.tag !== 'th' || element.attributes.scope) continue;
        const rowParent = element.parentId != null ? indexes.byElementId.get(element.parentId) : null;
        if (!rowParent || rowParent.tag !== 'tr') continue;
        const rowCells = getDescendants(snapshot, indexes, rowParent, (child) => (
          child.tag === 'th' || child.tag === 'td'
        ));
        if (rowCells[0]?.id !== element.id) continue;
        const table = findAncestorTable(snapshot, indexes, element);
        if (!table || !hasColumnHeaders(snapshot, indexes, table)) continue;
        findings.push(elementFinding(element));
      }
      return { status: 'complete', candidatesScanned: candidates.length, findings };
    }

    throw Object.assign(new Error(`unsupported table-graph mode "${mode}"`), {
      errorCode: 'evaluator_failure',
    });
  },
};

/**
 * @param {import('../runtime/types.js').SnapshotElement} element
 */
function isPresentationTable(element) {
  const role = element.attributes.role;
  return role === 'presentation' || role === 'none';
}

/**
 * @param {import('../runtime/types.js').Snapshot} snapshot
 * @param {ReturnType<import('../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 * @param {import('../runtime/types.js').SnapshotElement} table
 */
function getTableRows(snapshot, indexes, table) {
  const theadRows = getDescendants(snapshot, indexes, table, (child) => (
    child.tag === 'tr' && hasAncestor(snapshot, indexes, child, (ancestor) => ancestor.tag === 'thead')
  ));
  const bodyRows = getDescendants(snapshot, indexes, table, (child) => (
    child.tag === 'tr' && !hasAncestor(snapshot, indexes, child, (ancestor) => ancestor.tag === 'thead')
  ));
  return [...theadRows, ...bodyRows];
}

/**
 * @param {import('../runtime/types.js').Snapshot} snapshot
 * @param {ReturnType<import('../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 * @param {import('../runtime/types.js').SnapshotElement} table
 */
function hasColumnHeaders(snapshot, indexes, table) {
  const theadHeaders = getDescendants(snapshot, indexes, table, (child) => (
    child.tag === 'th' && hasAncestor(snapshot, indexes, child, (ancestor) => ancestor.tag === 'thead')
  ));
  if (theadHeaders.length > 0) return true;

  const firstRow = getTableRows(snapshot, indexes, table)[0];
  if (!firstRow) return false;
  return getDescendants(snapshot, indexes, firstRow, (child) => child.tag === 'th').length > 0;
}

/**
 * @param {import('../runtime/types.js').Snapshot} snapshot
 * @param {ReturnType<import('../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 * @param {import('../runtime/types.js').SnapshotElement} element
 */
function findAncestorTable(snapshot, indexes, element) {
  return getAncestorsTable(snapshot, indexes, element);
}

/**
 * @param {import('../runtime/types.js').Snapshot} snapshot
 * @param {ReturnType<import('../runtime/graph-relationships.js').buildSnapshotIndexes>} indexes
 * @param {import('../runtime/types.js').SnapshotElement} element
 */
function getAncestorsTable(snapshot, indexes, element) {
  let parentId = element.parentId;
  while (parentId != null) {
    const parent = indexes.byElementId.get(parentId);
    if (!parent) break;
    if (parent.tag === 'table' || TABLE_ROLES.has(parent.attributes.role || '')) return parent;
    parentId = parent.parentId;
  }
  return null;
}
