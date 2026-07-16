#!/usr/bin/env node
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import '../src/utils/config.js';
import {
  createCisTransportFromTrustedConfig,
  resolveTrustedCisConfig,
} from '../src/fix/cis/config.js';
import { redactTransportErrorMessage } from '../src/fix/cis/transport.js';

/**
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   stdoutWrite?: (chunk: string) => void,
 *   stderrWrite?: (chunk: string) => void,
 *   resolveConfig?: (env: NodeJS.ProcessEnv) => import('../src/fix/cis/config.js').ReturnType<typeof resolveTrustedCisConfig>,
 *   createTransportBundle?: typeof createCisTransportFromTrustedConfig,
 * }} [options]
 */
export async function runCisModelsCli({
  env = process.env,
  stdoutWrite = (chunk) => process.stdout.write(chunk),
  stderrWrite = (chunk) => process.stderr.write(chunk),
  resolveConfig = (candidateEnv) => resolveTrustedCisConfig(candidateEnv, { requireModel: false }),
  createTransportBundle = createCisTransportFromTrustedConfig,
} = {}) {
  const config = resolveConfig(env);
  if (!config.ok) {
    stderrWrite(`${config.reason}: ${config.message}\n`);
    return 1;
  }

  const bundle = createTransportBundle(config);
  if (!bundle) {
    stderrWrite('CIS_CONFIG_MISSING: CIS model discovery is unavailable.\n');
    return 1;
  }

  /** @type {import('../src/fix/cis/transport.js').ReturnType<typeof import('../src/fix/cis/transport.js').createCisTransport> | null} */
  let transport = null;
  try {
    transport = await bundle.importTransport();
    const { models } = await transport.listModels();
    stdoutWrite(`${JSON.stringify({ models })}\n`);
    return 0;
  } catch (error) {
    stderrWrite(`${redactTransportErrorMessage(error)}\n`);
    return 1;
  } finally {
    if (transport) {
      await transport.close().catch(() => {});
    }
  }
}

/** @deprecated Use runCisModelsCli */
export const runCisModels = runCisModelsCli;

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  runCisModelsCli().then((code) => {
    process.exitCode = code;
  });
}
