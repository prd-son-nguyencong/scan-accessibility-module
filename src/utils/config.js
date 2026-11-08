import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { getProjectRoot } from './paths.js';
import { CliError } from './cli-args.js';
import { validateThresholds } from './thresholds.js';
import { AGREEMENT_POLICIES } from '../reporter/engine-agreement.js';

const ROOT = getProjectRoot();

// Single, centralized .env load for the whole tool. dotenv is a declared
// dependency; the load is guarded so the tool (and unit tests) still run if it
// is somehow absent.
// ADA_SCAN_NO_DOTENV=1 opts out (tests set it so an ambient .env cannot leak in).
if (process.env.ADA_SCAN_NO_DOTENV !== '1') {
  try {
    const { default: dotenv } = await import('dotenv');
    dotenv.config({ path: path.join(ROOT, '.env') });
  } catch {
    /* .env support unavailable — env vars from the shell still apply */
  }
}

export const DEFAULT_AXE_VIEWPORTS = Object.freeze([
  { name: 'desktop', width: 1280, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
]);

export const DEFAULT_CONFIG = {
  baseUrl: 'http://localhost:1234',
  devCommand: 'pnpm dev',
  buildCommand: 'pnpm build:vite',
  buildEnv: { SCAN_MODE: 'true', MINIFY: 'true' },
  outDir: 'dist',
  source: {
    roots: ['src/partials', 'src/pages', 'src/components'],
    pagesRoot: 'src/pages',
    extension: '.liquid',
  },
  distMap: [
    { dist: 'dist/partials/', src: 'src/partials/', ext: '.liquid' },
    { dist: 'dist/pages/', src: 'src/pages/', ext: '.liquid' },
    { dist: 'dist/layouts/', src: 'src/layouts/', ext: '.liquid' },
    { dist: 'dist/components/', src: 'src/components/', ext: '.liquid' },
  ],
  thirdParty: {
    preset: 'auto',
    selectors: ['.d3afa4', '._72cec8', '.apply-', '[data-testid^="olivia"]'],
    devArtifactTokens: ['{{', '}}', '{%', '%}'],
    chatbotSelector: '.oliviaButton',
  },
  axe: {
    viewports: structuredClone(DEFAULT_AXE_VIEWPORTS),
    timeoutMs: 60000,
  },
  links: { platformRoutes: [] }, // globs of same-origin paths the platform serves (e.g. "/jobs", "/job-details/*"): never reported as dead
  gate: { countThirdParty: false, countPlatform: false }, // vendor-script, iframe and platform-widget findings are listed in their own section and left out of the gate
  tracing: { vendors: [], foreignImpactCap: 'moderate' }, // vendors: extra vendors.json entries; foreignImpactCap: highest impact of a non-site finding (null lifts it)
  pages: [],
  concurrency: 2,
  thresholds: {}, // defaults live in normalizeThresholds so legacy flat keys are not shadowed by merged nested defaults
  layers: {
    axe: true,
    accessScan: true,
    w3c: true,
    htmlValidate: true,
    links: true,
    lighthouse: true,
    keyboard: true,
    ariaLive: true,
    focusTrap: true,
    dynamicContent: true,
    screenReader: true,
  },
  external: { w3c: false, psi: false },
  html: { validate: { rules: {} } },
  lighthouse: { runs: 1, timeoutMs: 120000 },
  verify: { maxPerPage: 100, timeoutMs: 60000 },
  scan: { emptyPagePolicy: 'skip', errorPages: ['/404', '/500', '/job-details'], strict: false }, // errorPages: route globs of status/platform pages (job-details renders no authored content without platform job data); page-structure findings there are needs-review
  verdict: { agreementPolicy: 'strict' }, // strict: a finding only one heuristic engine reports is needs-review; off: no adjustment
  evidence: { screenshots: { enabled: true, maxPerPage: 20 } },
  customRules: [],
  skipRules: [],
  suppress: [],
  profile: 'standards',
};

export const KNOWN_LAYERS = Object.freeze(Object.keys(DEFAULT_CONFIG.layers));
const THIRD_PARTY_PRESETS = ['auto', 'paradox', 'none'];

export class ConfigError extends CliError {}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStrArr = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');

/** Page name defaults to the path: "/" -> "homepage", "/about/team" -> "about-team". */
export function derivePageName(pagePath = '/') {
  let p = String(pagePath);
  try {
    const u = new URL(p);
    p = `${u.hostname}${u.pathname}`;
  } catch { /* not an absolute URL */ }
  const slug = p.replace(/^\/+|\/+$/g, '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'homepage';
}

/** Hand-rolled schema check for the known keys. Returns a list of messages (empty = valid). Unknown keys are allowed. */
export function validateConfig(cfg) {
  if (!isObj(cfg)) return ['config must be a JSON object'];
  const errs = [];
  const str = (k, v = cfg[k]) => { if (v !== undefined && typeof v !== 'string') errs.push(`${k} must be a string`); };
  for (const k of ['baseUrl', 'devCommand', 'buildCommand', 'outDir', 'reportsDir', 'deploymentUrl']) str(k);
  if (cfg.buildEnv !== undefined && !(isObj(cfg.buildEnv) && Object.values(cfg.buildEnv).every((v) => typeof v === 'string'))) {
    errs.push('buildEnv must be an object of string values');
  }
  if (cfg.source !== undefined) {
    if (!isObj(cfg.source)) errs.push('source must be an object');
    else {
      if (cfg.source.roots !== undefined && !isStrArr(cfg.source.roots)) errs.push('source.roots must be an array of strings');
      str('source.pagesRoot', cfg.source.pagesRoot);
      str('source.extension', cfg.source.extension);
    }
  }
  if (cfg.tracer !== undefined) {
    if (!isObj(cfg.tracer)) errs.push('tracer must be an object');
    else str('tracer.adapter', cfg.tracer.adapter);
  }
  if (cfg.distMap !== undefined && !(Array.isArray(cfg.distMap)
    && cfg.distMap.every((e) => isObj(e) && typeof e.dist === 'string' && typeof e.src === 'string'))) {
    errs.push('distMap must be an array of { dist, src, ext? } with string values');
  }
  if (cfg.profile !== undefined && !['standards', 'commercial-parity'].includes(cfg.profile)) {
    errs.push('profile must be "standards" or "commercial-parity"');
  }
  const tp = cfg.thirdParty;
  if (tp !== undefined && tp !== null && tp !== false && !Array.isArray(tp)) {
    if (!isObj(tp)) errs.push('thirdParty must be an object, an array of selectors, null or false');
    else {
      if (tp.preset !== undefined && !THIRD_PARTY_PRESETS.includes(tp.preset)) {
        errs.push(`thirdParty.preset must be one of ${THIRD_PARTY_PRESETS.join(', ')}`);
      }
      for (const k of ['selectors', 'devArtifactTokens']) {
        if (tp[k] !== undefined && !isStrArr(tp[k])) errs.push(`thirdParty.${k} must be an array of strings`);
      }
      str('thirdParty.chatbotSelector', tp.chatbotSelector);
    }
  } else if (Array.isArray(tp) && !isStrArr(tp)) errs.push('thirdParty array must contain strings');
  if (cfg.axe !== undefined) {
    const vps = cfg.axe?.viewports;
    if (!isObj(cfg.axe)) errs.push('axe must be an object');
    else if (vps !== undefined && !(Array.isArray(vps) && vps.length
      && vps.every((v) => isObj(v) && typeof v.name === 'string' && Number.isInteger(v.width) && v.width > 0
        && Number.isInteger(v.height) && v.height > 0))) {
      errs.push('axe.viewports must be a non-empty array of { name, width, height } (positive integers)');
    }
    if (isObj(cfg.axe) && cfg.axe.timeoutMs !== undefined && !(Number.isInteger(cfg.axe.timeoutMs) && cfg.axe.timeoutMs >= 1)) {
      errs.push('axe.timeoutMs must be an integer >= 1');
    }
  }
  if (cfg.pages !== undefined) {
    if (!Array.isArray(cfg.pages)) errs.push('pages must be an array');
    else {
      const seen = new Set();
      cfg.pages.forEach((p, i) => {
        if (!isObj(p) || typeof p.path !== 'string' || !p.path) return errs.push(`pages[${i}] must be an object with a non-empty string "path"`);
        if (p.name !== undefined && (typeof p.name !== 'string' || !p.name)) errs.push(`pages[${i}].name must be a non-empty string`);
        if (p.allowStatus !== undefined && !(Array.isArray(p.allowStatus) && p.allowStatus.every(Number.isInteger))) {
          errs.push(`pages[${i}].allowStatus must be an array of integers`);
        }
        const name = p.name || derivePageName(p.path);
        if (seen.has(name)) errs.push(`pages[${i}] duplicate page name "${name}" (set a unique "name")`);
        seen.add(name);
      });
    }
  }
  if (cfg.links !== undefined) {
    if (!isObj(cfg.links)) errs.push('links must be an object');
    else if (cfg.links.platformRoutes !== undefined && !isStrArr(cfg.links.platformRoutes)) errs.push('links.platformRoutes must be an array of path globs (strings)');
  }
  if (cfg.gate !== undefined) {
    if (!isObj(cfg.gate)) errs.push('gate must be an object');
    else {
      for (const k of ['countThirdParty', 'countPlatform']) if (cfg.gate[k] !== undefined && typeof cfg.gate[k] !== 'boolean') errs.push(`gate.${k} must be true or false`);
    }
  }
  if (cfg.tracing !== undefined) {
    if (!isObj(cfg.tracing)) errs.push('tracing must be an object');
    else {
      const vs = cfg.tracing.vendors;
      if (vs !== undefined && !(Array.isArray(vs) && vs.every((v) => isObj(v) && typeof v.id === 'string' && v.id && typeof v.name === 'string'
        && (v.patterns === undefined || (isObj(v.patterns) && Object.values(v.patterns).every(isStrArr)))))) {
        errs.push('tracing.vendors must be an array of { id, name, category?, patterns: { src?, id?, class?, attr?, html? } } with string-array patterns');
      }
      const cap = cfg.tracing.foreignImpactCap;
      if (cap !== undefined && cap !== null && cap !== false && !['critical', 'serious', 'moderate', 'minor'].includes(cap)) errs.push('tracing.foreignImpactCap must be critical, serious, moderate, minor or null');
    }
  }
  if (cfg.concurrency !== undefined && !(Number.isInteger(cfg.concurrency) && cfg.concurrency >= 1)) {
    errs.push('concurrency must be an integer >= 1');
  }
  if (cfg.thresholds !== undefined) errs.push(...validateThresholds(cfg.thresholds));
  if (cfg.layers !== undefined) {
    if (!isObj(cfg.layers)) errs.push('layers must be an object of booleans');
    else for (const [k, v] of Object.entries(cfg.layers)) {
      if (!KNOWN_LAYERS.includes(k)) errs.push(`layers.${k} is not a known layer (${KNOWN_LAYERS.join(', ')})`);
      else if (typeof v !== 'boolean') errs.push(`layers.${k} must be true or false`);
    }
  }
  if (cfg.external !== undefined) {
    if (!isObj(cfg.external)) errs.push('external must be an object');
    else {
      for (const k of ['w3c', 'psi']) {
        if (cfg.external[k] !== undefined && typeof cfg.external[k] !== 'boolean') errs.push(`external.${k} must be true or false`);
      }
      str('external.w3cEndpoint', cfg.external.w3cEndpoint);
    }
  }
  const hvRules = cfg.html?.validate?.rules;
  if (cfg.html !== undefined && !isObj(cfg.html)) errs.push('html must be an object');
  else if (hvRules !== undefined && !isObj(hvRules)) errs.push('html.validate.rules must be an object of html-validate rule settings');
  if (cfg.lighthouse !== undefined) {
    if (!isObj(cfg.lighthouse)) errs.push('lighthouse must be an object');
    else for (const k of ['runs', 'timeoutMs']) {
      if (cfg.lighthouse[k] !== undefined && !(Number.isInteger(cfg.lighthouse[k]) && cfg.lighthouse[k] >= 1)) {
        errs.push(`lighthouse.${k} must be an integer >= 1`);
      }
    }
  }
  if (cfg.verdict !== undefined) {
    if (!isObj(cfg.verdict)) errs.push('verdict must be an object');
    else if (cfg.verdict.agreementPolicy !== undefined && !AGREEMENT_POLICIES.includes(cfg.verdict.agreementPolicy)) {
      errs.push(`verdict.agreementPolicy must be one of: ${AGREEMENT_POLICIES.join(', ')}`);
    }
  }
  if (cfg.scan !== undefined) {
    if (!isObj(cfg.scan)) errs.push('scan must be an object');
    else if (cfg.scan.emptyPagePolicy !== undefined && !['skip', 'scan'].includes(cfg.scan.emptyPagePolicy)) errs.push("scan.emptyPagePolicy must be 'skip' or 'scan'");
    if (isObj(cfg.scan) && cfg.scan.strict !== undefined && typeof cfg.scan.strict !== 'boolean') errs.push('scan.strict must be a boolean');
    if (isObj(cfg.scan) && cfg.scan.errorPages !== undefined && !isStrArr(cfg.scan.errorPages)) errs.push('scan.errorPages must be an array of route globs (strings)');
  }
  if (cfg.verify !== undefined) {
    if (!isObj(cfg.verify)) errs.push('verify must be an object');
    else for (const k of ['maxPerPage', 'timeoutMs']) {
      if (cfg.verify[k] !== undefined && !(Number.isInteger(cfg.verify[k]) && cfg.verify[k] >= 1)) errs.push(`verify.${k} must be an integer >= 1`);
    }
  }
  if (cfg.evidence !== undefined) {
    const shots = cfg.evidence?.screenshots;
    if (!isObj(cfg.evidence)) errs.push('evidence must be an object');
    else if (shots !== undefined) {
      if (!isObj(shots)) errs.push('evidence.screenshots must be an object');
      else {
        if (shots.enabled !== undefined && typeof shots.enabled !== 'boolean') errs.push('evidence.screenshots.enabled must be true or false');
        if (shots.maxPerPage !== undefined && !(Number.isInteger(shots.maxPerPage) && shots.maxPerPage >= 0)) {
          errs.push('evidence.screenshots.maxPerPage must be an integer >= 0');
        }
      }
    }
  }
  for (const k of ['customRules', 'skipRules', 'suppress']) {
    if (cfg[k] !== undefined && !Array.isArray(cfg[k])) errs.push(`${k} must be an array`);
  }
  if (cfg.skipRules !== undefined && Array.isArray(cfg.skipRules) && !isStrArr(cfg.skipRules)) errs.push('skipRules must contain strings');
  return errs;
}

/** thirdParty: array/null/false (or preset "none") = nothing skipped; otherwise Paradox defaults ("auto" keeps today's behaviour). */
function resolveThirdParty(user, base) {
  const off = { preset: 'none', selectors: [], devArtifactTokens: [], chatbotSelector: '' };
  if (user === null || user === false) return off;
  if (Array.isArray(user)) return { ...off, selectors: user };
  if (user?.preset === 'none') return { ...off, ...user };
  return { ...base, preset: user?.preset || 'auto', ...user };
}

const _cache = new Map();

/**
 * Loads `.scan-config.json` from the host root, validates it and deep-merges it over the
 * defaults. A missing file warns and uses defaults; an unreadable, unparsable or invalid
 * file throws ConfigError (exit 2). Read once per root and process; callers get a copy.
 */
export function loadConfig(root = ROOT) {
  const configPath = path.join(root, '.scan-config.json');
  if (!_cache.has(configPath)) _cache.set(configPath, readConfig(configPath));
  return structuredClone(_cache.get(configPath));
}

/** Testing hook. */
export function resetConfigCache() {
  _cache.clear();
}

function readConfig(configPath) {
  if (!existsSync(configPath)) {
    console.warn('Warning: .scan-config.json not found — using defaults');
    return structuredClone(DEFAULT_CONFIG);
  }
  let userConfig;
  try {
    userConfig = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (err) {
    throw new ConfigError(`Cannot read ${configPath}: ${err.message}`);
  }
  const errs = validateConfig(userConfig);
  if (errs.length) throw new ConfigError(`Invalid ${configPath}:\n${errs.map((e) => `  - ${e}`).join('\n')}`);
  const merged = mergeConfig(DEFAULT_CONFIG, userConfig);
  merged.pages = merged.pages.map((p) => ({ ...p, name: p.name || derivePageName(p.path) }));
  return merged;
}

/** Deep-merge for the one-level-nested config objects the tool uses. */
export function mergeConfig(base, override) {
  const merged = structuredClone(base);
  for (const [key, value] of Object.entries(override || {})) {
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      merged[key] &&
      typeof merged[key] === 'object' &&
      !Array.isArray(merged[key])
    ) {
      merged[key] = key === 'thirdParty' ? resolveThirdParty(value, merged[key]) : { ...merged[key], ...value };
    } else if (key === 'thirdParty') {
      merged[key] = resolveThirdParty(value, merged[key]);
    } else {
      merged[key] = value;
    }
  }
  return merged;
}
