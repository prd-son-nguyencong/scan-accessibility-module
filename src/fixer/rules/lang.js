import { readFileSync, writeFileSync } from 'fs';
import { existsSync } from 'fs';
import path from 'path';
import { getProjectRoot } from '../../utils/paths.js';

const ROOT = getProjectRoot();

/**
 * Rule: lang
 * Ensures html[lang] is set in the layout file.
 * Auto-fixes by adding lang="en" (configurable) to the <html> tag.
 */
export const langRule = {
  id: 'lang',
  handles: ['html-has-lang', 'html-lang-valid', 'html-missing-lang'],

  fix(violation, config = {}) {
    const locale = config.locale || 'en';

    // The lang attribute lives in the layout file
    const layoutFile = path.join(ROOT, 'src/layouts/layout.liquid');
    if (!existsSync(layoutFile)) return { applied: false, reason: 'Layout file not found' };

    let content = readFileSync(layoutFile, 'utf8');

    // Check if already fixed
    if (/<html[^>]+lang=/.test(content)) {
      return { applied: false, reason: 'lang attribute already present' };
    }

    // Add lang attribute to <html> tag
    const fixed = content.replace(/<html(\s*)(>|[^>]*>)/i, (match, space, rest) => {
      return `<html${space}lang="${locale}"${rest.startsWith('>') ? '' : ' '}${rest}`;
    });

    if (fixed === content) {
      return { applied: false, reason: 'Could not locate <html> tag to patch' };
    }

    writeFileSync(layoutFile, fixed, 'utf8');
    return { applied: true, file: 'src/layouts/layout.liquid', description: `Added lang="${locale}" to <html>` };
  },
};
