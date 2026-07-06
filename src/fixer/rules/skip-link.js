import { readFileSync, writeFileSync } from 'fs';
import { existsSync } from 'fs';
import path from 'path';
import { getProjectRoot } from '../../utils/paths.js';

const ROOT = getProjectRoot();

const SKIP_LINK_HTML = `<a href="#main-content" class="skip-link">Skip to main content</a>`;

const SKIP_LINK_CSS = `
/* ADA Scanner: Skip Navigation Link
 * Visually hidden until focused by keyboard users.
 */
.skip-link {
  position: absolute;
  left: -9999px;
  top: auto;
  width: 1px;
  height: 1px;
  overflow: hidden;
  z-index: 9999;
}

.skip-link:focus {
  position: fixed;
  top: 0;
  left: 0;
  width: auto;
  height: auto;
  padding: 0.75rem 1.5rem;
  background: #000;
  color: #fff;
  font-size: 1rem;
  text-decoration: none;
  z-index: 9999;
}
`;

/**
 * Rule: skip-link
 * Injects a "Skip to main content" link as the first element in <body>
 * in the layout file, and adds corresponding CSS.
 */
export const skipLinkRule = {
  id: 'skip-link',
  handles: ['bypass', 'skip-link-missing'],

  fix(_violation, _config = {}) {
    const layoutFile = path.join(ROOT, 'src/layouts/layout.liquid');
    if (!existsSync(layoutFile)) return { applied: false, reason: 'Layout file not found' };

    let layoutContent = readFileSync(layoutFile, 'utf8');

    // Check if skip link already exists
    if (layoutContent.includes('skip-link') || layoutContent.includes('skip to main') || layoutContent.includes('#main-content')) {
      return { applied: false, reason: 'Skip link already present in layout' };
    }

    // Add skip link immediately after <body>
    const patched = layoutContent.replace(/<body(\s[^>]*)?>/, (match) => `${match}\n  ${SKIP_LINK_HTML}`);

    if (patched === layoutContent) {
      return { applied: false, reason: 'Could not locate <body> tag in layout' };
    }

    writeFileSync(layoutFile, patched, 'utf8');

    // Also add id="main-content" to <main> if it doesn't have one
    const mainFile = path.join(ROOT, 'src/partials/layout/main.liquid');
    if (existsSync(mainFile)) {
      let mainContent = readFileSync(mainFile, 'utf8');
      if (mainContent.includes('<main') && !mainContent.includes('id="main-content"')) {
        mainContent = mainContent.replace(/<main(\s[^>]*)?>/, (match, attrs) => {
          return `<main${attrs || ''} id="main-content">`;
        });
        writeFileSync(mainFile, mainContent, 'utf8');
      }
    }

    // Create skip-link CSS file
    const skipCssFile = path.join(ROOT, 'src/styles/base/skip-link.css');
    if (!existsSync(skipCssFile)) {
      writeFileSync(skipCssFile, SKIP_LINK_CSS.trim() + '\n', 'utf8');
    }

    return {
      applied: true,
      files: ['src/layouts/layout.liquid', 'src/styles/base/skip-link.css'],
      description: 'Added skip-to-main-content link to layout and CSS',
    };
  },
};
