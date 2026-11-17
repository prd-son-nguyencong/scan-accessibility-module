import { mkdtempSync, chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveTrustedRoot } from '../controller/local-attestation.js';
import { copyProjectTreeIntoShadow, runManagedCommand, startCandidateSite, stopCandidateSite, scannerOwnsSiteLifecycle } from './shadow.js';
import { compareVerificationFindings } from './verification-key.js';
import { ShadowVerificationError } from './shadow.js';

/**
 * Post-apply targeted verification against the live workspace bytes.
 * Uses the same conservative comparator as shadow verification — this is a
 * per-apply safety invariant, not a CI corpus release gate.
 */
export async function runPostApplyTargetedVerification({
  localRoot,
  units = [],
  baselineByUnit = new Map(),
  verification,
  signal = null,
}) {
  if (!verification?.scanner) {
    throw new ShadowVerificationError('SCANNER_REQUIRED', 'Post-apply verification requires a scanner adapter.');
  }

  const rootCheck = resolveTrustedRoot(localRoot);
  if (!rootCheck.ok) {
    throw new ShadowVerificationError(rootCheck.reason || 'LOCAL_ROOT_MISSING', 'Local root unavailable.');
  }

  const shadowRoot = mkdtempSync(join(tmpdir(), 'ada-post-apply-'));
  chmodSync(shadowRoot, 0o700);
  let siteHandle = null;

  try {
    copyProjectTreeIntoShadow({ localRoot: rootCheck.localRoot, shadowRoot });

    if (verification.prepare) {
      const prepareResult = await runManagedCommand(
        verification.prepare.command,
        verification.prepare.args || [],
        shadowRoot,
        { signal, extraEnv: verification.commandEnv || {} },
      );
      if (prepareResult.code !== 0) {
        return { ok: false, reason: 'POST_PREPARE_FAILED', prepare: prepareResult };
      }
    }

    if (verification.build) {
      const buildResult = await runManagedCommand(
        verification.build.command,
        verification.build.args || [],
        shadowRoot,
        { signal, extraEnv: verification.commandEnv || {} },
      );
      if (buildResult.code !== 0) {
        return { ok: false, reason: 'POST_BUILD_FAILED', build: buildResult };
      }
    }

    if (!scannerOwnsSiteLifecycle(verification.scanner) && verification.site) {
      siteHandle = await startCandidateSite(verification.site, shadowRoot, { signal });
    }

    const unitResults = [];
    let allPassed = true;

    for (const unit of units) {
      const baselineFindings = baselineByUnit.get(unit.fixUnitId) || [];
      const targetFindingIds = unit.findingIds || baselineFindings.map((f) => f.findingId).filter(Boolean);
      const candidateBindings = (unit.editIntents || unit.edits || []).map((edit) => ({ file: edit.file }));

      const scanResult = await verification.scanner({
        workspaceRoot: shadowRoot,
        siteUrl: siteHandle?.url ?? null,
        routes: unit.affectedRoutes || ['/'],
        layers: ['accessibility'],
        signal,
        candidateBindings,
        targetFindingIds,
      });

      const compareFn = typeof scanResult.compareFindings === 'function'
        ? scanResult.compareFindings.bind(scanResult)
        : compareVerificationFindings;
      const delta = compareFn(baselineFindings, scanResult.findings || [], targetFindingIds);

      const passed = delta.targetsResolved
        && delta.newCriticalSerious.length === 0
        && scanResult.sourceTraceResolved === true;

      if (!passed) allPassed = false;
      unitResults.push({
        fixUnitId: unit.fixUnitId,
        passed,
        delta,
        sourceTraceResolved: scanResult.sourceTraceResolved === true,
        executedLayers: scanResult.executedLayers || [],
      });
    }

    return {
      ok: allPassed,
      reason: allPassed ? 'POST_VERIFY_PASSED' : 'POST_VERIFY_FAILED',
      unitResults,
    };
  } finally {
    await stopCandidateSite(siteHandle);
    try {
      rmSync(shadowRoot, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}