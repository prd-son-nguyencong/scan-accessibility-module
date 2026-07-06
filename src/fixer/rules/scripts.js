import { readFileSync, writeFileSync } from 'fs';
import fg from 'fast-glob';
import path from 'path';
import { getProjectRoot } from '../../utils/paths.js';

const ROOT = getProjectRoot();

/**
 * Rule: scripts
 * Adds defer or async to render-blocking <script> tags.
 * - External scripts (src=) get defer by default (preserves execution order)
 * - Inline scripts that are not type="module" get defer
 * - Skips scripts already marked defer, async, or type="module"
 */
export const scriptsRule = {
  id: 'scripts',
  handles: ['render-blocking-resources'],

  async fix(_violation, _config = {}) {
    const liquidFiles = await fg('src/**/*.liquid', { cwd: ROOT });
    const fixed = [];
    let totalFixed = 0;

    for (const relPath of liquidFiles) {
      const fullPath = path.join(ROOT, relPath);
      const content = readFileSync(fullPath, 'utf8');

      if (!content.includes('<script')) continue;

      let count = 0;
      const patched = content.replace(/<script(\s[^>]*)?>/gi, (match, attrs) => {
        const a = attrs || '';

        // Skip if already non-blocking or module
        if (/defer|async|type\s*=\s*["']module["']/i.test(a)) return match;
        // Skip inline scripts with no src (they may be critical)
        // Only patch external scripts with src=""
        if (!/src\s*=/i.test(a)) return match;

        count++;
        return `<script${a} defer>`;
      });

      if (count > 0 && patched !== content) {
        writeFileSync(fullPath, patched, 'utf8');
        fixed.push(relPath);
        totalFixed += count;
      }
    }

    if (fixed.length === 0) {
      return { applied: false, reason: 'No render-blocking scripts found' };
    }

    return {
      applied: true,
      files: fixed,
      description: `Added defer to ${totalFixed} external script tag(s) in ${fixed.length} file(s)`,
    };
  },
};
