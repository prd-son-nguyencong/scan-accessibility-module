import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { getProjectRoot } from './paths.js';

const ROOT = getProjectRoot();

// Single, centralized .env load for the whole tool. dotenv is a declared
// dependency; the load is guarded so the tool (and unit tests) still run if it
// is somehow absent.
try {
  const { default: dotenv } = await import('dotenv');
  dotenv.config({ path: path.join(ROOT, '.env') });
} catch {
  /* .env support unavailable — env vars from the shell still apply */
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
    selectors: ['.d3afa4', '._72cec8', '.apply-', '[data-testid^="olivia"]'],
    devArtifactTokens: ['{{', '}}', '{%', '%}'],
    chatbotSelector: '.oliviaButton',
  },
  axe: {
    viewports: structuredClone(DEFAULT_AXE_VIEWPORTS),
  },
  pages: [],
  concurrency: 2,
  thresholds: { wcag: 0, performance: 90, bestPractices: 90 },
  layers: {
    axe: true,
    accessScan: true,
    w3c: true,
    links: true,
    lighthouse: true,
    keyboard: true,
    ariaLive: true,
    focusTrap: true,
    dynamicContent: true,
    screenReader: true,
  },
  usePSI: true,
  customRules: [],
  skipRules: [],
  suppress: [],
};

/**
 * Loads `.scan-config.json` from the host root and deep-merges it over the
 * defaults. Nested objects (layers, source, thirdParty) are merged key-by-key
 * so a partial user config never drops a default.
 */
export function loadConfig() {
  const configPath = path.join(ROOT, '.scan-config.json');
  if (!existsSync(configPath)) {
    console.warn('Warning: .scan-config.json not found — using defaults');
    return structuredClone(DEFAULT_CONFIG);
  }
  try {
    const userConfig = JSON.parse(readFileSync(configPath, 'utf8'));
    return mergeConfig(DEFAULT_CONFIG, userConfig);
  } catch (err) {
    console.error(`Error reading .scan-config.json: ${err.message}`);
    return structuredClone(DEFAULT_CONFIG);
  }
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
      merged[key] = { ...merged[key], ...value };
    } else {
      merged[key] = value;
    }
  }
  return merged;
}
