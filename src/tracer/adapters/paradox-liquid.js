import { buildTagIndex } from '../liquid-tag-index.js';
import { detectFramework, liquidFiles } from './index.js';
import { registerAdapter } from './registry.js';
import { traceLiquid } from '../trace-element.js';

/** The Paradox PDK flow: LiquidJS pages/layouts/partials, instrumented build markers, manifest. */
export const paradoxLiquid = registerAdapter({
  id: 'paradox-liquid',
  detect: (root) => detectFramework(root).id === 'paradox-liquid',
  index: (root) => liquidFiles(root)
    .flatMap((file) => buildTagIndex(file, root).map(({ tagName, line }) => ({ file, line, tagName }))),
  locate: traceLiquid,
  supports: { local: true, preview: true },
});
