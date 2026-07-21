import {
  existsSync,
  lstatSync,
} from 'node:fs';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { resolveTrustedRoot } from '../controller/local-attestation.js';
import { writeAtomicFile } from '../apply/transaction.js';
import { readBoundedFile, SecureIoError } from '../review/secure-io.js';
import { parseTrustedCommand } from '../verify/command.js';

export const SANDBOX_SCAN_CONFIG_FILE = '.scan-config.json';
const MAX_CONFIG_BYTES = 1024 * 1024;
// buildInstrumented splits buildCommand on whitespace and spawnSync looks up cmd on PATH.
const CANONICAL_PNPM_BUILD_COMMAND = 'pnpm build:vite';

const DEMO_SCAN_CONFIG_DEFAULTS = Object.freeze({
  baseUrl: 'http://localhost:1234',
  // buildEnv is consumed by fresh-scan instrumented builds only; shadow verification
  // intentionally receives an empty commandEnv from trusted adapters.
  buildEnv: Object.freeze({ SCAN_MODE: 'true', MINIFY: 'true' }),
  outDir: 'dist',
  source: Object.freeze({
    roots: ['src/partials', 'src/pages', 'src/components'],
    pagesRoot: 'src/pages',
    extension: '.liquid',
  }),
  distMap: Object.freeze([
    { dist: 'dist/partials/', src: 'src/partials/', ext: '.liquid' },
    { dist: 'dist/pages/', src: 'src/pages/', ext: '.liquid' },
    { dist: 'dist/layouts/', src: 'src/layouts/', ext: '.liquid' },
    { dist: 'dist/components/', src: 'src/components/', ext: '.liquid' },
  ]),
});

function throwMalformed(message) {
  throw Object.assign(new Error(message), { code: 'MALFORMED_CONFIG' });
}

function configPathForRoot(root) {
  const rootCheck = resolveTrustedRoot(root);
  if (!rootCheck.ok) return rootCheck;
  const configPath = join(rootCheck.localRoot, SANDBOX_SCAN_CONFIG_FILE);
  const rel = relative(rootCheck.localRoot, resolve(configPath));
  if (rel.startsWith('..') || isAbsolute(rel)) {
    return { ok: false, reason: 'MALFORMED_CONFIG' };
  }
  return { ok: true, localRoot: rootCheck.localRoot, configPath };
}

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function isSafeOutDir(outDir) {
  return typeof outDir === 'string' && outDir.length > 0 && !outDir.includes('..') && !isAbsolute(outDir);
}

function assertRegularConfigLeaf(configPath, code) {
  if (!existsSync(configPath)) return false;
  let stat;
  try {
    stat = lstatSync(configPath);
  } catch {
    throw Object.assign(new Error('Scan config is unavailable.'), { code });
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw Object.assign(new Error('Scan config must be a regular file.'), { code });
  }
  return true;
}

function sanitizeDemoBuildEnv(value) {
  const source = isPlainObject(value) ? value : null;
  if (!source) {
    return { ...DEMO_SCAN_CONFIG_DEFAULTS.buildEnv };
  }
  return {
    SCAN_MODE: typeof source.SCAN_MODE === 'string' ? source.SCAN_MODE : 'true',
    MINIFY: typeof source.MINIFY === 'string' ? source.MINIFY : 'true',
  };
}

function isPnpmExecutable(command) {
  const base = basename(String(command || '').trim()).toLowerCase();
  return base === 'pnpm' || base === 'pnpm.js' || base === 'pnpm.cmd';
}

function shouldPinBuildToPackageManager(command, packageManagerPath) {
  return command === packageManagerPath || isPnpmExecutable(command);
}

/**
 * Trusted local config boundary for demo sandboxes:
 * - verifyInstallCommand is always pinned to the resolved absolute package manager.
 * - verifyBuildCommand/buildCommand fallbacks must pass parseTrustedCommand.
 * - pnpm-family executables (pnpm, pnpm.js, resolved corepack path) pin verifyBuildCommand
 *   to the absolute package manager while legacy buildCommand stays `pnpm build:vite`.
 * - Other executables (e.g. node scripts/build.js) remain when parseTrustedCommand allows them.
 */
function normalizeDemoBuildCommand(config, packageManagerPath, specs) {
  const field = config.verifyBuildCommand != null ? 'verifyBuildCommand' : 'buildCommand';
  const source = config.verifyBuildCommand ?? config.buildCommand ?? null;
  if (source == null) {
    return specs.verifyBuildCommand;
  }

  let parsed;
  try {
    parsed = parseTrustedCommand(source, { field });
  } catch {
    throwMalformed(`Demo sandbox ${field} is not trusted.`);
  }

  if (shouldPinBuildToPackageManager(parsed.command, packageManagerPath)) {
    return {
      command: packageManagerPath,
      args: parsed.args.length > 0 ? parsed.args : ['build:vite'],
    };
  }

  return parsed;
}

function normalizeDemoBuildCommandString(buildCommand, packageManagerPath, specs) {
  if (buildCommand == null) {
    return specs.buildCommand;
  }
  if (typeof buildCommand !== 'string') {
    throwMalformed('Demo sandbox buildCommand must be a string.');
  }

  let parsed;
  try {
    parsed = parseTrustedCommand(buildCommand, { field: 'buildCommand' });
  } catch {
    throwMalformed('Demo sandbox buildCommand is not trusted.');
  }

  if (shouldPinBuildToPackageManager(parsed.command, packageManagerPath)) {
    return specs.buildCommand;
  }

  return buildCommand;
}

/**
 * Bounded no-follow read of `.scan-config.json` under a trusted sandbox root.
 */
export function readBoundedSandboxScanConfig(sandboxRoot) {
  const located = configPathForRoot(sandboxRoot);
  if (!located.ok) return located;

  if (!assertRegularConfigLeaf(located.configPath, 'MALFORMED_CONFIG')) {
    return { ok: true, present: false, localRoot: located.localRoot };
  }

  let raw;
  try {
    raw = readBoundedFile(located.configPath, MAX_CONFIG_BYTES);
  } catch (error) {
    if (error instanceof SecureIoError && error.code === 'SYMLINK_FILE') {
      return { ok: false, reason: 'SYMLINK_ESCAPE' };
    }
    return { ok: false, reason: 'MALFORMED_CONFIG' };
  }
  if (raw == null) {
    return { ok: false, reason: 'MALFORMED_CONFIG' };
  }

  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'MALFORMED_CONFIG' };
  }
  if (!isPlainObject(value)) {
    return { ok: false, reason: 'MALFORMED_CONFIG' };
  }
  return {
    ok: true,
    present: true,
    value,
    raw,
    localRoot: located.localRoot,
    configPath: located.configPath,
  };
}

/**
 * Read host `.scan-config.json` when present without mutating host bytes.
 */
export function readBoundedHostScanConfig(hostRoot) {
  const located = configPathForRoot(hostRoot);
  if (!located.ok) return located;

  if (!existsSync(located.configPath)) {
    return { ok: true, present: false, localRoot: located.localRoot };
  }

  try {
    assertRegularConfigLeaf(located.configPath, 'SYMLINK_ESCAPE');
  } catch (error) {
    return { ok: false, reason: error.code || 'MALFORMED_CONFIG' };
  }

  let raw;
  try {
    raw = readBoundedFile(located.configPath, MAX_CONFIG_BYTES);
  } catch (error) {
    if (error instanceof SecureIoError && error.code === 'SYMLINK_FILE') {
      return { ok: false, reason: 'SYMLINK_ESCAPE' };
    }
    return { ok: false, reason: 'MALFORMED_CONFIG' };
  }
  if (raw == null) {
    return { ok: false, reason: 'MALFORMED_CONFIG' };
  }

  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'MALFORMED_CONFIG' };
  }
  if (!isPlainObject(value)) {
    return { ok: false, reason: 'MALFORMED_CONFIG' };
  }

  return {
    ok: true,
    present: true,
    value,
    raw,
    localRoot: located.localRoot,
    configPath: located.configPath,
  };
}

export function packageManagerVerificationCommands(packageManagerPath) {
  if (typeof packageManagerPath !== 'string' || !isAbsolute(packageManagerPath)) {
    throw Object.assign(new Error('Package manager path must be absolute.'), { code: 'INVALID_PACKAGE_MANAGER' });
  }
  return {
    verifyInstallCommand: { command: packageManagerPath, args: ['install', '--ignore-scripts'] },
    verifyBuildCommand: { command: packageManagerPath, args: ['build:vite'] },
    buildCommand: CANONICAL_PNPM_BUILD_COMMAND,
  };
}

export function mergeDemoVerificationCommands(config, packageManagerPath) {
  if (!isPlainObject(config)) {
    throwMalformed('Scan config must be a JSON object.');
  }

  const specs = packageManagerVerificationCommands(packageManagerPath);
  const merged = structuredClone(config);

  merged.buildEnv = sanitizeDemoBuildEnv(merged.buildEnv);
  if (!isSafeOutDir(merged.outDir)) {
    merged.outDir = DEMO_SCAN_CONFIG_DEFAULTS.outDir;
  }

  merged.verifyInstallCommand = specs.verifyInstallCommand;
  merged.verifyBuildCommand = normalizeDemoBuildCommand(merged, packageManagerPath, specs);
  merged.buildCommand = normalizeDemoBuildCommandString(merged.buildCommand, packageManagerPath, specs);

  return merged;
}

export function buildFreshDemoScanConfig(packageManagerPath) {
  return mergeDemoVerificationCommands({ ...DEMO_SCAN_CONFIG_DEFAULTS }, packageManagerPath);
}

export function writeSandboxScanConfig(sandboxRoot, config) {
  if (!isPlainObject(config)) {
    throwMalformed('Scan config must be a JSON object.');
  }
  const located = configPathForRoot(sandboxRoot);
  if (!located.ok) {
    throw Object.assign(new Error('Sandbox root is unavailable.'), { code: located.reason || 'LOCAL_ROOT_MISSING' });
  }

  const serialized = `${JSON.stringify(config, null, 2)}\n`;
  const bytes = Buffer.from(serialized, 'utf8');
  if (bytes.length > MAX_CONFIG_BYTES) {
    throwMalformed('Scan config exceeds allowed size.');
  }

  writeAtomicFile(located.configPath, bytes, 0o600);
  return located.configPath;
}

export function ensureDemoSandboxScanConfig({
  sandboxRoot,
  hostRoot,
  packageManagerPath,
  hostScanConfig = null,
}) {
  const host = hostScanConfig || readBoundedHostScanConfig(hostRoot);
  if (!host.ok) {
    throw Object.assign(new Error('Host scan config is invalid.'), { code: host.reason || 'MALFORMED_CONFIG' });
  }

  const config = host.present
    ? mergeDemoVerificationCommands(host.value, packageManagerPath)
    : buildFreshDemoScanConfig(packageManagerPath);

  writeSandboxScanConfig(sandboxRoot, config);
  return config;
}
