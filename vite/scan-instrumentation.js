import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import fg from 'fast-glob';

/**
 * @typedef {{ dist: string, src: string, ext?: string }} DistMapEntry
 */

const DEFAULT_DIST_MAP = [
  { dist: 'dist/partials/', src: 'src/partials/', ext: '.liquid' },
  { dist: 'dist/pages/', src: 'src/pages/', ext: '.liquid' },
  { dist: 'dist/layouts/', src: 'src/layouts/', ext: '.liquid' },
  { dist: 'dist/components/', src: 'src/components/', ext: '.liquid' },
];

function loadHostScanConfig(projectRoot) {
  const configPath = join(projectRoot, '.scan-config.json');
  if (!existsSync(configPath)) return {};
  try {
    return JSON.parse(readFileSync(configPath, 'utf8'));
  } catch {
    return {};
  }
}

/**
 * Scan Instrumentation Plugin (ada-scan/vite)
 *
 * Active only when SCAN_MODE=true (set by ada-scan's instrumented build).
 * Emits `<outDir>/scan-manifest.json` mapping every built HTML file to its
 * source template file, so the scanner can trace violations back to source.
 *
 * distMap + outDir are read from the host `.scan-config.json`; if absent it
 * falls back to the default dist/{partials,pages,layouts,components} mapping.
 *
 * @returns {import('vite').Plugin}
 */
export function scanInstrumentationPlugin() {
  return {
    name: 'scan-instrumentation',
    apply: 'build',

    async closeBundle() {
      if (process.env.SCAN_MODE !== 'true') return;

      const projectRoot = process.cwd();
      const config = loadHostScanConfig(projectRoot);
      const outDir = config.outDir || 'dist';
      const distMap = Array.isArray(config.distMap) && config.distMap.length ? config.distMap : DEFAULT_DIST_MAP;

      const manifest = {};
      for (const { dist, src, ext } of distMap) {
        const files = await fg(`${dist}**/*.html`, { cwd: projectRoot });
        for (const file of files) {
          const relative = file.slice(dist.length).replace(/\.html$/, '');
          manifest[file] = `${src}${relative}${ext || '.liquid'}`;
        }
      }

      const outDirAbs = join(projectRoot, outDir);
      if (!existsSync(outDirAbs)) mkdirSync(outDirAbs, { recursive: true });

      const manifestPath = join(outDirAbs, 'scan-manifest.json');
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

      console.log(`[scan-instrumentation] ${outDir}/scan-manifest.json — ${Object.keys(manifest).length} entries`);
    },
  };
}
