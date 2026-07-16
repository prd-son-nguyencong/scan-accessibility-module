import { createHash } from 'node:crypto';
import { createContextBroker } from '../context/broker.js';
import { validateAndBuildCandidate, hashFileContent } from '../candidate/intent.js';
import { attachDiffToCandidate } from '../candidate/diff.js';
import { readSecureFileBytes, resolveSecureSourceFile } from '../candidate/path.js';
import { buildSourcePreimage, buildSourcePreimageRange } from '../../tracer/preimage.js';
import { lookupPolicyDecision } from '../policy/registry.js';
import { runCisAdvisory } from '../cis/advisory.js';
import { resolveTrustedCisConfig } from '../cis/config.js';
import { appendCisTelemetryRecord, sanitizeCisTelemetryRecord } from '../cis/telemetry.js';
import { CIS_VALIDATION_LIMITS } from '../cis/limits.js';

export class ProposalOrchestratorError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ProposalOrchestratorError';
    this.code = code;
  }
}

function blockIdForUnit(fixUnitId) {
  return `ctx_${createHash('sha256').update(fixUnitId).digest('hex').slice(0, 16)}`;
}

function buildContextBindings(fixUnit) {
  const owner = fixUnit.sourceOwner;
  if (!owner?.file || !owner?.line || !owner?.preimageSha256) {
    throw new ProposalOrchestratorError('SOURCE_OWNER_REQUIRED', 'Ready unit requires verified source owner.');
  }
  const blockId = blockIdForUnit(fixUnit.fixUnitId);
  const range = owner.preimageRange || { start: owner.line, end: owner.line };
  const startLine = Number.isInteger(range.start) ? range.start : owner.line;
  const endLine = Number.isInteger(range.end) ? range.end : owner.line;
  return [{
    blockId,
    file: owner.file,
    startLine,
    endLine: Math.max(startLine, endLine),
    expectedSha256: owner.preimageSha256,
  }];
}

function mapEditsFromCis(edits, bindings, broker, localRoot) {
  const bindingById = new Map(bindings.map((binding) => [binding.blockId, binding]));
  return edits.map((edit) => {
    const binding = bindingById.get(edit.blockId);
    if (!binding) {
      throw new ProposalOrchestratorError('UNKNOWN_BLOCK', `Unknown CIS block ${edit.blockId}.`);
    }
    broker.getBlock(edit.blockId, { expectedSha256: edit.expectedSha256 });
    const resolved = resolveSecureSourceFile(localRoot, binding.file, { maxBytes: CIS_VALIDATION_LIMITS.maxBlockBytes });
    const content = resolved.bytes.toString('utf8');
    const fileSha256 = hashFileContent(content);
    const preimage = binding.startLine === binding.endLine
      ? buildSourcePreimage(content, binding.startLine)
      : buildSourcePreimageRange(content, binding.startLine, binding.endLine);
    if (!preimage) {
      throw new ProposalOrchestratorError('PREIMAGE_RANGE_INVALID', 'Verified source range is invalid.');
    }
    return {
      file: binding.file,
      blockRange: { startLine: binding.startLine, endLine: binding.endLine },
      expectedBlockSha256: preimage.preimageSha256,
      expectedFileSha256: fileSha256,
      oldText: edit.oldText,
      newText: edit.newText,
    };
  });
}

/**
 * Trusted CIS proposal orchestrator. CIS never chooses paths, ranges, or commands.
 */
export async function runTrustedProposal({
  reviewState,
  fixUnitId,
  localRoot,
  reportId,
  transport,
  model,
  signal = null,
  env = process.env,
} = {}) {
  const unit = reviewState.fixUnits.find((item) => item.fixUnitId === fixUnitId);
  if (!unit || unit.status !== 'ready') {
    throw new ProposalOrchestratorError('UNIT_NOT_READY', 'Proposal requires a ready fix unit.');
  }

  const policyRoute = reviewState.policyRoutes.find((route) => route.fixUnitId === fixUnitId);
  const policyDecision = policyRoute?.decision || lookupPolicyDecision(unit);
  if (!policyRoute?.proposalAllowed) {
    throw new ProposalOrchestratorError('POLICY_BLOCKED', 'Policy blocks proposal generation for this unit.');
  }

  const cisConfig = resolveTrustedCisConfig(env);
  if (!transport) {
    if (!cisConfig.ok) {
      return { ok: false, reason: cisConfig.reason, message: cisConfig.message };
    }
    throw new ProposalOrchestratorError('TRANSPORT_REQUIRED', 'Trusted transport is required.');
  }

  const bindings = buildContextBindings(unit);
  const broker = createContextBroker({ localRoot, bindings });
  const initialBlockIds = bindings.map((binding) => binding.blockId);

  const startedAt = Date.now();
  let sessionCalls = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;
  const callLatencies = [];

  const wrappedTransport = {
    async chatCompletion(params) {
      sessionCalls += 1;
      const result = await transport.chatCompletion(params);
      if (Number.isFinite(result.elapsedMs)) callLatencies.push(result.elapsedMs);
      if (result.usage) {
        if (Number.isFinite(result.usage.prompt_tokens)) promptTokens += result.usage.prompt_tokens;
        if (Number.isFinite(result.usage.completion_tokens)) completionTokens += result.usage.completion_tokens;
        if (Number.isFinite(result.usage.total_tokens)) totalTokens += result.usage.total_tokens;
      }
      return result;
    },
  };

  let advisory;
  try {
    advisory = await runCisAdvisory({
      fixUnit: unit,
      policyDecision,
      broker,
      transport: wrappedTransport,
      model: model || cisConfig.model,
      initialBlockIds,
      signal,
    });
  } catch (error) {
    const telemetry = sanitizeCisTelemetryRecord({
      fixUnitId,
      sessionCalls,
      outcome: 'failed',
      reasonCode: error.code || 'ADVISORY_FAILED',
      latencyMs: { total: Date.now() - startedAt, calls: callLatencies },
      tokens: { prompt: promptTokens || null, completion: completionTokens || null, total: totalTokens || null },
    });
    appendCisTelemetryRecord(reviewState.sessionDir, telemetry);
    reviewState.recordAuditEvent({
      type: 'proposal_failed',
      fixUnitId,
      reasonCode: error.code || 'ADVISORY_FAILED',
    });
    throw error;
  }

  const telemetry = sanitizeCisTelemetryRecord({
    fixUnitId,
    sessionCalls,
    outcome: advisory.kind === 'propose_patch' ? 'proposed' : 'cannot_fix',
    reasonCode: advisory.reasonCode || null,
    promptVersion: advisory.promptVersion || '',
    modelId: advisory.modelId || model || cisConfig.model || '',
    latencyMs: { total: Date.now() - startedAt, calls: callLatencies },
    tokens: {
      prompt: promptTokens || null,
      completion: completionTokens || null,
      total: totalTokens || null,
    },
  });
  appendCisTelemetryRecord(reviewState.sessionDir, telemetry);

  if (advisory.kind !== 'propose_patch') {
    reviewState.recordAuditEvent({
      type: 'proposal_cannot_fix',
      fixUnitId,
      reasonCode: advisory.reasonCode,
    });
    return { ok: false, reason: advisory.reasonCode, advisory, telemetry };
  }

  const editIntents = mapEditsFromCis(advisory.edits, bindings, broker, localRoot);
  const candidate = attachDiffToCandidate(validateAndBuildCandidate({
    localRoot,
    reportId,
    policyVersion: policyDecision.policyVersion || '1',
    promptVersion: advisory.promptVersion || '',
    modelId: advisory.modelId || model || '',
    edits: editIntents,
  }));

  const registered = reviewState.registerCandidate(fixUnitId, {
    candidateHash: candidate.candidateHash,
    diffHash: candidate.diffHash,
    diff: candidate.diff,
    verified: false,
    conflictFree: true,
    editIntents: candidate.edits,
    policyVersion: candidate.policyVersion,
    promptVersion: candidate.promptVersion,
    modelId: candidate.modelId,
    rationale: advisory.rationale,
    manualChecks: advisory.manualChecks,
    cisTelemetry: telemetry,
    verification: { status: 'pending' },
  }, { replace: Boolean(reviewState.getCandidate?.(fixUnitId)?.candidateHash) });

  reviewState.recordAuditEvent({
    type: 'proposal_registered',
    fixUnitId,
    candidateHash: registered.candidateHash,
  });

  return {
    ok: true,
    candidate: registered,
    rationale: advisory.rationale,
    manualChecks: advisory.manualChecks,
    telemetry,
  };
}

export { resolveTrustedCisConfig };
