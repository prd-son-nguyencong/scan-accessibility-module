import path from 'path';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';

export function getDirname(metaUrl) {
  return path.dirname(fileURLToPath(metaUrl));
}

let _rootCache;

/**
 * Resolves the HOST project root (the repo being scanned), not the location of
 * this package inside node_modules.
 *
 * Resolution order:
 *   1. ADA_SCAN_ROOT env var (explicit override — recommended in monorepos)
 *   2. Nearest ancestor of process.cwd() containing `.scan-config.json`
 *   3. Nearest ancestor of process.cwd() containing `package.json`
 *   4. process.cwd()
 *
 * Must not read config contents — config location depends on the root.
 */
export function getProjectRoot() {
  if (_rootCache) return _rootCache;

  if (process.env.ADA_SCAN_ROOT) {
    _rootCache = path.resolve(process.env.ADA_SCAN_ROOT);
    return _rootCache;
  }

  const start = process.cwd();
  let dir = start;
  let firstPkgDir = null;

  while (true) {
    if (existsSync(path.join(dir, '.scan-config.json'))) {
      _rootCache = dir;
      return _rootCache;
    }
    if (!firstPkgDir && existsSync(path.join(dir, 'package.json'))) {
      firstPkgDir = dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  _rootCache = firstPkgDir || start;
  return _rootCache;
}

/** Testing hook — clears the memoized root so fixtures resolve independently. */
export function resetProjectRootCache() {
  _rootCache = undefined;
}

const DEFAULT_DIST_MAP = [
  { dist: 'dist/partials/', src: 'src/partials/', ext: '.liquid' },
  { dist: 'dist/pages/', src: 'src/pages/', ext: '.liquid' },
  { dist: 'dist/layouts/', src: 'src/layouts/', ext: '.liquid' },
  { dist: 'dist/components/', src: 'src/components/', ext: '.liquid' },
];

/**
 * Maps a built HTML path to its source template path.
 * Uses the configured distMap when provided; otherwise falls back to the
 * default dist/ -> src/ + .html -> .liquid convention.
 */
export function distToSrcLiquid(distRelativePath, distMap = DEFAULT_DIST_MAP) {
  for (const entry of distMap) {
    if (distRelativePath.startsWith(entry.dist)) {
      const rest = distRelativePath.slice(entry.dist.length).replace(/\.html$/, entry.ext || '.liquid');
      return `${entry.src}${rest}`;
    }
  }
  return distRelativePath.replace(/^dist\//, 'src/').replace(/\.html$/, '.liquid');
}

/**
 * Maps a URL pathname to a source page file.
 * `/jobs/detail` -> `src/pages/jobs/detail.liquid` (defaults), overridable via
 * `opts.pagesRoot` and `opts.extension` (from config.source).
 */
export function urlToPageFile(urlPathname, opts = {}) {
  const pagesRoot = (opts.pagesRoot || 'src/pages').replace(/\/$/, '');
  const extension = opts.extension || '.liquid';
  const normalized = urlPathname === '/' ? 'index' : urlPathname.replace(/^\//, '');
  return `${pagesRoot}/${normalized}${extension}`;
}
