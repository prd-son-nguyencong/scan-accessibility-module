import { attachDiffToCandidate } from '../candidate/diff.js';
import { validateAndBuildCandidate } from '../candidate/intent.js';
import { runShadowVerification } from './shadow.js';

/**
 * Trusted verification orchestration: shadow verify then register verified candidate.
 */
export async function verifyAndRegisterCandidate(reviewState, fixUnitId, {
  localRoot,
  reportId,
  policyVersion,
  promptVersion = '',
  modelId = '',
  edits = [],
  targetFindingIds = [],
  baselineFindings = [],
  manualChecks = [],
    manualChecksAcknowledged = false,
    acknowledgedCheckIds = [],
    performanceMetrics = null,
  formatter = null,
  prepare = null,
  build = null,
  scanner,
  site = null,
  commandEnv = {},
  buildTimeoutMs,
  signal = null,
  replace = false,
}) {
  const candidate = validateAndBuildCandidate({
    localRoot,
    reportId,
    policyVersion,
    promptVersion,
    modelId,
    edits,
  });

  const verification = await runShadowVerification({
    localRoot,
    sessionDir: reviewState.sessionDir,
    candidate,
    targetFindingIds,
    baselineFindings,
    manualChecks,
    manualChecksAcknowledged,
    performanceMetrics,
    formatter,
    prepare,
    build,
    scanner,
    site,
    commandEnv,
    buildTimeoutMs,
    signal,
  });

  if (!verification.ok) {
    return { ok: false, reason: verification.reason, verification };
  }

  const enriched = attachDiffToCandidate(candidate);
  const registered = reviewState.registerVerifiedCandidate(fixUnitId, {
    candidateHash: enriched.candidateHash,
    diffHash: enriched.diffHash,
    diff: enriched.diff,
    verified: true,
    conflictFree: true,
    editIntents: enriched.edits,
    policyVersion: enriched.policyVersion,
    promptVersion: enriched.promptVersion,
    modelId: enriched.modelId,
    manualChecks,
    verification: {
      status: 'passed',
      artifactId: verification.artifactId,
    },
  }, { replace, acknowledgedCheckIds });

  return {
    ok: true,
    candidate: registered,
    verification,
  };
}
