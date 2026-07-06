const PSI_API_URL = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed';
const PSI_CATEGORIES = ['performance', 'accessibility', 'best-practices', 'seo'];
const PSI_TIMEOUT_MS = 90_000;

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

function extractScores(lhr) {
  const scores = {};
  for (const [key, catId] of [['performance', 'performance'], ['accessibility', 'accessibility'], ['bestPractices', 'best-practices'], ['seo', 'seo']]) {
    const cat = lhr.categories[catId];
    scores[key] = cat ? Math.round((cat.score || 0) * 100) : null;
  }
  return scores;
}

async function runLighthouseForDevice(pageUrl, deviceMode, chromePort) {
  const { default: lighthouse } = await import('lighthouse');
  const deviceConfig = DEVICE_CONFIGS[deviceMode];

  const options = {
    logLevel: 'error',
    output: 'json',
    onlyCategories: ['performance', 'accessibility', 'best-practices', 'seo'],
    port: chromePort,
    ...deviceConfig,
  };

  const result = await lighthouse(pageUrl, options);
  const lhr = result.lhr;

  const { audits, groups, passedAudits, passedGroups } = extractAudits(lhr);
  return {
    device: deviceMode,
    scores: extractScores(lhr),
    metrics: extractMetrics(lhr),
    audits,
    groups,
    passedAudits,
    passedGroups,
    finalUrl: lhr.finalDisplayedUrl || lhr.finalUrl || pageUrl,
    fetchTime: lhr.fetchTime,
    runWarnings: (lhr.runWarnings || []).slice(0, 5),
  };
}

// ─── PSI API integration ─────────────────────────────────────────────────────

async function fetchPSI(pageUrl, strategy, retries = 2) {
  const params = new URLSearchParams({ url: pageUrl, strategy });
  for (const cat of PSI_CATEGORIES) params.append('category', cat);
  const apiKey = process.env.GOOGLE_API_KEY;
  if (apiKey) params.set('key', apiKey);

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
      const resp = await fetch(`${PSI_API_URL}?${params}`, { signal: controller.signal });
      if (resp.ok) return await resp.json();

      const body = await resp.text().catch(() => '');
      const detail = body.includes('"message"') ? JSON.parse(body).error?.message || '' : '';
      lastError = new Error(`PSI API ${resp.status}: ${resp.statusText}${detail ? ` — ${detail}` : ''}`);

      if (resp.status >= 400 && resp.status < 500 && resp.status !== 429) throw lastError;
    } catch (err) {
      lastError = err;
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

  const scores = extractScores(lhr);
  const metrics = extractMetrics(lhr);
  const { audits, groups, passedAudits, passedGroups } = extractAudits(lhr);
  const device = lhr.configSettings?.formFactor || 'mobile';

  return {
    device,
    scores,
    metrics,
    audits,
    groups,
    passedAudits,
    passedGroups,
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

function generateViolations(result, pageUrl, config) {
  const violations = [];
  const passes = [];
  const { mobile } = result;
  const scores = mobile.scores;
  const isDevMode = pageUrl.includes('localhost') || pageUrl.includes('127.0.0.1');
  const configThreshold = config.thresholds?.performance || 90;
  const perfThreshold = isDevMode ? Math.min(configThreshold, 60) : configThreshold;

  if (scores.performance !== null && scores.performance < perfThreshold) {
    violations.push({
      rule: 'lighthouse-performance',
      description: `Mobile performance score ${scores.performance}/100 is below threshold of ${perfThreshold}`,
      impact: scores.performance < 50 ? 'critical' : 'serious',
      wcagCriteria: 'perf',
      element: null,
    });
  } else if (scores.performance !== null) {
    passes.push(`Mobile Performance: ${scores.performance}/100`);
  }

  const DEV_SKIP_METRICS = new Set(['first-contentful-paint', 'largest-contentful-paint', 'total-blocking-time', 'interactive']);
  for (const [id, metric] of Object.entries(mobile.metrics)) {
    if (isDevMode && DEV_SKIP_METRICS.has(id)) continue;
    if (metric.rating === 'poor') {
      violations.push({ rule: id, description: `${metric.label} ${metric.displayValue} exceeds poor threshold`, impact: 'critical', wcagCriteria: 'perf', element: null });
    } else if (metric.rating === 'average' && !isDevMode) {
      violations.push({ rule: id, description: `${metric.label} ${metric.displayValue} needs improvement`, impact: 'serious', wcagCriteria: 'perf', element: null });
    }
  }

  const DEV_ONLY_AUDITS = new Set(['unminified-javascript', 'unminified-css', 'unused-css-rules', 'unused-javascript']);
  for (const [, entries] of Object.entries(mobile.groups)) {
    for (const audit of entries) {
      if (audit.score !== null && audit.score < 0.5) {
        if (isDevMode && DEV_ONLY_AUDITS.has(audit.id)) continue;
        violations.push({
          rule: audit.id,
          description: `${audit.title}${audit.displayValue ? ` — ${audit.displayValue}` : ''}`,
          impact: audit.score === 0 ? 'serious' : 'moderate',
          wcagCriteria: 'perf',
          element: null,
          details: audit.details || null,
        });
      }
    }
  }

  return { violations, passes };
}

// ─── Main export ─────────────────────────────────────────────────────────────

/**
 * Runs performance analysis in both mobile and desktop modes.
 *
 * For remote URLs (when config.usePSI !== false), calls the PageSpeed Insights
 * API to get results identical to pagespeed.web.dev. Falls back to local
 * Lighthouse via chrome-launcher if PSI fails or for local URLs.
 */
export async function scanWithLighthouse(pageUrl, config = {}) {
  const violations = [];
  const passes = [];
  const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1)/i.test(pageUrl);
  const usePSI = !isLocal && config.usePSI !== false;

  if (usePSI) {
    try {
      const mobile = await runPSIForDevice(pageUrl, 'mobile');
      const desktop = await runPSIForDevice(pageUrl, 'desktop');
      const result = { mobile, desktop };
      const { violations: vs, passes: ps } = generateViolations(result, pageUrl, config);
      return {
        url: pageUrl,
        scores: mobile.scores,
        lighthouse: result,
        violations: vs,
        passes: ps,
        source: 'psi-api',
        timestamp: new Date().toISOString(),
      };
    } catch (psiErr) {
      console.warn(`  PSI API failed (${psiErr.message}), falling back to local Lighthouse...`);
    }
  }

  try {
    const { launch: chromeLaunch } = await import('chrome-launcher');
    const chrome = await chromeLaunch({ chromeFlags: ['--headless', '--no-sandbox', '--disable-gpu'] });

    try {
      const mobile = await runLighthouseForDevice(pageUrl, 'mobile', chrome.port);
      const desktop = await runLighthouseForDevice(pageUrl, 'desktop', chrome.port);
      const result = { mobile, desktop };
      const { violations: vs, passes: ps } = generateViolations(result, pageUrl, config);

      return {
        url: pageUrl,
        scores: mobile.scores,
        lighthouse: result,
        violations: vs,
        passes: ps,
        source: 'local',
        timestamp: new Date().toISOString(),
      };
    } finally {
      await chrome.kill();
    }
  } catch (err) {
    const missingDep = err.code === 'ERR_MODULE_NOT_FOUND' || /Cannot find (package|module)/i.test(err.message);
    if (missingDep) {
      console.warn('  Lighthouse layer disabled — optional deps missing. Install with: pnpm add lighthouse chrome-launcher');
    }
    violations.push({
      rule: 'lighthouse-unavailable',
      description: missingDep
        ? 'Lighthouse layer skipped — optional deps (lighthouse, chrome-launcher) not installed.'
        : `Lighthouse scan failed: ${err.message}`,
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
      timestamp: new Date().toISOString(),
    };
  }
}
