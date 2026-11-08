#!/usr/bin/env node
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { loadTrustedCaBundle, CisCaError } from '../src/fix/cis/ca.js';
import { readBoundedFile } from '../src/fix/review/secure-io.js';
import {
  CIS_KEYS,
  extractBrunoCisSettings,
  mergeEnvSettings,
  resolveCanonicalCaBundlePath,
  writeEnvAtomic,
} from './lib/cis-local-config.js';

const MAX_BRU_FILE_BYTES = 64 * 1024;
const MAX_ENV_BYTES = 64 * 1024;

/**
 * @param {{
 *   argv?: string[],
 *   stdoutWrite?: (chunk: string) => void,
 *   stderrWrite?: (chunk: string) => void,
 *   readBoundedFile?: typeof readBoundedFile,
 *   loadTrustedCaBundle?: typeof loadTrustedCaBundle,
 *   writeEnvAtomic?: typeof writeEnvAtomic,
 *   realpathSync?: typeof realpathSync,
 * }} [options]
 */
export async function runCisConfigureCli({
  argv = process.argv,
  stdoutWrite = (chunk) => process.stdout.write(chunk),
  stderrWrite = (chunk) => process.stderr.write(chunk),
  readBoundedFile: readBoundedFileImpl = readBoundedFile,
  loadTrustedCaBundle: loadTrustedCaBundleImpl = loadTrustedCaBundle,
  writeEnvAtomic: writeEnvAtomicImpl = writeEnvAtomic,
  realpathSync: realpathSyncImpl = realpathSync,
} = {}) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv.slice(2),
      options: {
        collection: { type: 'string' },
        env: { type: 'string' },
        'ca-bundle': { type: 'string' },
        'ca-sha256': { type: 'string' },
      },
      strict: true,
    }));
  } catch {
    stderrWrite('CIS_CONFIGURE_INVALID: CIS configure arguments are invalid.\n');
    return 1;
  }

  const collection = String(values.collection || '').trim();
  const envPath = String(values.env || '').trim();
  const caBundle = String(values['ca-bundle'] || '').trim();
  const caSha256 = String(values['ca-sha256'] || '').trim().toLowerCase();

  if (!collection || !envPath || !caBundle || !caSha256) {
    stderrWrite('CIS_CONFIGURE_INVALID: CIS configure arguments are invalid.\n');
    return 1;
  }

  try {
    const modelsPath = path.join(collection, 'get-models.bru');
    const predictionsPath = path.join(collection, 'predictions.bru');
    const modelsSource = readBoundedFileImpl(modelsPath, MAX_BRU_FILE_BYTES);
    const predictionsSource = readBoundedFileImpl(predictionsPath, MAX_BRU_FILE_BYTES);

    if (modelsSource == null || predictionsSource == null) {
      throw new Error('Bruno collection files are missing.');
    }

    const extracted = extractBrunoCisSettings({ modelsSource, predictionsSource });
    const canonicalCaPath = resolveCanonicalCaBundlePath(caBundle, realpathSyncImpl);
    loadTrustedCaBundleImpl(canonicalCaPath, caSha256);

    const existingEnv = existsSync(envPath)
      ? readBoundedFileImpl(envPath, MAX_ENV_BYTES) ?? ''
      : '';

    const merged = mergeEnvSettings(existingEnv, {
      CIS_PROXY_URL: extracted.baseUrl,
      CIS_AUTH_TOKEN: extracted.featureKey,
      CIS_ALLOWED_HOSTS: extracted.allowedHost,
      CIS_PROVIDER: extracted.provider,
      CIS_MODEL: extracted.model,
      CIS_CA_BUNDLE_PATH: canonicalCaPath,
      CIS_CA_SHA256: caSha256,
    });

    writeEnvAtomicImpl(envPath, merged);
    stdoutWrite(`${JSON.stringify({ ok: true, updated: [...CIS_KEYS] })}\n`);
    return 0;
  } catch (error) {
    if (error instanceof CisCaError) {
      stderrWrite(`${error.code}: ${error.message}\n`);
      return 1;
    }
    stderrWrite('CIS_CONFIGURE_INVALID: CIS local configuration is invalid.\n');
    return 1;
  }
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  runCisConfigureCli().then((code) => {
    process.exitCode = code;
  });
}
