import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import fg from 'fast-glob';
import { getProjectRoot } from '../../utils/paths.js';
import { parseRenderedTag } from '../liquid-tag-index.js';
import { classifyOwnership, untraceableOwnerReason } from '../ownership.js';
import { hashSourceFiles } from '../preimage.js';
import { detectFramework } from './index.js';
import { registerAdapter } from './registry.js';
import { transformJsx } from './react-transform.js';

export const REACT_MANIFEST = 'ada-react-src.json';
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const SOURCE_FILE = /\.[cm]?[jt]sx?$/;
const IGNORE = ['**/node_modules/**', '**/dist/**', '**/build/**', '**/.next/**', '**/out/**', '**/.*/**'];

const jsxFiles = (root) => fg.sync('**/*.{jsx,tsx}', { cwd: root, ignore: IGNORE }).sort();

function hostElements(file, root) {
  try { return transformJsx(readFileSync(path.join(root, file), 'utf8'), { file }).elements; } catch { return []; }
}

/** Recorded build hash of `file` from the manifest the Vite plugin writes (`el.reactManifest`, else dist/ada-react-src.json). */
function recordedHash(el, root, file) {
  const manifest = el.reactManifest ? path.resolve(root, el.reactManifest) : path.join(root, 'dist', REACT_MANIFEST);
  try { return JSON.parse(readFileSync(manifest, 'utf8')).sourceHashes?.[file]; } catch { return undefined; }
}

/**
 * Locate a rendered element through the `data-ada-src="file:line"` attribute the build transform added.
 * `high` needs the attribute, the file's build-time hash from the manifest to still match, and a host element of the
 * same tag starting at that line. Without a manifest the same check gives `medium`. The line is never guessed.
 * @param {object} el outerHTML, root, optional reactManifest, ownership/platformOwned as for traceElement
 */
export function locateReact(el = {}) {
  const untraceable = (reason) => ({ confidence: 'untraceable', candidates: [], reason });
  if (classifyOwnership(el) !== 'source') return untraceable(untraceableOwnerReason(el));
  const rendered = parseRenderedTag(el.outerHTML || '');
  if (!rendered) return untraceable('no-element');
  const m = /^([^\0]+):(\d+)$/.exec(rendered.attrs['data-ada-src'] || '');
  if (!m) return untraceable('no-marker');
  const [, file, lineText] = m;
  const root = el.root || getProjectRoot();
  const line = Number(lineText);
  // The attribute is page content: only a project-relative source file is ever opened.
  if (path.isAbsolute(file) || file.split('/').includes('..') || !SOURCE_FILE.test(file)) return untraceable('no-match');
  if (!existsSync(path.join(root, file))) return untraceable('page-source-missing');
  // A recorded hash must be well formed: a corrupt manifest entry is never treated as verified.
  let hash = recordedHash(el, root, file);
  if (hash !== undefined) {
    if (typeof hash !== 'string' || !SHA256.test(hash)) return untraceable('manifest-invalid');
    if (hashSourceFiles(root, [file])[file] !== hash) return untraceable('source-changed-since-build');
  } else hash = null;
  if (!hostElements(file, root).some((e) => e.line === line && e.tag === rendered.tagName)) return untraceable('no-match');
  return {
    confidence: hash ? 'high' : 'medium',
    candidates: [{ file, line, method: 'react-data-ada-src', evidence: [hash ? 'file-hash-verified' : 'file-hash-unrecorded'] }],
    reason: null,
  };
}

/** React projects built with the `ada-scan/vite/react` plugin (or any transform using react-transform.js). */
export const react = registerAdapter({
  id: 'react',
  detect: (root) => detectFramework(root).id === 'react',
  index: (root) => jsxFiles(root).flatMap((file) => hostElements(file, root).map(({ line, tag }) => ({ file, line, tagName: tag }))),
  locate: locateReact,
  supports: { local: true, preview: true },
});
