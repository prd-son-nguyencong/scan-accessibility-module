import { spawnSync } from 'child_process';
import { existsSync, readFileSync, statSync } from 'fs';
import path from 'path';
import { getProjectRoot } from '../utils/paths.js';
import { loadConfig } from '../utils/config.js';

const ROOT = getProjectRoot();
const MANIFEST_MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes
const IS_WINDOWS = process.platform === 'win32';

function manifestPath(config) {
  const outDir = config?.outDir || 'dist';
  return path.join(ROOT, outDir, 'scan-manifest.json');
}

function isManifestFresh(config) {
  const p = manifestPath(config);
  if (!existsSync(p)) return false;
  const { mtimeMs } = statSync(p);
  return Date.now() - mtimeMs < MANIFEST_MAX_AGE_MS;
}

/**
 * Runs the host's build with the instrumentation env so the Vite plugin emits
 * `<outDir>/scan-manifest.json`. Build command + env + outDir are config-driven
 * (buildCommand / buildEnv / outDir) so npm/yarn/pnpm and custom scripts work.
 */
export async function buildInstrumented(force = false, config = loadConfig()) {
  if (!force && isManifestFresh(config)) {
    console.log('Scan manifest is fresh — skipping build.\n');
    return;
  }

  const buildCommand = config.buildCommand || 'pnpm build:vite';
  const [cmd, ...args] = buildCommand.split(/\s+/);
  const buildEnv = config.buildEnv || { SCAN_MODE: 'true', MINIFY: 'true' };

  console.log(`\nBuilding (${buildCommand}) with instrumentation env...`);
  const result = spawnSync(cmd, args, {
    cwd: ROOT,
    stdio: 'inherit',
    // Windows package-manager binaries are .cmd shims — require a shell.
    shell: IS_WINDOWS,
    env: {
      ...process.env,
      ...buildEnv,
      PARADOX_ENV: process.env.PARADOX_ENV || 'STG',
    },
  });

  if (result.status !== 0) {
    throw new Error(`Instrumented build failed (exit ${result.status}) via "${buildCommand}"`);
  }
  console.log('Build complete.\n');
}

export function loadScanManifest(config = loadConfig()) {
  const p = manifestPath(config);
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return {};
  }
}
