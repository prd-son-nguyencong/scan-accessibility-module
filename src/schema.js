import { randomUUID } from 'crypto';

export {
  ACCESSSCAN_CATEGORIES,
  getAccessScanCategory,
  getAccessScanRuleMetadata,
  getAccessScanRuleRequirement,
  listAccessScanCatalogRuleIds,
} from './scanner/access-scan/engine/public-catalog.js';

/**
 * Creates a Violation object conforming to the shared schema.
 * All scanner layers produce this shape — consumed by reporter and fixer.
 */
export function createViolation({
  ruleId,
  layer,
  category = 'accessibility',
  wcagRef = null,
  impact = 'moderate',
  priority = 3,
  element = {},
  source = {},
  fix = {},
}) {
  return {
    id: randomUUID(),
    ruleId,
    layer,
    category,
    wcagRef,
    impact,
    priority,
    count: 1,
    foundAt: new Date().toISOString(),
    related: [],
    element: {
      outerHTML: element.outerHTML || '',
      selector: element.selector || '',
      scanId: element.scanId || null,
    },
    source: {
      mode: source.mode || 'local',
      file: source.file || null,
      line: source.line || null,
      snippet: source.snippet || null,
      url: source.url || null,
      confidence: source.confidence || null,
      method: source.method || null,
      preimageSha256: source.preimageSha256 || null,
      preimageRange: source.preimageRange || null,
      partial: source.partial || null,
      page: source.page || null,
      routeDependencies: Array.isArray(source.routeDependencies)
        ? [...source.routeDependencies]
        : [],
    },
    fix: {
      deterministic: fix.deterministic ?? false,
      hint: fix.hint || '',
      patch: fix.patch || null,
    },
  };
}

/**
 * Impact severity ordering (highest to lowest).
 */
export const IMPACT_ORDER = ['critical', 'serious', 'moderate', 'minor'];

/**
 * Maps impact string to a default priority number.
 */
export function impactToPriority(impact) {
  const map = { critical: 1, serious: 2, moderate: 3, minor: 4 };
  return map[impact] || 3;
}

/**
 * Sorts violations by priority (ascending), then impact severity.
 */
export function sortViolations(violations) {
  return [...violations].sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return IMPACT_ORDER.indexOf(a.impact) - IMPACT_ORDER.indexOf(b.impact);
  });
}

/**
 * Groups violations by a key function.
 */
export function groupViolations(violations, keyFn) {
  const groups = new Map();
  for (const v of violations) {
    const key = keyFn(v);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(v);
  }
  return groups;
}

// ─── Normalizers for legacy scanner outputs ───────────────────────────────────
// Bridge existing axe / w3c / lighthouse / behavioral layer shapes to Violation[].

/**
 * Normalizes a single axe-core violation node into a Violation.
 * @param {object} axeViolation  - outer axe violation (has .id, .description, .impact, .tags)
 * @param {object} node          - per-node (has .html, .target, .source)
 * @param {string} sourceMode    - "local" | "url"
 */
export function normalizeAxeViolation(axeViolation, node, sourceMode = 'local') {
  const wcagTags = (axeViolation.tags || []).filter((t) => t.startsWith('wcag'));
  const wcagRef = wcagTags.length > 0 ? wcagTags.join(', ') : null;
  const selector = Array.isArray(node.target) ? node.target.join(' ') : String(node.target || '');
  return createViolation({
    ruleId: axeViolation.id,
    layer: 'axe',
    category: 'accessibility',
    wcagRef,
    impact: axeViolation.impact || 'moderate',
    priority: impactToPriority(axeViolation.impact),
    element: { outerHTML: node.html || '', selector, scanId: null },
    source: {
      mode: sourceMode,
      file: node.source?.file || null,
      line: node.source?.line || null,
      snippet: node.source?.snippetId || null,
      url: node.source?.url || null,
    },
    fix: { deterministic: false, hint: axeViolation.description || '', patch: null },
  });
}

/**
 * Normalizes a W3C violation into a Violation.
 */
export function normalizeW3cViolation(v, sourceMode = 'local', pageSource = {}) {
  const impact = v.type === 'error' ? 'serious' : 'minor';
  return createViolation({
    ruleId: v.rule || 'w3c-html-error',
    layer: 'w3c',
    category: 'markup',
    wcagRef: v.wcagCriteria ? `WCAG ${v.wcagCriteria}` : 'WCAG 4.1.1',
    impact,
    priority: impact === 'serious' ? 2 : 4,
    element: { outerHTML: v.html || v.element?.extract || '', selector: '', scanId: null },
    source: {
      mode: sourceMode,
      file: pageSource.file || null,
      line: v.element?.line || v.line || null,
      snippet: null,
      url: sourceMode === 'url' ? pageSource.url || null : null,
      confidence: v.source?.confidence || pageSource.confidence || (pageSource.file ? 'low' : 'none'),
      method: v.source?.method || pageSource.method || (pageSource.file ? 'legacy-source-attribution' : 'unresolved'),
      preimageSha256: v.source?.preimageSha256 || pageSource.preimageSha256 || null,
      preimageRange: v.source?.preimageRange || pageSource.preimageRange || null,
    },
    fix: { deterministic: false, hint: v.description || '', patch: null },
  });
}

/**
 * Normalizes a Lighthouse violation into a Violation.
 * Enriches fix.hint with resource-level details (file names, byte savings)
 * when audit details are available.
 */
export function normalizeLighthouseViolation(v, sourceMode = 'local', pageSource = {}) {
  let hint = v.description || v.title || '';
  if (v.details && Array.isArray(v.details) && v.details.length > 0) {
    const items = v.details.slice(0, 5).map((d) => {
      const parts = [];
      if (d.url) parts.push(d.url.split('/').pop().split('?')[0] || d.url.slice(-60));
      if (d.wastedBytes) parts.push(`save ${Math.round(d.wastedBytes / 1024)} KiB`);
      if (d.wastedMs) parts.push(`save ${Math.round(d.wastedMs)} ms`);
      return parts.join(' — ');
    }).filter(Boolean);
    if (items.length) hint += '\n  Resources: ' + items.join('; ');
  }
  const violation = createViolation({
    ruleId: v.rule || v.id || 'lighthouse',
    layer: 'lighthouse',
    category: v.category || 'performance',
    wcagRef: v.wcagCriteria && v.wcagCriteria !== 'perf' ? `WCAG ${v.wcagCriteria}` : null,
    impact: v.impact || 'moderate',
    priority: impactToPriority(v.impact),
    element: { outerHTML: v.snippet || '', selector: v.selector || '', scanId: null },
    source: {
      mode: sourceMode,
      file: pageSource.file || null,
      line: null,
      snippet: null,
      url: sourceMode === 'url' ? pageSource.url || null : null,
      confidence: pageSource.confidence || (pageSource.file ? 'low' : 'none'),
      method: pageSource.method || (pageSource.file ? 'legacy-source-attribution' : 'unresolved'),
      preimageSha256: pageSource.preimageSha256 || null,
      preimageRange: pageSource.preimageRange || null,
    },
    fix: { deterministic: false, hint, patch: null },
  });
  if (v.evidence) violation.evidence = v.evidence;
  return violation;
}

/**
 * Normalizes a behavioral layer violation (keyboard, focusTrap, ariaLive, etc.).
 */
export function normalizeBehavioralViolation(v, layer, sourceMode = 'local', pageSource = {}) {
  return createViolation({
    ruleId: v.rule || v.id || layer,
    layer,
    category: 'accessibility',
    wcagRef: v.wcagCriteria ? `WCAG ${v.wcagCriteria}` : null,
    impact: v.impact || 'moderate',
    priority: impactToPriority(v.impact),
    element: { outerHTML: v.html || v.element?.outerHTML || '', selector: v.selector || '', scanId: null },
    source: {
      mode: sourceMode,
      file: v.source?.file || pageSource.file || null,
      line: v.source?.line || null,
      snippet: null,
      url: sourceMode === 'url' ? pageSource.url || null : null,
      confidence: v.source?.confidence || pageSource.confidence || ((v.source?.file || pageSource.file) ? 'low' : 'none'),
      method: v.source?.method || pageSource.method || ((v.source?.file || pageSource.file) ? 'legacy-source-attribution' : 'unresolved'),
      preimageSha256: v.source?.preimageSha256 || pageSource.preimageSha256 || null,
      preimageRange: v.source?.preimageRange || pageSource.preimageRange || null,
    },
    fix: { deterministic: false, hint: v.description || v.message || '', patch: null },
  });
}
