import { readFileSync, writeFileSync } from 'fs';
import fg from 'fast-glob';
import path from 'path';
import { getProjectRoot } from '../../utils/paths.js';

const ROOT = getProjectRoot();

/**
 * Rule: semantic-emphasis
 *
 * Fixes <span> elements that are visually bold/italic via CSS or Tailwind classes
 * but lack semantic HTML markup. Screen readers don't announce CSS styling, so
 * these spans are indistinguishable from plain text for AT users (WCAG 1.3.1).
 *
 * Handles:
 *   <span style="font-weight: bold">  →  <strong>
 *   <span style="font-weight: 700">   →  <strong>
 *   <span class="font-bold ...">      →  <strong class="font-bold ...">
 *   <span style="font-style: italic"> →  <em>
 *   <span class="italic ...">         →  <em class="italic ...">
 *
 * Safety guards:
 *   - Skips spans that already have role/aria attributes (changing tag may confuse AT)
 *   - Skips if inner content contains block-level or interactive elements
 *   - Only replaces the tag name; all other attributes are preserved
 */
export const semanticRule = {
  id: 'semantic',
  handles: ['semantic-emphasis-missing'],

  async fix(_violation, _config = {}) {
    const liquidFiles = await fg('src/**/*.liquid', { cwd: ROOT });
    const fixed = [];
    let totalFixed = 0;

    for (const relPath of liquidFiles) {
      const fullPath = path.join(ROOT, relPath);
      const content = readFileSync(fullPath, 'utf8');

      let patched = content;
      let count = 0;

      // 1. Inline style: font-weight bold/700/800/900 → <strong>
      patched = patched.replace(
        /<span(\s[^>]*style=["'][^"']*font-weight\s*:\s*(bold|[789]\d{2})[^"']*["'][^>]*)>([\s\S]*?)<\/span>/gi,
        (match, attrs, _weight, inner) => {
          if (attrs.includes('role=') || attrs.includes('aria-')) return match;
          if (/(<div|<p[ >]|<ul|<ol|<table|<button|<input|<select|<textarea)/i.test(inner)) return match;
          // Remove redundant font-weight from inline style since <strong> carries the semantic
          const cleanAttrs = attrs
            .replace(/\s*font-weight\s*:\s*(bold|[789]\d{2})\s*;?/gi, '')
            .replace(/style=["']\s*["']/g, '')
            .trim();
          count++;
          return cleanAttrs ? `<strong ${cleanAttrs}>${inner}</strong>` : `<strong>${inner}</strong>`;
        }
      );

      // 2. Tailwind font-bold class → <strong>
      patched = patched.replace(
        /<span(\s[^>]*class=["'][^"']*\bfont-bold\b[^"']*["'][^>]*)>([\s\S]*?)<\/span>/gi,
        (match, attrs, inner) => {
          if (attrs.includes('role=') || attrs.includes('aria-')) return match;
          if (/(<div|<p[ >]|<ul|<ol|<table|<button|<input|<select|<textarea)/i.test(inner)) return match;
          count++;
          return `<strong${attrs}>${inner}</strong>`;
        }
      );

      // 3. Inline style: font-style italic → <em>
      patched = patched.replace(
        /<span(\s[^>]*style=["'][^"']*font-style\s*:\s*italic[^"']*["'][^>]*)>([\s\S]*?)<\/span>/gi,
        (match, attrs, inner) => {
          if (attrs.includes('role=') || attrs.includes('aria-')) return match;
          if (/(<div|<p[ >]|<ul|<ol|<table|<button|<input|<select|<textarea)/i.test(inner)) return match;
          const cleanAttrs = attrs
            .replace(/\s*font-style\s*:\s*italic\s*;?/gi, '')
            .replace(/style=["']\s*["']/g, '')
            .trim();
          count++;
          return cleanAttrs ? `<em ${cleanAttrs}>${inner}</em>` : `<em>${inner}</em>`;
        }
      );

      // 4. Tailwind italic class → <em>
      patched = patched.replace(
        /<span(\s[^>]*class=["'][^"']*\bitalic\b[^"']*["'][^>]*)>([\s\S]*?)<\/span>/gi,
        (match, attrs, inner) => {
          if (attrs.includes('role=') || attrs.includes('aria-')) return match;
          if (/(<div|<p[ >]|<ul|<ol|<table|<button|<input|<select|<textarea)/i.test(inner)) return match;
          count++;
          return `<em${attrs}>${inner}</em>`;
        }
      );

      if (count > 0 && patched !== content) {
        writeFileSync(fullPath, patched, 'utf8');
        fixed.push(relPath);
        totalFixed += count;
      }
    }

    if (fixed.length === 0) {
      return { applied: false, reason: 'No semantic emphasis fixes needed' };
    }

    return {
      applied: true,
      files: fixed,
      description: `Replaced ${totalFixed} visually-styled <span>(s) with semantic <strong>/<em> in ${fixed.length} file(s).`,
    };
  },
};
