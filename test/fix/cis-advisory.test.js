import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createContextBroker, hashBlockText } from '../../src/fix/context/broker.js';
import { parseCisActionFromModelOutput } from '../../src/fix/cis/parser.js';
import { runCisAdvisory, buildInitialUserPrompt, evaluateAdvisoryBudgets } from '../../src/fix/cis/advisory.js';
import { CIS_POC_LIMITS } from '../../src/fix/cis/limits.js';
import { POLICIES } from '../../src/fix/policy/registry.js';

const FIXTURE = JSON.parse(
  readFileSync(new URL('../fixtures/fix/prompt-injection.json', import.meta.url), 'utf8'),
);
const CANONICAL = JSON.parse(
  readFileSync(new URL('../fixtures/fix/canonical-unit-paths.json', import.meta.url), 'utf8'),
);
const SECRET = FIXTURE.secretMarker;

function makeBroker(extraBindings = []) {
  const root = mkdtempSync(path.join(tmpdir(), 'ada-advisory-'));
  writeFileSync(path.join(root, 'sample.liquid'), FIXTURE.sourceBlockText, 'utf8');
  return createContextBroker({
    localRoot: root,
    bindings: [
      { blockId: FIXTURE.blockId, file: 'sample.liquid' },
      ...extraBindings.map((binding) => ({ ...binding, file: binding.file || 'sample.liquid' })),
    ],
  });
}

function baseFixUnit() {
  return {
    fixUnitId: 'sha256:unit',
    kind: 'accessibility',
    canonicalRuleId: 'select-name',
    title: 'Sort select has no accessible name',
    findingIds: [FIXTURE.findingId],
    evidence: [{ layer: 'axe', nativeRuleId: 'select-name' }],
  };
}

test('only semantic_assistance policy is allowed before transport', async () => {
  const broker = makeBroker();
  const transport = {
    chatCompletion: async () => {
      throw new Error('transport should not be called');
    },
  };
  for (const policy of [
    POLICIES.MANUAL_ONLY,
    POLICIES.UNSUPPORTED,
    POLICIES.MECHANICALLY_SAFE,
    undefined,
    'unknown',
  ]) {
    await assert.rejects(
      () => runCisAdvisory({
        fixUnit: baseFixUnit(),
        policyDecision: { policy },
        broker,
        transport,
        model: 'test-model',
      }),
      (error) => error.code === 'ADVISORY_POLICY_BLOCKED',
    );
  }
});

test('initial prompt includes availableBlockIds and excludes path-bearing canonical fields', async () => {
  const broker = makeBroker([{ blockId: 'ctx_extra', file: 'sample.liquid' }]);
  /** @type {Array<{ role: string, content: string }> | null} */
  let capturedMessages = null;
  const transport = {
    chatCompletion: async ({ messages }) => {
      capturedMessages = messages;
      return {
        content: JSON.stringify({
          action: 'cannot_fix',
          reasonCode: 'STOP',
          explanation: 'done',
        }),
      };
    },
  };

  await runCisAdvisory({
    fixUnit: CANONICAL.fixUnit,
    policyDecision: { policy: POLICIES.SEMANTIC_ASSISTANCE },
    broker,
    transport,
    model: 'test-model',
  });

  assert.ok(capturedMessages);
  const userPrompt = JSON.parse(String(capturedMessages.find((entry) => entry.role === 'user')?.content));
  assert.deepEqual(userPrompt.availableBlockIds.sort(), [FIXTURE.blockId, 'ctx_extra'].sort());
  const serialized = JSON.stringify(capturedMessages);
  for (const forbidden of CANONICAL.forbiddenInPrompt) {
    assert.equal(serialized.includes(forbidden), false, `prompt leaked ${forbidden}`);
  }
  assert.equal(userPrompt.fixUnit.title, undefined);
});

test('buildInitialUserPrompt never includes path-bearing title', () => {
  const prompt = buildInitialUserPrompt(CANONICAL.fixUnit, ['ctx_1'], []);
  assert.equal(prompt.includes('src/partials/jobs/sort.liquid'), false);
  assert.equal(JSON.parse(prompt).fixUnit.title, undefined);
});

test('advisory loop handles request_context then propose_patch within budgets', async () => {
  const broker = makeBroker();
  const blockHash = hashBlockText(FIXTURE.sourceBlockText);
  let call = 0;
  const transport = {
    chatCompletion: async () => {
      call += 1;
      if (call === 1) {
        return {
          content: JSON.stringify({
            action: 'request_context',
            blockIds: [FIXTURE.blockId],
            reason: 'Need full block',
          }),
        };
      }
      return {
        content: JSON.stringify({
          action: 'propose_patch',
          edits: [{
            blockId: FIXTURE.blockId,
            expectedSha256: blockHash,
            oldText: FIXTURE.oldText,
            newText: FIXTURE.newText,
          }],
          resolvesFindingIds: [FIXTURE.findingId],
          rationale: 'Adds aria-label',
          manualChecks: ['Confirm announcement'],
        }),
      };
    },
  };

  const result = await runCisAdvisory({
    fixUnit: baseFixUnit(),
    policyDecision: { policy: POLICIES.SEMANTIC_ASSISTANCE },
    broker,
    transport,
    model: 'test-model',
  });

  assert.equal(result.kind, 'propose_patch');
  assert.equal(result.edits[0].blockId, FIXTURE.blockId);
  assert.equal(call, 2);
});

test('repeated request_context for already supplied blocks returns cannot_fix without extra calls', async () => {
  const broker = makeBroker();
  let call = 0;
  const transport = {
    chatCompletion: async () => {
      call += 1;
      return {
        content: JSON.stringify({
          action: 'request_context',
          blockIds: [FIXTURE.blockId],
          reason: 'Need again',
        }),
      };
    },
  };

  const result = await runCisAdvisory({
    fixUnit: baseFixUnit(),
    policyDecision: { policy: POLICIES.SEMANTIC_ASSISTANCE },
    broker,
    transport,
    model: 'test-model',
    initialBlockIds: [FIXTURE.blockId],
  });

  assert.equal(result.kind, 'cannot_fix');
  assert.equal(result.reasonCode, 'CONTEXT_ALREADY_SUPPLIED');
  assert.equal(call, 1);
});

test('empty manualChecks on propose_patch returns MANUAL_CHECKS_REQUIRED', async () => {
  const broker = makeBroker();
  const blockHash = hashBlockText(FIXTURE.sourceBlockText);
  const transport = {
    chatCompletion: async () => ({
      content: JSON.stringify({
        action: 'propose_patch',
        edits: [{
          blockId: FIXTURE.blockId,
          expectedSha256: blockHash,
          oldText: FIXTURE.oldText,
          newText: FIXTURE.newText,
        }],
        resolvesFindingIds: [FIXTURE.findingId],
        rationale: 'Adds aria-label',
        manualChecks: [],
      }),
    }),
  };

  const result = await runCisAdvisory({
    fixUnit: baseFixUnit(),
    policyDecision: { policy: POLICIES.SEMANTIC_ASSISTANCE },
    broker,
    transport,
    model: 'test-model',
    initialBlockIds: [FIXTURE.blockId],
  });

  assert.equal(result.kind, 'cannot_fix');
  assert.equal(result.reasonCode, 'MANUAL_CHECKS_REQUIRED');
});

test('initial prompt budget overflow returns INPUT_BUDGET_EXHAUSTED', async () => {
  const broker = makeBroker();
  const transport = {
    chatCompletion: async () => ({ content: '{}' }),
  };
  const hugeEvidence = Array.from({ length: 5000 }, (_, index) => ({
    layer: 'axe',
    nativeRuleId: `rule-${index}`,
    message: 'x'.repeat(200),
  }));

  const result = await runCisAdvisory({
    fixUnit: {
      ...baseFixUnit(),
      evidence: hugeEvidence,
    },
    policyDecision: { policy: POLICIES.SEMANTIC_ASSISTANCE },
    broker,
    transport,
    model: 'test-model',
  });

  assert.equal(result.kind, 'cannot_fix');
  assert.equal(result.reasonCode, 'INPUT_BUDGET_EXHAUSTED');
});

test('repair prompt budget overflow returns INPUT_BUDGET_EXHAUSTED', async () => {
  const broker = makeBroker();
  let call = 0;
  const transport = {
    chatCompletion: async () => {
      call += 1;
      return { content: 'not-json' };
    },
  };
  const nearLimitMessage = 'z'.repeat(31620);

  const result = await runCisAdvisory({
    fixUnit: {
      ...baseFixUnit(),
      evidence: [{ layer: 'axe', nativeRuleId: 'select-name', message: nearLimitMessage }],
    },
    policyDecision: { policy: POLICIES.SEMANTIC_ASSISTANCE },
    broker,
    transport,
    model: 'test-model',
  });

  assert.equal(result.kind, 'cannot_fix');
  assert.equal(result.reasonCode, 'INPUT_BUDGET_EXHAUSTED');
  assert.equal(call, 1);
});

test('supplement prompt budget overflow returns INPUT_BUDGET_EXHAUSTED', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ada-advisory-supplement-'));
  const huge = 'b'.repeat(CIS_POC_LIMITS.maxInputTokens * 4);
  writeFileSync(path.join(root, 'huge.liquid'), huge, 'utf8');
  const broker = createContextBroker({
    localRoot: root,
    bindings: [{ blockId: 'ctx_huge', file: 'huge.liquid' }],
  });
  let call = 0;
  const transport = {
    chatCompletion: async () => {
      call += 1;
      return {
        content: JSON.stringify({
          action: 'request_context',
          blockIds: ['ctx_huge'],
          reason: 'Need block',
        }),
      };
    },
  };

  const result = await runCisAdvisory({
    fixUnit: baseFixUnit(),
    policyDecision: { policy: POLICIES.SEMANTIC_ASSISTANCE },
    broker,
    transport,
    model: 'test-model',
  });

  assert.equal(result.kind, 'cannot_fix');
  assert.equal(result.reasonCode, 'INPUT_BUDGET_EXHAUSTED');
  assert.equal(call, 1);
});

test('exhaustion yields local cannot_fix without raw text fallback', async () => {
  const broker = makeBroker();
  let call = 0;
  const transport = {
    chatCompletion: async () => {
      call += 1;
      return { content: 'not-json-at-all' };
    },
  };

  const result = await runCisAdvisory({
    fixUnit: baseFixUnit(),
    policyDecision: { policy: POLICIES.SEMANTIC_ASSISTANCE },
    broker,
    transport,
    model: 'test-model',
  });

  assert.equal(result.kind, 'cannot_fix');
  assert.equal(result.action, 'cannot_fix');
  assert.ok(result.reasonCode);
  assert.ok(result.explanation);
  assert.equal(call, 2);
});

test('prompt-injection fixture cannot drive arbitrary reads or exfiltration actions', async () => {
  const broker = makeBroker();
  const transport = {
    chatCompletion: async () => ({
      content: FIXTURE.maliciousModelOutput,
    }),
  };

  const result = await runCisAdvisory({
    fixUnit: baseFixUnit(),
    policyDecision: { policy: POLICIES.SEMANTIC_ASSISTANCE },
    broker,
    transport,
    model: 'test-model',
    initialBlockIds: [FIXTURE.blockId],
  });

  assert.equal(result.kind, 'cannot_fix');
  assert.throws(
    () => parseCisActionFromModelOutput(FIXTURE.maliciousModelOutput, {
      requestableBlockIds: new Set([FIXTURE.blockId]),
      suppliedBlockIds: new Set([FIXTURE.blockId]),
      suppliedBlockHashes: { [FIXTURE.blockId]: hashBlockText(FIXTURE.sourceBlockText) },
      suppliedBlockTexts: { [FIXTURE.blockId]: FIXTURE.sourceBlockText },
      allowedFindingIds: new Set([FIXTURE.findingId]),
    }),
  );
  assert.throws(
    () => broker.readByRequestedPath('../.env'),
    (error) => error.code === 'CONTEXT_PATH_DENIED',
  );
});

test('advisory output and errors do not contain fixture secret marker', async () => {
  const broker = makeBroker();
  const transport = {
    chatCompletion: async () => ({
      content: FIXTURE.maliciousModelOutput,
    }),
  };
  const result = await runCisAdvisory({
    fixUnit: baseFixUnit(),
    policyDecision: { policy: POLICIES.SEMANTIC_ASSISTANCE },
    broker,
    transport,
    model: 'test-model',
    initialBlockIds: [FIXTURE.blockId],
  });
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(SECRET), false);
});

test('cancellation before loop starts throws ADVISORY_CANCELLED', async () => {
  const broker = makeBroker();
  const controller = new AbortController();
  controller.abort();
  const transport = {
    chatCompletion: async () => ({ content: '{}' }),
  };
  await assert.rejects(
    () => runCisAdvisory({
      fixUnit: baseFixUnit(),
      policyDecision: { policy: POLICIES.SEMANTIC_ASSISTANCE },
      broker,
      transport,
      model: 'test-model',
      signal: controller.signal,
    }),
    (error) => error.code === 'ADVISORY_CANCELLED',
  );
});

test('in-flight external cancellation propagates as ADVISORY_CANCELLED', async () => {
  const broker = makeBroker();
  const controller = new AbortController();
  const { createCisTransport } = await import('../../src/fix/cis/transport.js');
  const transport = createCisTransport({
    baseUrl: 'http://127.0.0.1:9/ml/inference/cis/',
    featureKey: 'test-key',
    allowedHosts: ['127.0.0.1'],
    allowInsecureLoopback: true,
    fetch: async (_url, init) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    }),
  });

  const pending = runCisAdvisory({
    fixUnit: baseFixUnit(),
    policyDecision: { policy: POLICIES.SEMANTIC_ASSISTANCE },
    broker,
    transport,
    model: 'test-model',
    signal: controller.signal,
  });

  controller.abort();
  await assert.rejects(
    pending,
    (error) => error.code === 'ADVISORY_CANCELLED',
  );
});

test('wall-clock budget exhaustion returns SESSION_WALL_CLOCK_EXHAUSTED cannot_fix', async () => {
  const broker = makeBroker();
  let transportCalls = 0;
  let nowCalls = 0;
  const startedAt = 1_000;
  const now = () => {
    nowCalls += 1;
    if (nowCalls === 1) return startedAt;
    return startedAt + CIS_POC_LIMITS.sessionWallClockBudgetMs + 1;
  };
  const transport = {
    chatCompletion: async () => {
      transportCalls += 1;
      return {
        content: JSON.stringify({
          action: 'cannot_fix',
          reasonCode: 'STOP',
          explanation: 'Should not reach transport after wall-clock exhaustion.',
        }),
      };
    },
  };

  const result = await runCisAdvisory({
    fixUnit: baseFixUnit(),
    policyDecision: { policy: POLICIES.SEMANTIC_ASSISTANCE },
    broker,
    transport,
    model: 'test-model',
    now,
  });

  assert.equal(result.kind, 'cannot_fix');
  assert.equal(result.action, 'cannot_fix');
  assert.equal(result.reasonCode, 'SESSION_WALL_CLOCK_EXHAUSTED');
  assert.equal(transportCalls, 0);
});

test('session call budget exhaustion returns SESSION_CALL_BUDGET_EXHAUSTED cannot_fix', () => {
  const result = evaluateAdvisoryBudgets({
    startedAt: 1_000,
    now: () => 1_000,
    sessionCalls: CIS_POC_LIMITS.sessionCallBudget,
  });

  assert.equal(result?.kind, 'cannot_fix');
  assert.equal(result?.action, 'cannot_fix');
  assert.equal(result?.reasonCode, 'SESSION_CALL_BUDGET_EXHAUSTED');
});

test('evaluateAdvisoryBudgets still throws ADVISORY_CANCELLED for external abort', () => {
  const controller = new AbortController();
  controller.abort();
  assert.throws(
    () => evaluateAdvisoryBudgets({
      signal: controller.signal,
      startedAt: 1_000,
      now: () => 1_000,
      sessionCalls: 0,
    }),
    (error) => error.code === 'ADVISORY_CANCELLED',
  );
});

test('mutated source between supply and propose_patch returns validated cannot_fix', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ada-stale-propose-'));
  const samplePath = path.join(root, 'sample.liquid');
  writeFileSync(samplePath, FIXTURE.sourceBlockText, 'utf8');
  const broker = createContextBroker({
    localRoot: root,
    bindings: [{ blockId: FIXTURE.blockId, file: 'sample.liquid' }],
  });
  const blockHash = hashBlockText(FIXTURE.sourceBlockText);
  let transportCalls = 0;
  const transport = {
    chatCompletion: async () => {
      transportCalls += 1;
      writeFileSync(samplePath, '<select id="mutated">changed</select>\n', 'utf8');
      return {
        content: JSON.stringify({
          action: 'propose_patch',
          edits: [{
            blockId: FIXTURE.blockId,
            expectedSha256: blockHash,
            oldText: FIXTURE.oldText,
            newText: FIXTURE.newText,
          }],
          resolvesFindingIds: [FIXTURE.findingId],
          rationale: 'Adds aria-label',
          manualChecks: ['Confirm announcement'],
        }),
      };
    },
  };

  const result = await runCisAdvisory({
    fixUnit: baseFixUnit(),
    policyDecision: { policy: POLICIES.SEMANTIC_ASSISTANCE },
    broker,
    transport,
    model: 'test-model',
    initialBlockIds: [FIXTURE.blockId],
  });

  assert.equal(result.kind, 'cannot_fix');
  assert.equal(result.action, 'cannot_fix');
  assert.match(result.reasonCode, /CONTEXT_/);
  assert.equal(transportCalls, 1);
});

test('role-aware prompt budget rejects before transport when content-only estimate would pass', async () => {
  const broker = makeBroker();
  let transportCalls = 0;
  const transport = {
    chatCompletion: async () => {
      transportCalls += 1;
      return { content: '{}' };
    },
  };
  const systemContent = 's'.repeat(700);
  const userContent = 'u'.repeat(32068);

  const result = await runCisAdvisory({
    fixUnit: {
      ...baseFixUnit(),
      evidence: [{ layer: 'axe', nativeRuleId: 'select-name', message: userContent }],
    },
    policyDecision: { policy: POLICIES.SEMANTIC_ASSISTANCE },
    broker,
    transport,
    model: 'test-model',
    initialBlockIds: [],
  });

  assert.equal(result.kind, 'cannot_fix');
  assert.equal(result.reasonCode, 'INPUT_BUDGET_EXHAUSTED');
  assert.equal(transportCalls, 0);
});

test('generation budget exhaustion end-to-end returns GENERATION_BUDGET_EXHAUSTED', async () => {
  const broker = makeBroker([{ blockId: 'ctx_extra', file: 'sample.liquid' }]);
  let transportCalls = 0;
  const transport = {
    chatCompletion: async () => {
      transportCalls += 1;
      return {
        content: JSON.stringify({
          action: 'request_context',
          blockIds: transportCalls === 1 ? [FIXTURE.blockId] : ['ctx_extra'],
          reason: 'Need more context',
        }),
      };
    },
  };

  const result = await runCisAdvisory({
    fixUnit: baseFixUnit(),
    policyDecision: { policy: POLICIES.SEMANTIC_ASSISTANCE },
    broker,
    transport,
    model: 'test-model',
  });

  assert.equal(result.kind, 'cannot_fix');
  assert.equal(result.reasonCode, 'GENERATION_BUDGET_EXHAUSTED');
  assert.equal(transportCalls, CIS_POC_LIMITS.maxGenerationAttempts);
});

test('context rounds end-to-end stop after immutable limits without further transport', async () => {
  const broker = makeBroker([{ blockId: 'ctx_extra', file: 'sample.liquid' }]);
  let transportCalls = 0;
  const transport = {
    chatCompletion: async () => {
      transportCalls += 1;
      if (transportCalls === 1) {
        return {
          content: JSON.stringify({
            action: 'request_context',
            blockIds: [FIXTURE.blockId],
            reason: 'Need first block',
          }),
        };
      }
      return {
        content: JSON.stringify({
          action: 'request_context',
          blockIds: ['ctx_extra'],
          reason: 'Need second block',
        }),
      };
    },
  };

  const result = await runCisAdvisory({
    fixUnit: baseFixUnit(),
    policyDecision: { policy: POLICIES.SEMANTIC_ASSISTANCE },
    broker,
    transport,
    model: 'test-model',
  });

  assert.equal(transportCalls, CIS_POC_LIMITS.maxGenerationAttempts);
  assert.equal(result.kind, 'cannot_fix');
  assert.match(result.reasonCode, /GENERATION_BUDGET_EXHAUSTED|CONTEXT_BUDGET_EXHAUSTED/);
});
