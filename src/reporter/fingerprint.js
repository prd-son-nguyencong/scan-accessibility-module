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

export function instrumentationManifestDigest(manifest = {}) {
  return canonicalSha256(normalizeInstrumentationManifest(manifest));
}

export function normalizedHtmlSha256(html = '') {
  return canonicalSha256(normalizeHtml(html));
}

export function stableFindingFingerprint(finding = {}) {
  const source = finding.source || {};
  const element = finding.element || {};
  const sourceFile = normalizeSourcePath(source.file);
  const sourceLine = Number.isInteger(source.line) && source.line > 0 ? source.line : null;
  const sourceLocator = sourceFile && sourceLine && source.preimageSha256
    ? {
        kind: 'source',
        file: sourceFile,
        line: sourceLine,
        preimageSha256: source.preimageSha256,
      }
    : null;
  const domLocator = {
    kind: 'dom',
    selector: normalizeSelector(element.selector),
    normalizedHtmlHash: element.normalizedHtmlHash
      || normalizedHtmlSha256(element.outerHTML || element.html || ''),
    sourceFile: sourceFile || null,
    sourceLine,
    ...(Array.isArray(element.framePath) && element.framePath.length > 0
      ? { framePath: [...element.framePath] }
      : {}),
    ...(Array.isArray(element.shadowPath) && element.shadowPath.length > 0
      ? { shadowPath: [...element.shadowPath] }
      : {}),
  };

  return canonicalSha256({
    schemaVersion: finding.schemaVersion || SCAN_REPORT_SCHEMA_VERSION,
    pageState: finding.pageState || 'initial',
    route: finding.route || '/',
    canonicalRuleId: finding.canonicalRuleId || finding.nativeRuleId || finding.ruleId,
    locator: sourceLocator || domLocator,
  });
}
