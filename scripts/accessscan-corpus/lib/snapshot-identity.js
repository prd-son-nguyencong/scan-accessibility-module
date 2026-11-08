import { canonicalSha256 } from '../../../src/reporter/fingerprint.js';
import { normalizeHtml } from '../../../src/reporter/fingerprint.js';
import { isGeneratedIdRef } from '../../../src/scanner/access-scan/corpus/semantic-fingerprint.js';

const VOLATILE_SELECTOR_ID_PATTERN = /#[a-z0-9_-]*[a-f0-9]{6,}[a-z0-9_-]*/gi;
const TIMESTAMP_PATTERN = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/g;

/**
 * @param {string} selector
 * @returns {string}
 */
export function normalizeIdentitySelector(selector = '') {
  return String(selector)
    .replace(VOLATILE_SELECTOR_ID_PATTERN, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * @param {string} html
 * @returns {string}
 */
export function normalizeIdentityHtml(html = '') {
  return normalizeHtml(String(html))
    .replace(/\sid=["'][^"']+["']/gi, '')
    .replace(/\sclass=["'][^"']+["']/gi, '')
    .replace(TIMESTAMP_PATTERN, '[timestamp]');
}

/**
 * @param {{ x?: number, y?: number, width?: number, height?: number }} rect
 * @returns {{ x: number, y: number, width: number, height: number }}
 */
function roundRect(rect = {}) {
  const round = (value) => Math.round(Number(value || 0) * 100) / 100;
  return {
    x: round(rect.x),
    y: round(rect.y),
    width: round(rect.width),
    height: round(rect.height),
  };
}

/**
 * @param {Record<string, string>} attributes
 * @returns {Record<string, string>}
 */
function normalizeIdentityAttributes(attributes = {}) {
  /** @type {Record<string, string>} */
  const output = {};
  for (const [name, value] of Object.entries(attributes)) {
    const lower = name.toLowerCase();
    if (['id', 'class', 'style', 'data-testid', 'data-test', 'data-cy'].includes(lower)) {
      continue;
    }
    if (lower === 'href' || lower === 'src') {
      output[lower] = String(value)
        .replace(/^https?:\/\/[^/]+/i, '')
        .replace(/^\/\/[^/]+/i, '');
      continue;
    }
    if (isGeneratedIdRef(value)) {
      output[lower] = '[generated-ref]';
      continue;
    }
    output[lower] = String(value).replace(TIMESTAMP_PATTERN, '[timestamp]');
  }
  return Object.fromEntries(Object.entries(output).sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * @param {Record<string, unknown>} snapshot
 * @returns {string}
 */
export function buildSnapshotIdentity(snapshot = {}) {
  const elements = Array.isArray(snapshot.elements) ? snapshot.elements : [];
  const identityElements = elements.map((element) => ({
    tag: element.tag,
    selector: normalizeIdentitySelector(element.selector),
    reportSelector: normalizeIdentitySelector(element.reportSelector),
    framePath: Array.isArray(element.framePath) ? [...element.framePath] : [],
    shadowPath: Array.isArray(element.shadowPath) ? [...element.shadowPath] : [],
    accessibleName: String(element.accessibleName || '').trim(),
    structure: normalizeIdentityHtml(element.outerHTML),
    attributes: normalizeIdentityAttributes(
      /** @type {Record<string, string>} */ (element.attributes || {}),
    ),
    rect: roundRect(/** @type {Record<string, number>} */ (element.rect || {})),
    rendered: Boolean(element.rendered),
    visuallyVisible: Boolean(element.visuallyVisible),
    hiddenFromAT: Boolean(element.hiddenFromAT),
    focusable: Boolean(element.focusable),
  })).sort((left, right) => (
    `${left.reportSelector}|${left.tag}`.localeCompare(`${right.reportSelector}|${right.tag}`)
  ));

  const diagnostics = (Array.isArray(snapshot.diagnostics) ? snapshot.diagnostics : [])
    .map((entry) => ({
      code: entry.code,
      inspected: Boolean(entry.inspected),
      reason: entry.reason || null,
    }))
    .sort((left, right) => `${left.code}|${left.reason}`.localeCompare(`${right.code}|${right.reason}`));

  const counts = snapshot.counts && typeof snapshot.counts === 'object'
    ? {
      frameCount: Number(snapshot.counts.frameCount || 0),
      shadowRootCount: Number(snapshot.counts.shadowRootCount || 0),
      closedShadowCount: Number(snapshot.counts.closedShadowCount || 0),
    }
    : { frameCount: 0, shadowRootCount: 0, closedShadowCount: 0 };

  return canonicalSha256({
    kind: 'snapshot-identity',
    counts,
    diagnostics,
    elements: identityElements,
  });
}

/**
 * @param {Record<string, unknown>} left
 * @param {Record<string, unknown>} right
 * @returns {boolean}
 */
export function snapshotsSemanticallyEqual(left, right) {
  return buildSnapshotIdentity(left) === buildSnapshotIdentity(right);
}
