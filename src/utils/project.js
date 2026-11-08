import path from 'path';
import { getProjectRoot } from './paths.js';
import { DEFAULT_CONFIG, loadConfig } from './config.js';

/**
 * Single source of truth for where the host project keeps its build output and
 * templates. Honors config.outDir and config.source; relative values are
 * project-root relative with forward slashes, `*Dir` values are absolute.
 */
export function resolveProject(config = loadConfig(), root = getProjectRoot()) {
  const outDir = String(config.outDir || 'dist').replace(/\\/g, '/').replace(/\/+$/, '') || 'dist';
  const source = { ...DEFAULT_CONFIG.source, ...(config.source || {}) };
  const pagesRoot = String(source.pagesRoot).replace(/\/+$/, '');
  const defaults = JSON.stringify(DEFAULT_CONFIG.distMap);
  // An untouched default distMap follows outDir; a user-supplied one is kept verbatim.
  const distMap = !config.distMap || JSON.stringify(config.distMap) === defaults
    ? DEFAULT_CONFIG.distMap.map((e) => ({ ...e, dist: e.dist.replace(/^dist\//, `${outDir}/`) }))
    : config.distMap;
  return {
    root,
    outDir,
    distDir: path.join(root, outDir),
    manifestPath: path.join(root, outDir, 'scan-manifest.json'),
    attestationPath: path.join(root, outDir, 'scan-attestation.json'),
    pagesRoot,
    pagesDir: path.join(root, pagesRoot),
    srcDir: path.join(root, path.posix.dirname(pagesRoot)),
    extension: source.extension,
    distMap,
  };
}
