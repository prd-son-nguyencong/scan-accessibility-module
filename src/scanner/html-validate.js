import { HtmlValidate, version as hvVersion } from 'html-validate/node';
import { acquirePage } from './session.js';
import { mapDescriptionToSource } from '../tracer/partial-map.js';
import { getThirdPartyConfig } from '../utils/third-party.js';
import { canonicalizeW3cDescription } from './w3c.js';

/**
 * Offline HTML validity (D2): html-validate over the rendered DOM. Nothing leaves the machine.
 * Calibrated against the W3C Nu validator (docs/html-validate-rules.md, kept in sync by a test): 'error' only for what Nu
 * reports as an error, 'warn' for Nu warnings and conventions (reported, never gated), 'off' for style-only rules, rules the
 * accessibility engines already cover, and rules that do not fit a serialized DOM or Paradox custom elements.
 * `html.validate.rules` in the config overrides per rule.
 */
export const DEFAULT_HTML_VALIDATE_RULES = Object.freeze({
  'aria-hidden-body': 'off',
  'aria-label-misuse': 'warn',
  'attr-case': 'off',
  'attr-delimiter': 'off',
  'attr-quotes': 'off',
  'attr-spacing': 'error',
  'attribute-allowed-values': 'error',
  'attribute-boolean-style': 'off',
  'attribute-empty-style': 'off',
  'attribute-misuse': 'error',
  'close-attr': 'error',
  'close-order': 'error',
  deprecated: 'error',
  'deprecated-rule': 'off',
  'doctype-html': 'error',
  'doctype-style': 'off',
  'element-case': 'off',
  'element-name': 'off', // Paradox widgets use custom elements
  'element-permitted-content': 'error',
  'element-permitted-occurrences': 'error',
  'element-permitted-order': 'error',
  'element-permitted-parent': 'error',
  'element-required-ancestor': 'error',
  'element-required-attributes': 'error',
  'element-required-content': 'error',
  'empty-heading': 'off',
  'empty-title': 'error',
  'form-dup-name': 'warn',
  'heading-level': 'off',
  'hidden-focusable': 'off',
  'input-attributes': 'error',
  'input-missing-label': 'off',
  'long-title': 'off',
  'map-dup-name': 'error',
  'map-id-name': 'error',
  'meta-refresh': 'off',
  'multiple-labeled-controls': 'error',
  'no-abstract-role': 'off',
  'no-autoplay': 'warn',
  'no-conditional-comment': 'off',
  'no-deprecated-attr': 'error',
  'no-dup-attr': 'error',
  'no-dup-class': 'warn',
  'no-dup-id': 'error',
  'no-implicit-button-type': 'off',
  'no-implicit-close': 'off',
  'no-implicit-input-type': 'off',
  'no-inline-style': 'off',
  'no-multiple-main': 'error',
  'no-raw-characters': 'off',
  'no-redundant-aria-label': 'warn',
  'no-redundant-for': 'warn',
  'no-redundant-role': 'warn',
  'no-self-closing': 'error',
  'no-trailing-whitespace': 'off',
  'no-unknown-elements': 'off',
  'no-unused-disable': 'off',
  'no-utf8-bom': 'off',
  'prefer-button': 'warn',
  'prefer-native-element': 'warn',
  'prefer-tbody': 'off',
  'require-sri': 'off',
  'script-element': 'error',
  'script-type': 'warn',
  'svg-focusable': 'off',
  'tel-non-breaking': 'off',
  'text-content': 'error',
  'unique-landmark': 'off',
  'unrecognized-char-ref': 'error',
  'valid-autocomplete': 'error',
  'valid-id': ['error', { relaxed: true }], // HTML standard: non-empty, no whitespace (digits first and punctuation are valid)
  void: 'off',
  'void-content': 'error',
  'void-style': 'warn',
  'wcag/h30': 'off',
  'wcag/h32': 'warn',
  'wcag/h36': 'off',
  'wcag/h37': 'off',
  'wcag/h63': 'warn',
  'wcag/h67': 'off',
  'wcag/h71': 'warn',
});

// shortcut: a small table of the WCAG-relevant rules, extend when a rule is reported without a reference
export const HTML_VALIDATE_WCAG = Object.freeze({
  'no-dup-id': '4.1.1',
  'valid-id': '4.1.1',
  'element-required-attributes': '4.1.2',
  'wcag/h30': '2.4.4',
  'wcag/h32': '3.2.2',
  'wcag/h36': '1.1.1',
  'wcag/h37': '1.1.1',
  'wcag/h63': '1.3.1',
  'wcag/h67': '1.1.1',
  'hidden-focusable': '4.1.2',
  'no-implicit-button-type': '4.1.2',
});

/**
 * Impact of an `error`-level rule (docs/html-validate-rules.md, "Impact of error rules", kept in sync by a test). `warn` rules are always minor.
 * serious = breaks assistive-technology semantics (names, references, document title); moderate = invalid markup an AT or browser may
 * mis-handle; minor = spec or hygiene with no assistive-technology effect (deprecated attributes, stray syntax). A rule missing here keeps 'serious'.
 */
export const HTML_VALIDATE_IMPACT = Object.freeze({
  'attr-spacing': 'minor',
  'attribute-allowed-values': 'moderate',
  'attribute-misuse': 'moderate',
  'close-attr': 'minor',
  'close-order': 'minor',
  deprecated: 'minor',
  'doctype-html': 'minor',
  'element-permitted-content': 'moderate',
  'element-permitted-occurrences': 'moderate',
  'element-permitted-order': 'minor',
  'element-permitted-parent': 'moderate',
  'element-required-ancestor': 'moderate',
  'element-required-attributes': 'serious',
  'element-required-content': 'moderate',
  'empty-title': 'serious',
  'input-attributes': 'moderate',
  'map-dup-name': 'moderate',
  'map-id-name': 'minor',
  'multiple-labeled-controls': 'serious',
  'no-deprecated-attr': 'minor',
  'no-dup-attr': 'minor',
  'no-dup-id': 'serious',
  'no-multiple-main': 'moderate',
  'no-self-closing': 'minor',
  'script-element': 'minor',
  'text-content': 'minor',
  'unrecognized-char-ref': 'minor',
  'valid-autocomplete': 'moderate',
  'valid-id': 'serious',
  'void-content': 'minor',
});

export const htmlValidateImpact = (ruleId, isError) => (isError ? HTML_VALIDATE_IMPACT[ruleId] || 'serious' : 'minor');

export const HTML_VALIDATE_ENGINE = 'html-validate';
export const HTML_VALIDATE_VERSION = hvVersion;

/**
 * With scripting on, a browser treats <noscript> content as text: it is no DOM, so html-validate must not parse it
 * (a GTM <noscript><iframe> is not an error). Content becomes blank lines, which keeps reported line numbers.
 */
export const blankNoscript = (html) => html.replace(/(<noscript\b[^>]*>)([\s\S]*?)(<\/noscript\s*>)/gi, (_, open, body, close) => open + body.replace(/[^\n]/g, '') + close);

const START_TAG = /^<[a-zA-Z][^\s/>]*(?:"[^"]*"|'[^']*'|[^>"'])*>/;

/** The start tag of the element a message points at (the position may be on one of its attributes), or null. */
function startTagAt(html, offset) {
  const open = html.lastIndexOf('<', offset);
  return open < 0 ? null : START_TAG.exec(html.slice(open, open + 4000))?.[0] ?? null;
}

/** html-validate messages for one serialized document -> violations (error -> serious, warning -> minor). */
export async function validateHtml(html, ruleOverrides = {}) {
  html = blankNoscript(html);
  const hv = new HtmlValidate({
    extends: ['html-validate:recommended'],
    rules: { ...DEFAULT_HTML_VALIDATE_RULES, ...ruleOverrides },
  });
  const report = await hv.validateString(html);
  const lines = html.split('\n');
  const lineStart = (n) => lines.slice(0, n - 1).reduce((sum, l) => sum + l.length + 1, 0);
  const openTokens = (getThirdPartyConfig().devArtifactTokens || []).filter((_, i) => i % 2 === 0);
  const violations = [];
  for (const m of report.results.flatMap((r) => r.messages)) {
    if (openTokens.some((tok) => tok && m.message.includes(tok))) continue;
    // ARIA 1.2 lets a heading take aria-label; html-validate's older table does not.
    // Resolved from the source position of the attribute (the selector may be an #id).
    if (m.ruleId === 'aria-label-misuse' && /^<h[1-6][\s>/]/i.test(html.slice(html.lastIndexOf('<', lineStart(m.line) + m.column - 1)))) continue;
    const isError = m.severity === 2;
    const extract = (lines[m.line - 1] || '').trim().slice(0, 500);
    // The live DOM is often one long line: the element's own start tag is what source tracing can match, not the line.
    const tag = startTagAt(html, lineStart(m.line) + m.column - 1);
    violations.push({
      rule: `html-validate:${m.ruleId}`,
      description: m.message,
      impact: htmlValidateImpact(m.ruleId, isError),
      type: isError ? 'error' : 'warning',
      wcagCriteria: HTML_VALIDATE_WCAG[m.ruleId] || null,
      html: tag ? tag.slice(0, 500) : extract,
      selector: m.selector || '',
      line: m.line,
      element: { line: m.line, col: m.column, extract, selector: m.selector || '' },
    });
  }
  return violations;
}

/** Both engines may report the same problem: drop html-validate findings whose message (and selector, when w3c has one) matches. */
export function dropW3cDuplicates(findings, w3cFindings) {
  const norm = (s) => canonicalizeW3cDescription(s).replace(/\.$/, '');
  const seen = w3cFindings.map((f) => [norm(f.fix?.hint || f.description || ''), f.element?.selector || '']);
  return findings.filter((f) => {
    const msg = norm(f.fix?.hint || f.description || '');
    const sel = f.element?.selector || '';
    return !seen.some(([m, s]) => m === msg && (!s || s === sel));
  });
}

/** Where the validated HTML came from. Only the scanned page's own serialized DOM is the live render. */
export const HTML_SOURCE_LIVE_DOM = 'live-dom';

/** A finding on HTML that is not the live render (a build artefact may have lost template data) is never `confirmed`. */
export const htmlValidateKind = (htmlSource, type) => (type === 'warning' || htmlSource !== HTML_SOURCE_LIVE_DOM ? 'heuristic' : undefined);

export async function scanHtmlValidate(pageUrl, config = {}, opts = {}) {
  const { page, close } = await acquirePage(pageUrl, opts);
  try {
    const violations = await validateHtml(await page.content(), config.html?.validate?.rules);
    const source = await mapDescriptionToSource(pageUrl);
    return {
      url: pageUrl,
      htmlSource: HTML_SOURCE_LIVE_DOM, // page.content() of the page just navigated to, never dist/*.html
      violations: violations.map((v) => ({ ...v, layer: 'htmlValidate', source })),
      passes: violations.some((v) => v.type === 'error') ? [] : ['html-validate: no errors'],
      timestamp: new Date().toISOString(),
    };
  } finally {
    await close();
  }
}
