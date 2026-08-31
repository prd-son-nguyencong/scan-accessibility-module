import { writeFileSync, mkdirSync, readdirSync, rmSync, existsSync } from 'fs';
import path from 'path';
import { getProjectRoot } from '../../utils/paths.js';
import { groupViolations } from '../../schema.js';

const ROOT = getProjectRoot();

/** Element HTML is truncated in patches; long enough to identify the node. */
const ELEMENT_HTML_LIMIT = 600;

/** Findings whose source file could not be resolved land here instead of being dropped. */
const UNRESOLVED_FILE = 'unknown';
const UNRESOLVED_PATCH = '_unresolved.patch';
const INDEX_FILE = '_index.json';

/**
 * Cursor IDE integration mode.
 *
 * Writes:
 * - .cursor/patches/<src__path__to__file>.patch — one block per *occurrence*
 * - .cursor/patches/_unresolved.patch — findings with no source file
 * - .cursor/patches/_index.json — machine-readable reconciliation index
 * - .cursor/rules/scan-fixes.md — full context + fix instructions
 *
 * Patch files are grouped by SOURCE FILE, not by scanned page: one `--page /`
 * run renders the whole page, so its findings fan out across every partial the
 * page pulls in.
 *
 * The directory is pruned first. Patches are derived output: a file left behind
 * from an earlier run describes work that may already be done, and an agent
 * working the folder would redo it.
 */
export async function writeFixContext(violations, config = {}, options = {}) {
  const scanScope = options.scanScope || null;
  // Only a run covering every configured page may prune: a --page run knows
  // nothing about the other pages, and their patches are still valid work.
  const authoritative = !scanScope || !scanScope.partial;
  const patchDir = path.join(ROOT, '.cursor', 'patches');
  const rulesDir = path.join(ROOT, '.cursor', 'rules');
  mkdirSync(patchDir, { recursive: true });
  mkdirSync(rulesDir, { recursive: true });

  const pruned = authoritative ? prunePatchDir(patchDir) : 0;

  // Expand each finding into its individual occurrences. A finding with
  // count > 1 matched several DOM nodes; evidence.observations carries one
  // record per node, each with its own element and source location.
  const occurrences = violations.flatMap(toOccurrences);

  const byFile = groupViolations(occurrences, (o) => o.file || UNRESOLVED_FILE);

  const index = {
    generatedAt: new Date().toISOString(),
    totals: {
      findings: violations.length,
      occurrences: occurrences.length,
      declaredOccurrences: violations.reduce((n, v) => n + (v.count || 1), 0),
      unresolved: (byFile.get(UNRESOLVED_FILE) || []).length,
      // Layers disagree on how to count: some report one observation per node,
      // others one observation carrying a node count. Both totals are recorded
      // so a mismatch is visible rather than silently swallowed.
      nodesCovered: occurrences.reduce((n, o) => n + (o.nodeCount || 1), 0),
      prunedStalePatches: pruned,
    },
    scope: scanScope
      ? {
        routes: scanScope.routes,
        scannedPageCount: scanScope.scannedPageCount,
        configuredPageCount: scanScope.configuredPageCount,
        partial: scanScope.partial,
        authoritative,
      }
      : { partial: false, authoritative: true },
    files: {},
  };

  for (const [file, fileOccurrences] of byFile) {
    const patchName = file === UNRESOLVED_FILE
      ? UNRESOLVED_PATCH
      : `${file.replace(/[/\\]/g, '__').replace(/\.liquid$/, '')}.patch`;

    const body = fileOccurrences.map(renderOccurrence).join('\n\n');
    const provenance = [
      `# Generated ${index.generatedAt}`,
      `# Routes scanned: ${scanScope?.routes?.join(', ') || 'all configured pages'}`,
      authoritative ? '' : '# PARTIAL RUN — other patch files in this directory are from earlier runs.',
      '',
      '',
    ].filter((line) => line !== null).join('\n');
    const header = file === UNRESOLVED_FILE
      ? [
        '# Unresolved source attribution',
        '#',
        '# These findings are real, but the scanner could not map them back to a',
        '# source file. Usually that means dist/scan-manifest.json is missing or',
        '# stale — check that scanInstrumentationPlugin() from "ada-scan/vite" is',
        '# registered in the host vite config and that the build ran SCAN_MODE=true.',
        '',
        '',
      ].join('\n')
      : '';

    writeFileSync(path.join(patchDir, patchName), provenance + header + body, 'utf8');

    index.files[file] = {
      patch: path.relative(ROOT, path.join(patchDir, patchName)),
      occurrences: fileOccurrences.length,
      findingIds: [...new Set(fileOccurrences.map((o) => o.findingId))],
      rules: [...new Set(fileOccurrences.map((o) => o.ruleId))].sort(),
    };
  }

  writeFileSync(path.join(patchDir, INDEX_FILE), JSON.stringify(index, null, 2), 'utf8');

  const ruleContent = buildScanFixesRule(occurrences, byFile, index);
  writeFileSync(path.join(rulesDir, 'scan-fixes.md'), ruleContent, 'utf8');

  const fileCount = byFile.size - (byFile.has(UNRESOLVED_FILE) ? 1 : 0);
  console.log(`  Cursor patches: ${patchDir} (${fileCount} file(s), ${occurrences.length} occurrence(s))`);
  if (pruned) console.log(`  Pruned ${pruned} stale patch file(s) from a previous run.`);
  if (!authoritative) {
    const routes = scanScope.routes.join(', ');
    console.warn(
      `  WARNING: partial run — scanned ${scanScope.scannedPageCount} of `
      + `${scanScope.configuredPageCount} configured page(s) (${routes}). `
      + 'Patch files for pages that were not scanned were left untouched and may be stale. '
      + 'Drop --page to regenerate patches for the whole site.'
    );
  }
  if (index.totals.unresolved > 0) {
    console.warn(
      `  WARNING: ${index.totals.unresolved} finding(s) have no source file — see ${UNRESOLVED_PATCH}. `
      + 'Source attribution is incomplete; patches do not cover every finding.'
    );
  }
  console.log(`  Cursor index: ${path.join(patchDir, INDEX_FILE)}`);
  console.log(`  Cursor rule: ${path.join(rulesDir, 'scan-fixes.md')}`);

  return index;
}

/**
 * Deletes patch files this writer owns so output reflects only the current scan.
 * Only *.patch and the generated index are removed; anything else is left alone.
 */
function prunePatchDir(patchDir) {
  if (!existsSync(patchDir)) return 0;
  let removed = 0;
  for (const entry of readdirSync(patchDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.patch') && entry.name !== INDEX_FILE) continue;
    rmSync(path.join(patchDir, entry.name));
    removed += 1;
  }
  return removed;
}

/**
 * One finding -> one record per matched element. Falls back to the finding's
 * representative element when a layer reports no per-node observations.
 */
function toOccurrences(violation) {
  const observations = violation.evidence?.observations || [];
  const base = {
    findingId: violation.id,
    ruleId: violation.ruleId,
    canonicalRuleId: violation.canonicalRuleId,
    layer: violation.layer,
    priority: violation.priority,
    impact: violation.impact,
    wcagRef: violation.wcagRef,
    hint: violation.fix?.hint,
    patch: violation.fix?.patch,
    deterministic: violation.fix?.deterministic,
    manualChecks: violation.manualChecks,
    total: Math.max(observations.length, 1),
  };

  if (observations.length === 0) {
    return [{
      ...base,
      nth: 1,
      file: violation.source?.file || null,
      line: violation.source?.line || null,
      snippet: violation.source?.snippet || null,
      selector: violation.element?.selector || null,
      outerHTML: violation.element?.outerHTML || null,
      nodeCount: violation.count || 1,
    }];
  }

  return observations.map((observation, i) => ({
    ...base,
    nth: i + 1,
    ruleId: observation.nativeRuleId || base.ruleId,
    impact: observation.impact || base.impact,
    wcagRef: observation.wcagRef || base.wcagRef,
    hint: observation.message || base.hint,
    file: observation.source?.file || violation.source?.file || null,
    line: observation.source?.line ?? violation.source?.line ?? null,
    snippet: observation.source?.snippet || violation.source?.snippet || null,
    selector: observation.element?.selector || null,
    outerHTML: observation.element?.outerHTML || null,
    nodeCount: observation.count || 1,
  }));
}

function renderOccurrence(o) {
  const location = `${o.file || UNRESOLVED_FILE}:${o.line ?? '?'}`;
  const canonical = o.canonicalRuleId && o.canonicalRuleId !== o.ruleId
    ? ` [canonical: ${o.canonicalRuleId}]`
    : '';
  const position = o.total > 1 ? ` (occurrence ${o.nth} of ${o.total})` : '';
  // A single observation can stand for several identical nodes; say so, or an
  // agent fixes one and believes the finding is cleared.
  const nodes = o.nodeCount > 1 ? `Matches: ${o.nodeCount} elements — fix all of them` : '';

  return [
    `--- ${location}`,
    `Finding: ${o.findingId}${position}`,
    `Rule: ${o.ruleId}${canonical} (${o.layer}) — P${o.priority} ${o.impact}`,
    `WCAG: ${o.wcagRef || 'N/A'}`,
    `Fix: ${o.hint || 'No hint'}`,
    nodes,
    o.deterministic === false ? 'Deterministic: no — needs judgment, do not auto-apply blindly' : '',
    renderManualChecks(o.manualChecks),
    o.patch ? `Patch:\n${o.patch}` : '',
    o.selector ? `Selector: ${o.selector}` : '',
    o.outerHTML ? `Element:\n${truncate(o.outerHTML, ELEMENT_HTML_LIMIT)}` : '',
    o.snippet ? `Source:\n${o.snippet}` : '',
    '---',
  ]
    .filter(Boolean)
    .join('\n');
}

function renderManualChecks(manualChecks) {
  if (!Array.isArray(manualChecks) || manualChecks.length === 0) return '';
  const lines = manualChecks.map((check) => {
    const text = typeof check === 'string' ? check : (check.question || check.message || JSON.stringify(check));
    return `  - ${text}`;
  });
  return `Manual checks:\n${lines.join('\n')}`;
}

function truncate(text, limit) {
  return text.length > limit ? `${text.slice(0, limit)}…[truncated]` : text;
}

function buildScanFixesRule(occurrences, byFile, index) {
  const lines = [
    '# Scan Fix Instructions',
    '',
    `> Auto-generated ${index.generatedAt} — ${index.totals.findings} findings, `
      + `${index.totals.occurrences} occurrences across ${Object.keys(index.files).length} file(s)`,
    '',
    '## Instructions',
    '',
    'Fix every occurrence below in the file it names. Follow the WCAG reference and the fix hint.',
    'Entries marked `[Manual]` need a judgment call — read the manual check before changing anything.',
    'Occurrences of the same finding usually share one source line: a single edit fixes them all.',
    'After fixing, re-run the scan to verify.',
    '',
  ];

  if (index.totals.unresolved > 0) {
    lines.push(
      '## ⚠ Incomplete coverage',
      '',
      `${index.totals.unresolved} finding(s) could not be traced to a source file and are listed under`,
      '`unknown` below. This list does NOT cover every finding until that is resolved —',
      'register `scanInstrumentationPlugin()` from `ada-scan/vite` in the host vite config',
      'and confirm the build emits `dist/scan-manifest.json`.',
      '',
    );
  }

  lines.push('## Violations by File', '');

  for (const [file, fileOccurrences] of byFile) {
    lines.push(`### ${file}`, '');
    for (const o of fileOccurrences) {
      const badge = o.deterministic ? '[Auto-fix]' : '[Manual]';
      const position = o.total > 1 ? ` — occurrence ${o.nth}/${o.total}` : '';
      lines.push(`- **${o.ruleId}** ${badge} (P${o.priority}, ${o.impact})${position}`);
      lines.push(`  - Finding: \`${o.findingId}\``);
      if (o.line) lines.push(`  - Line: ${o.line}`);
      if (o.wcagRef) lines.push(`  - WCAG: ${o.wcagRef}`);
      lines.push(`  - Fix: ${o.hint || 'Review manually'}`);
      if (o.selector) lines.push(`  - Selector: \`${o.selector}\``);
      if (o.outerHTML) lines.push(`  - Element: \`${truncate(o.outerHTML, 200)}\``);
      if (o.snippet) {
        lines.push('  - Source context:');
        lines.push('  ```liquid');
        for (const snippetLine of o.snippet.split('\n')) lines.push(`  ${snippetLine}`);
        lines.push('  ```');
      }
    }
    lines.push('');
  }

  const lighthouse = occurrences.filter((o) => o.layer === 'lighthouse');
  if (lighthouse.length > 0) {
    lines.push('## Performance Optimization Guide', '');
    lines.push('Based on Lighthouse audit, here are actionable fixes to improve scores:', '');

    const ruleIds = new Set(lighthouse.map((o) => o.ruleId));

    if (ruleIds.has('unminified-javascript') || ruleIds.has('unminified-css')) {
      lines.push('### Minification');
      lines.push('- Run `pnpm build:prod` (or `MINIFY=true pnpm build`) to enable esbuild minification');
      lines.push('- Configured in `vite.config.ts`: `minify: process.env.MINIFY === \'true\' ? \'esbuild\' : false`');
      lines.push('');
    }

    if (ruleIds.has('unused-css-rules')) {
      lines.push('### Unused CSS');
      lines.push('- Tailwind CSS v4 with JIT already tree-shakes unused utilities');
      lines.push('- Split page-specific CSS so it only loads on the page that needs it');
      lines.push('');
    }

    if (ruleIds.has('largest-contentful-paint') || ruleIds.has('first-contentful-paint') || ruleIds.has('largest-contentful-paint-element')) {
      lines.push('### LCP / FCP Optimization');
      lines.push('- Preload the hero image: `<link rel="preload" as="image" href="...">` in the head partial');
      lines.push('- Add `fetchpriority="high"` to the hero `<img>` and ensure it has no `loading="lazy"`');
      lines.push('');
    }

    if (ruleIds.has('render-blocking-resources')) {
      lines.push('### Render-Blocking Resources');
      lines.push('- Verify no synchronous `<script>` tags block rendering in the head partial');
      lines.push('- Add `defer` to any render-blocking `<script src=...>` tags');
      lines.push('');
    }

    for (const o of lighthouse) {
      if (o.hint?.includes('Resources:')) {
        lines.push(`### ${o.ruleId}`);
        lines.push(`- ${o.hint}`);
        lines.push('');
      }
    }
  }

  return lines.join('\n');
}
