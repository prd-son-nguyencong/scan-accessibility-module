import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSourcePreimage, buildSourcePreimageRange } from '../../src/tracer/preimage.js';
import { createReviewState } from '../../src/fix/review/state.js';
import { runTrustedProposal } from '../../src/fix/proposal/orchestrator.js';
import { runCisAdvisory } from '../../src/fix/cis/advisory.js';
import { createContextBroker, hashBlockText } from '../../src/fix/context/broker.js';
import { lookupPolicyDecision } from '../../src/fix/policy/registry.js';
import { trustedCisTestEnv } from './helpers/cis-ca-fixture.js';

const REPORT_ID = 'sha256:proposal-test';
const FINDING_ID = `sha256:${createHash('sha256').update('f1').digest('hex')}`;
const BUDGET_FINDING_ID = `sha256:${createHash('sha256').update('budget-f1').digest('hex')}`;

function blockIdForUnit(fixUnitId) {
  return `ctx_${createHash('sha256').update(fixUnitId).digest('hex').slice(0, 16)}`;
}

function bootstrap(root) {
  mkdirSync(join(root, 'src'), { recursive: true });
  const content = '<button id="apply">Apply</button>\n';
  writeFileSync(join(root, 'src/a.liquid'), content);
  const preimage = buildSourcePreimage(content, 1);
  const sessionDir = join(root, 'scan-reports', 'fix-sessions', 'proposal');
  mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  const source = {
    file: 'src/a.liquid',
    line: 1,
    preimageSha256: preimage.preimageSha256,
    confidence: 'high',
    method: 'attested',
  };
  const fixUnits = [{
    fixUnitId: 'unit-proposal',
    kind: 'accessibility',
    title: 'Apply button',
    canonicalRuleId: 'button-name',
    pageState: 'initial',
    findingIds: [FINDING_ID],
    status: 'ready',
    sourceOwner: source,
    evidence: [],
    affectedRoutes: ['/'],
    findings: [{ findingId: FINDING_ID, source, pageState: 'initial', canonicalRuleId: 'button-name', impact: 'critical' }],
  }];
  const reviewState = createReviewState({
    sessionDir,
    reportId: REPORT_ID,
    sessionId: 'proposal',
    fixUnits,
    traceResults: [],
    policyRoutes: [{ fixUnitId: 'unit-proposal', proposalAllowed: true, decision: lookupPolicyDecision(fixUnits[0]) }],
    localRoot: root,
  });
  return { reviewState };
}

test('runTrustedProposal registers unverified candidate with diff rationale and manual checks', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-proposal-'));
  try {
    const { reviewState } = bootstrap(root);
    const bindingsBlockId = blockIdForUnit('unit-proposal');
    const line = readFileSync(join(root, 'src/a.liquid'), 'utf8').split('\n')[0];
    const blockHash = hashBlockText(line);
    const transport = {
      async chatCompletion() {
        return {
          content: JSON.stringify({
            action: 'propose_patch',
            edits: [{
              blockId: bindingsBlockId,
              expectedSha256: blockHash,
              oldText: '<button id="apply">Apply</button>',
              newText: '<button id="apply" aria-label="Apply">Apply</button>',
            }],
            resolvesFindingIds: [FINDING_ID],
            rationale: 'Add aria-label.',
            manualChecks: ['Confirm announcement reads Apply.'],
          }),
        };
      },
    };

    const result = await runTrustedProposal({
      reviewState,
      fixUnitId: 'unit-proposal',
      localRoot: root,
      reportId: REPORT_ID,
      transport,
      model: 'test-model',
      env: trustedCisTestEnv(),
    });

    assert.equal(result.ok, true, JSON.stringify(result));
    const candidate = reviewState.getCandidate('unit-proposal');
    assert.match(candidate.candidateHash, /^sha256:/);
    assert.equal(candidate.verified, false);
    assert.equal(candidate.rationale, 'Add aria-label.');
    assert.deepEqual(candidate.manualChecks, ['Confirm announcement reads Apply.']);
    assert.equal(candidate.cisTelemetry.sessionCalls, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runCisAdvisory stub stays within two-call budget', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-proposal-budget-'));
  try {
    mkdirSync(join(root, 'src'), { recursive: true });
    const content = '<button>Save</button>\n';
    writeFileSync(join(root, 'src/a.liquid'), content);
    const broker = createContextBroker({
      localRoot: root,
      bindings: [{ blockId: 'ctx_block_1', file: 'src/a.liquid', startLine: 1, endLine: 1 }],
    });
    let calls = 0;
    const transport = {
      async chatCompletion() {
        calls += 1;
        if (calls === 1) {
          return { content: JSON.stringify({ action: 'request_context', blockIds: ['ctx_block_1'], reason: 'need block' }) };
        }
        return {
          content: JSON.stringify({
            action: 'propose_patch',
            edits: [{
              blockId: 'ctx_block_1',
              expectedSha256: broker.getKnownBlockHashes().ctx_block_1,
              oldText: '<button>Save</button>',
              newText: '<button aria-label="Save">Save</button>',
            }],
            resolvesFindingIds: [BUDGET_FINDING_ID],
            rationale: 'label',
            manualChecks: ['Confirm Save announcement'],
          }),
        };
      },
    };
    const unit = {
      fixUnitId: 'u1',
      findingIds: [BUDGET_FINDING_ID],
      canonicalRuleId: 'button-name',
    };
    const result = await runCisAdvisory({
      fixUnit: unit,
      policyDecision: lookupPolicyDecision(unit),
      broker,
      transport,
      model: 'test-model',
      initialBlockIds: [],
    });
    assert.equal(result.kind, 'propose_patch');
    assert.equal(calls, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runTrustedProposal supports multiline verified source preimage range', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-proposal-multiline-'));
  try {
    mkdirSync(join(root, 'src'), { recursive: true });
    const content = [
      '<div class="form-row">',
      '  <button id="apply">Apply</button>',
      '</div>',
      '',
    ].join('\n');
    writeFileSync(join(root, 'src/a.liquid'), content);
    const preimage = buildSourcePreimageRange(content, 1, 3);
    const sessionDir = join(root, 'scan-reports', 'fix-sessions', 'proposal-multiline');
    mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
    const source = {
      file: 'src/a.liquid',
      line: 2,
      preimageSha256: preimage.preimageSha256,
      preimageRange: preimage.range,
      confidence: 'high',
      method: 'attested',
    };
    const fixUnits = [{
      fixUnitId: 'unit-multiline',
      kind: 'accessibility',
      title: 'Apply button block',
      canonicalRuleId: 'button-name',
      pageState: 'initial',
      findingIds: [FINDING_ID],
      status: 'ready',
      sourceOwner: source,
      evidence: [],
      affectedRoutes: ['/'],
      findings: [{ findingId: FINDING_ID, source, pageState: 'initial', canonicalRuleId: 'button-name', impact: 'critical' }],
    }];
    const reviewState = createReviewState({
      sessionDir,
      reportId: REPORT_ID,
      sessionId: 'proposal-multiline',
      fixUnits,
      traceResults: [],
      policyRoutes: [{ fixUnitId: 'unit-multiline', proposalAllowed: true, decision: lookupPolicyDecision(fixUnits[0]) }],
      localRoot: root,
    });

    const bindingsBlockId = blockIdForUnit('unit-multiline');
    const blockText = content.split('\n').slice(0, 3).join('\n');
    const blockHash = hashBlockText(blockText);
    const transport = {
      async chatCompletion() {
        return {
          content: JSON.stringify({
            action: 'propose_patch',
            edits: [{
              blockId: bindingsBlockId,
              expectedSha256: blockHash,
              oldText: blockText,
              newText: [
                '<div class="form-row">',
                '  <button id="apply" aria-label="Apply">Apply</button>',
                '</div>',
              ].join('\n'),
            }],
            resolvesFindingIds: [FINDING_ID],
            rationale: 'Add aria-label within multiline block.',
            manualChecks: ['Confirm announcement reads Apply.'],
          }),
        };
      },
    };

    const result = await runTrustedProposal({
      reviewState,
      fixUnitId: 'unit-multiline',
      localRoot: root,
      reportId: REPORT_ID,
      transport,
      model: 'test-model',
      env: trustedCisTestEnv(),
    });

    assert.equal(result.ok, true, JSON.stringify(result));
    const candidate = reviewState.getCandidate('unit-multiline');
    assert.match(candidate.candidateHash, /^sha256:/);
    assert.equal(candidate.editIntents[0].blockRange.startLine, 1);
    assert.equal(candidate.editIntents[0].blockRange.endLine, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
