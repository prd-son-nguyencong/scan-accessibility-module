import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs';
import path from 'path';
import { getReportsDir } from '../utils/paths.js';
import { escapeHtml as esc } from '../utils/escape-html.js';
import { docParts, THEME_TOGGLE_HTML, wbr } from './ui/theme.js';


/**
 * Generates the ROI Comparison Document pair:
 * - <reportsDir>/roi-comparison.html  - Executive summary for leadership
 * - <reportsDir>/roi-technical.html   - Technical appendix for QA team
 *
 * Both are self-contained HTML files (no external dependencies).
 */
export function generateRoiDocuments(latestReport) {
  mkdirSync(getReportsDir(), { recursive: true });
  const comparisonPath = path.join(getReportsDir(), 'roi-comparison.html');
  const technicalPath = path.join(getReportsDir(), 'roi-technical.html');

  writeFileSync(comparisonPath, buildExecSummary(latestReport));
  writeFileSync(technicalPath, buildTechnicalAppendix(latestReport));

  return { comparisonPath, technicalPath };
}

// ─── Chart helpers ────────────────────────────────────────────────────────────

const LAYER_LABELS = {
  axe: 'axe-core',
  accessScan: 'AccessScan',
  w3c: 'W3C HTML',
  links: 'Dead Links',
  keyboard: 'Keyboard',
  focusTrap: 'Focus Trap',
  ariaLive: 'ARIA Live',
  dynamicContent: 'Dynamic',
  screenReader: 'Screen Reader',
  lighthouse: 'Lighthouse',
};

function buildLayerBarChart(layerCounts) {
  const entries = Object.entries(layerCounts).filter(([, v]) => v > 0);
  if (entries.length === 0) return '<p class="muted">No violations found.</p>';
  const max = Math.max(...entries.map(([, v]) => v), 1);

  const rows = entries
    .sort(([, a], [, b]) => b - a)
    .map(([key, count]) => {
      const pct = Math.round((count / max) * 100);
      const label = LAYER_LABELS[key] || key;
      return `<div class="bar-row">
        <div class="bar-label">${esc(label)}</div>
        <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
        <div class="bar-value">${esc(count)}</div>
      </div>`;
    })
    .join('');

  return rows;
}

// ─── Executive Summary ───────────────────────────────────────────────────────

function buildExecSummary(latest) {
  const latestTotal = latest.summary.totalViolations;
  const comparison = latest.comparison;

  const pagesScanned = latest.summary.pagesScanned;
  const topViolations = latest.summary.topViolations || [];

  const page = docParts({ title: 'ADA Automation: Executive Summary' });
  return `<!DOCTYPE html>
<html lang="en">
<head>
${page.head}
</head>
<body class="doc">
${page.bodyStart}
<a class="skip" href="#main">Skip to the report</a>
<header class="top"><div class="wrap">
  <div class="top-row"><h1>ADA and performance automation</h1>${THEME_TOGGLE_HTML}</div>
  <p class="lead">Scan summary for ${esc(pagesScanned)} pages.</p>
  <p>Generated: ${esc(new Date(latest.timestamp).toLocaleString())}</p>
  <p>Automated scans cover only part of WCAG. Manual review is still required.</p>
</div></header>
  <main id="main" class="wrap">

    <!-- Key Metrics -->
    <div class="metrics">
      <div class="metric-card">
        <div class="value">${esc(latestTotal)}</div>
        <div class="label">Current violations</div>
      </div>
      ${comparison ? `
      <div class="metric-card good">
        <div class="value">${esc(comparison.totals.fixed)}</div>
        <div class="label">Fixed since ${esc(comparison.baseline.source)}</div>
      </div>
      <div class="metric-card">
        <div class="value">${esc(comparison.totals.remaining)}</div>
        <div class="label">Remaining</div>
      </div>
      <div class="metric-card warn">
        <div class="value">${esc(comparison.totals.new)}</div>
        <div class="label">New</div>
      </div>` : ''}
    </div>

    <!-- Charts -->
    <div class="charts">
      <div class="chart-card">
        <h2>Violations by Layer</h2>
        ${buildLayerBarChart(latest.summary.layerCounts || {})}
      </div>
      ${comparison ? `<div class="chart-card">
        <h2>Compared with ${esc(comparison.baseline.source)}</h2>
        <p>Matched by finding id; confirmed and likely findings only. Needs review (not compared): ${esc(comparison.totals.needsReview.baseline)} before, ${esc(comparison.totals.needsReview.current)} now.</p>
        ${comparison.warnings.map((w) => `<p class="cell-note">Warning: ${esc(w)}</p>`).join('')}
      </div>` : '<div></div>'}
    </div>
    <section>
      <h2>Scanner Layers</h2>
      <div class="tbl-scroll" tabindex="0" role="group" aria-label="Table, scrolls sideways"><table class="tbl">
        <thead><tr><th>Check</th><th>Tool</th></tr></thead>
        <tbody>
          <tr><td>WCAG structural checks</td><td>axe-core via Playwright</td></tr>
          <tr><td>HTML validity</td><td>Nu HTML Checker</td></tr>
          <tr><td>Keyboard, focus trap, ARIA live, dynamic content</td><td>Playwright behavioral scanners</td></tr>
          <tr><td>Screen reader reading patterns</td><td>Accessibility tree</td></tr>
          <tr><td>Performance</td><td>Google Lighthouse</td></tr>
          <tr><td>Cognitive accessibility and other judgment-based criteria</td><td>Manual review required</td></tr>
        </tbody>
      </table></div>
    </section>

    <!-- Top Violations -->
    ${topViolations.length > 0 ? `
    <section>
      <h2>Top Violations Found</h2>
      <div class="tbl-scroll" tabindex="0" role="group" aria-label="Table, scrolls sideways"><table class="tbl">
        <thead><tr><th>Rule ID</th><th>Count</th></tr></thead>
        <tbody>
          ${topViolations.map((v) => `<tr><td>${wbr(v.id)}</td><td>${esc(v.count)}</td></tr>`).join('')}
        </tbody>
      </table></div>
    </section>` : ''}

  </main>
  <footer class="wrap">ADA and performance automation tool, generated ${new Date().getFullYear()}</footer>
${page.bodyEnd}
</body>
</html>`;
}

// ─── Technical Appendix ──────────────────────────────────────────────────────

function buildTechnicalAppendix(latest) {
  const pages = latest.pages || [];

  const pageRows = pages.map((page) => {
    const viols = page.violations || [];
    const countByLayer = (layer) => viols.filter((v) => v.layer === layer).length;
    const behavioralLayers = ['keyboard', 'focusTrap', 'ariaLive', 'dynamicContent'];
    const behavioralCount = viols.filter((v) => behavioralLayers.includes(v.layer)).length;
    const lhScores = page.lighthouse?.scores || {};
    const total = viols.length;

    return `
    <tr>
      <td><strong>${esc(page.page)}</strong><br><small class="muted">${esc(page.url)}</small></td>
      <td>${countByLayer('axe') + countByLayer('accessScan')}</td>
      <td>${behavioralCount}</td>
      <td>${countByLayer('screenReader')}</td>
      <td>${countByLayer('lighthouse')}${lhScores.performance !== undefined ? ` (perf: ${esc(lhScores.performance)})` : ''}</td>
      <td>${countByLayer('w3c') + countByLayer('links')}</td>
      <td><strong>${total}</strong></td>
    </tr>
    ${buildViolationDetails(page)}`;
  }).join('');

  const page = docParts({ title: 'ADA Automation: Technical Report' });
  return `<!DOCTYPE html>
<html lang="en">
<head>
${page.head}
</head>
<body class="doc">
${page.bodyStart}
<a class="skip" href="#main">Skip to the report</a>
<header class="top"><div class="wrap">
  <div class="top-row"><h1>ADA and performance automation: technical report</h1>${THEME_TOGGLE_HTML}</div>
  <p>Generated: ${esc(new Date(latest.timestamp).toLocaleString())} | Pages: ${pages.length} | Total violations: ${esc(latest.summary.totalViolations)}</p>
</div></header>
  <main id="main" class="wrap">

    <h2>Per-Page Summary</h2>
    <div class="tbl-scroll" tabindex="0" role="group" aria-label="Table, scrolls sideways"><table class="tbl">
      <thead>
        <tr>
          <th>Page</th>
          <th>axe (L1)</th>
          <th>Behavioral (L2)</th>
          <th>Screen Reader (L3)</th>
          <th>Lighthouse</th>
          <th>W3C</th>
          <th>Total</th>
        </tr>
      </thead>
      <tbody>${pageRows}</tbody>
    </table></div>

    <h2>Affected Source Files</h2>
    <div class="tbl-scroll" tabindex="0" role="group" aria-label="Table, scrolls sideways"><table class="tbl">
      <thead><tr><th>Source File</th><th>Violations</th><th>Top Rule</th><th>Layers</th><th>Confidence</th><th>Partial</th></tr></thead>
      <tbody>
        ${Object.entries(latest.summary.violationsByFile || {}).map(([file, violations]) => {
          const topConf = violations[0]?.sourceConfidence || '';
          const confClass = topConf === 'high' ? 'conf-high' : topConf === 'medium' ? 'conf-medium' : 'conf-low';
          const layers = [...new Set(violations.map((v) => v.layer).filter(Boolean))].join(', ');
          const snippetId = violations.find((v) => v.snippetId)?.snippetId || '';
          return `
        <tr>
          <td>${wbr(file)}</td>
          <td>${violations.length}</td>
          <td>${wbr(violations[0]?.ruleId || '')}</td>
          <td class="cell-note">${esc(layers || 'none')}</td>
          <td class="${confClass}">${esc(topConf || 'none')}</td>
          <td class="cell-note mono">${esc(snippetId)}</td>
        </tr>`;
        }).join('')}
      </tbody>
    </table></div>

  </main>
${page.bodyEnd}
</body>
</html>`;
}

function buildViolationDetails(page) {
  const allViolations = page.violations || [];

  if (allViolations.length === 0) return '';

  return `<tr><td colspan="7">
    <div>
    ${allViolations.slice(0, 20).map((v) => `
      <div class="violation">
        <span class="rule">[${esc(v.layer || 'unknown')}] ${wbr(v.ruleId || v.rule || v.id)}</span>
        <span class="impact-${esc(String(v.impact || 'info').replace(/[^a-z]/gi, ''))}"> (${esc(v.impact || 'info')})</span>
        - ${esc((v.fix?.hint || v.description || '').slice(0, 120))}
        ${v.source?.file ? `<div class="source">&#8618; ${esc(v.source.file)}${v.source.line ? `:${esc(v.source.line)}` : ''} [${esc(v.source.confidence || 'low')}]${v.source.snippetId ? ` - <em>${esc(v.source.snippetId)}</em>` : ''}${v.source.method ? ` - via ${esc(String(v.source.method).replace('page-html-comment', 'watermark').replace('partial-file-search', 'partial-match').replace('text-fingerprint', 'text-fp').replace('href-fingerprint', 'href-fp'))}` : ''}</div>` : ''}
      </div>`).join('')}
    </div>
  </td></tr>`;
}
