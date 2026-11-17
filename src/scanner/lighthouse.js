import { externalGate } from '../utils/external.js';
const PSI_API_URL = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed';
const PSI_CATEGORIES = ['performance', 'accessibility', 'best-practices', 'seo'];
const PSI_TIMEOUT_MS = 90_000;

export function classifyPsiFailure(error) {
  const message = String(error?.message || error || '');
  const statusMatch = message.match(/PSI API (\d{3})/i);
  const status = statusMatch ? Number(statusMatch[1]) : null;
  if (status === 429 || /quota exceeded/i.test(message)) {
    return { code: 'quota-exceeded', status: 429 };
  }
  if (/timed out|aborterror/i.test(message)) {
    return { code: 'timeout', status };
  }
  if (/missing lighthouseResult/i.test(message)) {
    return { code: 'invalid-response', status };
  }
  if (status) {
    return { code: 'http-error', status };
  }
  return { code: 'unavailable', status: null };
}

export function createLighthouseProvenance({
  requestedSource = 'local',
  actualSource = 'local',
  fallbackError = null,
} = {}) {
  return {
    requestedSource,
    actualSource,
    comparableToPsi: actualSource === 'psi-api',
    fallbackReason: fallbackError ? classifyPsiFailure(fallbackError) : null,
  };
}

const METRIC_THRESHOLDS = {
  'first-contentful-paint': { good: 1800, poor: 3000, unit: 'ms', label: 'First Contentful Paint' },
  'largest-contentful-paint': { good: 2500, poor: 4000, unit: 'ms', label: 'Largest Contentful Paint' },
  'total-blocking-time': { good: 200, poor: 600, unit: 'ms', label: 'Total Blocking Time' },
  'cumulative-layout-shift': { good: 0.1, poor: 0.25, unit: '', label: 'Cumulative Layout Shift' },
  'speed-index': { good: 3400, poor: 5800, unit: 'ms', label: 'Speed Index' },
  'interactive': { good: 3800, poor: 7300, unit: 'ms', label: 'Time to Interactive' },
};

const PERFORMANCE_AUDIT_IDS = [
  'render-blocking-resources',
  'uses-responsive-images',
  'offscreen-images',
  'unminified-css',
  'unminified-javascript',
  'unused-css-rules',
  'unused-javascript',
  'uses-optimized-images',
  'modern-image-formats',
  'uses-text-compression',
  'uses-rel-preconnect',
  'server-response-time',
  'redirects',
  'uses-rel-preload',
  'efficient-animated-content',
  'duplicated-javascript',
  'legacy-javascript',
  'total-byte-weight',
  'uses-long-cache-ttl',
  'dom-size',
  'critical-request-chains',
  'user-timings',
  'bootup-time',
  'mainthread-work-breakdown',
  'font-display',
  'third-party-summary',
  'third-party-facades',
  'largest-contentful-paint-element',
  'lcp-lazy-loaded',
  'layout-shift-elements',
  'uses-passive-event-listeners',
  'no-document-write',
  'long-tasks',
  'non-composited-animations',
  'unsized-images',
  'viewport',
  'no-unload-listeners',
];

const AUDIT_GROUP_MAP = {
  'render-blocking-resources': 'Render Blocking',
  'uses-rel-preconnect': 'Render Blocking',
  'uses-rel-preload': 'Render Blocking',
  'critical-request-chains': 'Render Blocking',
  'server-response-time': 'Render Blocking',
  'redirects': 'Render Blocking',
  'uses-long-cache-ttl': 'Cache Efficiency',
  'uses-responsive-images': 'Image Delivery',
  'offscreen-images': 'Image Delivery',
  'uses-optimized-images': 'Image Delivery',
  'modern-image-formats': 'Image Delivery',
  'efficient-animated-content': 'Image Delivery',
  'unsized-images': 'Image Delivery',
  'lcp-lazy-loaded': 'Image Delivery',
  'font-display': 'Font Display',
  'third-party-summary': 'Third Parties',
  'third-party-facades': 'Third Parties',
  'bootup-time': 'Main Thread',
  'mainthread-work-breakdown': 'Main Thread',
  'long-tasks': 'Main Thread',
  'dom-size': 'DOM & Resources',
  'total-byte-weight': 'DOM & Resources',
  'user-timings': 'DOM & Resources',
  'unminified-css': 'Code Optimization',
  'unminified-javascript': 'Code Optimization',
  'unused-css-rules': 'Code Optimization',
  'unused-javascript': 'Code Optimization',
  'duplicated-javascript': 'Code Optimization',
  'legacy-javascript': 'Code Optimization',
  'uses-text-compression': 'Code Optimization',
  'largest-contentful-paint-element': 'LCP Analysis',
  'layout-shift-elements': 'CLS Analysis',
  'no-document-write': 'Best Practices',
  'uses-passive-event-listeners': 'Best Practices',
  'non-composited-animations': 'Best Practices',
  'viewport': 'Best Practices',
  'no-unload-listeners': 'Best Practices',
};

const DEVICE_CONFIGS = {
  mobile: {
    formFactor: 'mobile',
    screenEmulation: { mobile: true, width: 412, height: 823, deviceScaleFactor: 1.75 },
    throttling: {
      rttMs: 150,
      throughputKbps: 1638.4,
      cpuSlowdownMultiplier: 4,
      requestLatencyMs: 562.5,
      downloadThroughputKbps: 1474.56,
      uploadThroughputKbps: 675,
    },
    throttlingMethod: 'simulate',
  },
  desktop: {
    formFactor: 'desktop',
    screenEmulation: { mobile: false, width: 1350, height: 940, deviceScaleFactor: 1 },
    throttling: {
      rttMs: 40,
      throughputKbps: 10240,
      cpuSlowdownMultiplier: 1,
      requestLatencyMs: 0,
      downloadThroughputKbps: 10240,
      uploadThroughputKbps: 10240,
    },
    throttlingMethod: 'simulate',
  },
};

function ratingFromScore(score) {
  if (score === null || score === undefined) return 'error';
  if (score >= 0.9) return 'good';
  if (score >= 0.5) return 'average';
  return 'poor';
}

function metricRating(auditId, value) {
  const t = METRIC_THRESHOLDS[auditId];
  if (!t) return 'info';
  if (value <= t.good) return 'good';
  if (value <= t.poor) return 'average';
  return 'poor';
}

function formatMetricValue(auditId, value) {
  const t = METRIC_THRESHOLDS[auditId];
  if (!t) return String(value);
  if (t.unit === 'ms') {
    return value >= 1000 ? `${(value / 1000).toFixed(1)} s` : `${Math.round(value)} ms`;
  }
  return auditId === 'cumulative-layout-shift' ? value.toFixed(3) : String(Math.round(value));
}

function extractMetrics(lhr) {
  const metrics = {};
  for (const [id, config] of Object.entries(METRIC_THRESHOLDS)) {
    const audit = lhr.audits[id];
    if (!audit) continue;
    const value = audit.numericValue;
    if (value === undefined || value === null) continue;
    metrics[id] = {
      label: config.label,
      value,
      displayValue: formatMetricValue(id, value),
      rating: metricRating(id, value),
      score: audit.score,
      target: `good <= ${formatMetricValue(id, config.good)}, poor > ${formatMetricValue(id, config.poor)}`,
    };
  }
  return metrics;
}

function extractAuditDetails(auditId, audit) {
  const items = Array.isArray(audit.details?.items) ? audit.details.items : [];
  if (items.length === 0) return null;

  if (auditId === 'largest-contentful-paint-element') {
    return items.slice(0, 5).map((item) => ({
      url: '',
      wastedBytes: 0,
      wastedMs: 0,
      totalBytes: 0,
      label: item.node?.snippet || item.node?.nodeLabel || item.element || '',
      selector: item.node?.selector || '',
      type: item.node?.type || item.type || 'element',
    }));
  }

  if (auditId === 'layout-shift-elements') {
    return items.slice(0, 10).map((item) => ({
      url: '',
      wastedBytes: 0,
      wastedMs: 0,
      totalBytes: 0,
      label: item.node?.snippet || item.node?.nodeLabel || '',
      selector: item.node?.selector || '',
      score: item.score || 0,
    }));
  }

  if (auditId === 'third-party-summary') {
    return items.slice(0, 10).map((item) => ({
      url: item.entity || item.url || '',
      wastedBytes: item.transferSize || item.totalBytes || 0,
      wastedMs: item.blockingTime || 0,
      totalBytes: item.transferSize || item.totalBytes || 0,
      label: item.entity || '',
    }));
  }

  return items.slice(0, 10).map((item) => ({
    url: item.url || item.source || '',
    wastedBytes: item.wastedBytes || 0,
    wastedMs: item.wastedMs || 0,
    totalBytes: item.totalBytes || 0,
    label: item.label || item.groupLabel || '',
  }));
}

function extractAudits(lhr) {
  const audits = {};
  const groups = {};
  const passedAudits = {};
  const passedGroups = {};

  for (const auditId of PERFORMANCE_AUDIT_IDS) {
    const audit = lhr.audits[auditId];
    if (!audit || audit.score === null) continue;

    const groupName = AUDIT_GROUP_MAP[auditId] || 'Other';
    const overallSavingsMs = audit.details?.overallSavingsMs || audit.numericValue || 0;
    const entry = {
      id: auditId,
      title: audit.title || auditId,
      description: (audit.description || '').replace(/\[.*?\]\(.*?\)/g, '').trim(),
      score: audit.score,
      rating: ratingFromScore(audit.score),
      displayValue: audit.displayValue || '',
      numericValue: audit.numericValue,
      wastedMs: overallSavingsMs,
      details: extractAuditDetails(auditId, audit),
    };

    if (audit.score === 1) {
      passedAudits[auditId] = entry;
      if (!passedGroups[groupName]) passedGroups[groupName] = [];
      passedGroups[groupName].push(entry);
    } else {
      audits[auditId] = entry;
      if (!groups[groupName]) groups[groupName] = [];
      groups[groupName].push(entry);
    }
  }

  return { audits, groups, passedAudits, passedGroups };
}

export function extractAccessibilityAudits(lhr = {}) {
  const auditRefs = lhr.categories?.accessibility?.auditRefs || [];
  const failedAudits = [];
  const summary = {
    rawAuditCount: auditRefs.length,
    issueGroups: 0,
    affectedNodes: 0,
    passed: 0,
    manual: 0,
    notApplicable: 0,
    incomplete: 0,
  };

  for (const reference of auditRefs) {
    const audit = lhr.audits?.[reference.id];
    if (!audit) {
      summary.incomplete += 1;
      continue;
    }
    if (audit.score === 1) {
      summary.passed += 1;
      continue;
    }
    if (audit.score === null || audit.score === undefined) {
      if (audit.scoreDisplayMode === 'manual') summary.manual += 1;
      else if (audit.scoreDisplayMode === 'notApplicable') summary.notApplicable += 1;
      else summary.incomplete += 1;
      continue;
    }

    const items = Array.isArray(audit.details?.items) ? audit.details.items : [];
    const nodes = items.map((item) => {
      const node = item.node || item;
      return {
        selector: node.selector || '',
        snippet: node.snippet || '',
        nodeLabel: node.nodeLabel || '',
        explanation: node.explanation || item.explanation || '',
        path: node.path || '',
      };
    }).filter((node) =>
      node.selector || node.snippet || node.nodeLabel || node.explanation || node.path
    );
    failedAudits.push({
      id: reference.id,
      title: audit.title || reference.id,
      description: (audit.description || '').replace(/\[.*?\]\(.*?\)/g, '').trim(),
      score: audit.score,
      weight: reference.weight ?? null,
      nodes,
    });
    summary.issueGroups += 1;
    summary.affectedNodes += nodes.length;
  }

  return { failedAudits, summary };
}

// Lighthouse a11y audit id -> [impact, WCAG success criterion (null = best practice only)]. Unknown ids stay moderate/null and are flagged unmapped.
const A11Y_AUDIT_MAP = {
  'color-contrast': ['serious', '1.4.3'], 'image-alt': ['critical', '1.1.1'], 'input-image-alt': ['critical', '1.1.1'],
  'object-alt': ['serious', '1.1.1'], 'button-name': ['critical', '4.1.2'], 'link-name': ['serious', '2.4.4'],
  'label': ['critical', '1.3.1'], 'select-name': ['critical', '4.1.2'], 'html-has-lang': ['serious', '3.1.1'],
  'html-lang-valid': ['serious', '3.1.1'], 'valid-lang': ['serious', '3.1.2'], 'document-title': ['serious', '2.4.2'],
  'meta-viewport': ['critical', '1.4.4'], 'meta-refresh': ['critical', '2.2.1'], 'bypass': ['serious', '2.4.1'],
  'frame-title': ['serious', '4.1.2'], 'tabindex': ['serious', null], 'heading-order': ['moderate', null],
  'duplicate-id-aria': ['critical', '4.1.2'], 'aria-allowed-attr': ['critical', '4.1.2'],
  'aria-required-attr': ['critical', '4.1.2'], 'aria-valid-attr': ['critical', '4.1.2'],
  'aria-valid-attr-value': ['critical', '4.1.2'], 'aria-roles': ['critical', '4.1.2'],
  'aria-hidden-body': ['critical', '4.1.2'], 'aria-hidden-focus': ['serious', '4.1.2'],
  'aria-input-field-name': ['serious', '4.1.2'], 'aria-command-name': ['serious', '4.1.2'],
  'aria-toggle-field-name': ['serious', '4.1.2'], 'aria-dialog-name': ['serious', '4.1.2'],
  'aria-meter-name': ['serious', '1.1.1'], 'aria-progressbar-name': ['serious', '1.1.1'],
  'aria-tooltip-name': ['serious', '4.1.2'], 'aria-treeitem-name': ['serious', '4.1.2'],
  'list': ['serious', '1.3.1'], 'listitem': ['serious', '1.3.1'], 'definition-list': ['serious', '1.3.1'],
  'dlitem': ['serious', '1.3.1'], 'td-headers-attr': ['serious', '1.3.1'], 'th-has-data-cells': ['serious', '1.3.1'],
  'video-caption': ['critical', '1.2.2'], 'target-size': ['serious', '2.5.8'], 'link-in-text-block': ['serious', '1.4.1'],
  'autocomplete-valid': ['serious', '1.3.5'], 'label-content-name-mismatch': ['serious', '2.5.3'],
};

export function mapLighthouseA11yAudit(auditId) {
  const hit = A11Y_AUDIT_MAP[auditId];
  return hit ? { impact: hit[0], wcagCriteria: hit[1], unmapped: false } : { impact: 'moderate', wcagCriteria: null, unmapped: true };
}

export function generateLighthouseAccessibilityViolations(result = {}) {
  const findings = new Map();

  for (const [deviceName, device] of Object.entries(result)) {
    for (const audit of device?.accessibility?.failedAudits || []) {
      const nodes = audit.nodes?.length > 0 ? audit.nodes : [{}];
      const mapped = mapLighthouseA11yAudit(audit.id);
      for (const node of nodes) {
        const key = `${audit.id}|${node.selector || ''}|${node.snippet || ''}`;
        if (!findings.has(key)) {
          findings.set(key, {
            rule: audit.id,
            category: 'accessibility',
            description: [audit.title, node.explanation].filter(Boolean).join(' — '),
            impact: mapped.impact,
            wcagCriteria: mapped.wcagCriteria,
            selector: node.selector || '',
            snippet: node.snippet || '',
            evidence: {
              layer: 'lighthouse',
              unmapped: mapped.unmapped,
              audit: {
                title: audit.title,
                description: audit.description,
                score: audit.score,
                weight: audit.weight,
              },
              explanation: node.explanation || '',
              nodeLabel: node.nodeLabel || '',
              path: node.path || '',
              viewports: [],
            },
          });
        }
        findings.get(key).evidence.viewports.push({
          name: device.device || deviceName,
          width: device.viewport?.width || null,
          height: device.viewport?.height || null,
        });
      }
    }
  }

  return [...findings.values()];
}

function extractScores(lhr) {
  const scores = {};
  for (const [key, catId] of [['performance', 'performance'], ['accessibility', 'accessibility'], ['bestPractices', 'best-practices'], ['seo', 'seo']]) {
    const cat = lhr.categories[catId];
    scores[key] = typeof cat?.score === 'number' ? Math.round(cat.score * 100) : null;
  }
  return scores;
}

/**
 * A page Lighthouse could not score (empty template, blocked load): no category has a score, or every
 * score is 0 while at least half of the audits are incomplete (errored, no result). Not a 0/100 result.
 */
export function isUnscorable(lhr = {}) {
  const cats = Object.values(lhr.categories || {});
  if (!cats.length || cats.every((c) => c.score == null)) return true;
  if (!cats.every((c) => !c.score)) return false;
  const refs = new Set(cats.flatMap((c) => (c.auditRefs || []).map((r) => r.id)));
  const incomplete = [...refs].filter((id) => {
    const a = lhr.audits?.[id];
    return !a || (a.score == null && !['manual', 'notApplicable', 'informative'].includes(a.scoreDisplayMode));
  }).length;
  return refs.size > 0 && incomplete * 2 >= refs.size;
}

function buildDeviceResult(lhr, deviceMode, pageUrl) {
  const deviceConfig = DEVICE_CONFIGS[deviceMode];
  const { audits, groups, passedAudits, passedGroups } = extractAudits(lhr);
  const unscorable = isUnscorable(lhr);
  return {
    device: deviceMode,
    engineVersion: lhr.lighthouseVersion || null,
    viewport: {
      width: deviceConfig.screenEmulation.width,
      height: deviceConfig.screenEmulation.height,
    },
    scores: unscorable ? extractScores({ categories: {} }) : extractScores(lhr),
    ...(unscorable ? { unscorable: true } : {}),
    metrics: extractMetrics(lhr),
    audits,
    groups,
    passedAudits,
    passedGroups,
    accessibility: extractAccessibilityAudits(lhr),
    finalUrl: lhr.finalDisplayedUrl || lhr.finalUrl || pageUrl,
    fetchTime: lhr.fetchTime,
    runWarnings: (lhr.runWarnings || []).slice(0, 5),
  };
}

/** Default runner: one headless Chrome per run (killed on abort), returns the raw lhr. */
export async function runLocalLighthouse(pageUrl, deviceMode, { signal } = {}) {
  const { default: lighthouse } = await import('lighthouse');
  const { launch: chromeLaunch } = await import('chrome-launcher');
  const chrome = await chromeLaunch({ chromeFlags: ['--headless', '--no-sandbox', '--disable-gpu'] });
  const kill = () => chrome.kill();
  signal?.addEventListener('abort', kill);
  try {
    const result = await lighthouse(pageUrl, {
      logLevel: 'error',
      output: 'json',
      onlyCategories: PSI_CATEGORIES,
      port: chrome.port,
      ...DEVICE_CONFIGS[deviceMode],
    });
    return result.lhr;
  } finally {
    signal?.removeEventListener('abort', kill);
    await kill();
  }
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

async function runWithTimeout(runner, pageUrl, deviceMode, timeoutMs) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(Object.assign(new Error(`Lighthouse ${deviceMode} run timed out after ${timeoutMs} ms`), { code: 'timeout' }));
    }, timeoutMs);
  });
  try {
    return await Promise.race([runner(pageUrl, deviceMode, { signal: controller.signal, timeoutMs }), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Runs one form factor `runs` times. Reported scores are the per-category MEDIAN; audits/metrics come
 * from the run with the median performance score. Throws only when every run failed.
 */
async function runLocalDevice(pageUrl, deviceMode, { runs, timeoutMs, runner }) {
  const done = [];
  let lastError;
  for (let i = 0; i < runs; i++) {
    try {
      done.push(buildDeviceResult(await runWithTimeout(runner, pageUrl, deviceMode, timeoutMs), deviceMode, pageUrl));
    } catch (err) {
      lastError = err;
    }
  }
  if (done.length === 0) throw lastError;
  const byPerf = [...done].sort((a, b) => (a.scores.performance ?? 0) - (b.scores.performance ?? 0));
  const picked = byPerf[(byPerf.length - 1) >> 1];
  const scores = {};
  for (const key of Object.keys(picked.scores)) {
    const nums = done.map((d) => d.scores[key]).filter((n) => typeof n === 'number');
    scores[key] = nums.length ? median(nums) : null;
  }
  const { unscorable: _, ...rest } = picked;
  return {
    ...rest,
    scores,
    ...(done.every((d) => d.unscorable) ? { unscorable: true } : {}),
    runs: done.map((d) => ({ scores: d.scores, fetchTime: d.fetchTime })),
    provenance: {
      source: 'local',
      version: picked.engineVersion,
      formFactor: deviceMode,
      runsRequested: runs,
      runs: done.length,
      comparableToPsi: false,
    },
  };
}

// Lighthouse runs never overlap, even when pages are scanned concurrently.
let lighthouseQueue = Promise.resolve();
const serialize = (fn) => {
  const next = lighthouseQueue.then(fn, fn);
  lighthouseQueue = next.catch(() => {});
  return next;
};

// ─── PSI API integration ─────────────────────────────────────────────────────

// Key travels in a header, never the URL; scrub it (and any key= echo) from error text.
function redactSecret(text, apiKey) {
  let out = String(text ?? '').replace(/([?&]key=)[^&\s"']*/gi, '$1[redacted]');
  if (apiKey) out = out.split(apiKey).join('[redacted]');
  return out;
}

export async function fetchPSI(pageUrl, strategy, retries = 2) {
  const params = new URLSearchParams({ url: pageUrl, strategy });
  for (const cat of PSI_CATEGORIES) params.append('category', cat);
  const apiKey = process.env.GOOGLE_API_KEY;
  const headers = apiKey ? { 'X-Goog-Api-Key': apiKey } : {};

  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      const delay = 2000 * attempt;
      console.warn(`  PSI API retry ${attempt}/${retries} for ${strategy} in ${delay / 1000}s...`);
      await new Promise((r) => setTimeout(r, delay));
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PSI_TIMEOUT_MS);

    try {
      const resp = await fetch(`${PSI_API_URL}?${params}`, { headers, signal: controller.signal });
      if (resp.ok) return await resp.json();

      const body = await resp.text().catch(() => '');
      const detail = body.includes('"message"') ? JSON.parse(body).error?.message || '' : '';
      lastError = new Error(redactSecret(`PSI API ${resp.status}: ${resp.statusText}${detail ? ` — ${detail}` : ''}`, apiKey));

      if (resp.status >= 400 && resp.status < 500 && resp.status !== 429) throw lastError;
    } catch (err) {
      lastError = err;
      if (err.message) err.message = redactSecret(err.message, apiKey);
      if (err.name === 'AbortError') lastError = new Error(`PSI API timed out after ${PSI_TIMEOUT_MS / 1000}s`);
      if (err.message?.includes('PSI API 4') && !err.message?.includes('429')) throw err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

function normalizePSIResponse(psiData) {
  const lhr = psiData.lighthouseResult;
  if (!lhr) throw new Error('PSI response missing lighthouseResult');

  const unscorable = isUnscorable(lhr);
  const scores = unscorable ? extractScores({ categories: {} }) : extractScores(lhr);
  const metrics = extractMetrics(lhr);
  const { audits, groups, passedAudits, passedGroups } = extractAudits(lhr);
  const accessibility = extractAccessibilityAudits(lhr);
  const device = lhr.configSettings?.formFactor || 'mobile';
  const screenEmulation = lhr.configSettings?.screenEmulation
    || DEVICE_CONFIGS[device]?.screenEmulation
    || {};

  return {
    device,
    engineVersion: lhr.lighthouseVersion || null,
    viewport: {
      width: screenEmulation.width || null,
      height: screenEmulation.height || null,
    },
    scores,
    ...(unscorable ? { unscorable: true } : {}),
    metrics,
    audits,
    groups,
    passedAudits,
    passedGroups,
    accessibility,
    provenance: {
      source: 'psi-api',
      version: lhr.lighthouseVersion || null,
      formFactor: device,
      runsRequested: 1,
      runs: 1,
      comparableToPsi: true,
    },
    finalUrl: lhr.finalDisplayedUrl || lhr.finalUrl || '',
    fetchTime: lhr.fetchTime || new Date().toISOString(),
    runWarnings: (lhr.runWarnings || []).slice(0, 5),
  };
}

async function runPSIForDevice(pageUrl, strategy) {
  const psiData = await fetchPSI(pageUrl, strategy);
  return normalizePSIResponse(psiData);
}

// ─── Violation generation from device results ─────────────────────────────────

// Only Lighthouse ACCESSIBILITY audits become findings. Performance, best-practices, SEO and the metric audits
// stay informational (scores feed the lighthouse.* thresholds, metrics appear in the Performance section).
function generateViolations(result) {
  const passes = [];
  const mobile = result.mobile;
  if (mobile?.scores?.performance != null) passes.push(`Mobile Performance: ${mobile.scores.performance}/100`);
  return { violations: generateLighthouseAccessibilityViolations(result), passes };
}

/** Per form factor: every run's category scores, their median and max-min spread (additive report field). */
export function summarizeLighthouseRuns(lighthouse) {
  const out = {};
  for (const [ff, d] of Object.entries(lighthouse || {})) {
    if (!d?.scores) continue;
    const runs = (d.runs?.length ? d.runs.map((r) => r.scores) : [d.scores]);
    const spread = {};
    for (const key of Object.keys(d.scores)) {
      const nums = runs.map((r) => r[key]).filter((n) => typeof n === 'number');
      spread[key] = nums.length ? Math.max(...nums) - Math.min(...nums) : null;
    }
    out[ff] = { runs, median: d.scores, spread };
  }
  return out;
}

// ─── Main export ─────────────────────────────────────────────────────────────

/**
 * Runs performance analysis in both mobile and desktop modes.
 *
 * For remote URLs (only when external.psi is enabled), calls the PageSpeed Insights
 * API to get results identical to pagespeed.web.dev. Falls back to local
 * Lighthouse via chrome-launcher if PSI fails or for local URLs. Local runs use config.lighthouse.runs
 * (median reported) and timeoutMs per run; `deps.runner(url, formFactor, {signal})` returns an lhr (tests inject it).
 */
export async function scanWithLighthouse(pageUrl, config = {}, deps = {}) {
  const violations = [];
  const passes = [];
  const usePSI = externalGate('psi', pageUrl, config, { sends: 'the page URL', endpoint: PSI_API_URL }).allowed;
  let psiFailure = null;

  if (usePSI) {
    try {
      const mobile = await runPSIForDevice(pageUrl, 'mobile');
      const desktop = await runPSIForDevice(pageUrl, 'desktop');
      const result = { mobile, desktop };
      const { violations: vs, passes: ps } = generateViolations(result);
      return {
        url: pageUrl,
        scores: mobile.scores,
        lighthouse: result,
        violations: vs,
        passes: ps,
        source: 'psi-api',
        provenance: createLighthouseProvenance({
          requestedSource: 'psi-api',
          actualSource: 'psi-api',
        }),
        timestamp: new Date().toISOString(),
      };
    } catch (psiErr) {
      psiFailure = psiErr;
      const failure = classifyPsiFailure(psiErr);
      console.warn(`  PSI API failed (${failure.code}${failure.status ? `, HTTP ${failure.status}` : ''}), falling back to local Lighthouse...`);
    }
  }

  const runs = config.lighthouse?.runs ?? 1;
  const timeoutMs = config.lighthouse?.timeoutMs ?? 120_000;
  const runner = deps.runner || runLocalLighthouse;
  const result = { mobile: null, desktop: null };
  const errors = {};
  await serialize(async () => {
    for (const mode of ['mobile', 'desktop']) {
      try {
        result[mode] = await runLocalDevice(pageUrl, mode, { runs, timeoutMs, runner });
      } catch (err) {
        errors[mode] = {
          code: err.code === 'timeout' || /timed out/i.test(err.message) ? 'timeout' : 'error',
          message: err.message,
          missingDep: err.code === 'ERR_MODULE_NOT_FOUND' || /Cannot find (package|module)/i.test(err.message),
        };
      }
    }
  });

  if (result.mobile || result.desktop) {
    const { violations: vs, passes: ps } = generateViolations(result);
    return {
      url: pageUrl,
      scores: (result.mobile || result.desktop).scores,
      lighthouse: result,
      violations: vs,
      passes: ps,
      source: psiFailure ? 'local-fallback' : 'local',
      partial: Object.keys(errors).length > 0,
      errors,
      provenance: createLighthouseProvenance({
        requestedSource: usePSI ? 'psi-api' : 'local',
        actualSource: 'local',
        fallbackError: psiFailure,
      }),
      timestamp: new Date().toISOString(),
    };
  }

  const first = Object.values(errors)[0];
  const missingDep = first.missingDep;
  if (missingDep) {
    console.warn('  Lighthouse layer disabled — optional deps missing. Install with: pnpm add lighthouse chrome-launcher');
  }
  violations.push({
    rule: 'lighthouse-unavailable',
    description: missingDep
      ? 'Lighthouse layer skipped — optional deps (lighthouse, chrome-launcher) not installed.'
      : `Lighthouse scan failed: ${first.message}`,
    impact: 'info',
    wcagCriteria: 'perf',
    element: null,
  });

  return {
    url: pageUrl,
    scores: {},
    lighthouse: null,
    violations,
    passes,
    source: 'error',
    errors,
    provenance: createLighthouseProvenance({
      requestedSource: usePSI ? 'psi-api' : 'local',
      actualSource: 'error',
      fallbackError: psiFailure || new Error(first.message),
    }),
    timestamp: new Date().toISOString(),
  };
}
