// Quality gate (T-E3.7): thresholds schema, legacy mapping, dev-server detection and per-page/per-metric evaluation.

export const DEFAULT_THRESHOLDS = {
  lighthouse: {
    mobile: { performance: 80, accessibility: 100, bestPractices: 90, seo: 90 },
    desktop: { performance: 90, accessibility: 100, bestPractices: 90, seo: 90 },
  },
  a11y: { critical: 0, serious: 0, moderate: 'report', minor: 'report' },
  w3c: { errors: 0, warnings: 'report' },
};

export const LEGACY_THRESHOLD_KEYS = ['wcag', 'performance', 'bestPractices'];
const LH_KEYS = ['performance', 'accessibility', 'bestPractices', 'seo'];
const A11Y_KEYS = ['critical', 'serious', 'moderate', 'minor'];
const W3C_KEYS = ['errors', 'warnings'];

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const okNum = (v, max) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && (max === undefined || v <= max);

/** Validation errors for `config.thresholds` (nested schema plus the deprecated flat keys). */
export function validateThresholds(t) {
  if (!isObj(t)) return ['thresholds must be an object'];
  const errs = [];
  const group = (name, obj, keys, check, hint) => {
    if (!isObj(obj)) return errs.push(`thresholds.${name} must be an object`);
    for (const [k, v] of Object.entries(obj)) {
      if (!keys.includes(k)) errs.push(`thresholds.${name}.${k} is not a known key (${keys.join(', ')})`);
      else if (!check(v)) errs.push(`thresholds.${name}.${k} must be ${hint}`);
    }
  };
  for (const [k, v] of Object.entries(t)) {
    if (LEGACY_THRESHOLD_KEYS.includes(k)) {
      if (!okNum(v, k === 'wcag' ? undefined : 100)) errs.push(`thresholds.${k} must be a number >= 0 (scores <= 100)`);
    } else if (k === 'lighthouse') {
      if (!isObj(v)) errs.push('thresholds.lighthouse must be an object');
      else for (const [ff, o] of Object.entries(v)) {
        if (ff !== 'mobile' && ff !== 'desktop') errs.push(`thresholds.lighthouse.${ff} is not a form factor (mobile, desktop)`);
        else group(`lighthouse.${ff}`, o, LH_KEYS, (x) => okNum(x, 100), 'a number 0-100');
      }
    } else if (k === 'a11y') group(k, v, A11Y_KEYS, (x) => okNum(x) || x === 'report', "a count >= 0 or 'report'");
    else if (k === 'w3c') group(k, v, W3C_KEYS, (x) => okNum(x) || x === 'report', "a count >= 0 or 'report'");
    else errs.push(`thresholds.${k} is not a known key (lighthouse, a11y, w3c, wcag, performance, bestPractices)`);
  }
  return errs;
}

/** Full nested thresholds from user config; old flat keys map onto it. Returns { thresholds, notices }. */
export function normalizeThresholds(user = {}) {
  const t = structuredClone(DEFAULT_THRESHOLDS);
  const notices = [];
  const legacy = LEGACY_THRESHOLD_KEYS.filter((k) => user?.[k] !== undefined);
  if (legacy.length) {
    notices.push(`thresholds.${legacy.join(', thresholds.')} ${legacy.length > 1 ? 'are' : 'is'} deprecated; use thresholds.lighthouse / a11y / w3c`);
  }
  if (user?.wcag !== undefined) t.a11y.critical = t.a11y.serious = user.wcag;
  if (user?.performance !== undefined) t.lighthouse.mobile.performance = user.performance;
  if (user?.bestPractices !== undefined) t.lighthouse.mobile.bestPractices = t.lighthouse.desktop.bestPractices = user.bestPractices;
  for (const [ff, o] of Object.entries(user?.lighthouse || {})) Object.assign(t.lighthouse[ff], o);
  Object.assign(t.a11y, user?.a11y);
  Object.assign(t.w3c, user?.w3c);
  return { thresholds: t, notices };
}

/** True when the served HTML carries the Vite dev client (unminified dev server; Lighthouse performance is not meaningful). */
export function isDevServerHtml(html) {
  return typeof html === 'string' && html.includes('/@vite/client');
}

/** True when the main response blocks indexing: robots/googlebot meta or X-Robots-Tag header with noindex (or none). Lighthouse SEO is then meaningless. */
export function isNoindex(html, headers = {}) {
  const blocks = (v) => /\b(noindex|none)\b/i.test(v || '');
  const metas = typeof html === 'string' ? html.match(/<meta\b[^>]*>/gi) || [] : [];
  const meta = metas.some((tag) => /\bname\s*=\s*["']?(robots|googlebot)\b/i.test(tag) && blocks(tag.match(/\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)')/i)?.slice(1).join('')));
  return meta || blocks(headers['x-robots-tag']);
}

// The offline html-validate layer feeds the same HTML validity counts as the W3C Nu layer.
const W3C_LAYERS = ['w3c', 'htmlValidate'];
const isW3c = (v) => W3C_LAYERS.includes(v.layer) || v.layers?.some((l) => W3C_LAYERS.includes(l));

const verdict = (actual, target, passes, extra = {}) => ({
  actual, target, status: actual === null || actual === undefined ? 'skipped' : passes ? 'pass' : 'fail', ...extra,
});

/**
 * pages: [{ name, url, findings (report model, preferred) or violations, lighthouseScores, devServer }]. Returns { thresholds, notices, pages: [{ name, url, metrics }], failed }.
 * Metric status: pass | fail | advisory (performance on a dev server, SEO on a noindex target) | skipped (no data) | report (target 'report', never fails).
 * `layers` limits the w3c checks to layers that ran.
 */
export function evaluateGate(pages, userThresholds, { perfGate = false, seoGate = false, layers = {}, countThirdParty = false, countPlatform = false } = {}) {
  const { thresholds, notices } = normalizeThresholds(userThresholds);
  const out = pages.map((page) => {
    const metrics = [];
    if (page.status === 'failed' || page.status === 'skipped-empty') return { name: page.name, url: page.url, devServer: false, noindex: false, metrics };
    const scores = page.lighthouseScores?.[page.name]?.lighthouse || {};
    for (const ff of ['mobile', 'desktop']) {
      for (const key of LH_KEYS) {
        const target = thresholds.lighthouse[ff][key];
        const actual = scores[ff]?.scores?.[key] ?? null;
        const m = { id: `lighthouse.${ff}.${key}`, ...verdict(actual, target, actual >= target) };
        if (m.status === 'skipped' && scores[ff]?.unscorable) m.reason = 'unscorable';
        if (key === 'performance' && page.devServer && !perfGate && m.status !== 'skipped') {
          m.status = 'advisory';
          m.reason = 'dev server (Vite): unminified, performance is advisory; use --perf-gate to enforce';
        }
        if (key === 'seo' && page.noindex && !seoGate && m.status !== 'skipped') {
          m.status = 'advisory';
          m.reason = 'target is noindex (preview); use --seo-gate to enforce';
        }
        metrics.push(m);
      }
    }
    // Report-model findings carry summed occurrence counts; raw violations count one each.
    // Vendor, iframe and platform-widget content is not the site's to fix: listed in the report, outside the gate unless asked for.
    const all = page.findings || page.violations || [];
    const items = all.filter((v) => (countThirdParty || v.ownership !== 'third-party') && (countPlatform || v.ownership !== 'platform'));
    // Confirmed occurrences the filter above kept out, so the report can say how many the gate did not look at.
    const excluded = all.filter((v) => !items.includes(v) && v.impact !== 'info' && (v.verdict ?? 'confirmed') === 'confirmed').reduce((n, v) => n + (v.count ?? 1), 0);
    const count = (fn) => items.reduce((n, v) => n + (fn(v) ? (v.count ?? 1) : 0), 0);
    const counted = (id, target, actual) => metrics.push(
      target === 'report' ? { id, actual, target, status: 'report' } : { id, ...verdict(actual, target, actual <= target) });
    // Only confirmed findings can fail; likely and needs-review are reported beside them (findings without a verdict predate E11.2).
    const confirmed = (v) => (v.verdict ?? 'confirmed') === 'confirmed';
    for (const level of A11Y_KEYS) {
      counted(`a11y.${level}`, thresholds.a11y[level], count((v) => v.category === 'accessibility' && v.impact === level && confirmed(v)));
    }
    for (const [id, verdict] of [['a11y.likely', 'likely'], ['a11y.needsReview', 'needs-review']]) {
      counted(id, 'report', count((v) => v.category === 'accessibility' && v.verdict === verdict && v.impact !== 'info'));
    }
    const listed = W3C_LAYERS.filter((l) => l in layers);
    const w3cRan = !listed.length || listed.some((l) => layers[l]);
    const w3c = (id, target, fn) => (w3cRan ? counted(id, target, count(fn)) : metrics.push({ id, actual: null, target, status: 'skipped' }));
    w3c('w3c.errors', thresholds.w3c.errors, (v) => isW3c(v) && v.impact !== 'minor' && confirmed(v));
    w3c('w3c.warnings', thresholds.w3c.warnings, (v) => isW3c(v) && v.impact === 'minor');
    return { name: page.name, url: page.url, devServer: Boolean(page.devServer), noindex: Boolean(page.noindex), metrics, ...(excluded ? { excluded } : {}) };
  });
  const failed = out.some((p) => p.metrics.some((m) => m.status === 'fail'));
  return { thresholds, notices, pages: out, failed };
}

export const excludedNote = (n) => `third-party and platform findings excluded (${n})`;

/** Console lines: `actual / target` per metric and page. */
export function formatGate(gate) {
  const lines = ['\nQuality gate (actual / target)'];
  for (const p of gate.pages) {
    lines.push(`  ${p.url} ${[p.devServer && '[dev server]', p.noindex && '[noindex]'].filter(Boolean).join(' ')}`.trimEnd());
    for (const m of p.metrics) {
      lines.push(`    ${m.status.toUpperCase().padEnd(8)} ${m.id}: ${m.actual ?? 'n/a'} / ${m.target}${m.reason ? ` (${m.reason})` : ''}`);
    }
    if (p.excluded) lines.push(`    ${excludedNote(p.excluded)}`);
  }
  lines.push(`Gate: ${gate.failed ? 'FAILED' : 'passed'}`);
  return lines;
}
