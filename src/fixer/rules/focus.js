import { readFileSync, writeFileSync } from 'fs';
import fg from 'fast-glob';
import path from 'path';
import { getProjectRoot } from '../../utils/paths.js';

const ROOT = getProjectRoot();

const FOCUS_VISIBLE_CSS = `
/* ADA Scanner: Focus Visible Enhancement
 * Ensures keyboard focus indicators are always visible.
 * Respects user preference for reduced motion.
 */
:focus-visible {
  outline: 3px solid currentColor;
  outline-offset: 2px;
}

/* Remove outline only when mouse/touch is used (via :focus, not :focus-visible) */
:focus:not(:focus-visible) {
  outline: none;
}
`;

/**
 * Rule: focus
 * Injects a :focus-visible CSS rule into src/styles/base/ if focus indicators
 * are being suppressed without a replacement.
 * Creates src/styles/base/focus-visible.css if it doesn't exist.
 */
export const focusRule = {
  id: 'focus',
  handles: ['focus-indicator-removed', 'focus-not-visible'],

  async fix(_violation, _config = {}) {
    const focusFile = path.join(ROOT, 'src/styles/base/focus-visible.css');
    const { existsSync } = await import('fs');

    if (existsSync(focusFile)) {
      return { applied: false, reason: 'src/styles/base/focus-visible.css already exists' };
    }

    // Check if any CSS has outline:none on :focus without a replacement
    const cssFiles = await fg('src/styles/**/*.css', { cwd: ROOT });
    let suppressionFound = false;

    for (const relPath of cssFiles) {
      const content = readFileSync(path.join(ROOT, relPath), 'utf8');
      if (
        content.includes(':focus') &&
        (content.includes('outline: none') || content.includes('outline:none') || content.includes('outline: 0'))
      ) {
        suppressionFound = true;
        break;
      }
    }

    if (!suppressionFound) {
      return { applied: false, reason: 'No focus outline suppression detected' };
    }

    writeFileSync(focusFile, FOCUS_VISIBLE_CSS.trim() + '\n', 'utf8');

    return {
      applied: true,
      file: 'src/styles/base/focus-visible.css',
      description: 'Created src/styles/base/focus-visible.css with :focus-visible rules',
      note: 'The auto-imports plugin will automatically include this file. Verify it does not conflict with existing focus styles.',
    };
  },
};
