import { join, isAbsolute } from 'node:path';
import { assertPathContainedInRoot, resolveTrustedRoot } from '../controller/local-attestation.js';
import { readBoundedFile } from '../review/secure-io.js';
import { parseTrustedCommand } from './command.js';

const MAX_JSON_BYTES = 1024 * 1024;
const DEFAULT_BUILD = Object.freeze({ command: 'npm', args: ['run', 'build'] });
const DEFAULT_FORMAT = null;

function resolveOutDir(root, config = {}) {
  const outDir = config?.outDir || 'dist';
  if (typeof outDir !== 'string' || outDir.includes('..') || isAbsolute(outDir)) {
    return 'dist';
  }
  return outDir;
}

function readTrustedScanConfig(localRoot) {
  const rootCheck = resolveTrustedRoot(localRoot);
  if (!rootCheck.ok) return rootCheck;

  const configPath = join(rootCheck.localRoot, '.scan-config.json');
  const contained = assertPathContainedInRoot(rootCheck.localRoot, configPath);
  if (!contained.ok) return { ok: false, reason: 'MALFORMED_CONFIG' };

  let raw;
  try {
    raw = readBoundedFile(contained.resolvedPath, MAX_JSON_BYTES);
  } catch {
    return { ok: false, reason: 'MALFORMED_CONFIG' };
  }
  if (raw == null) return { ok: true, value: {}, localRoot: rootCheck.localRoot };

  try {
    return { ok: true, value: JSON.parse(raw), localRoot: rootCheck.localRoot };
  } catch {
    return { ok: false, reason: 'MALFORMED_CONFIG' };
  }
}

function tryOptionalCommand(config, key) {
  if (config[key] == null) return { ok: true, value: null };
  try {
    return { ok: true, value: parseTrustedCommand(config[key], { field: key }) };
  } catch {
    return { ok: false, reason: 'MALFORMED_CONFIG' };
  }
}

/**
 * Resolve trusted shadow verification commands from host `.scan-config.json` only.
 * buildEnv in scan config is not exported here; it is consumed by fresh-scan builds.
 */
export function resolveTrustedVerificationConfig(localRoot) {
  const loaded = readTrustedScanConfig(localRoot);
  if (!loaded.ok) {
    return loaded;
  }

  const config = loaded.value || {};
  const outDir = resolveOutDir(loaded.localRoot, config);
  if (outDir.includes('..') || isAbsolute(outDir)) {
    return { ok: false, reason: 'MALFORMED_CONFIG' };
  }

  let build = DEFAULT_BUILD;
  if (config.verifyBuildCommand != null) {
    const parsed = tryOptionalCommand(config, 'verifyBuildCommand');
    if (!parsed.ok) return parsed;
    build = parsed.value;
  } else if (config.buildCommand != null) {
    const parsed = tryOptionalCommand(config, 'buildCommand');
    if (!parsed.ok) return parsed;
    build = parsed.value;
  }

  let formatter = DEFAULT_FORMAT;
  if (config.verifyFormatCommand != null) {
    const parsed = tryOptionalCommand(config, 'verifyFormatCommand');
    if (!parsed.ok) return parsed;
    formatter = parsed.value;
  } else if (config.formatCommand != null) {
    const parsed = tryOptionalCommand(config, 'formatCommand');
    if (!parsed.ok) return parsed;
    formatter = parsed.value;
  }

  let prepare = null;
  if (config.verifyInstallCommand != null) {
    const parsed = tryOptionalCommand(config, 'verifyInstallCommand');
    if (!parsed.ok) return parsed;
    prepare = parsed.value;
  }

  return {
    ok: true,
    localRoot: loaded.localRoot,
    outDir,
    build,
    formatter,
    prepare,
  };
}
