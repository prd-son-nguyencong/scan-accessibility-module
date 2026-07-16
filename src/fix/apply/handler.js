import { validateAndBuildCandidate } from '../candidate/intent.js';
import { attachDiffToCandidate } from '../candidate/diff.js';
import { applyBatchTransaction, TransactionError } from './transaction.js';
import { restoreTransactionFiles } from './rollback.js';
import { runPostApplyTargetedVerification } from '../verify/post-apply-scan.js';

function rebuildCandidateForApply(localRoot, reportId, stored) {
  if (!stored?.editIntents?.length) {
    const error = new Error('INVALID_CANDIDATE');
    error.code = 'INVALID_CANDIDATE';
    throw error;
  }
  const rebuilt = attachDiffToCandidate(validateAndBuildCandidate({
    localRoot,
    reportId,
    policyVersion: stored.policyVersion || '1',
    promptVersion: stored.promptVersion || '',
    modelId: stored.modelId || '',
    edits: stored.editIntents,
  }));
  if (stored.candidateHash && rebuilt.candidateHash !== stored.candidateHash) {
    const error = new Error('CANDIDATE_HASH_MISMATCH');
    error.code = 'CANDIDATE_HASH_MISMATCH';
    throw error;
  }
  if (stored.diffHash && rebuilt.diffHash !== stored.diffHash) {
    const error = new Error('DIFF_HASH_MISMATCH');
    error.code = 'DIFF_HASH_MISMATCH';
    throw error;
  }
  return rebuilt;
}

/**
 * Trusted apply handler for review workbench/controller.
 * Commits atomically, runs post-apply targeted verification, and rolls back on failure.
 */
export function createTrustedApplyHandler({
  localRoot,
  sessionDir,
  reportId = null,
  verification = null,
  postVerify = runPostApplyTargetedVerification,
} = {}) {
  return async function trustedApplyHandler({
    units = [],
    candidates = [],
    reportId: handlerReportId = null,
    baselineByUnit = new Map(),
    signal = null,
  } = {}) {
    const effectiveReportId = handlerReportId || reportId;
    if (!effectiveReportId) {
      const error = new Error('REPORT_ID_REQUIRED');
      error.code = 'REPORT_ID_REQUIRED';
      throw error;
    }

    const entries = units.map((unit) => {
      const wrapped = candidates.find((item) => item.fixUnitId === unit.fixUnitId);
      const stored = wrapped?.candidate;
      const artifactId = stored?.verification?.artifactId;
      if (!stored || !artifactId) {
        const error = new Error('VERIFICATION_REQUIRED');
        error.code = 'VERIFICATION_REQUIRED';
        throw error;
      }
      const candidate = rebuildCandidateForApply(localRoot, effectiveReportId, stored);
      return {
        fixUnitId: unit.fixUnitId,
        candidate,
        candidateHash: unit.candidateHash,
        diffHash: unit.diffHash,
        verificationArtifactId: artifactId,
      };
    });

    const result = await applyBatchTransaction({
      localRoot,
      sessionDir,
      entries,
    });

    if (result.status === 'rollback-conflicted') {
      const error = new Error('Rollback conflicted with concurrent user edits.');
      error.code = 'ROLLBACK_CONFLICTED';
      error.result = result;
      throw error;
    }
    if (result.status !== 'committed') {
      const error = new Error(result.error || 'APPLY_FAILED');
      error.code = result.error || 'APPLY_FAILED';
      error.result = result;
      throw error;
    }

    if (typeof postVerify === 'function' && verification?.scanner) {
      const applyUnits = entries.map((entry) => {
        const wrapped = candidates.find((item) => item.fixUnitId === entry.fixUnitId);
        const unitMeta = units.find((item) => item.fixUnitId === entry.fixUnitId);
        return {
          fixUnitId: entry.fixUnitId,
          findingIds: unitMeta?.findingIds || [],
          affectedRoutes: unitMeta?.affectedRoutes || ['/'],
          editIntents: entry.candidate.edits,
        };
      });

      const postResult = await postVerify({
        localRoot,
        units: applyUnits,
        baselineByUnit,
        verification,
        signal,
      });

      if (!postResult.ok) {
        const rollback = await restoreTransactionFiles({
          localRoot,
          transactionDir: result.transactionDir,
        });
        if (rollback.conflicts?.length > 0) {
          const error = new Error('Post-verify rollback conflicted with concurrent user edits.');
          error.code = 'POST_VERIFY_ROLLBACK_CONFLICTED';
          error.postVerify = postResult;
          error.rollback = rollback;
          throw error;
        }
        const error = new Error('POST_VERIFY_FAILED');
        error.code = 'POST_VERIFY_FAILED';
        error.postVerify = postResult;
        error.rollback = rollback;
        throw error;
      }

      return {
        ...result,
        postVerified: true,
        postVerify: postResult,
      };
    }

    return result;
  };
}

export { applyBatchTransaction, TransactionError };
