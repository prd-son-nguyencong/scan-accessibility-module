import { sep } from 'node:path';
import { REACT_MANIFEST } from '../src/tracer/adapters/react.js';
import { relativeSource, transformJsx } from '../src/tracer/adapters/react-transform.js';
import { hashSourceFiles } from '../src/tracer/preimage.js';

/**
 * Vite plugin for scan builds (`SCAN_MODE=true`): adds data-ada-src="file:line" to every host element in .jsx/.tsx
 * and emits `ada-react-src.json` (sha256 of each transformed file) so the `react` adapter can verify the source.
 * Register it before the React plugin. Normal builds are untouched.
 */
export function reactSourceAttrPlugin() {
  let root = process.cwd();
  const files = new Set();
  return {
    name: 'ada-react-source-attr',
    enforce: 'pre',
    configResolved(cfg) { root = cfg.root; },
    transform(code, id) {
      if (process.env.SCAN_MODE !== 'true') return null;
      const abs = id.split('?')[0];
      if (!/\.[jt]sx$/.test(abs) || abs.includes(`${sep}node_modules${sep}`)) return null;
      const file = relativeSource(root, abs);
      if (!file) return null;
      const out = transformJsx(code, { file });
      if (out.code === code) return null;
      files.add(file);
      return { code: out.code, map: null }; // insertions stay on their line, so existing maps still point at the right line
    },
    generateBundle() {
      if (process.env.SCAN_MODE !== 'true' || !files.size) return;
      const sourceHashes = hashSourceFiles(root, [...files]);
      this.emitFile({ type: 'asset', fileName: REACT_MANIFEST, source: `${JSON.stringify({ schemaVersion: 1, sourceHashes }, null, 2)}\n` });
    },
  };
}
