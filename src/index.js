import { loadConfig } from './utils/config.js';
import { ensureServer } from './utils/server.js';
import { buildInstrumented, loadScanManifest } from './tracer/build-instrumented.js';
import { clearPartialCache, mapViolationToSource } from './tracer/partial-map.js';
import { scanPageWithAxe } from './scanner/axe.js';
import { scanWithAccessScan } from './scanner/access-scan/index.js';
import { scanKeyboardNavigation } from './scanner/keyboard.js';
import { scanFocusTraps } from './scanner/focus-trap.js';
import { scanAriaLiveRegions } from './scanner/aria-live.js';
import { scanDynamicContent } from './scanner/dynamic-content.js';
import { scanScreenReaderAccessibility } from './scanner/screen-reader.js';
import { scanW3cValidation } from './scanner/w3c.js';
import { scanDeadLinks } from './scanner/links.js';
import { scanWithLighthouse } from './scanner/lighthouse.js';
import { getBrowser, newPage, closeBrowser, resilientGoto } from './scanner/browser.js';
import { createViolation, impactToPriority, normalizeLighthouseViolation } from './schema.js';
import { writeReport, writeBaseline, loadBaseline, printConsoleSummary } from './reporter/scan-report.js';
import { writeHtmlReport } from './reporter/html.js';
import { runFixEngine } from './fixer/engine.js';
import { generateExecSummary } from './reporter/exec-summary.js';
import { gitChangedSinceLastCommit } from './utils/git.js';
import path from 'path';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { getProjectRoot, urlToPageFile } from './utils/paths.js';

const PAGE_TIMEOUT_MS = 30000;
const REMOTE_PAGE_TIMEOUT_MS = 60000;
const PROJECT_ROOT = getProjectRoot();

// ─── Source tracing helpers ───────────────────────────────────────────────────

function findInLiquidSource(srcDir, searchHint) {
  try {
    const walk = (dir) => {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          const result = walk(full);
          if (result) return result;
        } else if (entry.name.endsWith('.liquid')) {
          const content = readFileSync(full, 'utf-8');
          const lines = content.split('\n');
          for (let i = 0; i < lines.length; i++) {
            if (lines[i].includes(searchHint)) {
              const relPath = path.relative(PROJECT_ROOT, full);
              return { file: relPath, line: i + 1 };
            }
          }
        }
      }
      return null;
    };
    return walk(srcDir);
  } catch {
    return null;
  }
}

function enrichLocalSnippets(violations) {
  for (const v of violations) {
    if (v.source?.snippet || !v.source?.file || !v.source?.line) continue;
    try {
      const filePath = path.isAbsolute(v.source.file)
        ? v.source.file
        : path.join(PROJECT_ROOT, v.source.file);
      if (!existsSync(filePath)) continue;
      const lines = readFileSync(filePath, 'utf8').split('\n');
      const lineNum = v.source.line;
      const start = Math.max(0, lineNum - 5);
      const end = Math.min(lines.length, lineNum + 5);
      v.source.snippet = lines.slice(start, end).map((l, i) => {
        const num = start + i + 1;
        const marker = num === lineNum ? '>' : ' ';
        return `${marker} ${String(num).padStart(4)} | ${l}`;
      }).join('\n');
    } catch { /* skip if file read fails */ }
  }
}

/**
 * Fingerprint-based deduplication of violations.
 *
 * Within-rule dedup: violations with identical (ruleId + normalized-outerHTML-prefix)
 * are collapsed into one, incrementing the `count` field.
 *
 * Cross-scanner related: violations from different rules but targeting the same
 * element get `related[]` populated with the other rule IDs.
 */
function deduplicateViolations(violations) {
  // Phase 1: Collapse identical violations (same rule + same HTML content).
  // Selector is excluded so mobile/desktop duplicates of the same element merge.
  const fingerprint = (v) => {
    const html = (v.element?.outerHTML || '').replace(/\s+/g, ' ').trim().slice(0, 300);
    if (html.length >= 10) return `${v.ruleId}|${html}`;
    return `${v.ruleId}|${(v.fix?.hint || '').replace(/\s+/g, ' ').slice(0, 120)}`;
  };

  const seen = new Map();
  const deduped = [];

  for (const v of violations) {
    const fp = fingerprint(v);
    if (seen.has(fp)) {
      seen.get(fp).count = (seen.get(fp).count || 1) + 1;
    } else {
      seen.set(fp, v);
      deduped.push(v);
    }
  }

  // Phase 2: Cross-scanner related — violations from different rules targeting the same element
  const elementKey = (v) => {
    const html = (v.element?.outerHTML || '').replace(/\s+/g, ' ').trim().slice(0, 300);
    return html.length >= 10 ? html : null;
  };

  const byElement = new Map();
  for (const v of deduped) {
    const ek = elementKey(v);
    if (!ek) continue;
    if (!byElement.has(ek)) byElement.set(ek, []);
    byElement.get(ek).push(v);
  }
  for (const group of byElement.values()) {
    if (group.length < 2) continue;
    for (const v of group) {
      v.related = group.filter((o) => o.ruleId !== v.ruleId).map((o) => o.ruleId);
    }
  }

  return deduped;
}

/**
 * Enriches violations with partial-level source tracing.
 *
 * Uses two strategies (in order):
 *  1. partial-file-search — substring match of outerHTML in dist/partials/*.html
 *  2. page-html-comment — scan:begin/end markers in the assembled dist page HTML
 *
 * Sets source.partial and source.page so the report can show
 * "src/pages/index.liquid -> src/partials/layout/header" breadcrumb.
 */
async function traceToPartials(violations, pageUrl) {
  const manifestPath = path.join(PROJECT_ROOT, 'dist', 'scan-manifest.json');
  if (!existsSync(manifestPath)) return;

  let pageFile;
  try {
    const urlPath = new URL(pageUrl).pathname;
    pageFile = urlToPageFile(urlPath);
  } catch { return; }

  for (const v of violations) {
    const html = v.element?.outerHTML || '';
    if (html.length < 10) {
      if (!v.source.file || v.source.file === 'unknown') {
        v.source.file = pageFile;
        v.source.page = pageFile;
      }
      continue;
    }

    const currentFile = v.source?.file;
    if (currentFile?.startsWith('src/partials/')) {
      v.source.partial = currentFile;
      v.source.page = pageFile;
      continue;
    }

    try {
      const traced = await mapViolationToSource({ html }, pageUrl);
      if (traced?.file?.startsWith('src/partials/')) {
        v.source.partial = traced.file;
        v.source.page = pageFile;
        v.source.file = traced.file;
        if (traced.line) v.source.line = traced.line;
      } else {
        // Head-level elements (<meta>, <link>, <script>) live in head.liquid or scripts.liquid
        const isHeadTag = /^<(meta|link)\b/i.test(html);
        const isScriptTag = /^<script\b/i.test(html);
        if (isHeadTag || isScriptTag) {
          const headPartials = isScriptTag
            ? ['src/partials/layout/scripts.liquid', 'src/partials/layout/head.liquid']
            : ['src/partials/layout/head.liquid'];
          for (const partial of headPartials) {
            const fullPath = path.join(PROJECT_ROOT, partial);
            if (!existsSync(fullPath)) continue;
            const content = readFileSync(fullPath, 'utf-8');
            const lines = content.split('\n');
            const attrMatch = html.match(/(?:name|property|content|rel|href|src)="([^"]+)"/);
            const searchStr = attrMatch?.[1];
            if (searchStr && searchStr.length >= 3) {
              for (let i = 0; i < lines.length; i++) {
                if (lines[i].includes(searchStr)) {
                  v.source.partial = partial;
                  v.source.page = pageFile;
                  v.source.file = partial;
                  v.source.line = i + 1;
                  break;
                }
              }
            }
            if (v.source.partial) break;
          }
          if (v.source.partial) {
            v.source.page = pageFile;
            if (!v.source.file || v.source.file === 'unknown') v.source.file = pageFile;
            continue;
          }
        }

        const idMatch = html.match(/id="([^"]+)"/);
        const classStr = (html.match(/class="([^"]+)"/) || [])[1] || '';
        const uniqueClasses = classStr.split(/\s+/).filter(c =>
          c.length > 4 && !c.startsWith('text-') && !c.startsWith('p-') && !c.includes(':')
        );
        const ariaLabel = (html.match(/aria-label="([^"]+)"/) || [])[1];
        const href = (html.match(/href="([^"]{5,})"/) || [])[1];
        const hints = [
          idMatch?.[1],
          ariaLabel,
          uniqueClasses.length >= 2 ? uniqueClasses.slice(0, 2).join(' ') : null,
          ...uniqueClasses,
          href && !href.startsWith('#') && !href.startsWith('http') ? href : null,
        ].filter(Boolean);
        const searchDirs = [
          path.join(PROJECT_ROOT, 'src', 'partials'),
          path.join(PROJECT_ROOT, 'src', 'pages'),
          path.join(PROJECT_ROOT, 'src', 'components'),
        ];
        let found = false;
        for (const hint of hints) {
          for (const srcDir of searchDirs) {
            if (!existsSync(srcDir)) continue;
            const matched = findInLiquidSource(srcDir, hint);
            if (matched) {
              v.source.partial = matched.file;
              v.source.page = pageFile;
              v.source.file = matched.file;
              if (matched.line) v.source.line = matched.line;
              found = true;
              break;
            }
          }
          if (found) break;
        }
        if (!v.source.file || v.source.file === 'unknown') {
          v.source.file = pageFile;
        }
        v.source.page = pageFile;
      }
    } catch { /* tracing is best-effort */ }
  }
}

/**
 * Best-effort tracing for remote scans when run from the project directory.
 * Uses hint-based search against local src/ files (no instrumented build needed).
 */
function traceRemoteToLocal(violations) {
  const searchDirs = [
    path.join(PROJECT_ROOT, 'src', 'partials'),
    path.join(PROJECT_ROOT, 'src', 'pages'),
    path.join(PROJECT_ROOT, 'src', 'components'),
  ];
  for (const v of violations) {
    const html = v.element?.outerHTML || '';
    if (html.length < 10) continue;
    if (v.source?.file && v.source.file !== 'unknown' && v.source?.line) continue;

    const idMatch = html.match(/id="([^"]+)"/);
    const classStr = (html.match(/class="([^"]+)"/) || [])[1] || '';
    const uniqueClasses = classStr.split(/\s+/).filter(c =>
      c.length > 4 && !c.startsWith('text-') && !c.startsWith('p-') && !c.includes(':')
    );
    const ariaLabel = (html.match(/aria-label="([^"]+)"/) || [])[1];
    const dataTestid = (html.match(/data-testid="([^"]+)"/) || [])[1];
    const hints = [
      idMatch?.[1],
      ariaLabel,
      dataTestid,
      uniqueClasses.length >= 2 ? uniqueClasses.slice(0, 2).join(' ') : null,
      ...uniqueClasses,
    ].filter(Boolean);

    let found = false;
    for (const hint of hints) {
      for (const srcDir of searchDirs) {
        if (!existsSync(srcDir)) continue;
        const matched = findInLiquidSource(srcDir, hint);
        if (matched) {
          v.source = {
            ...v.source,
            file: matched.file,
            line: matched.line,
            partial: matched.file,
            confidence: 'medium',
            method: 'remote-hint-search',
          };
          found = true;
          break;
        }
      }
      if (found) break;
    }

    if (!found && (!v.source?.file || v.source.file === 'unknown' || v.source.file === null)) {
      const tag = html.match(/^<(\w+)/)?.[1]?.toLowerCase();
      if (['meta', 'link', 'title', 'script'].includes(tag)) {
        const headFile = 'src/partials/layout/head.liquid';
        if (existsSync(path.join(PROJECT_ROOT, headFile))) {
          const line = findInLiquidSource(path.join(PROJECT_ROOT, 'src', 'partials', 'layout'), tag === 'title' ? '<title' : html.match(/name="([^"]+)"/)?.[1] || tag)?.line ?? null;
          v.source = { ...v.source, file: headFile, line, partial: headFile, confidence: line ? 'medium' : 'low', method: 'remote-head-fallback' };
        }
      }
    }
  }
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

export async function runCli() {
  const rawArgs = process.argv.slice(2);
  const args = new Set(rawArgs);

  const dryRun = args.has('--dry-run');
  const fix = args.has('--fix');
  const useAI = args.has('--ai');
  const baselineMode = args.has('--baseline');
  const reportOnly = args.has('--report-only');
  const forceBuild = args.has('--force-build');
  const changedOnly = args.has('--changed-only');
  const useUI = args.has('--ui');
  const agentMode = args.has('--agent');
  const allPages = args.has('--all');
  const verbose = args.has('--verbose');
  const noFail = args.has('--no-fail');
  const includeThirdParty = args.has('--include-third-party');
  const forcePSI = args.has('--psi');
  const noPSI = args.has('--no-psi');
  const failOnViolations = args.has('--fail-on-violations');

  const urlIdx = rawArgs.indexOf('--url');
  const urlArg = urlIdx !== -1 ? rawArgs[urlIdx + 1] : null;

  const pageIdx = rawArgs.indexOf('--page');
  const pageFilter = pageIdx !== -1 ? rawArgs[pageIdx + 1] : null;

  const layersIdx = rawArgs.indexOf('--layers');
  const layersArg = layersIdx !== -1 ? rawArgs[layersIdx + 1] : null;

  const fixModeIdx = rawArgs.indexOf('--fix-mode');
  const fixMode = fixModeIdx !== -1 ? rawArgs[fixModeIdx + 1] : 'claude';

  const config = loadConfig();

  config.layers = {
    ...config.layers,
    accessScan: config.layers.accessScan ?? true,
    links: config.layers.links ?? true,
  };

  if (layersArg) {
    const activeLayerNames = layersArg.split(',');
    for (const key of Object.keys(config.layers)) {
      config.layers[key] = activeLayerNames.includes(key);
    }
  }

  if (forcePSI) config.usePSI = true;
  if (noPSI) config.usePSI = false;

  console.log('\nADA & Performance Scanner v2');
  console.log('============================');
  if (dryRun) console.log('DRY RUN — no files will be modified');
  if (baselineMode) console.log('BASELINE MODE — saving results as ROI baseline');
  if (allPages) console.log('ALL PAGES — explicit all-page scan');
  if (changedOnly) console.log('CHANGED-ONLY — scanning pages with modified .liquid files');
  if (fix) console.log(`FIX MODE: ${fixMode}`);

  if (verbose) {
    const activeLayers = Object.entries(config.layers).filter(([, v]) => v).map(([k]) => k);
    console.log(`LAYERS: ${activeLayers.join(', ')}`);
  }

  if (reportOnly) {
    const latestPath = path.join(PROJECT_ROOT, 'scan-reports', 'latest.json');
    if (!existsSync(latestPath)) {
      console.error('No latest scan found. Run `pnpm scan` first.');
      process.exit(1);
    }
    const latestReport = JSON.parse(readFileSync(latestPath, 'utf8'));
    const enriched = enrichReportForHtml(latestReport);
    const vPath = writeHtmlReport(enriched);
    console.log(`Visual report: ${vPath}`);
    await generateExecSummary(latestReport);
    return;
  }

  // Remote URL scan mode
  if (urlArg) {
    const isLocalUrl = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/i.test(urlArg);
    if (isLocalUrl) {
      console.log(`\nLocal URL scan: ${urlArg}`);
      console.log('Building instrumented dist for partial tracing...');
      await buildInstrumented(forceBuild);
      clearPartialCache();
    } else {
      console.log(`\nRemote URL scan: ${urlArg}`);
    }
    try {
      await runScan(
        [{ url: urlArg, name: 'remote', path: '/' }],
        config,
        {},
        { fix, fixMode, useAI, dryRun, baselineMode, useUI, agentMode, isUrlMode: !isLocalUrl, noFail, includeThirdParty, failOnViolations }
      );
    } finally {
      await closeBrowser();
    }
    return;
  }

  // Local scan
  let serverProcess = null;
  try {
    serverProcess = await ensureServer(args, config);
    await buildInstrumented(forceBuild);
    clearPartialCache();

    const manifest = loadScanManifest();
    console.log(`Manifest: ${Object.keys(manifest).length} path mappings loaded`);

    let pages = config.pages.length > 0 ? config.pages : [{ path: '/', name: 'homepage' }];

    if (pageFilter) {
      const normalizedFilter = pageFilter.replace(/^\//, '');
      const filtered = pages.filter((p) => {
        const pageName = p.name || '';
        const pagePath = p.path?.replace(/^\//, '') || '';
        return p.path === pageFilter || p.name === pageFilter ||
          pageName === normalizedFilter || pagePath === normalizedFilter ||
          (normalizedFilter === 'index' && p.path === '/');
      });
      const fallbackPath = pageFilter.startsWith('/') ? pageFilter : `/${pageFilter}`;
      pages = filtered.length > 0 ? filtered : [{ path: fallbackPath, name: normalizedFilter || 'page' }];
    }

    if (changedOnly && !pageFilter) {
      const changedFiles = gitChangedSinceLastCommit();
      if (changedFiles.length > 0) {
        const filtered = pages.filter((p) => {
          const pageName = p.name || p.path.replace(/^\//, '') || 'homepage';
          return changedFiles.some((f) => f.includes(pageName) || f.includes(p.path.replace(/^\//, '')) || f.endsWith('.liquid'));
        });
        if (filtered.length > 0) {
          pages = filtered;
          console.log(`Changed-only: scanning ${pages.length} of ${config.pages.length || 1} page(s)`);
        } else {
          console.log('Changed-only: no .liquid changes detected — scanning all pages');
        }
      }
    }

    const pagesToScan = pages.map((p) => {
      if (p.path.startsWith('http')) return { ...p, url: p.path };
      const pagePath = p.path.startsWith('/') ? p.path : `/${p.path}`;
      const base = config.baseUrl.replace(/\/$/, '');
      return { ...p, url: `${base}${pagePath}` };
    });

    const isSinglePage = pagesToScan.length === 1 || !!pageFilter;
    await runScan(pagesToScan, config, manifest, {
      fix, fixMode, useAI, dryRun, baselineMode, useUI, agentMode,
      isUrlMode: false, isSinglePage, noFail, includeThirdParty, failOnViolations,
    });
  } finally {
    await closeBrowser();
    if (serverProcess) {
      console.log('\nStopping dev server...');
      serverProcess.kill();
    }
  }
}

// ─── Concurrency helper ───────────────────────────────────────────────────────

async function runWithConcurrency(tasks, limit) {
  const results = new Array(tasks.length);
  const queue = tasks.map((task, idx) => ({ task, idx }));
  const running = new Set();

  async function runNext() {
    if (queue.length === 0) return;
    const { task, idx } = queue.shift();
    const p = task().then((result) => {
      results[idx] = result;
      running.delete(p);
    });
    running.add(p);
    await p;
    return runNext();
  }

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => runNext());
  await Promise.all(workers);
  return results;
}

// ─── Progress display (multi-page) ───────────────────────────────────────────

function createProgressDisplay(pages) {
  const state = pages.map((p) => ({ name: p.name || p.path, status: 'queued', violations: 0, error: null }));
  let startTime = Date.now();

  function render() {
    const done = state.filter((s) => s.status === 'done' || s.status === 'error').length;
    const total = state.length;
    const barWidth = 30;
    const filled = Math.round((done / total) * barWidth);
    const bar = '='.repeat(filled) + (filled < barWidth ? '>' : '') + ' '.repeat(Math.max(0, barWidth - filled - 1));
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    const mins = String(Math.floor(elapsed / 60)).padStart(2, '0');
    const secs = String(elapsed % 60).padStart(2, '0');

    const lines = [`\nScanning ${total} pages  [${bar}]  ${done} / ${total}\n`];
    for (const s of state) {
      const pad = s.name.padEnd(22);
      if (s.status === 'done') {
        lines.push(`  ${pad} done    ${s.violations} violations`);
      } else if (s.status === 'error') {
        lines.push(`  ${pad} error — ${s.error}`);
      } else if (s.status === 'scanning') {
        lines.push(`  ${pad} scanning...`);
      } else {
        lines.push(`  ${pad} queued`);
      }
    }
    lines.push(`\nElapsed: ${mins}:${secs}`);

    const totalLines = lines.length;
    process.stdout.write(`\x1b[${totalLines + 1}A`);
    for (const line of lines) {
      process.stdout.write(`\x1b[2K${line}\n`);
    }
  }

  return {
    start() {
      startTime = Date.now();
      process.stdout.write('\n'.repeat(state.length + 5));
      render();
    },
    update(pageIdx, status, violations = 0, error = null) {
      state[pageIdx] = { ...state[pageIdx], status, violations, error };
      render();
    },
    finish() {
      render();
      console.log('');
    },
  };
}

// ─── CSS path helper injected into Playwright pages ──────────────────────────

async function injectCssPath(page) {
  await page.addScriptTag({
    content: `
      window.cssPath = function cssPath(el) {
        if (!el || el === document.body) return 'body';
        const parts = [];
        let current = el;
        while (current && current !== document.body) {
          let selector = current.tagName.toLowerCase();
          if (current.id) {
            selector += '#' + current.id;
            parts.unshift(selector);
            break;
          }
          const parent = current.parentElement;
          if (parent) {
            const siblings = [...parent.children].filter(c => c.tagName === current.tagName);
            if (siblings.length > 1) {
              selector += ':nth-of-type(' + (siblings.indexOf(current) + 1) + ')';
            }
          }
          parts.unshift(selector);
          current = current.parentElement;
        }
        return parts.join(' > ');
      };
    `,
  });
}

// ─── Axe violations → unified schema adapter ─────────────────────────────────

function axeToUnified(axeResult, url) {
  const violations = [];
  for (const v of axeResult.violations || []) {
    for (const node of v.nodes || []) {
      if (node.devArtifact) continue;
      violations.push(
        createViolation({
          ruleId: v.id,
          layer: 'axe',
          category: 'accessibility',
          wcagRef: (v.tags || []).find((t) => t.startsWith('wcag'))?.toUpperCase(),
          impact: v.impact,
          priority: impactToPriority(v.impact),
          element: {
            outerHTML: node.html || '',
            selector: Array.isArray(node.target) ? node.target.join(' ') : String(node.target || ''),
            scanId: node.source?.snippetId || null,
          },
          source: {
            mode: 'url',
            file: node.source?.file || null,
            line: node.source?.line || null,
            snippet: null,
            url,
          },
          fix: {
            deterministic: false,
            hint: v.description || v.help || '',
          },
        })
      );
    }
  }
  return violations;
}

// ─── Per-page scan ────────────────────────────────────────────────────────────

async function scanOnePage(pageConfig, config, options = {}) {
  const url = pageConfig.url;
  const violations = [];
  const lighthouseScores = {};
  const isRemote = options.isUrlMode === true;
  const timeout = isRemote ? REMOTE_PAGE_TIMEOUT_MS : PAGE_TIMEOUT_MS;

  const browser = await getBrowser();
  let page = null;

  try {
    page = await newPage(browser);
    await resilientGoto(page, url, { timeout });
    await page.waitForTimeout(500);
    await injectCssPath(page);

    if (config.layers.axe) {
      const axeResult = await scanPageWithAxe(url, config);
      const axeViols = axeToUnified(axeResult, url);
      violations.push(...axeViols);
      console.log(`  [${pageConfig.name}] axe: ${axeViols.length} violation${axeViols.length === 1 ? '' : 's'}`);
    }

    if (config.layers.accessScan) {
      const accessViols = await scanWithAccessScan(page, url, { skipRules: config.skipRules, includeThirdParty: options.includeThirdParty });
      violations.push(...accessViols);
      console.log(`  [${pageConfig.name}] accessScan: ${accessViols.length} violation${accessViols.length === 1 ? '' : 's'}`);
    }

    // Each layer is wrapped in try/catch so a timeout in one scanner
    // (common on slow remote URLs) doesn't discard results from earlier layers.

    if (config.layers.w3c) {
      try {
        const w3cResult = await scanW3cValidation(url);
        const w3cViols = (w3cResult.violations || []).filter((v) => {
          if (v.rule === 'w3c-html-info' || v.type === 'info') return false;
          return true;
        });
        for (const v of w3cViols) {
          const impactMap = { error: 'serious', warning: 'minor' };
          const priorityMap = { error: 2, warning: 4 };
          const vType = v.type || (v.rule === 'w3c-html-error' ? 'error' : 'warning');
          const unified = createViolation({
            ruleId: v.rule || v.id || 'w3c-html-error',
            layer: 'w3c', category: 'markup',
            impact: impactMap[vType] || v.impact || 'minor',
            priority: priorityMap[vType] || 4,
            element: { outerHTML: v.element?.extract || v.html || '', selector: '' },
            source: { mode: 'url', file: v.source?.file || '', line: v.element?.line || v.line || null, url },
            fix: { deterministic: false, hint: v.description || v.message || '' },
            wcagRef: v.wcagCriteria ? `WCAG ${v.wcagCriteria}` : '',
          });
          if (v.count > 1) unified.count = v.count;
          violations.push(unified);
        }
        const infoCount = (w3cResult.violations || []).length - w3cViols.length;
        console.log(`  [${pageConfig.name}] w3c: ${w3cViols.length} violation${w3cViols.length === 1 ? '' : 's'}${infoCount > 0 ? ` (${infoCount} info filtered)` : ''}`);
      } catch (err) {
        console.log(`  [${pageConfig.name}] w3c: skipped — ${err.message.split('\n')[0]}`);
      }
    }

    if (config.layers.links) {
      try {
        const linkViols = await scanDeadLinks(page, url);
        violations.push(...linkViols);
        console.log(`  [${pageConfig.name}] links: ${linkViols.length} issue${linkViols.length === 1 ? '' : 's'}`);
      } catch (err) {
        console.log(`  [${pageConfig.name}] links: skipped — ${err.message.split('\n')[0]}`);
      }
    }

    if (config.layers.keyboard) {
      try {
        const kbResult = await scanKeyboardNavigation(url);
        for (const v of kbResult.violations || []) {
          violations.push(createViolation({
            ruleId: v.rule || v.id || 'keyboard-trap',
            layer: 'keyboard', category: 'accessibility',
            wcagRef: v.wcagCriteria ? `WCAG ${v.wcagCriteria}` : null,
            impact: v.impact || 'serious', priority: impactToPriority(v.impact || 'serious'),
            element: { outerHTML: v.element?.html || v.snippet || '', selector: v.element?.tag ? `<${v.element.tag.toLowerCase()}>` : '' },
            source: { mode: 'url', file: v.source?.file, line: v.source?.line, url },
            fix: { deterministic: false, hint: v.description || '' },
          }));
        }
      } catch (err) {
        console.log(`  [${pageConfig.name}] keyboard: skipped — ${err.message.split('\n')[0]}`);
      }
    }

    if (config.layers.focusTrap) {
      try {
        const ftResult = await scanFocusTraps(url);
        for (const v of ftResult.violations || []) {
          violations.push(createViolation({
            ruleId: v.rule || v.id || 'focus-trap',
            layer: 'focusTrap', category: 'accessibility',
            wcagRef: v.wcagCriteria ? `WCAG ${v.wcagCriteria}` : null,
            impact: 'critical', priority: 1,
            element: { outerHTML: v.element?.html || '', selector: v.element?.selector || '' },
            source: { mode: 'url', url },
            fix: { deterministic: false, hint: v.description || '' },
          }));
        }
      } catch (err) {
        console.log(`  [${pageConfig.name}] focusTrap: skipped — ${err.message.split('\n')[0]}`);
      }
    }

    if (config.layers.ariaLive) {
      try {
        const alResult = await scanAriaLiveRegions(url);
        for (const v of alResult.violations || []) {
          violations.push(createViolation({
            ruleId: v.rule || v.id || 'aria-live-missing',
            layer: 'ariaLive', category: 'accessibility',
            wcagRef: v.wcagCriteria ? `WCAG ${v.wcagCriteria}` : null,
            impact: v.impact || 'moderate', priority: 3,
            element: { outerHTML: v.element?.html || '', selector: v.element?.selector || v.element?.id || '' },
            source: { mode: 'url', url },
            fix: { deterministic: false, hint: v.description || '' },
          }));
        }
      } catch (err) {
        console.log(`  [${pageConfig.name}] ariaLive: skipped — ${err.message.split('\n')[0]}`);
      }
    }

    if (config.layers.dynamicContent) {
      try {
        const dcResult = await scanDynamicContent(url);
        for (const v of dcResult.violations || []) {
          violations.push(createViolation({
            ruleId: v.rule || v.id || 'dynamic-content',
            layer: 'dynamicContent', category: 'accessibility',
            wcagRef: v.wcagCriteria ? `WCAG ${v.wcagCriteria}` : null,
            impact: v.impact || 'moderate', priority: 3,
            element: { outerHTML: v.element?.html || v.element?.examples?.[0]?.html || '', selector: v.element?.selector || '' },
            source: { mode: 'url', url },
            fix: { deterministic: false, hint: v.description || '' },
          }));
        }
      } catch (err) {
        console.log(`  [${pageConfig.name}] dynamicContent: skipped — ${err.message.split('\n')[0]}`);
      }
    }

    if (config.layers.screenReader) {
      try {
        const srResult = await scanScreenReaderAccessibility(url);
        for (const v of srResult.violations || []) {
          violations.push(createViolation({
            ruleId: v.rule || v.id || 'screen-reader',
            layer: 'screenReader', category: 'accessibility',
            wcagRef: v.wcagCriteria ? `WCAG ${v.wcagCriteria}` : null,
            impact: v.impact || 'serious', priority: 2,
            element: { outerHTML: v.html || v.element?.outerHTML || v.element?.examples?.[0]?.html || '', selector: v.element?.selector || '' },
            source: { mode: 'url', file: v.source?.file, line: v.source?.line, url },
            fix: { deterministic: false, hint: v.description || '' },
          }));
        }
      } catch (err) {
        console.log(`  [${pageConfig.name}] screenReader: skipped — ${err.message.split('\n')[0]}`);
      }
    }
  } finally {
    if (page) await page.close().catch(() => {});
  }

  if (config.layers.lighthouse) {
    const lhResult = await scanWithLighthouse(url, config);
    lighthouseScores[pageConfig.name] = {
      scores: lhResult.scores,
      lighthouse: lhResult.lighthouse,
      source: lhResult.source,
    };
    for (const v of lhResult.violations || []) {
      if (v.impact === 'info') continue;
      violations.push(normalizeLighthouseViolation(v, 'url', { file: pageConfig.file || null, url }));
    }
    const mPerf = lhResult.lighthouse?.mobile?.scores?.performance ?? 'n/a';
    const dPerf = lhResult.lighthouse?.desktop?.scores?.performance ?? 'n/a';
    const lhSource = lhResult.source === 'psi-api' ? 'PSI API' : 'local';
    console.log(`  [${pageConfig.name}] lighthouse (${lhSource}): mobile ${mPerf}/100, desktop ${dPerf}/100`);
  }

  const dedupedViolations = deduplicateViolations(violations);
  if (!isRemote) {
    await traceToPartials(dedupedViolations, url);
    enrichLocalSnippets(dedupedViolations);
  } else if (existsSync(path.join(PROJECT_ROOT, 'src'))) {
    traceRemoteToLocal(dedupedViolations);
    enrichLocalSnippets(dedupedViolations);
  }

  return { name: pageConfig.name, url, violations: dedupedViolations, lighthouseScores };
}

// ─── Report enrichment for html.js ────────────────────────────────────────────

/**
 * Transforms unified scan results into the shape html.js expects:
 * - report.pages[].violations — unified Violation[] per page
 * - report.lighthouse — keyed by page name with { lighthouse: { mobile, desktop } }
 */
function enrichReportForHtml(report, pageResults) {
  const lighthouseData = {};

  if (pageResults) {
    for (const pr of pageResults) {
      if (pr.lighthouseScores) {
        for (const [pageName, lhData] of Object.entries(pr.lighthouseScores)) {
          lighthouseData[pageName] = lhData;
        }
      }
    }
  } else {
    for (const page of report.pages || []) {
      const pageName = page.page || 'homepage';
      if (page.lighthouse?.lighthouse) {
        lighthouseData[pageName] = { lighthouse: page.lighthouse.lighthouse };
      }
    }
  }

  return { ...report, lighthouse: lighthouseData };
}

// ─── Main scan orchestrator ───────────────────────────────────────────────────

async function runScan(pages, config, _manifest, options) {
  const { fix, fixMode, useAI, dryRun, baselineMode, useUI, agentMode, isSinglePage, noFail, includeThirdParty, failOnViolations } = options;
  const concurrency = config.concurrency || 2;

  console.log(`\nScanning ${pages.length} page(s) with concurrency ${concurrency}...`);

  let progress = null;
  if (!isSinglePage && pages.length > 1) {
    progress = createProgressDisplay(pages);
    progress.start();
  }

  const tasks = pages.map((page, idx) => async () => {
    if (progress) progress.update(idx, 'scanning');
    try {
      const result = await scanOnePage(page, config, options);
      if (progress) progress.update(idx, 'done', result.violations.length);
      return result;
    } catch (err) {
      if (progress) progress.update(idx, 'error', 0, err.message);
      console.error(`  [${page.name}] ERROR: ${err.message}`);
      return { name: page.name, url: page.url, violations: [], lighthouseScores: {} };
    }
  });

  const pageResults = await runWithConcurrency(tasks, concurrency);

  if (progress) progress.finish();

  // Build old-style scanResults for writeReport() (per-layer shape)
  const scanResults = pageResults.map((pr) => ({
    page: pr.name,
    url: pr.url,
    violations: pr.violations,
    lighthouseScores: pr.lighthouseScores,
  }));

  const { report, latestPath, histDir } = writeReport(scanResults);
  printConsoleSummary(report);
  console.log(`Report: ${latestPath}`);

  try {
    const enriched = enrichReportForHtml(report, pageResults);
    enriched.pages = enriched.pages?.map((p) => {
      const pr = pageResults.find((r) => r.url === p.url || r.name === p.page);
      if (pr) return { ...p, violations: pr.violations };
      return p;
    });
    const htmlPath = writeHtmlReport(enriched);
    console.log(`Visual report: ${htmlPath}`);
  } catch (err) {
    console.error(`HTML report error: ${err.message}`);
  }

  if (baselineMode) {
    const baselinePath = writeBaseline(report);
    console.log(`Baseline saved: ${baselinePath}`);
  }

  if (fix) {
    const allViolations = pageResults.flatMap((p) => p.violations || []);
    const session = await runFixEngine(allViolations, {
      fixMode, dryRun, useUI, useAI, agent: agentMode, config, includeThirdParty,
    });
    console.log(`Fix session: ${session.fixes.length} fix(es), ${session.skipped.length} skipped`);
  }

  await generateExecSummary(report).catch((err) => {
    console.warn(`ROI report warning: ${err.message}`);
  });

  if (!noFail && options.failOnViolations && report.summary.totalViolations > 0) {
    process.exitCode = 1;
  }

  return report;
}

