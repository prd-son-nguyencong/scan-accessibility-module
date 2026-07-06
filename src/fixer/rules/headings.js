import { readFileSync, writeFileSync } from 'fs';
import fg from 'fast-glob';
import path from 'path';
import { getProjectRoot } from '../../utils/paths.js';

const ROOT = getProjectRoot();

/**
 * Rule: headings
 * Detects and fixes skipped heading levels in .liquid files.
 *
 * Strategy:
 * - Within a single partial file, if h1→h3 appears without h2, promote h3→h2
 * - Does NOT attempt cross-file heading restructuring (that requires AI)
 * - Flags cross-file issues in the report instead
 */
export const headingsRule = {
  id: 'headings',
  handles: ['heading-order'],

  async fix(_violation, _config = {}) {
    const liquidFiles = await fg('src/**/*.liquid', { cwd: ROOT });
    const fixed = [];
    const flagged = [];

    for (const relPath of liquidFiles) {
      const fullPath = path.join(ROOT, relPath);
      const content = readFileSync(fullPath, 'utf8');

      if (!/h[1-6]/i.test(content)) continue;

      // Extract headings in order
      const headingMatches = [];
      const headingRegex = /<h([1-6])(\s[^>]*)?>[\s\S]*?<\/h\1>/gi;
      let m;
      while ((m = headingRegex.exec(content)) !== null) {
        headingMatches.push({ level: parseInt(m[1], 10), index: m.index, full: m[0] });
      }

      if (headingMatches.length < 2) continue;

      // Check for intra-file skipped levels
      let patched = content;
      let changed = false;

      for (let i = 1; i < headingMatches.length; i++) {
        const prev = headingMatches[i - 1];
        const curr = headingMatches[i];

        if (curr.level > prev.level + 1) {
          // Skipped: prev=h1, curr=h3 — fix to h2
          const correctedLevel = prev.level + 1;
          const oldTag = `h${curr.level}`;
          const newTag = `h${correctedLevel}`;
          const fixedHeading = curr.full
            .replace(new RegExp(`^<${oldTag}`, 'i'), `<${newTag}`)
            .replace(new RegExp(`</${oldTag}>$`, 'i'), `</${newTag}>`);

          patched = patched.replace(curr.full, fixedHeading);
          changed = true;
        }
      }

      if (changed) {
        writeFileSync(fullPath, patched, 'utf8');
        fixed.push(relPath);
      } else if (headingMatches.length > 0) {
        // Check if first heading in file starts at h2+ (might be continuation)
        const firstLevel = headingMatches[0].level;
        if (firstLevel > 2) {
          flagged.push({ file: relPath, reason: `Starts at h${firstLevel} — check if parent partial provides h1` });
        }
      }
    }

    if (fixed.length === 0 && flagged.length === 0) {
      return { applied: false, reason: 'No intra-file heading order issues found' };
    }

    return {
      applied: fixed.length > 0,
      files: fixed,
      flagged,
      description: fixed.length > 0
        ? `Fixed heading order in ${fixed.length} file(s)`
        : `No auto-fixable heading issues (${flagged.length} files flagged for review)`,
    };
  },
};
