import { createHash } from 'node:crypto';

export const SCAN_REPORT_SCHEMA_VERSION = '2.0.0';

export function normalizeWhitespace(value = '') {
  return String(value).replace(/\s+/g, ' ').trim();
}

export function normalizeSelector(selector = '') {
  const value = Array.isArray(selector) ? selector.join(' ') : String(selector);
  return normalizeWhitespace(value)
    .replace(/\s*([>+~])\s*/g, '$1')
    .replace(/\s*,\s*/g, ',');
}

export function normalizeHtml(html = '') {
  return normalizeWhitespace(html).replace(/>\s+</g, '><');
}

export function normalizeSourcePath(file = '') {
  if (file == null) return '';
  return String(file)
    .replace(/\\/g, '/')
    .replace(/^(?:\.\/)+/, '')
    .replace(/\/+/g, '/');
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  const output = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] !== undefined) output[key] = canonicalize(value[key]);
  }
  return output;
}

export function canonicalStringify(value) {
  return JSON.stringify(canonicalize(value));
}

export function canonicalSha256(value) {
  return `sha256:${createHash('sha256').update(canonicalStringify(value)).digest('hex')}`;
}

export function normalizeInstrumentationManifest(manifest = {}) {
  return Object.fromEntries(
    Object.entries(manifest)
      .map(([distFile, sourceFile]) => [
        normalizeSourcePath(distFile),
        normalizeSourcePath(sourceFile),
      ])
      .sort(([a], [b]) => a.localeCompare(b))
  );
}

/** With `sourceHashes` (build-time sha256 per source file) the digest commits to content, not just names. */
export function instrumentationManifestDigest(manifest = {}, sourceHashes = null) {
  const normalized = normalizeInstrumentationManifest(manifest);
  const hasHashes = sourceHashes && typeof sourceHashes === 'object' && Object.keys(sourceHashes).length > 0;
  return canonicalSha256(hasHashes ? { manifest: normalized, sources: sourceHashes } : normalized);
}

export function normalizedHtmlSha256(html = '') {
  return canonicalSha256(normalizeHtml(html));
}

function locatorPaths(element) {
  return {
    ...(Array.isArray(element.framePath) && element.framePath.length > 0
      ? { framePath: [...element.framePath] }
      : {}),
    ...(Array.isArray(element.shadowPath) && element.shadowPath.length > 0
      ? { shadowPath: [...element.shadowPath] }
      : {}),
  };
}

export function stableFindingFingerprint(finding = {}) {
  const source = finding.source || {};
  const element = finding.element || {};
  const sourceFile = normalizeSourcePath(source.file);
  const sourceLine = Number.isInteger(source.line) && source.line > 0 ? source.line : null;
  const selector = normalizeSelector(element.selector);
  // The selector stays in the source locator: distinct elements can share one file, line and preimage.
  const sourceLocator = sourceFile && sourceLine && source.preimageSha256
    ? {
        kind: 'source',
        file: sourceFile,
        line: sourceLine,
        preimageSha256: source.preimageSha256,
        selector,
        ...locatorPaths(element),
      }
    : null;
  const domLocator = {
    kind: 'dom',
    selector,
    normalizedHtmlHash: element.normalizedHtmlHash
      || normalizedHtmlSha256(element.outerHTML || element.html || ''),
    sourceFile: sourceFile || null,
    sourceLine,
    ...locatorPaths(element),
  };

  return canonicalSha256({
    schemaVersion: finding.schemaVersion || SCAN_REPORT_SCHEMA_VERSION,
    pageState: finding.pageState || 'initial',
    route: finding.route || '/',
    canonicalRuleId: finding.canonicalRuleId || finding.nativeRuleId || finding.ruleId,
    locator: sourceLocator || domLocator,
  });
}

/** Bump when stableId inputs change: baselines saved under another version cannot be compared exactly. */
export const STABLE_ID_VERSION = 2;

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const mixedHex = (s) => /^[0-9a-f]+$/i.test(s) && /\d/.test(s) && /[a-f]/i.test(s);

// Generated ids, known patterns only: a UUID, Element UI's el-<widget>-N, a 10+ digit timestamp suffix (ours1793041973008).
// Other digit runs (job-1001, tab-100, id-1, section-12) name different elements and stay.
function stableIdToken(value) {
  return value.replace(UUID, '{uuid}').replace(/^(el-[a-z][a-z-]*-)\d+$/i, '$1#').replace(/^(.*[A-Za-z_-])\d{10,}$/, '$1#');
}

// Generated classes (null = drop): bare 6-8 char hashes (ae8f46), css-in-js (css-1a2b3c) and a trailing -hash. col-6, grid-cols-3, h1 stay.
function stableClassToken(value) {
  if (/^[0-9a-f]{6,8}$/i.test(value) && mixedHex(value)) return null;
  if (/^(?:css|sc|jsx|emotion|svelte)-[a-z0-9]{5,}$/i.test(value)) return null;
  const m = value.match(/^(.*[a-z])[-_]([0-9a-f]{6,8})$/i);
  return m && mixedHex(m[2]) ? m[1] : value;
}

const ID_ATTRS = /^(?:id|for|aria-(?:describedby|controls|labelledby|owns|activedescendant))$/i;
const VOLATILE_POSITION_TAGS = '(?:script|link|meta|style|noscript)';

/**
 * Selector with run-specific parts removed: generated ids and classes, volatile attributes, and the
 * :nth-child / :nth-of-type positions of head elements and of script/link/meta/style/noscript.
 * `positionless` tells the caller the position went, so the element's own markup must tell siblings apart.
 */
export function stableSelector(selector = '') {
  let out = normalizeSelector(selector).replace(
    /\[([^\]]*)\]|#([\w-]+)|\.(-?[_a-zA-Z][\w-]*)/g,
    (all, attr, id, cls) => {
      if (id) return `#${stableIdToken(id)}`;
      if (cls) { const c = stableClassToken(cls); return c === null ? '' : `.${c}`; }
      const m = attr.match(/^([\w:-]+)\s*(?:[~|^$*]?=)\s*(?:"([^"]*)"|'([^']*)'|(.*))$/);
      const name = m ? m[1] : attr;
      if (/^(?:style|nonce)$/i.test(name) || /^data-v-/i.test(name)) return '';
      if (m && ID_ATTRS.test(name)) return `[${name}="${stableIdToken(m[2] ?? m[3] ?? m[4])}"]`;
      return all;
    },
  );
  const before = out;
  const nth = ':nth-(?:child|of-type)\\(\\d+\\)';
  out = /^html>head/.test(out)
    ? out.replace(new RegExp(nth, 'g'), '')
    : out.replace(new RegExp(`(^|[>,\\s])(${VOLATILE_POSITION_TAGS})(?:${nth})+(?=$|[>,\\s:.#\\[])`, 'g'), '$1$2');
  return { selector: out, positionless: out !== before };
}

/** Markup with the same run-specific parts removed (volatile attributes, generated ids and classes, URL queries). */
export function stableHtml(html = '') {
  return normalizeHtml(html)
    .replace(/\s(?:style|nonce)="[^"]*"/gi, '')
    .replace(/\sdata-v-[\w-]+(?:="[^"]*")?/gi, '')
    .replace(/\s(id|for|aria-[\w-]+)="([^"]*)"/gi, (_, n, v) => ` ${n}="${ID_ATTRS.test(n) ? stableIdToken(v) : v}"`)
    .replace(/\sclass="([^"]*)"/gi, (_, v) => {
      const kept = v.split(/\s+/).filter(Boolean).map((c) => stableClassToken(c)).filter((c) => c !== null);
      return kept.length ? ` class="${kept.join(' ')}"` : '';
    })
    .replace(/\s(src|href)="([^"?#]*)[?#][^"]*"/gi, ' $1="$2"');
}

/**
 * Identity of "the same issue" across runs: rule + route (query kept) + the element locator.
 * Excludes volatile fields (source line, preimage, HTML text, schema version, finding order) so
 * edits above the element or a new tool version do not change it. The selector and markup are
 * normalised first (see stableSelector / stableHtml) so generated ids, hashed classes and shifting
 * head/script positions do not change it. Falls back to the markup hash, and the source file and
 * line, only when the element has no selector.
 */
export function findingStableId(finding = {}) {
  const element = finding.element || {};
  const { selector, positionless } = stableSelector(element.selector);
  const source = finding.source || {};
  const html = element.outerHTML || element.html || '';
  const fallback = !selector ? {
    normalizedHtmlHash: html ? canonicalSha256(stableHtml(html)) : element.normalizedHtmlHash,
    sourceFile: normalizeSourcePath(source.file) || null,
    sourceLine: source.line || null,
  } : positionless && html ? { htmlHash: canonicalSha256(stableHtml(html)) } : {};
  const paths = locatorPaths(element);
  return canonicalSha256({
    stable: STABLE_ID_VERSION,
    pageState: finding.pageState || 'initial',
    route: finding.route || '/',
    canonicalRuleId: finding.canonicalRuleId || finding.nativeRuleId || finding.ruleId,
    selector,
    ...(paths.framePath ? { framePath: paths.framePath.map((p) => stableSelector(p).selector) } : {}),
    ...(paths.shadowPath ? { shadowPath: paths.shadowPath.map((p) => stableSelector(p).selector) } : {}),
    ...fallback,
  });
}
