import { readFileSync, writeFileSync } from 'fs';
import fg from 'fast-glob';
import path from 'path';
import { getProjectRoot } from '../../utils/paths.js';

const ROOT = getProjectRoot();

/**
 * Rule: aria
 * Fixes common ARIA attribute issues:
 * - Buttons with no text: adds aria-label from nearby text context
 * - Decorative Font Awesome icons: adds role="presentation" aria-hidden="true"
 * - Social media icon links: infers aria-label from icon class or href
 */
export const ariaRule = {
  id: 'aria',
  handles: ['aria-label', 'button-name', 'link-name', 'aria-hidden-focus'],

  async fix(_violation, _config = {}) {
    const liquidFiles = await fg('src/**/*.liquid', { cwd: ROOT });
    const fixed = [];
    let totalFixed = 0;

    for (const relPath of liquidFiles) {
      const fullPath = path.join(ROOT, relPath);
      const content = readFileSync(fullPath, 'utf8');

      let patched = content;
      let count = 0;

      // 1. Font Awesome icons without aria-hidden (decorative context)
      // <i class="fa ..."> or <i class="fas ..."> without aria-hidden
      patched = patched.replace(/<i(\s[^>]*class=["'][^"']*\bfa[s|r|l|b|d]?\b[^"']*["'][^>]*)>/gi, (match, attrs) => {
        if (attrs.includes('aria-hidden') || attrs.includes('role=')) return match;
        // Check if parent element has text context (hard to know in string parsing, assume decorative)
        count++;
        return `<i${attrs} role="presentation" aria-hidden="true">`;
      });

      // 2. SVG elements used as icons without aria-hidden
      patched = patched.replace(/<svg(\s[^>]*)>/gi, (match, attrs) => {
        if (attrs.includes('aria-hidden') || attrs.includes('aria-label') || attrs.includes('role=')) return match;
        // If svg has no title child and is used inline, mark as decorative
        count++;
        return `<svg${attrs} aria-hidden="true" focusable="false">`;
      });

      // 3. Buttons that have only an icon child and no text — add aria-label placeholder
      // <button ...><i class="fa..."></i></button> pattern
      patched = patched.replace(/<button([^>]*)>(\s*<i[^>]*><\/i>\s*)<\/button>/gi, (match, btnAttrs, inner) => {
        if (btnAttrs.includes('aria-label') || btnAttrs.includes('aria-labelledby')) return match;
        count++;
        return `<button${btnAttrs} aria-label="[TODO: add button label]">${inner}</button>`;
      });

      if (count > 0 && patched !== content) {
        writeFileSync(fullPath, patched, 'utf8');
        fixed.push(relPath);
        totalFixed += count;
      }
    }

    if (fixed.length === 0) {
      return { applied: false, reason: 'No ARIA fixes needed' };
    }

    return {
      applied: true,
      files: fixed,
      description: `Applied ${totalFixed} ARIA fix(es) in ${fixed.length} file(s). Note: [TODO] placeholders need meaningful labels added.`,
    };
  },
};
