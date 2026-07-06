import { readFileSync, writeFileSync } from 'fs';
import { existsSync } from 'fs';
import path from 'path';
import { getProjectRoot } from '../../utils/paths.js';

const ROOT = getProjectRoot();

/**
 * Rule: landmarks
 * Ensures the layout has proper landmark regions:
 * - <main> or role="main" wrapping page content
 * - <nav> or role="navigation" for navigation
 * - Multiple navs have aria-label to distinguish them
 */
export const landmarksRule = {
  id: 'landmarks',
  handles: ['landmark-one-main', 'region', 'missing-main-landmark'],

  fix(_violation, _config = {}) {
    const fixes = [];

    // Check layout file for missing main landmark
    const layoutFile = path.join(ROOT, 'src/layouts/layout.liquid');
    if (existsSync(layoutFile)) {
      let content = readFileSync(layoutFile, 'utf8');

      // Check if main landmark exists
      const hasMain = /<main[\s>]|role=["']main["']/i.test(content);
      if (!hasMain) {
        // Wrap {{ content }} or {%- block content -%} in <main>
        const patched = content
          .replace(/({{-?\s*content\s*-?}})/g, '<main id="main-content">\n  $1\n</main>')
          .replace(/({\%-?\s*block content\s*-?%})([\s\S]*?)({\%-?\s*endblock\s*-?%})/g,
            '<main id="main-content">\n  $1$2$3\n</main>');

        if (patched !== content) {
          writeFileSync(layoutFile, patched, 'utf8');
          fixes.push({ file: 'src/layouts/layout.liquid', description: 'Wrapped content block in <main>' });
        }
      }

      // Check for multiple navs without labels
      const navMatches = content.match(/<nav(?!\s[^>]*aria-label)[^>]*>/gi) || [];
      if (navMatches.length > 1) {
        // Flag — can't auto-add labels without knowing the nav content context
        fixes.push({
          file: 'src/layouts/layout.liquid',
          description: `${navMatches.length} <nav> elements found without aria-label — add aria-label="Primary navigation", "Footer navigation", etc.`,
          flagged: true,
        });
      }
    }

    if (fixes.length === 0) {
      return { applied: false, reason: 'No missing landmark issues found in layout' };
    }

    const actualFixes = fixes.filter((f) => !f.flagged);
    const flagged = fixes.filter((f) => f.flagged);

    return {
      applied: actualFixes.length > 0,
      files: actualFixes.map((f) => f.file),
      flagged: flagged.map((f) => ({ file: f.file, reason: f.description })),
      description: actualFixes.map((f) => f.description).join('; ') || 'No auto-fixes applied',
    };
  },
};
