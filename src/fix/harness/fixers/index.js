export { createRecipesFixer, SUPPORTED_RULES } from './recipes.js';
export { createCisFixer, injectionIn, summarizeGateEvidence } from './cis.js';
export { createExternalFixer, parseUnifiedDiff, applyHunks } from './external.js';
export { decline, isDeclined, readTaskContext, withinAllowlist } from './common.js';

/**
 * Build a fixer by name for `fix --harness`. `cis` reads its configuration from the environment through the existing
 * resolver, so the trusted pinned-CA mode is the default and the guarded `insecure-dev` mode is used only when every
 * guard variable is set; a missing or refused configuration throws with the resolver's safe reason code.
 */
export async function createFixer(name, { localRoot, report, env = process.env, fetchImpl } = {}) {
  if (name === 'recipes') return (await import('./recipes.js')).createRecipesFixer();
  if (name === 'external') {
    const dir = env.ADA_SCAN_EXTERNAL_DIFF_DIR || localRoot;
    return (await import('./external.js')).createExternalFixer({ dir, name: 'external' });
  }
  if (name === 'working-tree') return (await import('./external.js')).createWorkingTreeFixer({ dir: localRoot });
  if (name === 'cis') {
    const { resolveCisConfig, createCisTransportFromConfig } = await import('../../cis/config.js');
    const config = resolveCisConfig(env);
    if (!config.ok) throw new Error(`${config.reason}: ${config.message}`);
    const bundle = createCisTransportFromConfig(config, fetchImpl);
    if (!bundle) throw new Error('CIS_CONFIG_MISSING: CIS transport is unavailable.');
    const transport = typeof bundle.importTransport === 'function' ? await bundle.importTransport() : bundle;
    return (await import('./cis.js')).createCisFixer({ transport, model: config.model });
  }
  throw new Error(`Unknown fixer "${name}".`);
}
