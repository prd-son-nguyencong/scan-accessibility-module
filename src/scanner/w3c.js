import { getBrowser, newPage, resilientGoto } from './browser.js';
import { mapDescriptionToSource } from '../tracer/partial-map.js';
import { getThirdPartyConfig } from '../utils/third-party.js';

const PAGE_TIMEOUT_MS = 60000;
const W3C_VALIDATOR_API = 'https://validator.w3.org/nu/?out=json&showsource=yes';
const W3C_TIMEOUT_MS = 15000;

export function canonicalizeW3cDescription(description = '') {
  return String(description)
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function classifyW3cRule(message = {}) {
  const description = canonicalizeW3cDescription(
    typeof message === 'string' ? message : message.message || message.description
  ).toLowerCase();
  if (
    /the element "button" must not appear as a descendant of the "a" element/.test(description)
    || /bad value "button" for attribute "type" on element "a"/.test(description)
  ) {
    return 'w3c-nested-interactive';
  }
  if (/duplicate id "|the first occurrence of id "/.test(description)) {
    return 'w3c-duplicate-id';
  }
  // Keep Nu's three distinct main-landmark errors as separate rule IDs so
  // report fingerprints / scan-visual cards match the oracle message count.
  if (/main" element must not appear as a descendant of the "section" element/.test(description)) {
    return 'w3c-main-in-section';
  }
  if (/main" element must not appear as a descendant of the "main" element/.test(description)) {
    return 'w3c-main-nested';
  }
  if (/more than one visible "main" element/.test(description)) {
    return 'w3c-multiple-main';
  }
  if (/"main" element must not appear as a descendant|more than one visible "main" element|multiple main landmark|stray end tag "main"/.test(description)) {
    return 'w3c-main-landmark-structure';
  }
  if (/script" element with "type=module".*"defer" attribute/.test(description)) {
    return 'w3c-module-defer';
  }
  if (/heading .*skipping \d+ heading level/.test(description)) {
    return 'w3c-heading-order';
  }
  if (/viewport values that prevent users from resizing/.test(description)) {
    return 'w3c-viewport-zoom';
  }
  if (/section lacks heading/.test(description)) {
    return 'w3c-section-heading';
  }
  if (/"type" attribute is unnecessary for javascript resources/.test(description)) {
    return 'w3c-script-type-unnecessary';
  }
  if (/element "title" must not be empty/.test(description)) {
    return 'w3c-empty-title';
  }
  const type = typeof message === 'string' ? 'error' : message.type;
  if (type === 'info' && !message.subType) return 'w3c-html-info';
  if (type === 'warning' || message.subType === 'warning') return 'w3c-html-warning';
  return 'w3c-html-error';
}

export function filterSupplementalW3cIssues(apiMessages, supplementalIssues) {
  const existingDescriptions = new Set(
    apiMessages.map((message) => canonicalizeW3cDescription(message.message || message.description))
  );
  return supplementalIssues.filter(
    (issue) => !existingDescriptions.has(canonicalizeW3cDescription(issue.description))
  );
}

export function buildW3cRunMetadata({
  messages = [],
  isArtifact = () => false,
  engineName = 'Nu Html Checker',
  engineVersion = null,
  status = 'complete',
  supplemental = {
    candidateCount: 0,
    addedCount: 0,
    suppressedCount: 0,
  },
  emittedViolations = [],
} = {}) {
  const raw = {
    messageCount: messages.length,
    errors: 0,
    warnings: 0,
    infos: 0,
    other: 0,
    artifactFilteredCount: messages.filter(isArtifact).length,
  };
  for (const message of messages) {
    if (message.type === 'error') raw.errors++;
    else if (message.type === 'info' && message.subType === 'warning') raw.warnings++;
    else if (message.type === 'info' && !message.subType) raw.infos++;
    else raw.other++;
  }
  const actionable = emittedViolations.filter((violation) => violation.type !== 'info');
  const occurrenceCount = (violations) => violations.reduce(
    (total, violation) => total + (
      Number.isInteger(violation.count) && violation.count > 0 ? violation.count : 1
    ),
    0
  );

  return {
    layer: 'w3c',
    engine: { name: engineName, version: engineVersion },
    pageState: 'initial',
    status,
    raw,
    supplemental,
    emitted: {
      actionableOccurrences: occurrenceCount(actionable),
      actionableFixUnits: actionable.length,
      infoFixUnits: emittedViolations.length - actionable.length,
    },
  };
}

/**
 * Layer 1: W3C HTML5 Validation Scanner
 *
 * Uses the Nu HTML Checker HTTP API to validate page HTML.
 * Falls back gracefully if the API is unreachable (network timeout or offline).
 *
 * The validator accepts HTML via POST with Content-Type: text/html.
 * API docs: https://github.com/validator/validator/wiki/Service:-Input:-POST-body
 */
export async function scanW3cValidation(pageUrl) {
  const browser = await getBrowser();
  const page = await newPage(browser);
  const violations = [];
  const passes = [];
  let metadataInput = null;

  try {
    await resilientGoto(page, pageUrl, { timeout: PAGE_TIMEOUT_MS });

    // Get the DOM-serialized HTML for Nu Checker
    const html = await page.content();

    // Fetch raw source HTML (preserves trailing slashes, original formatting)
    let rawSourceHtml = '';
    try {
      const resp = await fetch(pageUrl, { signal: AbortSignal.timeout(10000) });
      if (resp.ok) rawSourceHtml = await resp.text();
    } catch { /* fallback: rawSourceHtml stays empty */ }

    // Submit to Nu HTML Checker
    const validationResult = await validateWithNuChecker(html);

    if (validationResult === null) {
      // API unreachable — run basic local checks instead
      const localIssues = await runLocalHtmlChecks(page);
      violations.push(...localIssues);
      if (localIssues.length === 0) {
        passes.push('Local HTML checks passed (Nu validator unavailable)');
      }
      const sourceOffline = await mapDescriptionToSource(pageUrl);
      const offlineViolations = violations.map((v) => ({ ...v, layer: 'w3c', source: sourceOffline }));
      return {
        url: pageUrl,
        violations: offlineViolations,
        passes,
        timestamp: new Date().toISOString(),
        w3cUnavailable: true,
        scannerRun: buildW3cRunMetadata({
          engineName: 'ada-scan local HTML checks',
          status: 'fallback',
          supplemental: {
            candidateCount: localIssues.length,
            addedCount: localIssues.length,
            suppressedCount: 0,
          },
          emittedViolations: offlineViolations,
        }),
      };
    }

    const { messages } = validationResult;

    // Only skip messages where the error message itself is about template tokens
    // (e.g. Liquid/Paradox {{…}} / {%…%}). Open delimiters come from config.thirdParty.
    const openTokens = (getThirdPartyConfig().devArtifactTokens || []).filter((_, i) => i % 2 === 0);
    const isParadoxArtifact = (msg) => {
      const text = msg.message || '';
      return openTokens.some((tok) => tok && text.includes(tok));
    };

    const typeBreakdown = {};
    for (const m of messages) {
      const key = `${m.type}${m.subType ? '/' + m.subType : ''}`;
      typeBreakdown[key] = (typeBreakdown[key] || 0) + 1;
    }
    const filtered = messages.filter(isParadoxArtifact);
    console.log(`  [w3c] Nu Checker: ${messages.length} messages (${JSON.stringify(typeBreakdown)})${filtered.length ? `, ${filtered.length} Paradox artifact(s) filtered` : ''}`);

    const errors = messages.filter((m) => m.type === 'error' && !isParadoxArtifact(m));
    const warnings = messages.filter((m) => m.type === 'info' && m.subType === 'warning' && !isParadoxArtifact(m));
    const infos = messages.filter((m) => m.type === 'info' && !m.subType && !isParadoxArtifact(m));

    for (const msg of errors) {
      violations.push({
        rule: classifyW3cRule(msg),
        description: msg.message,
        impact: 'serious',
        wcagCriteria: '4.1.1',
        html: (msg.extract || '').slice(0, 500),
        element: {
          line: msg.lastLine,
          col: msg.lastColumn,
          extract: (msg.extract || '').slice(0, 500),
        },
        line: msg.lastLine,
        type: 'error',
      });
    }

    for (const msg of warnings) {
      violations.push({
        rule: classifyW3cRule(msg),
        description: msg.message,
        impact: 'minor',
        wcagCriteria: '4.1.1',
        html: (msg.extract || '').slice(0, 500),
        element: { line: msg.lastLine, col: msg.lastColumn, extract: (msg.extract || '').slice(0, 500) },
        line: msg.lastLine,
        type: 'warning',
      });
    }

    for (const msg of infos) {
      violations.push({
        rule: classifyW3cRule(msg),
        description: msg.message,
        impact: 'minor',
        wcagCriteria: '4.1.1',
        html: (msg.extract || '').slice(0, 500),
        element: { line: msg.lastLine, col: msg.lastColumn, extract: (msg.extract || '').slice(0, 500) },
        line: msg.lastLine,
        type: 'info',
      });
    }

    // Supplemental local DOM checks — the remote API doesn't return
    // trailing-slash info, duplicate-ID, or empty-title errors reliably.
    const allApiMessages = [...errors, ...warnings, ...infos];
    const supplemental = await runSupplementalChecks(page, allApiMessages, rawSourceHtml);
    violations.push(...supplemental.issues);
    metadataInput = {
      messages,
      isArtifact: isParadoxArtifact,
      engineVersion: validationResult.version || null,
      supplemental: supplemental.stats,
    };

    if (errors.length === 0) {
      passes.push(`W3C HTML validation passed (${warnings.length} warning${warnings.length === 1 ? '' : 's'}, ${infos.length} info)`);
    }
  } finally {
    await page.close().catch(() => {});
  }

  const dedupedViolations = deduplicateW3cViolations(violations);

  const source = await mapDescriptionToSource(pageUrl);
  const emittedViolations = dedupedViolations.map((v) => ({ ...v, layer: 'w3c', source }));
  return {
    url: pageUrl,
    violations: emittedViolations,
    passes,
    timestamp: new Date().toISOString(),
    scannerRun: buildW3cRunMetadata({
      ...metadataInput,
      emittedViolations,
    }),
  };
}

async function validateWithNuChecker(html) {
  try {
    const response = await fetch(W3C_VALIDATOR_API, {
      method: 'POST',
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'User-Agent': 'ADA-Scanner/1.0' },
      body: html,
      signal: AbortSignal.timeout(W3C_TIMEOUT_MS),
    });

    if (!response.ok) return null;
    return response.json();
  } catch {
    return null;
  }
}

async function runLocalHtmlChecks(page) {
  return page.evaluate(() => {
    const issues = [];

    // Check for duplicate IDs
    const allIds = Array.from(document.querySelectorAll('[id]')).map((el) => el.id);
    const seen = new Set();
    const dupes = new Set();
    for (const id of allIds) {
      if (seen.has(id)) dupes.add(id);
      seen.add(id);
    }
    if (dupes.size > 0) {
      issues.push({
        rule: 'w3c-duplicate-id',
        description: `Duplicate IDs found: ${Array.from(dupes).slice(0, 5).join(', ')} — ARIA relationships rely on unique IDs`,
        impact: 'serious',
        wcagCriteria: '4.1.1',
        element: null,
      });
    }

    // Check for deprecated elements
    const deprecated = ['font', 'center', 'strike', 'tt', 'big', 'small', 'frame', 'frameset', 'noframes'];
    for (const tag of deprecated) {
      const count = document.querySelectorAll(tag).length;
      if (count > 0) {
        issues.push({
          rule: 'w3c-deprecated-element',
          description: `Deprecated HTML element <${tag}> used ${count} time(s)`,
          impact: 'minor',
          wcagCriteria: '4.1.1',
          element: null,
        });
      }
    }

    // Check for missing doctype (evaluate can't detect this, but check html[lang] as proxy)
    const htmlEl = document.documentElement;
    if (!htmlEl.getAttribute('lang')) {
      issues.push({
        rule: 'w3c-missing-lang',
        description: '<html> element missing lang attribute — required for valid HTML5',
        impact: 'moderate',
        wcagCriteria: '3.1.1',
        element: null,
      });
    }

    // Check meta charset
    const hasCharset = !!document.querySelector('meta[charset], meta[http-equiv="Content-Type"]');
    if (!hasCharset) {
      issues.push({
        rule: 'w3c-missing-charset',
        description: 'No meta charset declaration found',
        impact: 'minor',
        wcagCriteria: '4.1.1',
        element: null,
      });
    }

    return issues;
  });
}

/**
 * Supplemental DOM checks that fill gaps in the remote Nu Checker API.
 * These always run alongside the API response to ensure full coverage.
 */
async function runSupplementalChecks(page, apiMessages, rawHtml) {
  const issues = [];

  // --- DOM-based checks (use Playwright page.evaluate) ---
  const domIssues = await page.evaluate(() => {
    const found = [];

    const titleEl = document.querySelector('title');
    if (titleEl && !titleEl.textContent.trim()) {
      found.push({
        rule: 'w3c-html-error',
        description: 'Element "title" must not be empty.',
        impact: 'serious',
        type: 'error',
        element: { extract: '<title></title>' },
      });
    }

    const allIds = Array.from(document.querySelectorAll('[id]'));
    const idMap = new Map();
    for (const el of allIds) {
      if (!el.id) continue;
      if (!idMap.has(el.id)) idMap.set(el.id, []);
      idMap.get(el.id).push(el.outerHTML.slice(0, 200));
    }
    for (const [id, elements] of idMap) {
      if (elements.length > 1) {
        found.push({
          rule: 'w3c-html-error',
          description: `Duplicate ID "${id}".`,
          impact: 'serious',
          type: 'error',
          element: { extract: elements[1].slice(0, 200) },
        });
      }
    }

    const moduleDefer = Array.from(document.querySelectorAll('script[type="module"][defer]'));
    for (const el of moduleDefer) {
      found.push({
        rule: 'w3c-html-error',
        description: 'A "script" element with "type=module" must not have a "defer" attribute.',
        impact: 'serious',
        type: 'error',
        element: { extract: el.outerHTML.slice(0, 200) },
      });
    }

    const unnecessaryType = Array.from(document.querySelectorAll('script[type="text/javascript"]'));
    for (const el of unnecessaryType) {
      found.push({
        rule: 'w3c-html-warning',
        description: 'The "type" attribute is unnecessary for JavaScript resources.',
        impact: 'minor',
        type: 'warning',
        element: { extract: el.outerHTML.slice(0, 200) },
      });
    }

    return found;
  });

  // --- Raw HTML source checks (trailing slashes only appear in source, not DOM) ---
  if (rawHtml) {
    const voidRegex = /<(input|br|hr|img|meta|link|source|track|wbr|area|col|embed|param)\b[^>]*\/>/gi;
    const matches = rawHtml.match(voidRegex) || [];
    const uniqueMatches = [...new Set(matches.map((m) => m.slice(0, 300)))];
    for (const match of uniqueMatches.slice(0, 50)) {
      domIssues.push({
        rule: 'w3c-html-info',
        description: 'Trailing slash on void elements has no effect and interacts badly with unquoted attribute values.',
        impact: 'minor',
        type: 'info',
        element: { extract: match },
      });
    }
  }

  const uniqueIssues = filterSupplementalW3cIssues(apiMessages, domIssues);
  for (const issue of uniqueIssues) {
    issues.push({
      ...issue,
      rule: classifyW3cRule(issue),
      wcagCriteria: '4.1.1',
      html: issue.element?.extract || '',
    });
  }

  return {
    issues,
    stats: {
      candidateCount: domIssues.length,
      addedCount: uniqueIssues.length,
      suppressedCount: domIssues.length - uniqueIssues.length,
    },
  };
}

/**
 * Deduplicate W3C violations by (rule, line, description, extract-prefix-80).
 * Keeps the first occurrence and increments its count field.
 */
export function deduplicateW3cViolations(violations) {
  const seen = new Map();
  const result = [];

  for (const v of violations) {
    const extract = (v.element?.extract || v.html || '').replace(/\s+/g, ' ').slice(0, 80);
    // Include Nu message text so distinct errors on the same extract/line
    // (e.g. three main-landmark messages on <main class="c-jobs__main">) stay separate.
    const description = canonicalizeW3cDescription(v.description || v.message || '');
    const key = `${v.rule}|${v.line ?? 'null'}|${description}|${extract}`;

    if (seen.has(key)) {
      seen.get(key).count = (seen.get(key).count || 1) + 1;
    } else {
      v.count = 1;
      seen.set(key, v);
      result.push(v);
    }
  }

  return result;
}
