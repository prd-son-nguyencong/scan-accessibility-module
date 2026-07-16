import { loadConfig } from './config.js';

/**
 * Centralizes what used to be hardcoded Paradox/third-party knowledge scattered
 * across engine.js, axe.js, w3c.js and focus-trap.js. Everything is now driven
 * by `config.thirdParty` so non-Paradox consumers configure (or empty) their own.
 */

const DEFAULT_THIRD_PARTY = {
  selectors: ['.d3afa4', '._72cec8', '.apply-', '[data-testid^="olivia"]'],
  devArtifactTokens: ['{{', '}}', '{%', '%}'],
  chatbotSelector: '.oliviaButton',
};

let _cache;

export function resolveIncludeThirdParty({
  isRemoteUrl = false,
  includeRequested = false,
  excludeRequested = false,
} = {}) {
  if (excludeRequested) return false;
  if (includeRequested) return true;
  return isRemoteUrl;
}

export function getThirdPartyConfig() {
  if (_cache) return _cache;
  try {
    const cfg = loadConfig();
    _cache = { ...DEFAULT_THIRD_PARTY, ...(cfg.thirdParty || {}) };
  } catch {
    _cache = DEFAULT_THIRD_PARTY;
  }
  return _cache;
}

/** Testing hook. */
export function resetThirdPartyCache() {
  _cache = undefined;
}

/**
 * True when the element HTML matches any configured third-party selector.
 * Matches by class/id token or literal attribute substring (mirrors the
 * previous `html.includes(sel.replace('.', ''))` behavior, generalized).
 */
export function isThirdPartyHtml(html = '', selectors) {
  if (!html) return false;
  const sels = selectors || getThirdPartyConfig().selectors || [];
  return sels.some((sel) => {
    if (!sel) return false;
    const token = sel.replace(/^[.#]/, '');
    return html.includes(token);
  });
}

/**
 * Builds a matcher regex list from configured devArtifactTokens.
 * Tokens are consumed as delimiter pairs: ['{{','}}','{%','%}'] -> {{…}}, {%…%}.
 */
function templateTokenPatterns(tokens) {
  const patterns = [];
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    const open = escapeRegExp(tokens[i]);
    const close = escapeRegExp(tokens[i + 1]);
    patterns.push(new RegExp(`${open}[\\s\\S]*?${close}`, 'g'));
  }
  return patterns;
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * True when, after stripping configured template tokens + HTML tags + whitespace,
 * nothing remains — i.e. the node is only a dev-time template artifact
 * (e.g. `<h1>{{data:hero_heading}}</h1>` empty in dev, populated in prod).
 */
export function isTemplateDevArtifact(html = '', tokens) {
  const toks = tokens || getThirdPartyConfig().devArtifactTokens || [];
  const source = String(html);
  const patterns = templateTokenPatterns(toks);
  const hasTemplateToken = patterns.some((re) => {
    re.lastIndex = 0;
    return re.test(source);
  });

  if (!hasTemplateToken) return false;

  let stripped = source;
  for (const re of patterns) {
    re.lastIndex = 0;
    stripped = stripped.replace(re, '');
  }
  stripped = stripped.replace(/<[^>]+>/g, '').replace(/\s+/g, '');
  return stripped.length === 0;
}
