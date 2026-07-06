import { readFileSync, writeFileSync } from 'fs';
import { existsSync } from 'fs';
import fg from 'fast-glob';
import path from 'path';
import { getProjectRoot } from '../../utils/paths.js';

const ROOT = getProjectRoot();

/**
 * Rule: font-display
 * Injects `font-display: swap` into all @font-face declarations that lack it.
 * Applies to all CSS files under src/styles/.
 */
export const fontDisplayRule = {
  id: 'font-display',
  handles: ['font-display'],

  async fix(_violation, _config = {}) {
    const cssFiles = await fg('src/styles/**/*.css', { cwd: ROOT });
    const fixed = [];

    for (const relPath of cssFiles) {
      const fullPath = path.join(ROOT, relPath);
      const content = readFileSync(fullPath, 'utf8');

      if (!content.includes('@font-face')) continue;

      // Find @font-face blocks missing font-display
      const patched = content.replace(/@font-face\s*\{([^}]*)\}/g, (match, body) => {
        if (body.includes('font-display')) return match; // Already has it
        return match.replace(body, `${body}  font-display: swap;\n`);
      });

      if (patched !== content) {
        writeFileSync(fullPath, patched, 'utf8');
        fixed.push(relPath);
      }
    }

    if (fixed.length === 0) {
      return { applied: false, reason: 'No @font-face declarations missing font-display found' };
    }

    return {
      applied: true,
      files: fixed,
      description: `Added font-display: swap to @font-face in: ${fixed.join(', ')}`,
    };
  },
};
