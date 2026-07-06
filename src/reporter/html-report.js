import { writeFileSync } from 'fs';
import path from 'path';
import { getProjectRoot } from '../utils/paths.js';

const ROOT = getProjectRoot();
const REPORTS_DIR = path.join(ROOT, 'scan-reports');

/**
 * Generates a visual per-partial diff report for the QA team.
 * Output: scan-reports/scan-visual.html
 *
 * Features:
 * - Collapsible per-page sections with violation counts
 * - Per-violation: source file:line, layer badge, impact badge, HTML snippet
 * - Fix status badge (auto-fixable / AI / manual)
 * - Layer filter controls
 */
export function writeVisualReport(report) {
  const outPath = path.join(REPORTS_DIR, 'scan-visual.html');
  writeFileSync(outPath, buildVisualReport(report));
  return outPath;
}

// ─── Impact helpers ───────────────────────────────────────────────────────────

const IMPACT_COLORS = {
  critical: { bg: '#fde8e8', border: '#e53e3e', text: '#c53030' },
  serious:  { bg: '#fff0e0', border: '#dd6b20', text: '#c05600' },
  moderate: { bg: '#fffde6', border: '#d69e2e', text: '#b7791f' },
  minor:    { bg: '#f0fff4', border: '#38a169', text: '#276749' },
  info:     { bg: '#ebf8ff', border: '#3182ce', text: '#2b6cb0' },
};

function impactBadge(impact) {
  const c = IMPACT_COLORS[impact] || IMPACT_COLORS.info;
  return `<span class="badge" style="background:${c.bg};border-color:${c.border};color:${c.text}">${impact || 'info'}</span>`;
}

// ─── Layer helpers ────────────────────────────────────────────────────────────

const LAYER_META = {
  axe:           { label: 'axe-core',     color: '#4f6ef7' },
  w3c:           { label: 'W3C',          color: '#f7a74f' },
  keyboard:      { label: 'Keyboard',     color: '#e05c5c' },
  focusTrap:     { label: 'Focus Trap',   color: '#5cb8e0' },
  ariaLive:      { label: 'ARIA Live',    color: '#9b59b6' },
  dynamicContent:{ label: 'Dynamic',      color: '#2ecc71' },
  screenReader:  { label: 'Screen Rdr',  color: '#e67e22' },
  lighthouse:    { label: 'Lighthouse',   color: '#1abc9c' },
};

function layerBadge(layerKey) {
  const m = LAYER_META[layerKey] || { label: layerKey, color: '#888' };
  return `<span class="layer-badge" style="background:${m.color}20;border-color:${m.color};color:${m.color}" data-layer="${layerKey}">${m.label}</span>`;
}

// Static patch hints keyed by ruleId — used when v.patch is absent
const RULE_PATCH_HINTS = {
  'focus-indicator-low-contrast': { description: 'Add focus-visible ring with ≥3:1 contrast ratio', fixType: 'auto', wcagRef: 'https://www.w3.org/WAI/WCAG22/Understanding/focus-appearance.html' },
  'focus-not-visible': { description: 'Add visible focus indicator (outline, box-shadow, or border)', fixType: 'auto', wcagRef: 'https://www.w3.org/WAI/WCAG22/Understanding/focus-visible.html' },
  'focus-indicator-removed': { description: 'Remove outline:none or add a replacement focus style', fixType: 'auto', wcagRef: 'https://www.w3.org/WAI/WCAG22/Understanding/focus-visible.html' },
  'skip-link-missing': { description: 'Add <a href="#main-content" class="skip-link">Skip to main content</a> as first focusable element in layout', fixType: 'auto', wcagRef: 'https://www.w3.org/WAI/WCAG22/Understanding/bypass-blocks.html' },
  'non-descriptive-link-text': { description: 'Replace "learn more" / "click here" with descriptive link text or add aria-label', fixType: 'ai', wcagRef: 'https://www.w3.org/WAI/WCAG22/Understanding/link-purpose-in-context.html' },
  'w3c-html-error': { description: 'Fix HTML validation error per W3C Nu Checker', fixType: 'manual', wcagRef: 'https://www.w3.org/WAI/WCAG22/Understanding/parsing.html' },
  'image-alt': { description: 'Add meaningful alt text to image', fixType: 'auto', wcagRef: 'https://www.w3.org/WAI/WCAG22/Understanding/non-text-content.html' },
  'dynamic-region-missing-aria-live': { description: 'Add aria-live="polite" or role="status" to the dynamic container', fixType: 'auto', wcagRef: 'https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html' },
};

// Determines fix-category for a violation
function fixBadge(v) {
  const fixableRules = new Set([
    'image-alt', 'input-image-alt', 'aria-label', 'button-name', 'link-name',
    'aria-hidden-focus', 'landmark-one-main', 'region', 'bypass', 'html-has-lang',
    'html-lang-valid', 'heading-order', 'label', 'select-name', 'font-display',
    'offscreen-images', 'render-blocking-resources',
    'focus-indicator-low-contrast', 'focus-not-visible', 'focus-indicator-removed', 'skip-link-missing',
  ]);
  const manualRules = new Set(['color-contrast', 'focus-trap', 'cognitive']);

  const ruleId = v.rule || v.id || '';
  if (manualRules.has(ruleId)) {
    return `<span class="fix-badge manual">Manual</span>`;
  }
  if (fixableRules.has(ruleId)) {
    return `<span class="fix-badge auto">Auto-fixable</span>`;
  }
  if (v.impact === 'critical' || v.impact === 'serious') {
    return `<span class="fix-badge ai">AI Assist</span>`;
  }
  return `<span class="fix-badge manual">Review</span>`;
}

// ─── Violation card ───────────────────────────────────────────────────────────

function buildViolationCard(v, layerKey) {
  const ruleId = v.rule || v.id || '—';
  const desc = (v.description || v.message || '').slice(0, 200);
  const snippet = v.html || v.extract || v.element?.extract || v.snippet || '';
  const sourceFile = v.source?.file || '';
  const sourceLine = v.source?.line || '';
  const sourceConf = v.source?.confidence || '';

  const snippetId = v.source?.snippetId;
  const method = v.source?.method;
  const methodLabel = method === 'page-html-comment' ? 'watermark'
    : method === 'partial-file-search' ? 'partial-match'
    : method === 'url-fallback' ? 'url-fallback'
    : '';

  const sourceRef = sourceFile
    ? `<div class="source-ref">
        <span class="src-icon">&#8618;</span>
        <code>${sourceFile}${sourceLine ? `:${sourceLine}` : ''}</code>
        ${sourceConf ? `<span class="confidence ${sourceConf}">${sourceConf}</span>` : ''}
        ${snippetId ? `<span class="snippet-id" title="Partial: ${escHtml(snippetId)}">&#8617;&nbsp;${escHtml(snippetId)}</span>` : ''}
        ${methodLabel ? `<span class="method-tag">${escHtml(methodLabel)}</span>` : ''}
       </div>`
    : '';

  const snippetBlock = snippet
    ? `<pre class="snippet">${escHtml(snippet.slice(0, 300))}</pre>`
    : '';

  const helpUrl = v.helpUrl ? `<a class="help-link" href="${escHtml(v.helpUrl)}" target="_blank" rel="noopener">Learn more &#8594;</a>` : '';

  // Patch hint: use explicit v.patch or fall back to static rule hint
  const patchData = v.patch || (RULE_PATCH_HINTS[ruleId] ? {
    file: v.source?.file,
    line: v.source?.line,
    ...RULE_PATCH_HINTS[ruleId],
  } : null);

  const patchBlock = patchData
    ? `<div class="patch-hint">
        <span class="patch-icon">&#9998;</span>
        ${patchData.file ? `<code class="patch-file">${escHtml(patchData.file)}${patchData.line ? `:${patchData.line}` : ''}</code>` : ''}
        <span class="fix-type-pill ${patchData.fixType || 'manual'}">${escHtml(patchData.fixType || 'review')}</span>
        <span class="patch-desc">${escHtml(patchData.description || '')}</span>
        ${patchData.wcagRef ? `<a class="wcag-ref" href="${escHtml(patchData.wcagRef)}" target="_blank" rel="noopener">WCAG &#8599;</a>` : ''}
       </div>`
    : '';

  return `<div class="violation-card" data-impact="${v.impact || 'info'}" data-layer="${layerKey}">
  <div class="violation-header">
    <span class="rule-id">${escHtml(ruleId)}</span>
    ${layerBadge(layerKey)}
    ${impactBadge(v.impact)}
    ${fixBadge(v)}
    ${helpUrl}
  </div>
  <p class="violation-desc">${escHtml(desc)}</p>
  ${sourceRef}
  ${snippetBlock}
  ${patchBlock}
</div>`;
}

// ─── Per-page section ─────────────────────────────────────────────────────────

function buildPageSection(page, index) {
  const layers = [
    'axe', 'keyboard', 'focusTrap', 'ariaLive', 'dynamicContent',
    'screenReader', 'w3c', 'lighthouse',
  ];

  const allViolations = layers.flatMap((key) => {
    const violations = page[key]?.violations || [];
    if (key === 'axe') {
      // axe violations are rule-level; source + html live on each node
      return violations.flatMap((v) =>
        (v.nodes || [])
          .filter((n) => !n.devArtifact)
          .map((n) => ({
            rule: v.id,
            id: v.id,
            description: v.description,
            impact: v.impact,
            helpUrl: v.helpUrl,
            html: n.html,
            source: n.source,
            _layer: key,
          }))
      );
    }
    return violations.map((v) => ({ ...v, _layer: key }));
  });

  const total = allViolations.length;
  const perfScore = page.lighthouse?.scores?.performance;
  const perfLabel = perfScore !== undefined ? ` &nbsp;|&nbsp; Perf: ${perfScore}/100` : '';

  if (total === 0) {
    return `<details class="page-section pass" open>
  <summary>
    <span class="page-name">${escHtml(page.page)}</span>
    <span class="page-url">${escHtml(page.url)}</span>
    <span class="total-badge pass">&#10003; No violations${perfLabel}</span>
  </summary>
</details>`;
  }

  const cards = allViolations
    .map((v) => buildViolationCard(v, v._layer))
    .join('\n');

  return `<details class="page-section" ${index === 0 ? 'open' : ''}>
  <summary>
    <span class="page-name">${escHtml(page.page)}</span>
    <span class="page-url">${escHtml(page.url)}</span>
    <span class="total-badge">${total} violation${total === 1 ? '' : 's'}${perfLabel}</span>
  </summary>
  <div class="violations-list">
    ${cards}
  </div>
</details>`;
}

// ─── Layer filter pill row ────────────────────────────────────────────────────

function buildFilterRow() {
  const pills = Object.entries(LAYER_META)
    .map(([key, m]) => `<button class="filter-pill active" data-filter="${key}" style="--color:${m.color}" onclick="toggleFilter(this,'${key}')">${m.label}</button>`)
    .join('');

  return `<div class="filter-row">
  <span class="filter-label">Filter by layer:</span>
  ${pills}
  <button class="filter-reset" onclick="resetFilters()">Show all</button>
</div>`;
}

// ─── Full report HTML ─────────────────────────────────────────────────────────

function buildVisualReport(report) {
  const pages = report.pages || [];
  const total = report.summary?.totalViolations ?? 0;
  const ts = report.timestamp ? new Date(report.timestamp).toLocaleString() : new Date().toLocaleString();

  const pageSections = pages.map((p, i) => buildPageSection(p, i)).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Scan Visual Report — ${escHtml(ts)}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 0.875rem; color: #1a1a1a; background: #f0f4f8; }

    /* Header */
    .header { background: #1a1a2e; color: #fff; padding: 1.5rem 2rem; display: flex; align-items: baseline; gap: 1.5rem; flex-wrap: wrap; }
    .header h1 { font-size: 1.3rem; font-weight: 700; }
    .header .meta { opacity: 0.7; font-size: 0.8rem; }
    .header .total-pill { background: #e53e3e; color: #fff; padding: 0.2rem 0.8rem; border-radius: 12px; font-size: 0.8rem; font-weight: 600; margin-left: auto; }
    .header .total-pill.pass { background: #38a169; }

    /* Filter row */
    .filter-row { display: flex; align-items: center; flex-wrap: wrap; gap: 0.5rem; padding: 1rem 2rem; background: #fff; border-bottom: 1px solid #e0e0e0; position: sticky; top: 0; z-index: 10; }
    .filter-label { font-size: 0.78rem; color: #666; margin-right: 0.25rem; }
    .filter-pill { border: 1.5px solid var(--color); background: var(--color)20; color: var(--color); padding: 0.2rem 0.7rem; border-radius: 12px; font-size: 0.75rem; font-weight: 600; cursor: pointer; transition: opacity 0.15s; }
    .filter-pill:not(.active) { opacity: 0.35; }
    .filter-reset { margin-left: auto; font-size: 0.75rem; color: #555; background: #f0f4f8; border: 1px solid #ccc; border-radius: 6px; padding: 0.2rem 0.6rem; cursor: pointer; }
    .filter-reset:hover { background: #e0e7ef; }

    /* Main content */
    .container { max-width: 1100px; margin: 1.5rem auto; padding: 0 2rem; }

    /* Page section */
    .page-section { background: #fff; border: 1px solid #e0e0e0; border-radius: 8px; margin-bottom: 1rem; overflow: hidden; }
    .page-section > summary { list-style: none; display: flex; align-items: center; gap: 0.75rem; padding: 1rem 1.25rem; cursor: pointer; user-select: none; flex-wrap: wrap; }
    .page-section > summary::-webkit-details-marker { display: none; }
    .page-section > summary::before { content: '▶'; font-size: 0.7rem; color: #888; transition: transform 0.15s; flex-shrink: 0; }
    .page-section[open] > summary::before { transform: rotate(90deg); }
    .page-section.pass > summary { background: #f0fff4; }
    .page-name { font-weight: 700; font-size: 0.95rem; color: #1a1a2e; }
    .page-url { font-size: 0.75rem; color: #888; font-family: monospace; }
    .total-badge { margin-left: auto; background: #fde8e8; color: #c53030; padding: 0.2rem 0.75rem; border-radius: 12px; font-size: 0.78rem; font-weight: 600; flex-shrink: 0; }
    .total-badge.pass { background: #f0fff4; color: #276749; }

    /* Violations list */
    .violations-list { padding: 0.75rem 1.25rem 1.25rem; display: flex; flex-direction: column; gap: 0.6rem; }

    /* Violation card */
    .violation-card { border: 1px solid #e8ecf0; border-radius: 6px; padding: 0.75rem 1rem; background: #fafbfc; }
    .violation-card[data-impact="critical"] { border-left: 3px solid #e53e3e; }
    .violation-card[data-impact="serious"]  { border-left: 3px solid #dd6b20; }
    .violation-card[data-impact="moderate"] { border-left: 3px solid #d69e2e; }
    .violation-card[data-impact="minor"]    { border-left: 3px solid #38a169; }
    .violation-card[data-impact="info"]     { border-left: 3px solid #3182ce; }
    .violation-header { display: flex; align-items: center; flex-wrap: wrap; gap: 0.4rem; margin-bottom: 0.4rem; }
    .rule-id { font-family: monospace; font-weight: 700; font-size: 0.82rem; color: #1a1a2e; }
    .violation-desc { font-size: 0.82rem; color: #444; margin-bottom: 0.4rem; line-height: 1.4; }
    .source-ref { display: flex; align-items: center; gap: 0.4rem; font-size: 0.75rem; color: #555; margin-bottom: 0.4rem; }
    .source-ref code { font-family: monospace; background: #f0f4f8; padding: 0.1rem 0.4rem; border-radius: 3px; color: #2b6cb0; }
    .src-icon { color: #888; }
    .confidence { padding: 0.1rem 0.4rem; border-radius: 10px; font-size: 0.7rem; font-weight: 600; }
    .confidence.high   { background: #f0fff4; color: #276749; }
    .confidence.medium { background: #fffde6; color: #b7791f; }
    .confidence.low    { background: #fff0e0; color: #c05600; }
    .snippet-id { font-family: monospace; font-size: 0.7rem; color: #4a5568; background: #edf2f7; padding: 0.1rem 0.35rem; border-radius: 3px; }
    .method-tag { font-size: 0.68rem; color: #718096; background: #f7fafc; border: 1px solid #e2e8f0; padding: 0.1rem 0.35rem; border-radius: 3px; }
    .patch-hint { display: flex; align-items: center; flex-wrap: wrap; gap: 0.4rem; margin-top: 0.5rem; padding: 0.45rem 0.6rem; background: #f0f7ff; border: 1px solid #bee3f8; border-radius: 4px; font-size: 0.74rem; }
    .patch-icon { color: #2b6cb0; flex-shrink: 0; }
    .patch-file { font-family: monospace; background: #ebf8ff; color: #2c5282; padding: 0.1rem 0.35rem; border-radius: 3px; }
    .fix-type-pill { padding: 0.1rem 0.4rem; border-radius: 10px; font-size: 0.68rem; font-weight: 600; }
    .fix-type-pill.auto   { background: #d4edda; color: #155724; }
    .fix-type-pill.ai     { background: #e8d5f5; color: #5a1a8a; }
    .fix-type-pill.manual { background: #f8d7da; color: #721c24; }
    .patch-desc { color: #2d3748; flex: 1; }
    .wcag-ref { font-size: 0.68rem; color: #3182ce; text-decoration: none; margin-left: auto; }
    .wcag-ref:hover { text-decoration: underline; }

    /* Badges */
    .badge { display: inline-block; padding: 0.15rem 0.5rem; border-radius: 10px; font-size: 0.72rem; font-weight: 600; border: 1px solid transparent; }
    .layer-badge { display: inline-block; padding: 0.15rem 0.5rem; border-radius: 10px; font-size: 0.7rem; font-weight: 600; border: 1.5px solid transparent; }
    .fix-badge { display: inline-block; padding: 0.15rem 0.5rem; border-radius: 10px; font-size: 0.7rem; font-weight: 600; }
    .fix-badge.auto   { background: #d4edda; color: #155724; }
    .fix-badge.ai     { background: #e8d5f5; color: #5a1a8a; }
    .fix-badge.manual { background: #f8d7da; color: #721c24; }
    .help-link { font-size: 0.72rem; color: #3182ce; text-decoration: none; margin-left: 0.25rem; }
    .help-link:hover { text-decoration: underline; }

    /* Code snippet */
    .snippet { font-family: 'Courier New', monospace; font-size: 0.75rem; background: #1a1a2e; color: #e2e8f0; padding: 0.6rem 0.8rem; border-radius: 4px; overflow-x: auto; white-space: pre; margin-top: 0.5rem; }

    /* Footer */
    .footer { text-align: center; padding: 2rem; font-size: 0.75rem; color: #aaa; }

    /* Hidden via filter */
    .violation-card.filtered { display: none; }
    .violations-list:empty::after { content: 'All violations filtered.'; color: #aaa; font-size: 0.8rem; padding: 0.5rem 0; display: block; }
  </style>
</head>
<body>
  <div class="header">
    <h1>Scan Visual Report</h1>
    <span class="meta">Generated: ${escHtml(ts)} &nbsp;|&nbsp; ${pages.length} pages</span>
    <span class="total-pill${total === 0 ? ' pass' : ''}">${total === 0 ? '&#10003; No violations' : total + ' total violation' + (total === 1 ? '' : 's')}</span>
  </div>

  ${buildFilterRow()}

  <div class="container">
    ${pageSections}
  </div>

  <div class="footer">
    ADA &amp; Performance Automation Tool &nbsp;|&nbsp; local-career-site
  </div>

  <script>
    function toggleFilter(btn, layer) {
      btn.classList.toggle('active');
      applyFilters();
    }
    function resetFilters() {
      document.querySelectorAll('.filter-pill').forEach(p => p.classList.add('active'));
      applyFilters();
    }
    function applyFilters() {
      const activeLayers = new Set(
        [...document.querySelectorAll('.filter-pill.active')].map(p => p.dataset.filter)
      );
      document.querySelectorAll('.violation-card').forEach(card => {
        const show = activeLayers.has(card.dataset.layer);
        card.classList.toggle('filtered', !show);
      });
    }
  </script>
</body>
</html>`;
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function escHtml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
