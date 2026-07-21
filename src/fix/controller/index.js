import { mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { resolveFixCapability, requiresHybridAttestation } from './mode-gate.js';
import {
  assertPathContainedInRoot,
  loadTrustedLocalAttestation,
  resolveTrustedRoot,
} from './local-attestation.js';
import {
  FixControllerError,
  SESSION_STATES,
  appendAuditEvent,
  createFixSession,
  transitionSession,
} from './session.js';
import { buildFixUnits } from '../canonical/fix-unit.js';
import { partitionProposableUnits } from '../policy/router.js';
import { validateScanReportV2 } from '../../reporter/report-v2.js';
import { createSourceTraceInbox, traceAllFindings, applyTraceResultsToFindings } from '../trace/inbox.js';
import { buildTraceCandidatesFromFindings } from '../trace/candidates.js';
import { loadReviewState } from '../review/state.js';
import { startReviewServer } from '../review/server.js';
import { createTrustedApplyHandler } from '../apply/handler.js';
import {
  buildManualCheckAttestations,
  validateAcknowledgedManualCheckIds,
} from '../manual-checks.js';
import { verifyAndRegisterCandidate } from '../verify/orchestrate.js';
import { createTrustedVerificationAdapters } from '../verify/adapters.js';
import { runTrustedProposal } from '../proposal/orchestrator.js';
import {
  createCisTransportFromConfig,
  resolveCisConfig,
} from '../cis/config.js';
import { redactTransportErrorMessage } from '../cis/transport.js';
import { normalizeSourcePath } from '../../reporter/fingerprint.js';
import { validateRelativeCandidatePath, resolveSecureSourceFile } from '../candidate/path.js';
import { CANDIDATE_LIMITS, CandidateIntentError } from '../candidate/intent.js';

function collectFindings(report) {
  return (report.pages || []).flatMap((page) => page.findings || []);
}

function deriveCapabilityFromReport(report, localRoot) {
  const target = report.target || {};
  const loaded = localRoot ? loadTrustedLocalAttestation(localRoot) : { ok: false };

  if (
    localRoot
    && requiresHybridAttestation({ targetMode: target.mode, url: target.url, localRoot })
    && !loaded.ok
  ) {
    return {
      mode: 'hybrid',
      canFix: false,
      reason: loaded.reason || 'LOCAL_ATTESTATION_MISSING',
    };
  }

  return resolveFixCapability({
    targetMode: target.mode,
    url: target.url,
    localRoot,
    remoteRevision: target.buildRevision ?? null,
    localRevision: loaded.ok ? loaded.attestation.buildRevision : null,
    remoteInstrumentationDigest: target.instrumentationDigest ?? null,
    localInstrumentationDigest: loaded.ok ? loaded.attestation.instrumentationDigest : null,
    remoteDeploymentUrl: target.deploymentUrl ?? null,
    localDeploymentUrl: loaded.ok ? loaded.attestation.deploymentUrl : null,
    scannedUrl: target.url ?? null,
    attestationStatus: target.attestationStatus ?? null,
    attestationReason: target.attestationReason ?? null,
  });
}

function resolveSessionId(sessionId) {
  if (sessionId == null || sessionId === '') return `fix-${Date.now()}`;
  const value = String(sessionId);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value)) {
    throw new FixControllerError(
      'INVALID_SESSION_ID',
      'Session ID must contain only letters, numbers, underscores, and hyphens.',
    );
  }
  return value;
}

function deriveSessionDir(sessionId, sessionRoot) {
  const rootCheck = resolveTrustedRoot(sessionRoot);
  if (!rootCheck.ok) {
    throw new FixControllerError('INVALID_SESSION_ROOT', 'Session root is unavailable.');
  }

  const sessionDir = join(rootCheck.localRoot, 'scan-reports', 'fix-sessions', sessionId);
  mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  chmodSync(sessionDir, 0o700);

  const contained = assertPathContainedInRoot(rootCheck.localRoot, sessionDir);
  if (!contained.ok) {
    throw new FixControllerError('INVALID_SESSION_ROOT', 'Session directory escaped session root.');
  }

  return contained.resolvedPath;
}

function resolveSessionRoot(sessionRoot, localRoot) {
  const effective = sessionRoot ?? localRoot;
  const rootCheck = resolveTrustedRoot(effective);
  if (!rootCheck.ok) {
    throw new FixControllerError('INVALID_SESSION_ROOT', 'Session root is unavailable.');
  }
  return rootCheck.localRoot;
}

function resolveTargetSourceFile(targetSourceFile, localRoot) {
  if (targetSourceFile == null || targetSourceFile === '') return null;
  try {
    const normalized = validateRelativeCandidatePath(targetSourceFile);
    resolveSecureSourceFile(localRoot, normalized, { maxBytes: CANDIDATE_LIMITS.maxFileBytes });
    return normalized;
  } catch (error) {
    const code = error instanceof CandidateIntentError ? error.code : 'INVALID_TARGET_FILE';
    throw new FixControllerError(code, error.message || 'Target source file is invalid.');
  }
}

function filterFindingsByTargetSource(findings, targetSourceFile) {
  if (!targetSourceFile) return findings;
  return findings.filter(
    (finding) => normalizeSourcePath(finding.source?.file || '') === targetSourceFile,
  );
}

function initialWorkflowState(fixUnits, policyRoutes) {
  if (fixUnits.every((unit) => unit.status === 'ready')) {
    if (policyRoutes.every((route) => !route.proposalAllowed)) {
      return SESSION_STATES.MANUAL_ONLY;
    }
    return SESSION_STATES.READY_FOR_POLICY;
  }
  return SESSION_STATES.TRACE_REQUIRED;
}

function freezeTrustedVerificationConfig(verification) {
  if (!verification || typeof verification !== 'object') return null;
  const {
    build = null,
    formatter = null,
    prepare = null,
    scanner = null,
    site = null,
    commandEnv = {},
    buildTimeoutMs = undefined,
  } = verification;
  if (typeof scanner !== 'function') {
    throw new Error('Trusted verification requires a scanner adapter function.');
  }
  return Object.freeze({
    build,
    formatter,
    prepare,
    scanner,
    site,
    commandEnv: Object.freeze({ ...(commandEnv || {}) }),
    buildTimeoutMs,
  });
}

export function resolveDefaultTrustedVerification(localRoot, overrides = null) {
  if (overrides) return freezeTrustedVerificationConfig(overrides);
  return freezeTrustedVerificationConfig(createTrustedVerificationAdapters(localRoot));
}

/**
 * Bind trusted verification dependencies from Node CLI options only.
 * Request/HTTP payloads must never supply scanner, site, build, or formatter adapters.
 */
export function createVerifyCandidateOperation({
  reviewState,
  localRoot,
  reportId,
  verification,
}) {
  const trusted = freezeTrustedVerificationConfig(verification);
  if (!trusted) {
    throw new Error('Trusted verification configuration is required for verifyCandidate.');
  }

  return async function verifyCandidate(fixUnitId, {
    edits = [],
    policyVersion = '1',
    promptVersion = '',
    modelId = '',
    targetFindingIds = [],
    baselineFindings = [],
    manualChecks = [],
    manualChecksAcknowledged = false,
    acknowledgedCheckIds = [],
    performanceMetrics = null,
    replace = false,
    signal = null,
  } = {}) {
    return verifyAndRegisterCandidate(reviewState, fixUnitId, {
      localRoot,
      reportId,
      policyVersion,
      promptVersion,
      modelId,
      edits,
      targetFindingIds,
      baselineFindings,
      manualChecks,
      manualChecksAcknowledged,
      acknowledgedCheckIds,
      performanceMetrics,
      formatter: trusted.formatter,
      prepare: trusted.prepare,
      build: trusted.build,
      scanner: trusted.scanner,
      site: trusted.site,
      commandEnv: trusted.commandEnv,
      buildTimeoutMs: trusted.buildTimeoutMs,
      signal,
      replace,
    });
  };
}

export function createProposeCandidateOperation({
  reviewState,
  localRoot,
  reportId,
  transport = null,
  model = null,
  env = process.env,
}) {
  return async function proposeCandidate(fixUnitId, { signal = null } = {}) {
    reviewState.recordAuditEvent({ type: 'proposal_started', fixUnitId });
    try {
      return await runTrustedProposal({
        reviewState,
        fixUnitId,
        localRoot,
        reportId,
        transport,
        model,
        signal,
        env,
      });
    } catch (error) {
      reviewState.recordAuditEvent({
        type: 'proposal_failed',
        fixUnitId,
        reasonCode: error.code || 'PROPOSAL_FAILED',
      });
      throw error;
    }
  };
}

export function collectVerificationBaseline(fixUnits = []) {
  const findings = [];
  const seenIds = new Set();

  for (const unit of fixUnits || []) {
    for (const finding of unit.findings || []) {
      const findingId = finding.findingId || finding.fingerprint || null;
      if (findingId && seenIds.has(findingId)) continue;
      if (findingId) seenIds.add(findingId);
      findings.push(structuredClone(finding));
    }
  }

  return findings;
}

function cloneAndFreezeVerificationBaseline(findings = []) {
  const cloned = structuredClone(findings || []);
  const seen = new WeakSet();

  function freeze(value) {
    if (!value || typeof value !== 'object' || seen.has(value)) return value;
    seen.add(value);
    for (const child of Object.values(value)) freeze(child);
    return Object.freeze(value);
  }

  return freeze(cloned);
}

export function createVerifyRegisteredCandidateOperation({
  reviewState,
  localRoot,
  reportId,
  verification,
  fixUnits = [],
  verificationBaselineFindings = undefined,
}) {
  const verifyCandidate = createVerifyCandidateOperation({
    reviewState,
    localRoot,
    reportId,
    verification,
  });
  const baselineFindings = cloneAndFreezeVerificationBaseline(
    verificationBaselineFindings === undefined
      ? collectVerificationBaseline(fixUnits.length > 0 ? fixUnits : reviewState.fixUnits)
      : verificationBaselineFindings,
  );

  return async function verifyRegisteredCandidate(fixUnitId, {
    acknowledgedCheckIds = [],
    signal = null,
  } = {}) {
    const unit = fixUnits.find((item) => item.fixUnitId === fixUnitId)
      || reviewState.fixUnits.find((item) => item.fixUnitId === fixUnitId);
    const candidate = reviewState.getCandidate(fixUnitId);
    if (!candidate?.editIntents?.length) {
      throw new Error('Registered candidate is required for verification.');
    }
    const attestations = candidate.manualCheckAttestations
      || buildManualCheckAttestations(candidate.candidateHash, candidate.manualChecks || []);
    if (attestations.length > 0) {
      const ack = validateAcknowledgedManualCheckIds(attestations, acknowledgedCheckIds, {
        candidateHash: candidate.candidateHash,
      });
      if (!ack.ok) {
        const error = new Error('All manual checks must be acknowledged with current check IDs.');
        error.code = ack.reason;
        throw error;
      }
    }

    reviewState.recordAuditEvent({ type: 'verify_started', fixUnitId, candidateHash: candidate.candidateHash });
    try {
      const result = await verifyCandidate(fixUnitId, {
        edits: candidate.editIntents,
        policyVersion: candidate.policyVersion || '1',
        promptVersion: candidate.promptVersion || '',
        modelId: candidate.modelId || '',
        targetFindingIds: unit?.findingIds || [],
        baselineFindings,
        manualChecks: candidate.manualChecks || [],
        manualChecksAcknowledged: attestations.length === 0 || acknowledgedCheckIds.length === attestations.length,
        acknowledgedCheckIds,
        replace: true,
        signal,
      });
      reviewState.recordAuditEvent({
        type: result.ok ? 'verify_completed' : 'verify_failed',
        fixUnitId,
        candidateHash: candidate.candidateHash,
        reason: result.ok ? null : result.reason,
        artifactId: result.verification?.artifactId || null,
      });
      return result;
    } catch (error) {
      reviewState.recordAuditEvent({
        type: 'verify_failed',
        fixUnitId,
        reasonCode: error.code || 'VERIFY_FAILED',
      });
      throw error;
    }
  };
}

/**
 * Start a trusted fix controller session. Does not write user source.
 * Local attestation is always loaded from the filesystem; caller overrides are ignored.
 */
export function startFixController({
  report,
  localRoot = null,
  sessionRoot = null,
  sessionId = null,
  sessionDir: _ignoredSessionDir = null,
  targetSourceFile = null,
  localRevision: _ignoredRevision = null,
  localInstrumentationDigest: _ignoredDigest = null,
} = {}) {
  validateScanReportV2(report);

  const capability = deriveCapabilityFromReport(report, localRoot);

  if (!capability.canFix) {
    return {
      status: 'scan-only',
      capability,
      session: null,
    };
  }

  const findings = collectFindings(report);
  if (findings.length === 0) {
    return {
      status: 'no-findings',
      reason: 'NO_FINDINGS',
      capability,
      session: null,
      fixUnits: [],
      policyRoutes: [],
      proposable: [],
      blocked: [],
      traceInbox: null,
      traceResults: [],
    };
  }

  const resolvedSessionId = resolveSessionId(sessionId);
  const resolvedSessionRoot = resolveSessionRoot(sessionRoot, localRoot);
  const resolvedTargetSourceFile = resolveTargetSourceFile(targetSourceFile, localRoot);
  let session = createFixSession({
    sessionId: resolvedSessionId,
    reportId: report.reportId,
    capability,
    fixUnits: [],
    policyRoutes: [],
  });
  const resolvedSessionDir = deriveSessionDir(resolvedSessionId, resolvedSessionRoot);

  const traceInbox = createSourceTraceInbox({
    reportId: report.reportId,
    localRoot,
    sessionDir: resolvedSessionDir,
    candidates: buildTraceCandidatesFromFindings(findings),
  });
  const traceResults = traceAllFindings(traceInbox, findings);
  let sanitizedFindings = applyTraceResultsToFindings(findings, traceResults);
  sanitizedFindings = filterFindingsByTargetSource(sanitizedFindings, resolvedTargetSourceFile);

  if (sanitizedFindings.length === 0) {
    return {
      status: 'no-findings',
      reason: resolvedTargetSourceFile ? 'NO_TARGET_FINDINGS' : 'NO_FINDINGS',
      capability,
      session: null,
      fixUnits: [],
      policyRoutes: [],
      proposable: [],
      blocked: [],
      traceInbox: null,
      traceResults: [],
    };
  }

  const fixUnits = buildFixUnits(sanitizedFindings);
  const { routed, proposable, blocked } = partitionProposableUnits(fixUnits);

  session = {
    ...session,
    fixUnits,
    policyRoutes: routed,
  };

  session = transitionSession(session, SESSION_STATES.CANONICALIZED);
  session = transitionSession(session, initialWorkflowState(fixUnits, routed));
  session = appendAuditEvent(session, {
    type: 'controller_started',
    reportId: report.reportId,
    capability,
    fixUnitCount: fixUnits.length,
    proposableCount: proposable.length,
    blockedCount: blocked.length,
    sessionDir: resolvedSessionDir,
  });
  session = appendAuditEvent(session, {
    type: 'trace_bulk_completed',
    reportId: report.reportId,
    findingCount: findings.length,
    tracedCount: traceResults.length,
  });

  return {
    status: 'pending',
    reason: 'REVIEW_UI_PENDING',
    capability,
    sessionDir: resolvedSessionDir,
    session: {
      ...session,
      traceResults,
    },
    fixUnits,
    policyRoutes: routed,
    proposable,
    blocked,
    traceInbox,
    traceResults,
  };
}

export function formatCisTransportUnavailableMessage(error) {
  return `CIS transport unavailable: ${redactTransportErrorMessage(error)}`;
}

/**
 * @param {NonNullable<ReturnType<typeof resolveCisConfig>>} cisConfig
 * @param {{
 *   createCisTransportFromTrustedConfig?: typeof createCisTransportFromConfig,
 *   createCisTransportFromConfig?: typeof createCisTransportFromConfig,
 * }} [deps]
 */
export async function importTrustedCisTransport(cisConfig, deps = {}) {
  const createTransport = deps.createCisTransportFromTrustedConfig
    ?? deps.createCisTransportFromConfig
    ?? createCisTransportFromConfig;
  try {
    const bundle = createTransport(cisConfig);
    return await bundle.importTransport();
  } catch (error) {
    console.log(formatCisTransportUnavailableMessage(error));
    return null;
  }
}

export function loadReportFromPath(reportPath) {
  const report = JSON.parse(readFileSync(reportPath, 'utf8'));
  validateScanReportV2(report);
  return report;
}

/**
 * @param {() => (void | Promise<void>)} reviewServerClose
 * @param {{ close?: () => (void | Promise<void>) } | null | undefined} cisTransport
 */
export async function closeReviewServerWithCisTransport(reviewServerClose, cisTransport) {
  /** @type {unknown} */
  let serverError;
  /** @type {unknown} */
  let transportError;
  try {
    await reviewServerClose();
  } catch (error) {
    serverError = error;
  }
  try {
    if (cisTransport && typeof cisTransport.close === 'function') {
      await cisTransport.close();
    }
  } catch (error) {
    transportError = error;
  }
  if (serverError) throw serverError;
  if (transportError) throw transportError;
}

export async function runTrustedFixCli(options = {}) {
  const {
    reportPath = null,
    report = null,
    localRoot = null,
    sessionRoot = null,
    sessionId = null,
    targetSourceFile = null,
    useUI = false,
    verification = null,
    cisTransport = null,
    cisTransportFactory = null,
    cisModel = null,
    postVerify = undefined,
    applyHandlerWrap = null,
    sandboxContext = null,
    rollbackHandler = null,
  } = options;

  const resolvedReport = report || (reportPath ? loadReportFromPath(reportPath) : null);
  if (!resolvedReport) {
    throw new Error('A ScanReportV2 report is required for trusted fix mode.');
  }
  const verificationBaselineFindings = collectFindings(resolvedReport);

  const result = startFixController({
    report: resolvedReport,
    localRoot,
    sessionRoot,
    sessionId,
    targetSourceFile,
  });

  if (result.status === 'scan-only') {
    console.log(`Fix unavailable: ${result.capability.reason}`);
    return result;
  }

  if (result.status === 'no-findings') {
    console.log('No findings to fix.');
    return result;
  }

  console.log(`Trusted fix controller: ${result.fixUnits.length} canonical unit(s)`);
  console.log(`Policy routing: ${result.proposable.length} proposable, ${result.blocked.length} blocked`);
  console.log(`Review session: ${result.session.sessionId}`);
  if (useUI) {
    const cisConfig = resolveCisConfig();
    const transportSecurity = cisConfig.ok ? cisConfig.transportSecurity : 'disabled';
    const devAuthBypass = cisConfig.ok && cisConfig.devBypassAuth === true;

    const reviewState = loadReviewState({
      sessionDir: result.sessionDir,
      reportId: resolvedReport.reportId,
      sessionId: result.session.sessionId,
      fixUnits: result.fixUnits,
      traceResults: result.traceResults,
      policyRoutes: result.policyRoutes,
      traceInbox: result.traceInbox,
      localRoot,
      controllerAudit: result.session?.auditLog || [],
      transportSecurity,
      devAuthBypass,
      sandboxContext,
      verificationBaselineFindings,
    });
    let trustedVerification = verification;
    if (!trustedVerification && localRoot) {
      try {
        trustedVerification = resolveDefaultTrustedVerification(localRoot);
      } catch (error) {
        console.log(`Production verification adapters unavailable: ${error.message}`);
      }
    }

    let applyHandler = createTrustedApplyHandler({
      localRoot,
      sessionDir: result.sessionDir,
      reportId: resolvedReport.reportId,
      verification: trustedVerification,
      postVerify,
    });
    if (typeof applyHandlerWrap === 'function') {
      applyHandler = applyHandlerWrap(applyHandler);
    }

    let effectiveTransport = cisTransport;
    if (!effectiveTransport && typeof cisTransportFactory === 'function') {
      effectiveTransport = cisTransportFactory({ fixUnits: result.fixUnits, localRoot, report: resolvedReport });
    }
    if (!effectiveTransport && cisConfig.ok) {
      effectiveTransport = await importTrustedCisTransport(cisConfig);
    }

    const proposeCandidate = createProposeCandidateOperation({
      reviewState,
      localRoot,
      reportId: resolvedReport.reportId,
      transport: effectiveTransport,
      model: cisModel || (cisConfig.ok ? cisConfig.model : null),
    });
    const verifyRegisteredCandidate = trustedVerification
      ? createVerifyRegisteredCandidateOperation({
        reviewState,
        localRoot,
        reportId: resolvedReport.reportId,
        verification: trustedVerification,
        fixUnits: result.fixUnits,
        verificationBaselineFindings,
      })
      : null;

    const reviewServer = await startReviewServer({
      state: reviewState,
      applyHandler,
      proposeHandler: proposeCandidate,
      verifyHandler: verifyRegisteredCandidate,
      rollbackHandler,
    });
    console.log(`Review workbench: ${reviewServer.reviewUrl}`);

    const reviewServerClose = reviewServer.close.bind(reviewServer);
    reviewServer.close = () => closeReviewServerWithCisTransport(reviewServerClose, effectiveTransport);

    if (!cisConfig.ok) {
      console.log(`CIS proposals disabled: ${cisConfig.message}`);
    }

    const verifyCandidate = trustedVerification
      ? createVerifyCandidateOperation({
        reviewState,
        localRoot,
        reportId: resolvedReport.reportId,
        verification: trustedVerification,
      })
      : null;
    return {
      ...result,
      status: 'review',
      reason: 'REVIEW_UI_READY',
      reviewState,
      reviewUrl: reviewServer.reviewUrl,
      reviewServer,
      verifyCandidate,
      proposeCandidate,
      verifyRegisteredCandidate,
      cisConfig,
      verification: trustedVerification,
    };
  }
  return result;
}

export { resolveFixCapability } from './mode-gate.js';
export { buildFixUnits } from '../canonical/fix-unit.js';
export { SESSION_STATES, transitionSession, FixControllerError } from './session.js';
export { verifyAndRegisterCandidate } from '../verify/orchestrate.js';
