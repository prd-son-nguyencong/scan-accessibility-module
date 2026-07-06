import { writeFileSync } from 'fs';
import path from 'path';
import { getProjectRoot } from '../utils/paths.js';
import { groupViolations, ACCESSSCAN_CATEGORIES } from '../schema.js';

const ROOT = getProjectRoot();
const REPORTS_DIR = path.join(ROOT, 'scan-reports');

const TOOL_CONFIG = [
  { id: 'axe', label: 'Axe-core', layer: 'axe', color: '#4040bf', icon: 'M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10zm-1-15a1 1 0 112 0v6a1 1 0 11-2 0V7zm0 10a1 1 0 112 0 1 1 0 01-2 0z' },
  { id: 'accessScan', label: 'AccessScan', layer: 'accessScan', color: '#ff385c', icon: 'M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z' },
  { id: 'w3c', label: 'Nu Checker HTML + W3C', layer: 'w3c', color: '#460479', icon: 'M14.7 6.3a1 1 0 010 1.4L10.4 12l4.3 4.3a1 1 0 01-1.4 1.4l-5-5a1 1 0 010-1.4l5-5a1 1 0 011.4 0z' },
  { id: 'links', label: 'Dead Link Checker', layer: 'links', color: '#c13515', icon: 'M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1' },
  { id: 'behavioral', label: 'Behavioral Scanners', layers: ['keyboard', 'focusTrap', 'ariaLive', 'dynamicContent', 'screenReader'], color: '#0d7377', icon: 'M15 15l-2 5L9 9l11 4-5 2zm0 0l5 5M7.188 2.239l.777 2.897M5.136 7.965l-2.898-.777M13.95 4.05l-2.122 2.122m-5.657 5.656l-2.12 2.122' },
  { id: 'performance', label: 'Performance', layer: 'lighthouse', color: '#222222', icon: 'M13 10V3L4 14h7v7l9-11h-7z' },
];

function esc(str = '') {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function prettyHtml(raw) {
  let out = '';
  let indent = 0;
  const step = 2;
  const tokens = raw.replace(/>\s*</g, '>\n<').split('\n');
  for (const token of tokens) {
    const t = token.trim();
    if (!t) continue;
    if (t.startsWith('</')) indent = Math.max(0, indent - step);
    out += ' '.repeat(indent) + t + '\n';
    if (t.match(/^<[a-zA-Z][^>]*[^/]>$/) && !t.startsWith('</') && !t.match(/^<(br|hr|img|input|meta|link|col|area|base|source|track|wbr)\b/i)) {
      indent += step;
    }
  }
  return out.trimEnd();
}

export function writeHtmlReport(report) {
  const outPath = path.join(REPORTS_DIR, 'scan-visual.html');
  writeFileSync(outPath, buildHtml(report));
  return outPath;
}

function scoreColor(score) {
  if (score === null || score === undefined) return '#929292';
  if (score >= 90) return '#008a05';
  if (score >= 50) return '#ff385c';
  return '#c13515';
}

function metricDotColor(rating) {
  if (rating === 'good') return '#008a05';
  if (rating === 'average') return '#ff385c';
  return '#c13515';
}

function impactBadge(impact) {
  const map = {
    critical: { bg: 'rgba(193,53,21,0.08)', text: '#c13515', border: 'rgba(193,53,21,0.3)' },
    serious:  { bg: 'rgba(255,56,92,0.08)',  text: '#ff385c', border: 'rgba(255,56,92,0.3)' },
    moderate: { bg: 'rgba(180,120,0,0.08)',  text: '#8a6200', border: 'rgba(180,120,0,0.3)' },
    minor:    { bg: 'rgba(0,138,5,0.07)',    text: '#007003', border: 'rgba(0,138,5,0.25)' },
  };
  const s = map[impact] || { bg: '#f7f7f7', text: '#929292', border: '#dddddd' };
  return `<span class="badge" style="background:${s.bg};color:${s.text};border:1px solid ${s.border}">${impact || 'info'}</span>`;
}

function svgIcon(pathD, size = 16, color = '#222222') {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${pathD}"/></svg>`;
}

// ─── Performance Dashboard (kept from original) ─────────────────────────────

function buildCircleGauge(score, label, size = 120) {
  const r = 50;
  const circumference = 2 * Math.PI * r;
  if (score === null || score === undefined) {
    return `<div class="gauge-wrap">
      <svg width="${size}" height="${size}" viewBox="0 0 120 120">
        <circle cx="60" cy="60" r="${r}" fill="none" stroke="#ebebeb" stroke-width="6"/>
        <text x="60" y="56" text-anchor="middle" dominant-baseline="central" fill="#929292" font-size="32" font-weight="600" font-family="'Circular','Inter',sans-serif">--</text>
      </svg>
      <span class="gauge-lbl">${esc(label)}</span>
    </div>`;
  }
  const color = scoreColor(score);
  const offset = circumference - (score / 100) * circumference;
  return `<div class="gauge-wrap">
    <svg width="${size}" height="${size}" viewBox="0 0 120 120">
      <circle cx="60" cy="60" r="${r}" fill="none" stroke="#ebebeb" stroke-width="6"/>
      <circle cx="60" cy="60" r="${r}" fill="none" stroke="${color}" stroke-width="6"
        stroke-dasharray="${circumference}" stroke-dashoffset="${offset}" stroke-linecap="round"
        transform="rotate(-90 60 60)" class="gauge-ring"/>
      <text x="60" y="52" text-anchor="middle" dominant-baseline="central" fill="${color}" font-size="32" font-weight="700" font-family="'Circular','Inter',sans-serif">${score}</text>
      <text x="60" y="76" text-anchor="middle" fill="#929292" font-size="10" font-weight="400" font-family="'Circular','Inter',sans-serif">${score >= 90 ? 'Good' : score >= 50 ? 'Needs Work' : 'Poor'}</text>
    </svg>
    <span class="gauge-lbl">${esc(label)}</span>
  </div>`;
}

function buildMetricRow(metric) {
  const dotColor = metricDotColor(metric.rating);
  return `<tr>
    <td><span class="metric-dot" style="background:${dotColor}"></span>${esc(metric.label)}</td>
    <td class="metric-val" style="color:${dotColor}">${esc(metric.displayValue)}</td>
  </tr>`;
}

function buildPerformanceDashboard(lighthouseData) {
  if (!lighthouseData || Object.keys(lighthouseData).length === 0) return '';
  let html = '';
  for (const [pageName, pageData] of Object.entries(lighthouseData)) {
    const lh = pageData.lighthouse;
    if (!lh) continue;
    html += `<div class="perf-dashboard">
      <div class="device-tabs">
        <button class="device-tab active" onclick="switchDevice(this,'mobile-${esc(pageName)}','desktop-${esc(pageName)}')">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="2" width="14" height="20" rx="2"/><line x1="12" y1="18" x2="12" y2="18"/></svg>
          Mobile
        </button>
        <button class="device-tab" onclick="switchDevice(this,'desktop-${esc(pageName)}','mobile-${esc(pageName)}')">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
          Desktop
        </button>
      </div>`;
    if (lh.mobile) html += buildDeviceReport(lh.mobile, `mobile-${pageName}`);
    if (lh.desktop) html += buildDeviceReport(lh.desktop, `desktop-${pageName}`, true);
    html += '</div>';
  }
  return html;
}

function buildDeviceReport(data, id, hidden = false) {
  const s = data.scores;
  const gauges = [
    buildCircleGauge(s.performance, 'Performance'),
    buildCircleGauge(s.accessibility, 'Accessibility'),
    buildCircleGauge(s.bestPractices, 'Best Practices'),
    buildCircleGauge(s.seo, 'SEO'),
  ].join('');

  const metricRows = Object.values(data.metrics || {}).map(buildMetricRow).join('');

  let auditGroupsHtml = '';
  if (data.groups && Object.keys(data.groups).length > 0) {
    for (const [groupName, audits] of Object.entries(data.groups)) {
      const auditRows = audits.map((a) => {
        const dotColor = a.score === 0 ? '#c13515' : a.score < 0.5 ? '#ff385c' : '#929292';
        let detailsHtml = '';
        if (a.details && a.details.length > 0) {
          const items = a.details.map((d) => {
            const parts = [];
            if (d.url) parts.push(esc(d.url.split('/').pop().split('?')[0].slice(0, 60)));
            if (d.wastedMs) parts.push(`${Math.round(d.wastedMs)} ms`);
            if (d.wastedBytes) parts.push(`${(d.wastedBytes / 1024).toFixed(1)} KB`);
            if (d.label) parts.push(esc(d.label));
            return parts.join(' &middot; ');
          }).filter(Boolean);
          if (items.length > 0) {
            detailsHtml = `<ul class="audit-details">${items.map((d) => `<li>${d}</li>`).join('')}</ul>`;
          }
        }
        return `<div class="audit-item">
          <div class="audit-row">
            <span class="metric-dot" style="background:${dotColor}"></span>
            <span class="audit-title">${esc(a.title)}</span>
            ${a.displayValue ? `<span class="audit-value">${esc(a.displayValue)}</span>` : ''}
          </div>
          ${detailsHtml}
        </div>`;
      }).join('');
      auditGroupsHtml += `<details class="audit-group">
        <summary>${esc(groupName)}<span class="audit-count">${audits.length}</span></summary>
        ${auditRows}
      </details>`;
    }
  }

  let gapHtml = '';
  if (s.performance < 100 && data.groups) {
    const opportunities = Object.entries(data.groups)
      .flatMap(([, audits]) => audits)
      .filter((a) => a.score !== null && a.score < 1 && a.wastedMs > 0)
      .sort((a, b) => (b.wastedMs || 0) - (a.wastedMs || 0))
      .slice(0, 10);
    if (opportunities.length > 0) {
      const gap = 100 - (s.performance || 0);
      const totalWasted = opportunities.reduce((sum, o) => sum + (o.wastedMs || 0), 0);
      const opRows = opportunities.map((o) => {
        const pct = totalWasted > 0 ? Math.round(((o.wastedMs || 0) / totalWasted) * gap) : 0;
        return `<div class="gap-item">
          <div class="gap-label">${esc(o.title)}</div>
          <div class="gap-bar-track"><div class="gap-bar-fill" style="width:${Math.min(100, pct * 3)}%;background:${scoreColor(100 - pct)}"></div></div>
          <div class="gap-pts">~${pct} pts</div>
        </div>`;
      }).join('');
      gapHtml = `<div class="gap-to-100">
        <div class="metrics-title">Gap to 100 <span class="section-badge" style="background:${scoreColor(s.performance)}">${gap} pts to go</span></div>
        ${opRows}
      </div>`;
    }
  }

  let stepsHtml = '';
  if (s.performance < 100 && data.groups) {
    const AUDIT_TO_ACTION = {
      'unminified-javascript': 'Run `pnpm build:prod` to enable JS minification',
      'unminified-css': 'Run `pnpm build:prod` to enable CSS minification',
      'unused-css-rules': 'Move page-specific CSS out of global head.liquid',
      'render-blocking-resources': 'Defer non-critical CSS/JS or use async loading',
      'uses-long-cache-ttl': 'Set Cache-Control headers for static assets (CDN config)',
      'uses-responsive-images': 'Serve correctly-sized images via srcset or <picture>',
      'offscreen-images': 'Add loading="lazy" to below-fold images',
      'largest-contentful-paint-element': 'Preload hero image + add fetchpriority="high"',
      'total-byte-weight': 'Audit asset sizes — compress images, code-split JS',
      'dom-size': 'Reduce DOM nodes — simplify nested containers',
      'server-response-time': 'Optimize server response (CDN, caching)',
      'uses-text-compression': 'Enable gzip/brotli compression on server',
    };
    const failedAudits = Object.entries(data.groups)
      .flatMap(([, audits]) => audits)
      .filter((a) => a.score !== null && a.score < 0.9);
    const actions = failedAudits
      .map((a) => ({ id: a.id || a.title, title: a.title, action: AUDIT_TO_ACTION[a.id] }))
      .filter((a) => a.action);
    if (actions.length > 0) {
      const rows = actions.map((a) =>
        `<label class="step-item"><input type="checkbox"><span>${esc(a.title)}</span><em>${esc(a.action)}</em></label>`
      ).join('');
      stepsHtml = `<div class="steps-to-100">
        <div class="metrics-title">Steps to 100</div>
        <div class="steps-list">${rows}</div>
      </div>`;
    }
  }

  let passedHtml = '';
  if (data.passedGroups && Object.keys(data.passedGroups).length > 0) {
    let passedCount = 0;
    let passedItems = '';
    for (const [groupName, audits] of Object.entries(data.passedGroups)) {
      passedCount += audits.length;
      const rows = audits.map((a) =>
        `<div class="audit-item passed-item">
          <div class="audit-row">
            <span class="metric-dot" style="background:#008a05"></span>
            <span class="audit-title">${esc(a.title)}</span>
          </div>
        </div>`
      ).join('');
      passedItems += `<details class="audit-group passed-group">
        <summary>${esc(groupName)}<span class="audit-count">${audits.length}</span></summary>
        ${rows}
      </details>`;
    }
    passedHtml = `<details class="passed-audits-section">
      <summary class="passed-summary"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#008a05" stroke-width="2"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg> ${passedCount} passed audit${passedCount === 1 ? '' : 's'}</summary>
      <div class="passed-body">${passedItems}</div>
    </details>`;
  }

  return `<div class="device-panel" id="${esc(id)}" ${hidden ? 'style="display:none"' : ''}>
    <div class="gauges-row">${gauges}</div>
    ${metricRows ? `<div class="metrics-card"><div class="metrics-title">Core Web Vitals</div><table class="metrics-table">${metricRows}</table></div>` : ''}
    ${gapHtml}
    ${stepsHtml}
    ${auditGroupsHtml ? `<div class="audit-groups"><div class="metrics-title">Diagnostics</div>${auditGroupsHtml}</div>` : ''}
    ${passedHtml}
  </div>`;
}

// ─── Shared violation rendering helpers ──────────────────────────────────────

function buildSourcePath(v) {
  const file = v.source?.file || '';
  const line = v.source?.line || '';
  const partial = v.source?.partial || '';
  const page = v.source?.page || '';
  if (!file && !partial) return '';
  const fileIcon = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#929292" stroke-width="2"><path d="M13 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>';
  const arrowIcon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#FF5A5F" stroke-width="2.5" style="margin: 0 4px;"><path d="M5 12h14"/><path d="M12 5l7 7-7 7"/></svg>';
  if (partial && page && partial !== page) {
    const lineStr = line ? `<span class="source-line">:${line}</span>` : '';
    return `<div class="v-source">${fileIcon}<code class="source-page">${esc(page)}</code>${arrowIcon}<code class="source-partial">${esc(partial)}${lineStr}</code></div>`;
  }
  return `<div class="v-source">${fileIcon}<code>${esc(file)}${line ? `:${line}` : ''}</code></div>`;
}

// ─── Axe-core section builder ────────────────────────────────────────────────

function buildAxeSection(violations) {
  if (violations.length === 0) {
    return `<div class="no-issues"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#008a05" stroke-width="2"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg><span>All clear &mdash; no axe-core issues found</span></div>`;
  }
  const byRule = groupViolations(violations, (v) => v.ruleId);
  let html = '';
  for (const [ruleId, ruleViols] of byRule) {
    const first = ruleViols[0];
    const hint = first.fix?.hint || '';
    const dequeUrl = `https://dequeuniversity.com/rules/axe/4.10/${ruleId}`;
    const issueCards = ruleViols.map((v) => {
      const selector = v.element?.selector || '';
      const outerHTML = v.element?.outerHTML || '';
      return `<div class="violation-card" data-impact="${v.impact}" data-layer="${v.layer}" data-category="${v.category}">
        ${selector ? `<div class="v-location"><span class="location-label">Element Location:</span><code>${esc(selector)}</code></div>` : ''}
        ${outerHTML ? `<pre class="code-snippet">${esc(prettyHtml(outerHTML.slice(0, 500)))}</pre>` : ''}
        <div class="v-fix-row">
          <span class="fix-label">To solve this problem, you need to fix the following:</span>
          <p class="v-hint">${esc(hint)}</p>
        </div>
        <div class="v-meta-row">
          ${impactBadge(v.impact)}
          ${v.wcagRef ? `<span class="wcag-tag">${esc(v.wcagRef)}</span>` : ''}
          ${v.fix?.deterministic ? '<span class="fix-auto">Auto-fix</span>' : '<span class="fix-ai">AI-fix</span>'}
          <span class="found-date">Found: ${v.foundAt ? new Date(v.foundAt).toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', year: 'numeric' }) : new Date().toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', year: 'numeric' })}</span>
        </div>
        ${buildSourcePath(v)}
      </div>`;
    }).join('');

    html += `<details class="rule-accordion">
      <summary>
        <div class="rule-summary-left">
          ${impactBadge(first.impact)}
          <span class="rule-title">${esc(ruleId)}</span>
        </div>
        <span class="rule-count">${ruleViols.length} issue${ruleViols.length === 1 ? '' : 's'}</span>
      </summary>
      <div class="rule-body">
        <p class="rule-description">${esc(hint)}</p>
        <a class="rule-link" href="${dequeUrl}" target="_blank" rel="noopener">more information &#x2197;</a>
        ${issueCards}
      </div>
    </details>`;
  }
  return html;
}

// ─── AccessScan section builder ──────────────────────────────────────────────

const RULE_REQUIREMENTS = {
  AltMisuse: { title: 'Elements other than image (Tag: IMG) should not have alt attribute', requirement: 'The alt attribute is used to provide a text alternative for images. It is not meant to be used on elements other than images and therefore will not be read using screen-readers.' },
  BreadcrumbsNav: { title: 'Breadcrumbs navigation should be tagged properly', requirement: 'Breadcrumb navigation regions are essential for user orientation. If not appropriately tagged, screen reader users will not know that such an option exists on the page and will face more difficulties browsing around.' },
  EmphasisMismatch: { title: 'Emphasis should be tagged properly for assistive technology', requirement: 'Elements with emphasis importance should have the emphasis role. If not, screen reader users may not understand the emphasis of the text.' },
  IframeDiscernible: { title: 'Iframes should have a descriptive label', requirement: 'An iframe needs a label that describes its purpose to screen reader users.' },
  LinkAnchorAmbiguous: { title: 'Ambiguous links should have additional descriptions for screen readers', requirement: 'Ambiguous links like "Learn More", "Shop Now" and "Start Here" are often used as a call to action. However, screen-reader users, while using link navigation, do not interact with content above or below the link and therefore don\'t have the same context.' },
  NoRoleApplication: { title: 'Avoid using role="application"', requirement: 'Using role="application" is generally discouraged because it disables standard screen reader modes and forces users into an application mode, removing familiar navigation shortcuts.' },
  SalePriceDiscernible: { title: 'Original and discounted prices should be indicated to assistive technology', requirement: 'Discounted prices often appear next to the original and distinguished with visual cues like strikethroughs or color changes. Both prices must also be conveyed by screen readers in a way that enables users to differentiate between the values.' },
  StrongMismatch: { title: 'Strong should be tagged properly for assistive technology', requirement: 'Elements with strong importance should have the strong role. If not, screen reader users may not understand the importance of the text.' },
  VisibilityMismatch: { title: 'Visible content should not be hidden from assistive technology', requirement: 'If content remains visible on the screen but assigned aria-hidden="true", it will be excluded from the accessibility tree. As a result, screen reader users will not have access to the same information as sighted users.' },
  VisibilityMisuse: { title: 'Visibly hidden content should not be exposed to assistive technology', requirement: 'When elements are visually hidden but still exposed to assistive technology, screen reader users may encounter content that should not be available in the current interface.' },
  AriaDescribedByHasReference: { title: 'aria-describedby should reference a valid element id', requirement: 'If an element\'s aria-describedby attribute points to an id that does not exist or is not valid, assistive technologies will not convey the intended description.' },
  AriaLabelledByHasReference: { title: 'aria-labelledby should reference a valid element id', requirement: 'Since aria-labelledby relies on valid id references, screen readers can only announce the label if the target exists. If the id is missing or invalid, the label will not be conveyed.' },
  FigureDiscernible: { title: 'Figure elements should receive text description or lose figure role', requirement: 'Figure elements are often incorrectly used to display images on the screen. Incorrectly using the figure tag, without providing a proper figcaption, adds unnecessary clutter to the screen reader user\'s experience.' },
  NoExtraInformationInTitle: { title: 'The title attribute should not be the only method used to provide information', requirement: 'The title attribute is announced inconsistently across screen readers and browsers, making it unreliable for labeling interactive controls.' },
  FocusNotObscuredFooter: { title: 'Focused elements should not be obscured by a sticky footer', requirement: 'A sticky footer remains anchored to the bottom of the screen while the rest of the page content can be scrolled. If it is not offset from interactive elements, it can overlap and obscure the item in focus.' },
  ButtonDiscernible: { title: 'Buttons should have a label', requirement: 'Buttons that do not contain visible text should be assigned labels that inform screen reader users of their purpose.' },
  ButtonMismatch: { title: 'Buttons should be tagged for assistive technology', requirement: 'If interactive elements cannot be identified as buttons, screen reader users may not realize the element is actionable.' },
  LinkAnchorDiscernible: { title: 'Anchor links should have a descriptive label', requirement: 'Activating anchor links enables users to navigate to a different section within the same page. Anchor links without visible text or labeled images should be assigned labels that inform screen reader users of their destination.' },
  LinkCurrentPage: { title: 'Visual indication that a link\'s destination is the current page should be announced by screen readers', requirement: 'Visual cues are often used by sighted users to indicate which link represents the current page. This information should be made available to screen reader users by assigning aria-current=\'page\' to the link.' },
  LinkNavigationAmbiguous: { title: 'Link context should be exposed to assistive technology', requirement: 'Screen reader users may find it difficult to distinguish between links when the purpose of each link cannot be determined from its text alone or together with its immediate context.' },
  LinkNavigationDiscernible: { title: 'Navigation links should have a descriptive label', requirement: 'Activating navigation links enables users to navigate to a different page within the site. Links without visible text or labeled images should be assigned labels.' },
  MenuAvoid: { title: 'Avoid using role="menu" for web navigation links', requirement: 'In most cases, using role=menu on navigation elements within a web page can negatively impact screen reader users, especially those using JAWS.' },
  MenuBarAvoid: { title: 'Avoid using role="menubar" for web navigation links', requirement: 'In most cases, using role=menubar on navigation elements within a web page can negatively impact screen reader users, especially those using JAWS.' },
  MenuItemAvoid: { title: 'Avoid using role="menuitem" for web navigation links', requirement: 'In most cases, using ARIA menu roles within a web page can negatively impact screen reader users, especially those using JAWS.' },
  MenuTriggerClickable: { title: 'ARIA relationship attributes should only be applied to elements with appropriate roles', requirement: 'Interactive elements that trigger additional content should only have relationship and state ARIA attributes if they have interactive roles, such as button, tab, or combobox.' },
  NoAutofocus: { title: 'Avoid using autofocus', requirement: 'Make sure that no element has an autofocus attribute.' },
  AriaControlsHasReference: { title: 'aria-controls should reference a valid element id', requirement: 'The element\'s aria-controls points to an id that does not exist, breaking the link between the controlling element and the content it manages.' },
  LinkImageWarning: { title: 'Warning a user when a link triggers an image to open is recommended', requirement: 'It\'s good practice to warn users about the expected behavior when activating a link triggers an image to appear.' },
  LinkMailtoWarning: { title: 'Warning a user when a link triggers a mail application is recommended', requirement: 'It\'s good practice to warn users about the expected behavior when activating a link triggers a mail application.' },
  LinkPDFWarning: { title: 'Warning a user when a link triggers a PDF file is recommended', requirement: 'It\'s good practice to warn users about the expected behavior when activating a link triggers a PDF reader.' },
  LinkOpensNewWindow: { title: 'Warning a user when a link opens in a new window is recommended', requirement: 'It\'s good practice to warn users about the expected behavior when activating a link opens a new browser window or tab.' },
  TargetSize: { title: 'Interactive elements should meet minimum target size', requirement: 'Interactive elements must meet the minimum target size of 24x24 CSS pixels (WCAG 2.5.8) to ensure users with motor impairments can activate them without difficulty.' },
  CheckboxDiscernible: { title: 'Checkbox controls should have a label', requirement: 'Screen readers rely on properly coded and associated labels to announce the purpose of a form field. A checkbox control without an identifiable label may prevent screen reader users from completing the form.' },
  FormContextChangeWarning: { title: 'Interacting with form controls should not cause a change in context without warning', requirement: 'Interacting with form controls shouldn\'t automatically submit a form or cause any other change in context without notifying the user in advance.' },
  FormSubmitButtonMismatch: { title: 'Form submission controls should have type="submit"', requirement: 'Adding type="submit" to a control that submits a form ensures that screen readers users expect a change of context when they activate the control.' },
  MainNavigationMismatch: { title: 'Main navigation should have role navigation', requirement: 'Main navigation elements should have role navigation to ensure that screen readers can identify them as navigation regions.' },
  RadioDiscernible: { title: 'Radio controls should have a label', requirement: 'Screen readers rely on properly coded and associated labels to announce the purpose of a form field. A radio control without an identifiable label may prevent screen reader users from completing the form.' },
  RequiredFormFieldAriaRequired: { title: 'Mandatory form fields should indicate that they are required', requirement: 'If a field is marked as required only through visual cues, but lacks the required attribute or aria-required="true", screen readers will not announce it as mandatory.' },
  ArticleMisuse: { title: 'Only elements that function as articles should be tagged as article regions', requirement: 'Using an <article> tag on content that is not self-contained causes screen readers to announce misleading information about the page structure.' },
  BreadcrumbsMismatch: { title: 'Breadcrumb navigation region should have a label', requirement: 'A breadcrumb region presents a trail of links showing the user\'s current page in relation to higher-level pages. Without a label, it may be announced simply as "navigation".' },
  NavigationMisuse: { title: 'An element without navigation links is tagged as a navigation landmark', requirement: 'Screen readers rely on accurate tagging and labeling to provide necessary context. If an element that does not contain navigation links is tagged as a navigation landmark, screen reader users may lose orientation.' },
  RegionMainContentMismatch: { title: 'All main content should be contained in the main landmark', requirement: 'The main landmark represents the primary content of a page. It should include only content unique to that page and must remain separate from repeated elements.' },
  RegionMainContentMisuse: { title: 'An element without main content is tagged as a main landmark', requirement: 'Incorrectly tagging the main landmark may cause screen reader users to misunderstand where the primary content begins or ends.' },
  RegionMainContentSingle: { title: 'Each page should include at most one main landmark', requirement: 'A page typically presents one central subject, so a single main landmark establishes the boundaries of the primary content for screen reader users.' },
  SearchFormMismatch: { title: 'A search form should be tagged as a search landmark', requirement: 'Screen reader users rely on landmarks to quickly access important regions of a page. Defining a form as a search landmark ensures that users can quickly recognize and navigate to the search form.' },
  RegionFooterMismatch: { title: 'Global site information should be in a contentinfo landmark (footer)', requirement: 'The contentinfo region, typically represented by the <footer> element, provides screen reader users with information about the website, such as copyright, contact details, and legal information.' },
  RegionFooterMisuse: { title: 'An element without global site information is tagged as a contentinfo landmark', requirement: 'When a region without global site information is tagged as a contentinfo landmark, screen reader users may be misled about its purpose.' },
  RegionFooterSingle: { title: 'Each page should include at most one global contentinfo landmark (footer)', requirement: 'Each page should normally include only one contentinfo landmark to keep landmark navigation simple and predictable.' },
  BackgroundImageDiscernibleImage: { title: 'Functional CSS background images should be tagged for assistive technology', requirement: 'Functional images presented using CSS background properties should be marked up using role="img" so that they can be identified as images by screen reader users.' },
  DecorativeGraphicExposed: { title: 'Decorative graphics inside interactive elements should be hidden', requirement: 'Small decorative icons inside interactive elements that already have text labels add unnecessary clutter to the screen reader experience.' },
  IconDiscernible: { title: 'Meaningful icons should have a label, while decorative icons should be hidden', requirement: 'Smaller graphics used as decorative or complementary elements, such as icons, that do not provide additional information will often add unnecessary clutter to a screen reader user\'s browsing experience.' },
  ImageDiscernible: { title: 'Functional images should have a text alternative', requirement: 'Images require a text alternative when the image conveys meaningful content or serves a functional purpose. If the image is decorative, it must be hidden from assistive technology.' },
  ImageDiscernibleCorrectly: { title: 'Functional images should have an informative and accurate text alternative', requirement: 'Text alternatives must provide accurate descriptions of the image. Incorrect text alternatives, such as filenames or placeholder values, may disrupt the screen reader experience.' },
  ImageMisuse: { title: 'Only elements that function as images should be tagged as image', requirement: 'When non-graphical elements are marked up as images, screen reader users may misunderstand the intended purpose of the content.' },
  DraggingAlternative: { title: 'A slider should be operated with a single pointer', requirement: 'A slider should be operable with a single pointer.' },
  VisibleTextPartOfAccessibleName: { title: 'Aria labels should not override or replace visible text', requirement: 'Aria labels should describe elements that don\'t have proper text, like icons and field labels. It should not be used to override element texts. Screen reader users need to receive the exact text as visually on the screen.' },
  AriaLabelledbyContentMismatch: { title: 'aria-labelledby composed name should match visible text', requirement: 'When aria-labelledby references multiple elements, the composed accessible name should include the visible text content to avoid confusion for screen reader users.' },
  StickyHeaderObscuresFocus: { title: 'Focused elements should not be obscured by a sticky header', requirement: 'A sticky header remains anchored to the top of the screen while the rest of the page content can be scrolled. If it is not offset from interactive elements, it can overlap and obscure the item in focus.' },
  ListEmpty: { title: 'Lists should contain at least one list item', requirement: 'An empty list will still be announced by screen readers, which may confuse users, leaving them unsure if the list is empty or an issue prevents the screen reader from announcing the list items.' },
  HtmlLang: { title: 'Default page language should be defined', requirement: 'Specifying a default page language ensures screen readers apply the correct pronunciation rules, voices, and braille output.' },
  HtmlLangValid: { title: 'HTML lang attribute should have a valid value', requirement: 'Assigning a valid ISO language value to the <html> lang attribute ensures that screen readers use the correct pronunciation rules.' },
  MetaDescription: { title: 'Page should have a meta description', requirement: 'A meta description provides a brief summary of the page content for search engines and assistive technologies.' },
  MetaRefresh: { title: 'Pages should not use meta http-equiv="refresh"', requirement: 'A <meta> element with http-equiv="refresh" is sometimes used to automatically redirect users after a time delay. These timed changes can interrupt and disorient users who rely on assistive technology.' },
  MetaViewportScalable: { title: 'Meta viewport should allow content scaling', requirement: 'The meta viewport should allow scalability so text can be resized up to 200% without loss of functionality. Using user-scalable=no or maximum-scale=1 prevents users from enlarging content.' },
  MetaViewportPresent: { title: 'Page should have a meta viewport tag', requirement: 'Providing a meta viewport to control layout and scaling on mobile devices.' },
  PageTitle: { title: 'Page should have a title', requirement: 'A missing page title makes it difficult for screen reader users and sighted users with multiple tabs open to identify the page.' },
  PageTitleDescriptive: { title: 'Page title should be descriptive', requirement: 'Screen readers rely heavily on page titles to announce the purpose of a page. If titles aren\'t descriptive, users may not understand the context.' },
  TablistRole: { title: 'Tablists should be tagged for assistive technology', requirement: 'A tablist without role="tablist" is not announced as a group of related tabs, preventing screen reader users from recognizing the structure.' },
  TabAriaSelected: { title: 'Tab elements should have aria-selected', requirement: 'Tab elements need aria-selected to communicate which tab is currently active to screen reader users.' },
  TabAriaControls: { title: 'Tab elements should have aria-controls', requirement: 'Tab elements need aria-controls pointing to the tabpanel ID so screen readers can link tabs to their content panels.' },
  TabpanelLabelledBy: { title: 'Tab panels should have aria-labelledby', requirement: 'Tab panels need aria-labelledby referencing the controlling tab element ID for screen reader navigation.' },
  TabListMisuse: { title: 'Only elements that function as tablists should receive role="tablist"', requirement: 'Applying role="tablist" to an element without tabs misleads screen reader users by suggesting a group of tabs that does not exist.' },
  TabMismatch: { title: 'Tab controls should be tagged for assistive technology', requirement: 'Custom tabs must be explicitly defined for screen readers since there are no native HTML tab elements. Without role="tab", assistive technology will not identify them as tabs.' },
  TabMisuse: { title: 'Only elements that function as tabs should receive role="tab"', requirement: 'Applying role="tab" to an element that is not part of a functioning tab interface misleads screen reader users.' },
  TabPanelMismatch: { title: 'Tab panels should be tagged for assistive technology', requirement: 'The role="tabpanel" identifies an element as the content region of a tab interface. Without this role, panels are not perceived as part of the tab structure.' },
  TabPanelMisuse: { title: 'Only elements that function as tab panels should receive role="tabpanel"', requirement: 'Applying role="tabpanel" to an element without a corresponding tab misleads screen reader users.' },
  TableHeaders: { title: 'Table column headers should be tagged for assistive technology', requirement: 'If a column header is not marked up with the correct role or scope, screen reader users cannot determine which header applies to each cell.' },
  TableHeaderEmpty: { title: 'Table header cells should not be empty', requirement: 'If a table header cell is empty, screen reader users may only hear a generic label such as "column 3" or nothing at all.' },
  TableMisuse: { title: 'Only elements that function as data tables should be tagged as table', requirement: 'When a layout table is marked up with HTML table elements or assigned table ARIA roles, screen readers announce a data table structure even though the table is only used for page layout.' },
  TableNesting: { title: 'Tables should not be nested', requirement: 'Nested tables are often misinterpreted by screen readers, making it hard for users to follow the intended structure and meaning of the data.' },
  TableRoles: { title: 'Layout tables should not use data table markup', requirement: 'Layout tables should use role="presentation" so screen readers skip table semantics and do not announce misleading row/column information.' },
  TableCaption: { title: 'Data tables should have a caption', requirement: 'A caption or aria-label on data tables provides screen readers with context about the table\'s purpose and content.' },
  TableRowHeaderMismatch: { title: 'Table row headers should be tagged for assistive technology', requirement: 'If a table row header is not marked up with the correct role or scope, screen reader users cannot determine which header applies to each cell.' },
};

function buildAccessScanRuleCard(ruleId, ruleViols) {
  const first = ruleViols[0];
  const failCount = ruleViols.length;
  const wcagRef = first.wcagRef || '';
  const wcagVersion = wcagRef.match(/WCAG\s*\d+\.?\d*/)?.[0] || 'WCAG 2.0';
  const wcagLevel = wcagRef.match(/(A{1,3})\b/)?.[1] || (wcagRef.includes('Best Practice') ? 'BP' : 'A');
  const ruleInfo = RULE_REQUIREMENTS[ruleId];
  const ruleTitle = ruleInfo?.title || ruleId;
  const requirement = ruleInfo?.requirement || first.fix?.hint || '';

  const dedupMap = new Map();
  for (const v of ruleViols) {
    const html = v.element?.outerHTML || '';
    const key = html.slice(0, 500) || v.id;
    if (dedupMap.has(key)) {
      dedupMap.get(key).count++;
    } else {
      dedupMap.set(key, { v, html, count: 1 });
    }
  }

  const snapshotEntries = [...dedupMap.values()];
  let codeSnapshots = '';
  const uniqueCount = snapshotEntries.filter((e) => e.html).length;
  if (uniqueCount > 0) {
    codeSnapshots = snapshotEntries.map((entry, i) => {
      if (!entry.html) return '';
      const countBadge = entry.count > 1 ? `<span class="dedup-badge">&times;${entry.count}</span>` : '';
      const perHint = entry.v.fix?.hint && entry.v.fix.hint !== requirement ? `<div class="snap-hint">${esc(entry.v.fix.hint)}</div>` : '';
      const sourcePath = buildSourcePath(entry.v);
      return `<div class="snapshot-block">
      <span class="snapshot-num">${i + 1}</span>
      <div class="snapshot-content">
        <pre class="code-snippet">${esc(prettyHtml(entry.html.slice(0, 500)))}</pre>
        ${countBadge}${perHint}${sourcePath}
      </div>
    </div>`;
    }).filter(Boolean).join('');
  }

  const impactLabel = first.impact === 'critical' ? 'Critical' : first.impact === 'serious' ? 'Serious' : first.impact === 'moderate' ? 'Moderate' : 'Minor';
  const foundDate = first.foundAt ? new Date(first.foundAt).toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', year: 'numeric' }) : new Date().toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', year: 'numeric' });

  const leftContent = `<div class="as-rule-header">
          <span class="as-wcag-version">${esc(wcagVersion)}</span>
          <h4 class="as-rule-title">${esc(ruleTitle)}</h4>
        </div>
        <div class="as-requirement">
          <span class="as-req-label">Requirement:</span>
          <p>${esc(requirement)}</p>
        </div>
        ${codeSnapshots
          ? `<div class="as-snapshots"><span class="as-snap-label">${failCount} code snapshot${failCount === 1 ? '' : 's'} of failed element${failCount === 1 ? '' : 's'}</span>${codeSnapshots}</div>`
          : `<div class="as-page-level">Page-level violation &mdash; no specific element to display.</div>`}`;

  return `<div class="as-rule-card violation-card" data-impact="${first.impact}" data-layer="accessScan" data-category="accessibility">
    <div class="as-rule-layout">
      <div class="as-rule-left">
        ${leftContent}
      </div>
      <div class="as-rule-right">
        <table class="as-prop-table">
          <tr><th>Property</th><th>Value</th></tr>
          <tr><td>WCAG Version</td><td>${esc(wcagVersion)}</td></tr>
          <tr><td>WCAG Level</td><td>${esc(wcagLevel)}</td></tr>
          <tr><td>Rule Name</td><td><code>${esc(ruleId)}</code></td></tr>
          <tr><td>Failures</td><td><span class="fail-count">${failCount}</span></td></tr>
          <tr><td>Impact</td><td>${impactLabel}</td></tr>
          <tr><td>Found on</td><td>${foundDate}</td></tr>
        </table>
      </div>
    </div>
  </div>`;
}

function buildAccessScanSection(violations) {
  const totalIssues = violations.length;
  const isCompliant = totalIssues === 0;

  let html = `<div class="as-compliance-bar">
    <span class="as-compliance-badge ${isCompliant ? 'compliant' : 'non-compliant'}">
      ${isCompliant ? '&#x2713; Compliant' : '&#x2717; Non-compliant'}
    </span>
    ${isCompliant
      ? '<span class="as-compliance-text">Your scan found no accessibility issues. Great job!</span>'
      : '<span class="as-compliance-text">Your scan found serious accessibility issues. Let\'s fix them now to help you meet accessibility requirements and mitigate legal risk.</span>'}
  </div>`;

  if (isCompliant) {
    return html + `<div class="no-issues"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#008a05" stroke-width="2"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg><span>All clear</span></div>`;
  }

  for (const cat of ACCESSSCAN_CATEGORIES) {
    const catViols = violations.filter((v) => cat.rules.includes(v.ruleId));
    const catCount = catViols.length;
    const catStatusClass = catCount > 0 ? 'has-issues' : 'no-issues-cat';

    const byRule = groupViolations(catViols, (v) => v.ruleId);
    let ruleCards = '';
    for (const [ruleId, ruleViols] of byRule) {
      ruleCards += buildAccessScanRuleCard(ruleId, ruleViols);
    }

    if (catCount === 0) {
      ruleCards = `<div class="as-cat-pass"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#008a05" stroke-width="2"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg> No issues found in this category</div>`;
    }

    html += `<details class="cat-accordion ${catStatusClass}" ${catCount > 0 ? 'open' : ''}>
      <summary>
        <span class="cat-label">${esc(cat.label)}</span>
        <span class="cat-wcag">${esc(cat.wcagVersions.join(' + '))}</span>
        <span class="cat-count ${catCount > 0 ? 'has-count' : 'zero-count'}">${catCount}</span>
      </summary>
      <div class="cat-body">${ruleCards}</div>
    </details>`;
  }

  return html;
}

// ─── Generic violations section (W3C, Links, Behavioral) ────────────────────

function buildGenericViolationSection(violations) {
  if (violations.length === 0) {
    return `<div class="no-issues"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#008a05" stroke-width="2"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg><span>All clear &mdash; no issues found</span></div>`;
  }

  const byRule = groupViolations(violations, (v) => v.ruleId);
  let html = '';
  for (const [ruleId, ruleViols] of byRule) {
    const first = ruleViols[0];
    const issueCards = ruleViols.map((v) => {
      const outerHTML = v.element?.outerHTML || '';
      const selector = v.element?.selector || '';
      return `<div class="violation-card" data-impact="${v.impact}" data-layer="${v.layer}" data-category="${v.category}">
        <div class="v-meta-row">
          ${impactBadge(v.impact)}
          ${v.wcagRef ? `<span class="wcag-tag">${esc(v.wcagRef)}</span>` : ''}
          ${v.fix?.deterministic ? '<span class="fix-auto">Auto-fix</span>' : '<span class="fix-ai">AI-fix</span>'}
        </div>
        <p class="v-hint">${esc(v.fix?.hint || '')}</p>
        ${selector ? `<div class="v-location"><code>${esc(selector)}</code></div>` : ''}
        ${outerHTML ? `<pre class="code-snippet">${esc(prettyHtml(outerHTML.slice(0, 500)))}</pre>` : ''}
        ${buildSourcePath(v)}
      </div>`;
    }).join('');

    html += `<details class="rule-accordion">
      <summary>
        <div class="rule-summary-left">
          ${impactBadge(first.impact)}
          <span class="rule-title">${esc(ruleId)}</span>
        </div>
        <span class="rule-count">${ruleViols.length} issue${ruleViols.length === 1 ? '' : 's'}</span>
      </summary>
      <div class="rule-body">${issueCards}</div>
    </details>`;
  }
  return html;
}

// ─── Tool section wrapper ────────────────────────────────────────────────────

function buildToolSection(tool, allViolations, lighthouseData) {
  const toolViols = tool.layers
    ? allViolations.filter((v) => tool.layers.includes(v.layer))
    : allViolations.filter((v) => v.layer === tool.layer);
  const count = toolViols.length;

  let content = '';
  if (tool.id === 'performance') {
    content = buildPerformanceDashboard(lighthouseData);
    const perfViols = toolViols.filter((v) => v.impact !== 'info');
    if (perfViols.length > 0) {
      content += buildGenericViolationSection(perfViols);
    }
  } else if (tool.id === 'axe') {
    content = buildAxeSection(toolViols);
  } else if (tool.id === 'accessScan') {
    content = buildAccessScanSection(toolViols);
  } else {
    content = buildGenericViolationSection(toolViols);
  }

  const isPerf = tool.id === 'performance';

  return `<details class="tool-section" id="section-${tool.id}" ${count > 0 || isPerf ? 'open' : ''}>
    <summary class="tool-header">
      <div class="tool-icon" style="background:${tool.color}10;color:${tool.color}">
        ${svgIcon(tool.icon, 18, tool.color)}
      </div>
      <h2>${esc(tool.label)}</h2>
      <span class="tool-total">Total issues: <strong>${count}</strong></span>
      <span class="section-badge" style="background:${count > 0 ? tool.color : '#008a05'}">${count}</span>
      <svg class="chevron" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
    </summary>
    <div class="tool-body">${content}</div>
  </details>`;
}

// ─── Main HTML builder ───────────────────────────────────────────────────────

function buildHtml(report) {
  const allViolations = (report.pages || []).flatMap((p) => p.violations || []);
  const total = allViolations.length;
  const ts = report.timestamp ? new Date(report.timestamp).toLocaleString() : new Date().toLocaleString();
  const lighthouseData = report.lighthouse || {};

  const toolCounts = TOOL_CONFIG.map((t) => ({
    ...t,
    count: t.layers
      ? allViolations.filter((v) => t.layers.includes(v.layer)).length
      : allViolations.filter((v) => v.layer === t.layer).length,
  }));

  const criticalCount = allViolations.filter((v) => v.impact === 'critical').length;
  const seriousCount = allViolations.filter((v) => v.impact === 'serious').length;
  const moderateCount = allViolations.filter((v) => v.impact === 'moderate').length;
  const healthScore = total === 0 ? 100 : Math.max(0, 100 - criticalCount * 15 - seriousCount * 5 - moderateCount * 2);
  const healthColor = scoreColor(healthScore);

  const sections = TOOL_CONFIG.map((t) => buildToolSection(t, allViolations, lighthouseData)).join('\n');

  const navItems = toolCounts.map((t) =>
    `<button class="nav-pill" onclick="scrollToSection('section-${t.id}')">
      ${esc(t.label)}
      <span class="nav-count" style="background:${t.count > 0 ? t.color : '#008a05'}15;color:${t.count > 0 ? t.color : '#008a05'}">${t.count}</span>
    </button>`
  ).join('');

  const impactOptions = ['all', 'critical', 'serious', 'moderate', 'minor'].map((f) => {
    const colors = { all: '#222222', critical: '#c13515', serious: '#ff385c', moderate: '#6a6a6a', minor: '#929292' };
    const count = f === 'all' ? total : allViolations.filter((v) => v.impact === f).length;
    return `<button class="filter-pill${f === 'all' ? ' active' : ''}" data-filter="${f}" data-group="impact" onclick="setFilter('impact','${f}',this)" style="--fc:${colors[f]}">${f === 'all' ? 'All' : f.charAt(0).toUpperCase() + f.slice(1)} <span class="pill-count">${count}</span></button>`;
  }).join('');

  const categoryFilters = [{ id: 'all', label: 'All', color: '#222222' }, ...TOOL_CONFIG.map((t) => ({ id: t.layer || t.id, label: t.label, color: t.color }))];
  const categoryOptions = categoryFilters.map((f) => {
    const count = f.id === 'all' ? total : allViolations.filter((v) => v.layer === f.id || (f.id === 'behavioral' && ['keyboard', 'focusTrap', 'ariaLive', 'dynamicContent', 'screenReader'].includes(v.layer))).length;
    return `<button class="filter-pill${f.id === 'all' ? ' active' : ''}" data-filter="${f.id}" data-group="category-tool" onclick="setFilter('category-tool','${f.id}',this)" style="--fc:${f.color}">${esc(f.label)} <span class="pill-count">${count}</span></button>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Site Scan Report &mdash; ${esc(ts)}</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=Inter:ital,wght@0,400;0,500;0,600;0,700;1,400&display=swap');

:root {
  /* Airbnb brand palette */
  --rausch: #ff385c;
  --rausch-dark: #e0173a;
  --error: #c13515;
  --luxe: #460479;
  --ink: #222222;
  --body: #3f3f3f;
  --muted: #717171;
  --muted-soft: #b0b0b0;
  --hairline: #dddddd;
  --hairline-soft: #ebebeb;
  --canvas: #ffffff;
  --surface-soft: #f7f7f7;
  --surface-strong: #f0f0f0;
  --green: #008a05;
  --amber: #c47a00;
  --font: 'Circular', 'Inter', -apple-system, system-ui, 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif;
  --mono: 'SF Mono', 'Fira Code', 'Cascadia Code', Consolas, monospace;
  /* Airbnb border radii */
  --r-xs: 4px; --r-sm: 8px; --r-md: 12px; --r-lg: 16px; --r-xl: 24px; --r-full: 9999px;
  /* Airbnb elevation */
  --shadow-xs: 0 1px 2px rgba(0,0,0,0.06);
  --shadow-sm: 0 2px 4px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04);
  --shadow-md: 0 6px 16px rgba(0,0,0,0.12);
  --shadow-lg: 0 8px 28px rgba(0,0,0,0.18), 0 2px 8px rgba(0,0,0,0.08);
  --shadow-focus: 0 0 0 2px var(--ink);
}

*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
html { scroll-behavior: smooth; }
body { font-family: var(--font); font-size: 14px; color: var(--ink); background: var(--canvas); line-height: 1.43; -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale; }

/* ─── Top Navigation — Airbnb style ─── */
.top-nav {
  position: sticky; top: 0; z-index: 100;
  background: var(--canvas);
  border-bottom: 1px solid var(--hairline);
  box-shadow: var(--shadow-xs);
}
.top-nav-inner {
  max-width: 1760px; margin: 0 auto; padding: 0 80px;
  height: 80px; display: flex; align-items: center; gap: 20px;
}
.brand {
  display: flex; align-items: center; gap: 8px;
  font-size: 15px; font-weight: 700; color: var(--ink);
  text-decoration: none; flex-shrink: 0; letter-spacing: -0.2px;
}
.brand-mark svg { display: block; }
.nav-pills {
  display: flex; gap: 2px; flex: 1; overflow-x: auto;
  scrollbar-width: none; -webkit-overflow-scrolling: touch;
}
.nav-pills::-webkit-scrollbar { display: none; }
.nav-pill {
  padding: 9px 16px; border-radius: var(--r-full);
  font-size: 14px; font-weight: 500; color: var(--muted);
  background: transparent; border: 1px solid transparent;
  cursor: pointer; white-space: nowrap;
  display: flex; align-items: center; gap: 6px;
  transition: background .12s ease, color .12s ease, border-color .12s ease;
  line-height: 1;
}
.nav-pill:hover { background: var(--surface-soft); color: var(--ink); border-color: var(--hairline); }
.nav-pill:focus-visible { outline: none; box-shadow: var(--shadow-focus); }
.nav-count {
  font-size: 11px; font-weight: 700; padding: 2px 7px;
  border-radius: var(--r-full); line-height: 1.4;
}

/* Airbnb search bar — pill with shadow */
.search-bar { position: relative; flex-shrink: 0; }
.search-bar input {
  width: 220px; height: 44px;
  padding: 0 18px 0 40px;
  border: 1px solid var(--hairline);
  border-radius: var(--r-full);
  font-family: var(--font); font-size: 14px; color: var(--ink);
  background: var(--canvas); outline: none;
  box-shadow: var(--shadow-sm);
  transition: box-shadow .2s, border-color .2s;
}
.search-bar input:focus {
  border-color: var(--ink);
  box-shadow: var(--shadow-md);
}
.search-bar input::placeholder { color: var(--muted-soft); }
.search-bar svg {
  position: absolute; left: 14px; top: 50%;
  transform: translateY(-50%); color: var(--muted); pointer-events: none;
}

/* ─── Hero Header ─── */
.hero { background: var(--canvas); padding: 48px 80px 40px; max-width: 1760px; margin: 0 auto; }
.hero-top { display: flex; align-items: baseline; gap: 16px; margin-bottom: 32px; flex-wrap: wrap; }
.hero-title {
  font-size: 32px; font-weight: 700; color: var(--ink);
  line-height: 1.1; letter-spacing: -0.75px;
}
.hero-meta { font-size: 14px; color: var(--muted); font-weight: 400; padding-bottom: 2px; }
.summary-row { display: grid; grid-template-columns: repeat(auto-fill, minmax(148px, 1fr)); gap: 16px; }

/* Airbnb-style stat card */
.stat-card {
  background: var(--canvas);
  border: 1px solid var(--hairline);
  border-radius: var(--r-lg);
  padding: 20px 22px 18px;
  display: flex; flex-direction: column; gap: 8px;
  transition: box-shadow .2s ease, transform .2s ease;
  cursor: default;
}
.stat-card:hover {
  box-shadow: var(--shadow-md);
  transform: translateY(-1px);
}
.stat-value { font-size: 32px; font-weight: 700; line-height: 1; letter-spacing: -1px; }
.stat-label {
  font-size: 11px; font-weight: 600; color: var(--muted);
  text-transform: uppercase; letter-spacing: 0.6px;
}

/* ─── Filter Bar — Airbnb category chips ─── */
.filter-bar {
  display: flex; flex-direction: column; gap: 8px;
  padding: 12px 80px; max-width: 1760px; margin: 0 auto;
  border-bottom: 1px solid var(--hairline-soft);
}
.filter-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.filter-label { font-size: 13px; color: var(--muted); font-weight: 600; margin-right: 4px; min-width: 60px; }
.filter-pill {
  padding: 6px 14px; border-radius: var(--r-full);
  font-size: 13px; font-weight: 500; color: var(--ink);
  background: var(--canvas); border: 1px solid var(--hairline);
  cursor: pointer; transition: all .15s ease;
  display: flex; align-items: center; gap: 5px; white-space: nowrap;
}
.filter-pill:hover { border-color: var(--ink); background: var(--surface-soft); }
.filter-pill.active { background: var(--ink); color: var(--canvas); border-color: var(--ink); }
.pill-count { font-size: 11px; font-weight: 700; opacity: 0.75; }
.filter-actions { justify-content: space-between; }
.clear-filters-btn {
  padding: 6px 14px; border-radius: var(--r-full);
  font-size: 12px; font-weight: 600; color: var(--muted);
  background: transparent; border: 1px solid var(--hairline);
  cursor: pointer; display: flex; align-items: center; gap: 5px;
  transition: all .15s;
}
.clear-filters-btn:hover { border-color: var(--rausch); color: var(--rausch); }
.results-indicator { font-size: 13px; color: var(--muted); font-weight: 400; }
.results-indicator strong { font-weight: 700; color: var(--ink); }

/* ─── Main Content ─── */
.main-content { max-width: 1760px; margin: 0 auto; padding: 28px 80px 80px; }

/* ─── Tool Section — Airbnb card accordion ─── */
.tool-section {
  border: 1px solid var(--hairline);
  border-radius: var(--r-xl);
  margin-bottom: 20px; overflow: hidden;
  background: var(--canvas);
  transition: box-shadow .2s ease;
}
.tool-section:hover { box-shadow: var(--shadow-sm); }
.tool-header {
  display: flex; align-items: center; gap: 14px;
  padding: 22px 28px; cursor: pointer; list-style: none; user-select: none;
}
.tool-header::-webkit-details-marker { display: none; }
.tool-icon {
  width: 40px; height: 40px; border-radius: var(--r-md);
  display: flex; align-items: center; justify-content: center; flex-shrink: 0;
}
.tool-header h2 { font-size: 16px; font-weight: 600; flex: 1; color: var(--ink); letter-spacing: -0.1px; }
.tool-total { font-size: 13px; color: var(--muted); font-weight: 400; }
.tool-total strong { font-weight: 700; color: var(--ink); }
.section-badge {
  font-size: 11px; font-weight: 700; color: var(--canvas);
  padding: 4px 11px; border-radius: var(--r-full); min-width: 28px; text-align: center;
}
.chevron { transition: transform .25s cubic-bezier(.4,0,.2,1); color: var(--muted-soft); flex-shrink: 0; }
.tool-section[open] > .tool-header .chevron { transform: rotate(180deg); }
.tool-body { border-top: 1px solid var(--hairline-soft); }

/* ─── Rule Accordion (Axe, W3C, Links, Behavioral child) ─── */
.rule-accordion { border-bottom: 1px solid var(--hairline-soft); }
.rule-accordion:last-child { border-bottom: none; }
.rule-accordion > summary {
  padding: 14px 28px; cursor: pointer;
  display: flex; align-items: center; gap: 10px;
  font-size: 14px; color: var(--body); list-style: none;
  transition: background .1s;
}
.rule-accordion > summary::-webkit-details-marker { display: none; }
.rule-accordion > summary::before {
  content: ''; width: 0; height: 0;
  border-left: 5px solid var(--muted-soft);
  border-top: 4px solid transparent; border-bottom: 4px solid transparent;
  transition: transform .15s; flex-shrink: 0;
}
.rule-accordion[open] > summary::before { transform: rotate(90deg); }
.rule-accordion > summary:hover { background: var(--surface-soft); }
.rule-summary-left { display: flex; align-items: center; gap: 8px; flex: 1; min-width: 0; }
.rule-title { font-weight: 500; color: var(--ink); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rule-count {
  font-size: 12px; font-weight: 600; color: var(--muted);
  background: var(--surface-soft); padding: 3px 10px;
  border-radius: var(--r-full); white-space: nowrap; flex-shrink: 0;
  border: 1px solid var(--hairline-soft);
}
.rule-body { padding: 8px 28px 24px; display: flex; flex-direction: column; gap: 12px; }
.rule-description { font-size: 14px; color: var(--body); line-height: 1.55; }
.rule-link { font-size: 13px; color: var(--luxe); text-decoration: none; font-weight: 500; }
.rule-link:hover { text-decoration: underline; }

/* ─── AccessScan Compliance Bar ─── */
.as-compliance-bar {
  padding: 18px 28px; display: flex; align-items: center; gap: 14px;
  border-bottom: 1px solid var(--hairline-soft);
}
.as-compliance-badge { font-size: 13px; font-weight: 700; padding: 6px 16px; border-radius: var(--r-full); }
.as-compliance-badge.compliant { background: rgba(0,138,5,0.08); color: var(--green); border: 1px solid rgba(0,138,5,0.2); }
.as-compliance-badge.non-compliant { background: rgba(193,53,21,0.08); color: var(--error); border: 1px solid rgba(193,53,21,0.2); }
.as-compliance-text { font-size: 13px; color: var(--body); line-height: 1.4; }

/* ─── AccessScan Category Accordion ─── */
.cat-accordion { border-bottom: 1px solid var(--hairline-soft); }
.cat-accordion:last-child { border-bottom: none; }
.cat-accordion > summary {
  padding: 16px 28px; cursor: pointer;
  display: flex; align-items: center; gap: 10px;
  font-size: 14px; list-style: none; transition: background .1s;
}
.cat-accordion > summary::-webkit-details-marker { display: none; }
.cat-accordion > summary::before {
  content: ''; width: 0; height: 0;
  border-left: 5px solid var(--muted-soft);
  border-top: 4px solid transparent; border-bottom: 4px solid transparent;
  transition: transform .15s; flex-shrink: 0;
}
.cat-accordion[open] > summary::before { transform: rotate(90deg); }
.cat-accordion > summary:hover { background: var(--surface-soft); }
.cat-label { font-weight: 600; color: var(--ink); flex: 1; }
.cat-wcag { font-size: 12px; color: var(--muted-soft); }
.cat-count {
  font-size: 11px; font-weight: 700; padding: 3px 10px;
  border-radius: var(--r-full); flex-shrink: 0;
}
.cat-count.has-count { background: rgba(255,56,92,0.08); color: var(--rausch); border: 1px solid rgba(255,56,92,0.2); }
.cat-count.zero-count { background: rgba(0,138,5,0.07); color: var(--green); border: 1px solid rgba(0,138,5,0.2); }
.cat-body { padding: 4px 20px 20px; display: flex; flex-direction: column; gap: 14px; }
.as-cat-pass {
  font-size: 13px; color: var(--green);
  display: flex; align-items: center; gap: 8px; padding: 14px 0;
}

/* ─── AccessScan Rule Card — two-column ─── */
.as-rule-card {
  border: 1px solid var(--hairline); border-radius: var(--r-lg);
  padding: 0; overflow: hidden;
  transition: box-shadow .2s ease;
}
.as-rule-card:hover { box-shadow: var(--shadow-md); }
.as-rule-layout { display: grid; grid-template-columns: 1fr 260px; min-height: 0; }
.as-rule-left { padding: 24px 28px; border-right: 1px solid var(--hairline-soft); }
.as-rule-right { padding: 20px; background: var(--surface-soft); }
.as-rule-header { margin-bottom: 16px; }
.as-wcag-version {
  display: inline-block; font-size: 11px; font-weight: 600;
  color: var(--luxe); background: rgba(70,4,121,0.06);
  padding: 3px 10px; border-radius: var(--r-full);
  margin-bottom: 10px; letter-spacing: 0.2px;
  border: 1px solid rgba(70,4,121,0.15);
}
.as-rule-title { font-size: 15px; font-weight: 600; color: var(--ink); line-height: 1.4; }
.as-requirement {
  margin-bottom: 16px; padding: 14px 16px;
  background: var(--surface-soft); border-radius: var(--r-md);
  border-left: 3px solid var(--hairline);
}
.as-req-label {
  font-size: 11px; font-weight: 700; color: var(--muted);
  text-transform: uppercase; letter-spacing: 0.07em; display: block; margin-bottom: 6px;
}
.as-requirement p { font-size: 13px; color: var(--body); line-height: 1.6; }
.as-snapshots { margin-top: 14px; }
.as-snap-label { font-size: 13px; font-weight: 600; color: var(--ink); display: block; margin-bottom: 10px; }
.snapshot-block { display: flex; gap: 10px; margin-bottom: 10px; }
.snapshot-num {
  font-size: 11px; font-weight: 700; color: var(--canvas); background: var(--ink);
  width: 22px; height: 22px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  flex-shrink: 0; margin-top: 10px;
}
.snapshot-block .code-snippet { flex: 1; margin-top: 0; }
.snapshot-content { flex: 1; min-width: 0; }
.snapshot-content .code-snippet { margin-top: 0; }
.dedup-badge {
  display: inline-block; font-size: 11px; font-weight: 700;
  color: var(--canvas); background: var(--rausch);
  padding: 2px 8px; border-radius: var(--r-full); margin-top: 6px;
}
.snap-hint {
  font-size: 12px; color: var(--muted); margin-top: 6px; line-height: 1.4;
  padding: 7px 12px; background: rgba(255,56,92,0.04); border-radius: var(--r-sm);
  border: 1px solid rgba(255,56,92,0.1);
}
.as-page-level { font-size: 13px; color: var(--muted); font-style: italic; padding: 18px 0; }

/* ─── AccessScan Property Table ─── */
.as-prop-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.as-prop-table th {
  text-align: left; font-weight: 600; color: var(--muted);
  padding: 8px 10px; border-bottom: 1px solid var(--hairline);
  font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em;
}
.as-prop-table td { padding: 9px 10px; border-bottom: 1px solid var(--hairline-soft); color: var(--body); }
.as-prop-table tr:last-child td { border-bottom: none; }
.as-prop-table td:first-child { color: var(--muted); font-weight: 500; width: 100px; }
.as-prop-table code {
  font-family: var(--mono); font-size: 11.5px;
  background: rgba(255,56,92,0.06); padding: 2px 6px;
  border-radius: var(--r-xs); color: var(--rausch);
}
.fail-count { font-weight: 700; color: var(--error); }

/* ─── Violation Cards — Airbnb listing card feel ─── */
.violation-card {
  background: var(--canvas); border: 1px solid var(--hairline);
  border-radius: var(--r-lg); padding: 18px 22px;
  transition: box-shadow .2s ease;
  position: relative;
}
/* Impact-based left accent */
.violation-card[data-impact="critical"] { border-left: 3px solid var(--error); }
.violation-card[data-impact="serious"]  { border-left: 3px solid var(--rausch); }
.violation-card[data-impact="moderate"] { border-left: 3px solid #c47a00; }
.violation-card[data-impact="minor"]    { border-left: 3px solid var(--green); }
.violation-card:hover { box-shadow: var(--shadow-md); }

.v-meta-row { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; margin-bottom: 8px; }
.v-location { margin-bottom: 8px; }
.v-location .location-label { font-size: 12px; font-weight: 600; color: var(--muted); margin-right: 6px; }
.v-location code { font-family: var(--mono); font-size: 12px; color: var(--body); }
.v-fix-row { margin: 10px 0; }
.fix-label { font-size: 12px; font-weight: 600; color: var(--muted); display: block; margin-bottom: 4px; letter-spacing: 0.02em; }
.v-hint { font-size: 14px; color: var(--body); line-height: 1.55; }
.v-source { display: flex; align-items: center; gap: 6px; margin-top: 10px; flex-wrap: wrap; }
.v-source code { font-family: var(--mono); font-size: 12px; color: var(--muted); }
.v-source .source-page { color: var(--muted); opacity: 0.7; }
.v-source .source-partial { color: var(--rausch); font-weight: 600; }
.v-source .source-line { color: var(--muted); font-weight: 400; }

/* Airbnb badge style */
.badge {
  font-size: 11px; font-weight: 600; padding: 3px 9px;
  border-radius: var(--r-full); text-transform: capitalize;
  letter-spacing: 0.2px; display: inline-block;
}
.wcag-tag {
  font-size: 11px; font-weight: 500; color: var(--luxe);
  background: rgba(70,4,121,0.06); padding: 3px 9px;
  border-radius: var(--r-full); border: 1px solid rgba(70,4,121,0.12);
}
.fix-auto {
  font-size: 11px; font-weight: 600; color: #007003;
  background: rgba(0,138,5,0.07); padding: 3px 10px;
  border-radius: var(--r-full); white-space: nowrap;
  border: 1px solid rgba(0,138,5,0.2);
}
.fix-ai {
  font-size: 11px; font-weight: 600; color: var(--rausch);
  background: rgba(255,56,92,0.07); padding: 3px 10px;
  border-radius: var(--r-full); white-space: nowrap;
  border: 1px solid rgba(255,56,92,0.2);
}
.found-date { font-size: 11px; font-weight: 500; color: var(--muted-soft); margin-left: auto; white-space: nowrap; }

/* ─── Code Snippets — dark code block ─── */
.code-snippet, .source-snippet {
  font-family: var(--mono); font-size: 12px;
  background: #1a1a1a; color: #e8e8e8;
  padding: 14px 18px; border-radius: var(--r-md);
  overflow-x: auto; white-space: pre-wrap; word-break: break-all;
  max-height: 200px; margin-top: 12px; line-height: 1.6; border: none;
}
.source-snippet { background: #2a2a2a; color: #c5c5c5; }

/* ─── No Issues ─── */
.no-issues {
  padding: 56px 24px; display: flex; flex-direction: column;
  align-items: center; gap: 14px; color: var(--green);
  font-weight: 600; font-size: 16px; text-align: center;
}

/* ─── Performance Dashboard ─── */
.perf-dashboard { padding: 0; }
.device-tabs { display: flex; gap: 0; border-bottom: 1px solid var(--hairline-soft); }
.device-tab {
  flex: 1; padding: 16px 24px; font-size: 14px; font-weight: 500; color: var(--muted);
  background: var(--surface-soft); border: none; border-bottom: 2px solid transparent;
  cursor: pointer; transition: all .15s;
  display: flex; align-items: center; justify-content: center; gap: 8px;
}
.device-tab.active { background: var(--canvas); color: var(--ink); border-bottom-color: var(--ink); }
.device-tab:hover:not(.active) { background: var(--surface-strong); }
.device-panel { padding: 36px 28px; }
.gauges-row {
  display: flex; justify-content: center; gap: 40px; flex-wrap: wrap;
  padding-bottom: 36px; border-bottom: 1px solid var(--hairline-soft); margin-bottom: 28px;
}
.gauge-wrap { display: flex; flex-direction: column; align-items: center; gap: 10px; }
.gauge-lbl { font-size: 13px; font-weight: 500; color: var(--muted); }
.gauge-ring { transition: stroke-dashoffset .8s cubic-bezier(.4,0,.2,1); }
.metrics-card { background: var(--surface-soft); border-radius: var(--r-lg); padding: 22px 26px; margin-bottom: 18px; }
.metrics-title { font-size: 14px; font-weight: 600; color: var(--ink); margin-bottom: 14px; }
.metrics-table { width: 100%; border-collapse: collapse; }
.metrics-table td { padding: 10px 8px; font-size: 14px; border-bottom: 1px solid var(--hairline-soft); }
.metrics-table tr:last-child td { border-bottom: none; }
.metric-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 10px; vertical-align: middle; }
.metric-val { text-align: right; font-weight: 600; font-family: var(--mono); font-size: 14px; }
.audit-groups { margin-top: 10px; }
.audit-group { border: 1px solid var(--hairline-soft); border-radius: var(--r-md); margin-bottom: 10px; background: var(--canvas); }
.audit-group > summary {
  padding: 13px 18px; cursor: pointer; font-size: 14px; font-weight: 500; color: var(--ink);
  display: flex; align-items: center; gap: 8px; list-style: none;
}
.audit-group > summary::-webkit-details-marker { display: none; }
.audit-group > summary::before {
  content: ''; width: 0; height: 0;
  border-left: 5px solid var(--muted-soft);
  border-top: 3px solid transparent; border-bottom: 3px solid transparent; transition: transform .15s;
}
.audit-group[open] > summary::before { transform: rotate(90deg); }
.audit-count {
  font-size: 11px; font-weight: 600; color: var(--muted);
  background: var(--surface-soft); padding: 2px 8px;
  border-radius: var(--r-full); margin-left: auto;
  border: 1px solid var(--hairline-soft);
}
.audit-item { padding: 9px 18px 9px 36px; border-top: 1px solid var(--hairline-soft); }
.audit-row { display: flex; align-items: center; gap: 8px; font-size: 13px; }
.audit-title { flex: 1; color: var(--body); }
.audit-value { font-family: var(--mono); font-size: 12px; color: var(--muted); }
.audit-details { margin: 5px 0 0 24px; list-style: none; }
.audit-details li { font-size: 12px; color: var(--muted); padding: 2px 0; font-family: var(--mono); }
.audit-details li::before {
  content: ''; display: inline-block;
  width: 4px; height: 4px; border-radius: 50%;
  background: var(--hairline); margin-right: 8px; vertical-align: middle;
}

/* ─── Gap / Steps ─── */
.gap-to-100 {
  margin-top: 18px; padding: 18px;
  border: 1px solid var(--hairline-soft); border-radius: var(--r-md); background: var(--canvas);
}
.gap-item { display: grid; grid-template-columns: 1fr 120px 60px; gap: 8px; align-items: center; padding: 7px 0; font-size: 13px; }
.gap-label { color: var(--ink); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.gap-bar-track { height: 8px; background: var(--hairline-soft); border-radius: 4px; overflow: hidden; }
.gap-bar-fill { height: 100%; border-radius: 4px; transition: width .3s; }
.gap-pts { text-align: right; font-weight: 600; font-size: 12px; color: var(--muted); }
.steps-to-100 {
  margin-top: 18px; padding: 18px;
  border: 1px solid var(--hairline-soft); border-radius: var(--r-md); background: var(--canvas);
}
.steps-list { display: flex; flex-direction: column; gap: 10px; }
.step-item { display: flex; align-items: flex-start; gap: 10px; font-size: 13px; cursor: pointer; }
.step-item input[type="checkbox"] { margin-top: 3px; flex-shrink: 0; accent-color: var(--rausch); }
.step-item span { font-weight: 500; color: var(--ink); min-width: 200px; }
.step-item em { font-style: normal; color: var(--muted); font-size: 12px; }

/* ─── Passed Audits ─── */
.passed-audits-section { margin-top: 16px; border: 1px solid var(--hairline-soft); border-radius: var(--r-sm); background: var(--canvas); }
.passed-summary { padding: 12px 16px; cursor: pointer; font-size: 14px; font-weight: 500; color: var(--green); display: flex; align-items: center; gap: 8px; list-style: none; }
.passed-summary::-webkit-details-marker { display: none; }
.passed-body { padding: 0 8px 8px; }
.passed-group { border: none; margin-bottom: 4px; }
.passed-group > summary { padding: 8px 12px; font-size: 13px; color: var(--muted); }
.passed-item { border-top: none; padding: 4px 12px 4px 28px; }
.passed-item .audit-title { color: var(--muted); font-weight: 400; }

/* ─── Footer ─── */
.site-footer {
  max-width: 1760px; margin: 0 auto; padding: 28px 80px;
  border-top: 1px solid var(--hairline);
  display: flex; align-items: center; justify-content: space-between;
  font-size: 13px; color: var(--muted);
}

/* ─── Responsive ─── */
@media (max-width: 1128px) {
  .top-nav-inner, .hero, .filter-bar, .main-content, .site-footer { padding-left: 24px; padding-right: 24px; }
  .as-rule-layout { grid-template-columns: 1fr; }
  .as-rule-left { border-right: none; border-bottom: 1px solid var(--hairline-soft); }
  .as-rule-right { border-top: 1px solid var(--hairline-soft); }
  .rule-body, .tool-header, .rule-accordion > summary, .cat-accordion > summary { padding-left: 20px; padding-right: 20px; }
}
@media (max-width: 744px) {
  .top-nav-inner { height: 64px; gap: 8px; padding-left: 16px; padding-right: 16px; }
  .brand { font-size: 14px; }
  .hero { padding: 28px 16px 24px; }
  .hero-top { flex-direction: column; gap: 6px; align-items: flex-start; }
  .hero-title { font-size: 26px; }
  .filter-bar, .main-content, .site-footer { padding-left: 16px; padding-right: 16px; }
  .summary-row { grid-template-columns: repeat(2, 1fr); gap: 10px; }
  .stat-card { padding: 14px 16px; }
  .stat-value { font-size: 26px; }
  .gauges-row { gap: 20px; }
  .gauge-wrap svg { width: 90px; height: 90px; }
  .tool-header { padding: 16px 20px; }
  .tool-header h2 { font-size: 14px; }
  .rule-body, .cat-body { padding-left: 14px; padding-right: 14px; }
  .as-rule-left { padding: 16px 18px; }
  .as-rule-right { padding: 14px 16px; }
  .search-bar { display: none; }
  .filter-row { gap: 5px; overflow-x: auto; flex-wrap: nowrap; -webkit-overflow-scrolling: touch; scrollbar-width: none; }
  .filter-row::-webkit-scrollbar { display: none; }
  .filter-pill { padding: 5px 11px; font-size: 12px; flex-shrink: 0; }
  .as-rule-layout { grid-template-columns: 1fr; }
  .site-footer { flex-direction: column; gap: 8px; text-align: center; }
}

.section-empty { opacity: 0.3; }
.page-group-hidden { display: none; }
</style>
</head>
<body>

<nav class="top-nav">
  <div class="top-nav-inner">
    <a class="brand" href="#">
      <span class="brand-mark">
        <!-- Airbnb Bélo mark -->
        <svg width="28" height="28" viewBox="0 0 24 24" fill="#ff385c" xmlns="http://www.w3.org/2000/svg">
          <path d="M12 2C8.5 2 6 5.5 6 8.5c0 1.4.4 2.7 1.1 3.8L12 22l4.9-9.7c.7-1.1 1.1-2.4 1.1-3.8C18 5.5 15.5 2 12 2zm0 8.5a2.5 2.5 0 1 1 0-5 2.5 2.5 0 0 1 0 5z"/>
        </svg>
      </span>
      Site Scan
    </a>
    <div class="nav-pills">${navItems}</div>
    <div class="search-bar">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
      <input type="text" placeholder="Search rules..." oninput="onSearch(this)">
    </div>
  </div>
</nav>

<header class="hero">
  <div class="hero-top">
    <h1 class="hero-title">Scan Report</h1>
    <span class="hero-meta">${esc(ts)} &middot; ${(report.pages || []).length} page${(report.pages || []).length === 1 ? '' : 's'} scanned</span>
  </div>
  <div class="summary-row">
    <div class="stat-card">
      <span class="stat-value" style="color:${healthColor}">${healthScore}<span style="font-size:16px;font-weight:500;color:var(--muted);margin-left:2px">/100</span></span>
      <span class="stat-label">Health Score</span>
    </div>
    <div class="stat-card">
      <span class="stat-value" style="color:${total > 0 ? 'var(--rausch)' : 'var(--green)'}">${total}</span>
      <span class="stat-label">Total Issues</span>
    </div>
    <div class="stat-card">
      <span class="stat-value" style="color:var(--error)">${criticalCount}</span>
      <span class="stat-label">Critical</span>
    </div>
    <div class="stat-card">
      <span class="stat-value" style="color:var(--rausch)">${seriousCount}</span>
      <span class="stat-label">Serious</span>
    </div>
    ${toolCounts.map((t) => `<div class="stat-card"><span class="stat-value" style="color:${t.color}">${t.count}</span><span class="stat-label">${esc(t.label)}</span></div>`).join('')}
  </div>
</header>

<div class="filter-bar">
  <div class="filter-row">
    <span class="filter-label">Impact</span>
    ${impactOptions}
  </div>
  <div class="filter-row">
    <span class="filter-label">Category</span>
    ${categoryOptions}
  </div>
  <div class="filter-row filter-actions">
    <button class="clear-filters-btn" onclick="clearAllFilters()">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      Clear Filters
    </button>
    <span class="results-indicator" id="results-indicator">Showing <strong>${total}</strong> of ${total} issues</span>
  </div>
</div>

<main class="main-content">
  ${sections}
</main>

<footer class="site-footer">
  <span style="display:flex;align-items:center;gap:8px">
    <svg width="16" height="16" viewBox="0 0 24 24" fill="#ff385c"><path d="M12 2C8.5 2 6 5.5 6 8.5c0 1.4.4 2.7 1.1 3.8L12 22l4.9-9.7c.7-1.1 1.1-2.4 1.1-3.8C18 5.5 15.5 2 12 2zm0 8.5a2.5 2.5 0 1 1 0-5 2.5 2.5 0 0 1 0 5z"/></svg>
    &copy; ${new Date().getFullYear()} ADA &amp; Performance Automation
  </span>
  <span>local-career-site</span>
</footer>

<script>
const TOTAL_ISSUES = ${total};
let activeImpact = 'all';
let activeCategoryTool = 'all';
const BEHAVIORAL_LAYERS = ['keyboard', 'focusTrap', 'ariaLive', 'dynamicContent', 'screenReader'];
let searchQuery = '';

function scrollToSection(id) {
  const el = document.getElementById(id);
  if (el) { if (!el.open) el.open = true; el.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
}

function switchDevice(btn, showId, hideId) {
  btn.parentElement.querySelectorAll('.device-tab').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  const show = document.getElementById(showId);
  const hide = document.getElementById(hideId);
  if (show) show.style.display = '';
  if (hide) hide.style.display = 'none';
}

function setFilter(group, value, btn) {
  if (group === 'impact') activeImpact = value;
  if (group === 'category-tool') activeCategoryTool = value;
  document.querySelectorAll('.filter-pill[data-group="' + group + '"]').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  applyFilters();
}

function onSearch(input) {
  searchQuery = input.value.toLowerCase().trim();
  applyFilters();
}

function clearAllFilters() {
  activeImpact = 'all';
  activeCategoryTool = 'all';
  searchQuery = '';
  const si = document.querySelector('.search-bar input');
  if (si) si.value = '';
  document.querySelectorAll('.filter-pill').forEach(b => b.classList.toggle('active', b.dataset.filter === 'all'));
  applyFilters();
}

function applyFilters() {
  const cards = document.querySelectorAll('.violation-card');
  let shown = 0;
  cards.forEach(card => {
    const matchImpact = activeImpact === 'all' || card.dataset.impact === activeImpact;
    const layer = card.dataset.layer || '';
    const matchCategory = activeCategoryTool === 'all' || layer === activeCategoryTool || (activeCategoryTool === 'behavioral' && BEHAVIORAL_LAYERS.includes(layer));
    const matchSearch = !searchQuery || card.textContent.toLowerCase().includes(searchQuery);
    const visible = matchImpact && matchCategory && matchSearch;
    card.style.display = visible ? '' : 'none';
    if (visible) shown++;
  });
  document.getElementById('results-indicator').innerHTML = 'Showing <strong>' + shown + '</strong> of ' + TOTAL_ISSUES + ' issues';

  document.querySelectorAll('.tool-section').forEach(sec => {
    let cnt = 0;
    sec.querySelectorAll('.violation-card').forEach(c => { if (c.style.display !== 'none') cnt++; });
    const badge = sec.querySelector('.section-badge');
    if (badge) badge.textContent = cnt;
    const total = sec.querySelector('.tool-total strong');
    if (total) total.textContent = cnt;
  });

  document.querySelectorAll('.rule-accordion').forEach(ra => {
    let cnt = 0;
    ra.querySelectorAll('.violation-card').forEach(c => { if (c.style.display !== 'none') cnt++; });
    const rc = ra.querySelector('.rule-count');
    if (rc) rc.textContent = cnt + ' issue' + (cnt === 1 ? '' : 's');
    ra.style.display = cnt === 0 ? 'none' : '';
  });

  document.querySelectorAll('.cat-accordion').forEach(ca => {
    let cnt = 0;
    ca.querySelectorAll('.violation-card').forEach(c => { if (c.style.display !== 'none') cnt++; });
    const cc = ca.querySelector('.cat-count');
    if (cc) { cc.textContent = cnt; cc.className = 'cat-count ' + (cnt > 0 ? 'has-count' : 'zero-count'); }
  });

  document.querySelectorAll('.nav-pill').forEach(pill => {
    const sid = pill.getAttribute('onclick')?.match(/section-([^']+)/)?.[1];
    if (!sid) return;
    const sec = document.getElementById('section-' + sid);
    if (!sec) return;
    let cnt = 0;
    sec.querySelectorAll('.violation-card').forEach(c => { if (c.style.display !== 'none') cnt++; });
    const nc = pill.querySelector('.nav-count');
    if (nc) nc.textContent = cnt;
  });
}
</script>
</body>
</html>`;
}
