import { existsSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { resolveTrustedVerificationConfig } from './config.js';
import { createStaticSiteAdapter, createViteSiteAdapter } from './site.js';
import { createProductionScannerAdapter } from './scanner.js';

const VITE_CONFIG_FILES = Object.freeze([
  'vite.config.js',
  'vite.config.mjs',
  'vite.config.cjs',
  'vite.config.ts',
  'vite.config.mts',
  'vite.config.cts',
]);

function hasRegularViteConfig(localRoot) {
  return VITE_CONFIG_FILES.some((name) => {
    const file = join(localRoot, name);
    try {
      const stat = lstatSync(file);
      return existsSync(file) && stat.isFile() && !stat.isSymbolicLink();
    } catch {
      return false;
    }
  });
}

/**
 * Build trusted production verification adapters from host `.scan-config.json`.
 * Scanner/site/build/format/prepare never come from HTTP or model text.
 * buildEnv in scan config feeds fresh-scan instrumented builds only; shadow
 * verification uses candidate bindings for source attestation and intentionally
 * exposes an empty commandEnv here.
 */
export function createTrustedVerificationAdapters(localRoot, {
  scannerOptions = {},
  siteOptions = {},
  overrides = null,
} = {}) {
  if (overrides) {
    return Object.freeze({
      ...overrides,
      commandEnv: Object.freeze({ ...(overrides.commandEnv || {}) }),
    });
  }

  const config = resolveTrustedVerificationConfig(localRoot);
  if (!config.ok) {
    throw new Error(`Trusted verification config unavailable: ${config.reason}`);
  }

  const { mode: requestedSiteMode = 'auto', ...resolvedSiteOptions } = siteOptions;
  if (!['auto', 'static', 'vite'].includes(requestedSiteMode)) {
    throw new Error('Trusted verification site mode must be auto, static, or vite.');
  }
  const useViteSite = requestedSiteMode === 'vite'
    || (requestedSiteMode === 'auto' && hasRegularViteConfig(config.localRoot));

  return Object.freeze({
    build: config.build,
    formatter: config.formatter,
    prepare: config.prepare,
    site: useViteSite
      ? createViteSiteAdapter(resolvedSiteOptions)
      : createStaticSiteAdapter({ outDir: config.outDir, ...resolvedSiteOptions }),
    scanner: createProductionScannerAdapter(scannerOptions),
    commandEnv: Object.freeze({}),
    buildTimeoutMs: undefined,
  });
}

export { resolveTrustedVerificationConfig };
