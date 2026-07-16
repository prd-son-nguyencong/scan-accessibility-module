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

function optionalCommand(config, key) {
  if (config[key] == null) return null;
  return parseTrustedCommand(config[key], { field: key });
}

/**
 * Resolve trusted shadow verification commands from host `.scan-config.json` only.
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
    build = optionalCommand(config, 'verifyBuildCommand');
  } else if (config.buildCommand != null) {
    build = optionalCommand(config, 'buildCommand');
  }

  const formatter = config.verifyFormatCommand != null
    ? optionalCommand(config, 'verifyFormatCommand')
    : (config.formatCommand != null ? optionalCommand(config, 'formatCommand') : DEFAULT_FORMAT);

  const prepare = config.verifyInstallCommand != null
    ? optionalCommand(config, 'verifyInstallCommand')
    : null;

  return {
    ok: true,
    localRoot: loaded.localRoot,
    outDir,
    build,
    formatter,
    prepare,
  };
}
