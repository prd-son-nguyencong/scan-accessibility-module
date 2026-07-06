import { readFileSync, writeFileSync } from 'fs';
import fg from 'fast-glob';
import path from 'path';
import { getProjectRoot } from '../../utils/paths.js';

const ROOT = getProjectRoot();

/**
 * Rule: forms
 * Associates <label for="x"> with <input id="x"> when the id exists but for= is missing.
 * Also detects inputs without any label (flags for AI fix or manual review).
 */
export const formsRule = {
  id: 'forms',
  handles: ['label', 'select-name', 'form-field-no-label'],

  async fix(_violation, _config = {}) {
    const liquidFiles = await fg('src/**/*.liquid', { cwd: ROOT });
    const fixed = [];
    const flagged = [];
    let totalFixed = 0;

    for (const relPath of liquidFiles) {
      const fullPath = path.join(ROOT, relPath);
      const content = readFileSync(fullPath, 'utf8');

      if (!content.includes('<input') && !content.includes('<select') && !content.includes('<textarea')) {
        continue;
      }

      let patched = content;
      let count = 0;

      // Find inputs with id but whose preceding label lacks for=
      const inputIdRegex = /<input[^>]+id=["']([^"']+)["'][^>]*>/gi;
      let m;
      while ((m = inputIdRegex.exec(content)) !== null) {
        const inputId = m[1];
        const inputIndex = m.index;

        // Look for a nearby label without for= that wraps or precedes this input
        const precedingContent = content.slice(Math.max(0, inputIndex - 300), inputIndex);
        const labelRegex = /<label(?!\s[^>]*for=)(\s[^>]*)?>([^<]*)<\/label>/gi;
        let labelMatch;
        while ((labelMatch = labelRegex.exec(precedingContent)) !== null) {
          // Found a label without for= — associate it
          const oldLabel = labelMatch[0];
          const newLabel = oldLabel.replace('<label', `<label for="${inputId}"`);
          patched = patched.replace(oldLabel, newLabel);
          count++;
        }
      }

      if (count > 0) {
        writeFileSync(fullPath, patched, 'utf8');
        fixed.push(relPath);
        totalFixed += count;
      }

      // Flag inputs that have no id at all (can't auto-fix without AI)
      const unidentifiedInputs = (content.match(/<input(?![^>]*\bid=)[^>]*>/gi) || [])
        .filter((tag) => !tag.includes('type="hidden"') && !tag.includes("type='hidden'")).length;

      if (unidentifiedInputs > 0) {
        flagged.push({ file: relPath, reason: `${unidentifiedInputs} input(s) have no id attribute — cannot auto-associate labels` });
      }
    }

    return {
      applied: fixed.length > 0,
      files: fixed,
      flagged,
      description: fixed.length > 0
        ? `Associated labels with ${totalFixed} input(s) in ${fixed.length} file(s)`
        : `No auto-fixable form label issues (${flagged.length} files flagged for AI review)`,
    };
  },
};
