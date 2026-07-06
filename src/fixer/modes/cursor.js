import { writeFileSync, mkdirSync, existsSync } from 'fs';
import path from 'path';
import { getProjectRoot } from '../../utils/paths.js';
import { groupViolations } from '../../schema.js';

const ROOT = getProjectRoot();

/**
 * Cursor IDE integration mode.
 *
 * Writes:
 * - .cursor/patches/<ruleId>.patch for each violation
 * - .cursor/rules/scan-fixes.md with full context + fix instructions
 */
export async function writeFixContext(violations, _config = {}) {
  const patchDir = path.join(ROOT, '.cursor', 'patches');
  const rulesDir = path.join(ROOT, '.cursor', 'rules');
  mkdirSync(patchDir, { recursive: true });
  mkdirSync(rulesDir, { recursive: true });

  const byFile = groupViolations(violations, (v) => v.source?.file || 'unknown');

  // Write patch files
  for (const [file, fileViolations] of byFile) {
    if (file === 'unknown') continue;
    const patchName = file.replace(/[/\\]/g, '__').replace(/\.liquid$/, '') + '.patch';
    const patchContent = fileViolations
      .map((v) => {
        const line = v.source?.line || '?';
        return [
          `--- ${file}:${line}`,
          `Rule: ${v.ruleId} (${v.layer}) — P${v.priority} ${v.impact}`,
          `WCAG: ${v.wcagRef || 'N/A'}`,
          `Fix: ${v.fix?.hint || 'No hint'}`,
          v.fix?.patch ? `Patch:\n${v.fix.patch}` : '',
          v.element?.outerHTML ? `Element:\n${v.element.outerHTML.slice(0, 300)}` : '',
          '---',
        ]
          .filter(Boolean)
          .join('\n');
      })
      .join('\n\n');
    writeFileSync(path.join(patchDir, patchName), patchContent, 'utf8');
  }

  // Write scan-fixes.md rule
  const ruleContent = buildScanFixesRule(violations, byFile);
  writeFileSync(path.join(rulesDir, 'scan-fixes.md'), ruleContent, 'utf8');

  console.log(`  Cursor patches: ${patchDir} (${byFile.size} file(s))`);
  console.log(`  Cursor rule: ${path.join(rulesDir, 'scan-fixes.md')}`);
}

function buildScanFixesRule(violations, byFile) {
  const lines = [
    '# Scan Fix Instructions',
    '',
    `> Auto-generated ${new Date().toISOString()} — ${violations.length} violations`,
    '',
    '## Instructions',
    '',
    'Fix each violation below in the specified file. Follow the WCAG reference and fix hint.',
    'After fixing, re-run `pnpm scan --page <name>` to verify.',
    '',
    '## Violations by File',
    '',
  ];

  for (const [file, fileViolations] of byFile) {
    lines.push(`### ${file}`);
    lines.push('');
    for (const v of fileViolations) {
      const badge = v.fix?.deterministic ? '[Auto-fix]' : '[AI-fix]';
      lines.push(`- **${v.ruleId}** ${badge} (P${v.priority}, ${v.impact})`);
      if (v.source?.line) lines.push(`  - Line: ${v.source.line}`);
      if (v.wcagRef) lines.push(`  - WCAG: ${v.wcagRef}`);
      lines.push(`  - Fix: ${v.fix?.hint || 'Review manually'}`);
      if (v.element?.outerHTML) {
        lines.push(`  - Element: \`${v.element.outerHTML.slice(0, 100)}\``);
      }
      if (v.source?.snippet) {
        lines.push('  - Source context:');
        lines.push('  ```liquid');
        for (const snippetLine of v.source.snippet.split('\n')) {
          lines.push(`  ${snippetLine}`);
        }
        lines.push('  ```');
      }
    }
    lines.push('');
  }

  // Performance Optimization Guide (when Lighthouse violations exist)
  const lighthouseViolations = violations.filter((v) => v.layer === 'lighthouse');
  if (lighthouseViolations.length > 0) {
    lines.push('## Performance Optimization Guide');
    lines.push('');
    lines.push('Based on Lighthouse audit, here are actionable fixes to improve scores:');
    lines.push('');

    const ruleIds = new Set(lighthouseViolations.map((v) => v.ruleId));

    if (ruleIds.has('unminified-javascript') || ruleIds.has('unminified-css')) {
      lines.push('### Minification');
      lines.push('- Run `pnpm build:prod` (or `MINIFY=true pnpm build`) to enable esbuild minification');
      lines.push('- Configured in `vite.config.ts`: `minify: process.env.MINIFY === \'true\' ? \'esbuild\' : false`');
      lines.push('');
    }

    if (ruleIds.has('unused-css-rules')) {
      lines.push('### Unused CSS');
      lines.push('- Tailwind CSS v4 with JIT already tree-shakes unused utilities');
      lines.push('- `jobs-list.css` stays global (every page can have job components via Paradox runtime)');
      lines.push('- Move `job-detail.css` into `jobs-detail.liquid` only — unused on other pages');
      lines.push('');
    }

    if (ruleIds.has('largest-contentful-paint') || ruleIds.has('first-contentful-paint') || ruleIds.has('largest-contentful-paint-element')) {
      lines.push('### LCP / FCP Optimization');
      lines.push('- Preload hero image: add `<link rel="preload" as="image" href="...hero.webp">` in head.liquid');
      lines.push('- Add `fetchpriority="high"` to hero `<img>` and ensure it does NOT have `loading="lazy"`');
      lines.push('- Preconnect for CloudFront CDN is already in place (good)');
      lines.push('');
    }

    if (ruleIds.has('render-blocking-resources')) {
      lines.push('### Render-Blocking Resources');
      lines.push('- Google Fonts already use async pattern (preload + media=print onload)');
      lines.push('- Verify no synchronous `<script>` tags block rendering in head.liquid');
      lines.push('- Add `defer` to any render-blocking `<script src=...>` tags');
      lines.push('');
    }

    // Resource-level details from enriched hints
    for (const v of lighthouseViolations) {
      if (v.fix?.hint?.includes('Resources:')) {
        lines.push(`### ${v.ruleId}`);
        lines.push(`- ${v.fix.hint}`);
        lines.push('');
      }
    }
  }

  return lines.join('\n');
}
