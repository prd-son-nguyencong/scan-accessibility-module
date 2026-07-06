import { readFileSync, writeFileSync } from 'fs';
import fg from 'fast-glob';
import path from 'path';
import { getProjectRoot } from '../../utils/paths.js';

const ROOT = getProjectRoot();

/**
 * Rule: alt-text
 * Handles missing alt attributes on <img> elements.
 *
 * Strategy:
 * - Images inside <a> or <button> with no other text: mark as decorative alt="" (AI will improve)
 * - Decorative images (bg, icon, pattern in src name): alt=""
 * - All others: alt="[TODO: add descriptive alt text]" placeholder (flags for AI or human)
 * - When --ai flag is active, escalates to CIS to generate contextual alt text
 */
export const altTextRule = {
  id: 'alt-text',
  handles: ['image-alt', 'input-image-alt', 'image-alt-missing-sr', 'image-alt-not-descriptive'],

  async fix(_violation, config = {}) {
    const liquidFiles = await fg('src/**/*.liquid', { cwd: ROOT });
    const fixed = [];
    const aiQueue = [];
    let totalFixed = 0;

    const DECORATIVE_PATTERNS = /icon|logo|bg|background|pattern|divider|spacer|sprite|placeholder/i;

    for (const relPath of liquidFiles) {
      const fullPath = path.join(ROOT, relPath);
      const content = readFileSync(fullPath, 'utf8');

      if (!content.includes('<img')) continue;

      let patched = content;
      let count = 0;

      patched = patched.replace(/<img(\s[^>]*?)(\/??>)/gi, (match, attrs, close) => {
        // Skip if already has alt
        if (/\balt\s*=/.test(attrs)) return match;

        const srcMatch = attrs.match(/src\s*=\s*["']([^"']*?)["']/i);
        const src = srcMatch ? srcMatch[1] : '';
        const filename = src.split('/').pop().split('?')[0].toLowerCase();

        let altValue;
        if (DECORATIVE_PATTERNS.test(filename) || DECORATIVE_PATTERNS.test(src)) {
          altValue = '""';
        } else {
          // Queue for AI alt text generation
          aiQueue.push({ file: relPath, src, match });
          altValue = '"[TODO: add descriptive alt text]"';
        }

        count++;
        const separator = attrs.endsWith(' ') ? '' : ' ';
        return `<img${attrs}${separator}alt=${altValue}${close.startsWith('/') ? ' ' : ''}${close}`;
      });

      if (count > 0 && patched !== content) {
        writeFileSync(fullPath, patched, 'utf8');
        fixed.push(relPath);
        totalFixed += count;
      }
    }

    if (fixed.length === 0 && aiQueue.length === 0) {
      return { applied: false, reason: 'No images missing alt attributes found' };
    }

    return {
      applied: fixed.length > 0,
      files: fixed,
      aiQueue: aiQueue.slice(0, 20),
      description: fixed.length > 0
        ? `Added alt attributes to ${totalFixed} image(s) in ${fixed.length} file(s). Images marked [TODO] need descriptive alt text — use --ai to generate via CIS.`
        : 'All images have alt attributes',
    };
  },
};
