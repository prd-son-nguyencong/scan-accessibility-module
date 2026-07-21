import { getSharedBuiltInRuleRegistry } from './engine/builtin-registry.js';
import { runRules } from './engine/runner.js';
import {
  PROFILES,
  resolveScanProfile,
  AccessScanUnknownProfileError,
} from './engine/profiles.js';
import { toViolation } from './engine/finding.js';
import {
  activateDynamicContent,
  createScanSession,
  installRuntimeHooks,
} from './runtime/index.js';

export { PROFILES, resolveScanProfile, resolveOrchestratorScanProfile, AccessScanUnknownProfileError } from './engine/profiles.js';

export class AccessScanUnknownRuleError extends Error {
  /**
   * @param {string} ruleId
   */
  constructor(ruleId) {
    super(`Unknown accessScan rule: ${ruleId}`);
    this.name = 'AccessScanUnknownRuleError';
    this.errorCode = 'unknown_rule';
    this.ruleId = ruleId;
  }
}

/**
 * @param {unknown} err
 * @returns {boolean}
 */
export function isPlaywrightNavigationTimeout(err) {
  return Boolean(err && typeof err === 'object' && /** @type {{ name?: string }} */ (err).name === 'TimeoutError');
}

/**
 * @param {import('./engine/registry.js').RuleRegistry} registry
 * @param {import('./engine/finding.js').NormalizedFinding} finding
 * @param {{
 *   layer?: string,
 *   source?: Record<string, unknown>,
 *   fix?: Record<string, unknown>,
 * }} options
 */
export function findingToViolation(registry, finding, options = {}) {
  const rule = registry.getRule(finding.ruleId);
  if (!rule) {
    throw new AccessScanUnknownRuleError(finding.ruleId);
  }
  return toViolation(finding, {
    ...options,
    rule,
  });
}

/**
 * @param {import('playwright').Page} page
 * @param {string} url
 */
async function navigateForScan(page, url) {
  await installRuntimeHooks(page);
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
  } catch (err) {
    if (!isPlaywrightNavigationTimeout(err)) {
      throw err;
    }
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(3000);
  }
}

/**
 * @param {import('./runtime/session.js').ReturnType<typeof createScanSession> extends Promise<infer T> ? T : never} session
 * @param {{
 *   externalNavigationCount?: number,
 *   scannerNavigationCount?: number,
 *   activationFrameCount?: number,
 *   activationScrollCount?: number,
 * }} options
 */
function buildSessionMetrics(session, {
  externalNavigationCount = 0,
  scannerNavigationCount = 0,
  activationFrameCount = 0,
  activationScrollCount = 0,
} = {}) {
  return {
    ...session.metrics,
    externalNavigationCount,
    scannerNavigationCount,
    activationFrameCount,
    activationScrollCount,
    navigationCount: session.metrics.navigationCount + externalNavigationCount + scannerNavigationCount,
  };
}

/**
 * @param {import('playwright').Page} page
 * @param {string} url
 * @param {{
 *   skipRules?: string[],
 *   profile?: import('./engine/schema.js').ProfileId,
 *   includeThirdParty?: boolean,
 *   skipNavigation?: boolean,
 *   activateContent?: boolean,
 *   externalNavigationCount?: number,
 *   ruleTimeoutMs?: number,
 *   signal?: AbortSignal,
 *   stabilityQuietMs?: number,
 *   stabilityTimeoutMs?: number,
 *   stabilityMinObserveMs?: number,
 *   session?: Awaited<ReturnType<typeof createScanSession>>,
 *   onExecutionRecords?: (
 *     records: import('./engine/runner.js').RuleExecutionRecord[],
 *     meta: { profile: string, sessionMetrics: Record<string, number> },
 *   ) => void,
 * }} [options]
 */
export async function scanWithAccessScan(page, url, options = {}) {
  const profile = resolveScanProfile(options);
  const {
    skipRules = [],
    skipNavigation = false,
    activateContent = true,
    externalNavigationCount = 0,
    ruleTimeoutMs,
    signal,
    stabilityQuietMs,
    stabilityTimeoutMs,
    stabilityMinObserveMs,
    session: providedSession,
    onExecutionRecords,
  } = options;

  let scannerNavigationCount = 0;
  if (!skipNavigation) {
    await navigateForScan(page, url);
    scannerNavigationCount = 1;
  }

  const activation = activateContent && !signal?.aborted
    ? await activateDynamicContent(page)
    : { frameCount: 0, scrollCount: 0 };

  const registry = await getSharedBuiltInRuleRegistry();
  const session = providedSession || await createScanSession(page, {
    stabilityQuietMs,
    stabilityTimeoutMs,
    stabilityMinObserveMs,
  });

  const { findings, executionRecords } = await runRules({
    registry,
    profile,
    context: {
      snapshot: session.snapshot,
      session,
      url,
    },
    skipRules,
    ruleTimeoutMs,
    signal,
  });

  const sessionMetrics = buildSessionMetrics(session, {
    externalNavigationCount,
    scannerNavigationCount,
    activationFrameCount: activation.frameCount,
    activationScrollCount: activation.scrollCount,
  });

  if (onExecutionRecords) {
    try {
      onExecutionRecords(executionRecords, {
        profile,
        sessionMetrics,
      });
    } catch (observerErr) {
      const message = observerErr instanceof Error ? observerErr.message : String(observerErr);
      process.stderr.write(`[ada-scan:accessScan:onExecutionRecords] ${message}\n`);
    }
  }

  const violations = [];
  for (const finding of findings) {
    violations.push(findingToViolation(registry, finding, {
      layer: 'accessScan',
      source: { mode: 'url', url },
    }));
  }

  return violations;
}
