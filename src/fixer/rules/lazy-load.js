import { readFileSync, writeFileSync } from 'fs';
import fg from 'fast-glob';
import path from 'path';
import { getProjectRoot } from '../../utils/paths.js';

const ROOT = getProjectRoot();

/**
 * Rule: lazy-load
 * Adds loading="lazy" to <img> tags in .liquid source files.
 * Skips images that are in above-the-fold hero sections (first partial rendered in layout).
 * Skips images that already have loading="lazy" or loading="eager".
 */
export const lazyLoadRule = {
  id: 'lazy-load',
  handles: ['offscreen-images', 'uses-optimized-images'],

  async fix(_violation, _config = {}) {
    const liquidFiles = await fg('src/**/*.liquid', { cwd: ROOT });
    const fixed = [];
    let totalFixed = 0;

    // Hero partials are above the fold — skip lazy loading for them
    const heroPartials = new Set(['src/partials/layout/hero.liquid', 'src/partials/index/hero.liquid']);

    for (const relPath of liquidFiles) {
      if (heroPartials.has(relPath)) continue;

      const fullPath = path.join(ROOT, relPath);
      const content = readFileSync(fullPath, 'utf8');

      if (!content.includes('<img')) continue;

      // Add loading="lazy" to img tags without a loading attribute
      let count = 0;
      const patched = content.replace(/<img(\s)([^>]*?)(\/??>)/g, (match, space, attrs, close) => {
        if (attrs.includes('loading=')) return match; // Already has loading attribute
        count++;
        return `<img${space}${attrs.trim()} loading="lazy"${close.startsWith('/') ? ' ' : ''}${close}`;
      });

      if (count > 0 && patched !== content) {
        writeFileSync(fullPath, patched, 'utf8');
        fixed.push(relPath);
        totalFixed += count;
      }
    }

    if (fixed.length === 0) {
      return { applied: false, reason: 'No images found without loading attribute' };
    }

    return {
      applied: true,
      files: fixed,
      description: `Added loading="lazy" to ${totalFixed} image(s) in ${fixed.length} file(s)`,
    };
  },
};
