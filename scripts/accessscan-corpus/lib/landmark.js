const LANDMARK_TAGS = new Set([
  'main',
  'nav',
  'header',
  'footer',
  'aside',
  'section',
  'form',
  'search',
]);

const LANDMARK_ROLES = new Set([
  'main',
  'navigation',
  'banner',
  'contentinfo',
  'complementary',
  'search',
  'form',
  'region',
]);

/**
 * @param {Record<string, unknown>} element
 * @param {Record<string, string>} attributes
 * @returns {string | null}
 */
function buildLandmarkLabel(element, attributes) {
  const tag = String(element.tag || '').toLowerCase();
  const role = attributes.role || null;
  const ariaLabel = attributes['aria-label'] || null;

  const isLandmark = LANDMARK_TAGS.has(tag)
    || (role && LANDMARK_ROLES.has(role));

  if (!isLandmark) return null;

  if (ariaLabel) {
    const slug = String(ariaLabel)
      .trim()
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9_-]/g, '')
      .slice(0, 48);
    return slug ? `${tag}[${slug}]` : tag;
  }

  return tag;
}

/**
 * @param {Record<string, unknown>[]} elements
 * @param {Record<string, unknown>} element
 * @returns {string[]}
 */
export function buildLandmarkPath(elements, element) {
  /** @type {string[]} */
  const path = [];
  const byId = new Map(elements.map((entry) => [entry.id, entry]));
  let current = element;

  while (current && current.parentId != null) {
    const parent = byId.get(current.parentId);
    if (!parent) break;
    const attributes = /** @type {Record<string, string>} */ (parent.attributes || {});
    const label = buildLandmarkLabel(parent, attributes);
    if (label) path.unshift(label);
    current = parent;
  }

  return path;
}

/**
 * @param {Record<string, unknown>[]} elements
 * @param {Record<string, unknown>} element
 * @param {string[]} landmarkPath
 * @returns {number}
 */
export function computeOrdinal(elements, element, landmarkPath) {
  const siblings = elements.filter((candidate) => {
    if (candidate.parentId !== element.parentId) return false;
    if (candidate.tag !== element.tag) return false;
    return JSON.stringify(buildLandmarkPath(elements, candidate)) === JSON.stringify(landmarkPath);
  }).sort((left, right) => Number(left.id) - Number(right.id));

  const index = siblings.findIndex((candidate) => candidate.id === element.id);
  return index < 0 ? 0 : index;
}

/**
 * @param {Record<string, unknown>[]} elements
 * @param {Record<string, unknown>} element
 * @returns {Record<string, unknown>}
 */
export function buildSemanticFromSnapshotElement(elements, element) {
  const attributes = /** @type {Record<string, string>} */ (element.attributes || {});
  const landmarkPath = buildLandmarkPath(elements, element);
  const role = attributes.role || null;
  const ordinal = computeOrdinal(elements, element, landmarkPath);

  return {
    tag: String(element.tag || 'unknown'),
    role: role || null,
    attributes: Object.fromEntries(
      Object.entries(attributes)
        .filter(([name]) => !['id', 'class', 'style'].includes(name.toLowerCase())
          && !name.toLowerCase().startsWith('data-')
          && !name.toLowerCase().startsWith('on')),
    ),
    landmarkPath,
    ordinal,
    framePath: Array.isArray(element.framePath) ? [...element.framePath] : [],
    shadowPath: Array.isArray(element.shadowPath) ? [...element.shadowPath] : [],
  };
}
