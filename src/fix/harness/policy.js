// Accept policy and review queue (docs/fix-harness.md section 5). decide() wraps gates.decideAcceptance with the run config;
// queueForReview() puts candidates that passed every gate but are not auto-acceptable into the existing review workbench state with
// their evidence (gate table, before/after screenshot paths, diff, scan delta, perf rows).
import { mkdirSync } from 'node:fs';
import { decideAcceptance } from './gates.js';
import { fileToEdits } from './change.js';
import { validateAndBuildCandidate } from '../candidate/intent.js';
import { attachDiffToCandidate } from '../candidate/diff.js';
import { persistVerificationArtifact } from '../verify/artifact.js';
import { createReviewState, persistReviewState } from '../review/state.js';

export const DEFAULT_POLICY = Object.freeze({ autoAccept: true, maxAutoLines: 10, maxAutoRisk: 0.3 });

/** Accept decision. policy.autoAccept = false sends every gate-clean candidate to review. */
export function decide({ gateResult, mechanicallySafe = false, changedLines = 0, files = [], iteration = 1, maxIterations = 3, policy = {} }) {
  const p = { ...DEFAULT_POLICY, ...policy };
  const d = decideAcceptance({ gateResult, mechanicallySafe, changedLines, files, iteration, maxIterations, maxAutoLines: p.maxAutoLines, maxAutoRisk: p.maxAutoRisk });
  if (d.decision === 'auto_accept' && !p.autoAccept) return { ...d, decision: 'human_review', reason: 'auto-accept disabled by policy; all gates passed' };
  return d;
}

const posix = (p) => p.split('\\').join('/');
const MAX_EV = 8;

/** Screenshot paths (relative to runDir) of every captured cell, before and after. */
export function screenshotPaths(snapshot, runDir) {
  const out = [];
  const rel = (dir) => posix(dir.startsWith(runDir) ? dir.slice(runDir.length).replace(/^[\\/]/, '') : dir);
  for (const [route, cells] of Object.entries(snapshot?.routes || {})) {
    for (const [vp, cell] of Object.entries(cells)) if (cell?.screenshot) out.push({ route, viewport: vp, path: `${rel(snapshot.screenshotDir)}/${cell.screenshot.file}` });
  }
  return out;
}

/** Compact evidence record for the workbench and the run report. Paths, counts and capped evidence only; no image bytes. */
export function buildEvidence({ gateResult, before, after, diff, scanDelta, risk, decision, runDir }) {
  return {
    decision, risk,
    gateTable: gateResult.table,
    failedGates: gateResult.failed,
    gateEvidence: gateResult.gates.filter((g) => !g.pass).map((g) => ({ gate: g.gate, evidence: g.evidence.slice(0, MAX_EV) })),
    perf: gateResult.gates.find((g) => g.gate === 'G7')?.perf?.map((r) => ({ route: r.route, metrics: r.metrics })) || null,
    screenshots: { before: screenshotPaths(before, runDir).slice(0, 16), after: screenshotPaths(after, runDir).slice(0, 16), root: 'run directory' },
    scanDelta: scanDelta || null,
    diff: String(diff || '').slice(0, 12000),
  };
}

/**
 * Registers queued candidates in a review session (sessionDir) so `ada-scan fix --ui` style review shows them with evidence.
 * items: [{ taskId, rule, file, line, routes, findingIds, files: [{ path, before, after }], rationale, evidence }] where `before` must equal the
 * project file now. Items that cannot be registered (file changed by an accepted task, unsupported edit) are returned with registered:false and a reason.
 */
export function queueForReview({ items, sessionDir, localRoot, reportId = 'sha256:harness-run', sessionId = 'harness' }) {
  if (!items.length) return { sessionDir, queued: [] };
  mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  const fixUnits = items.map((i) => ({
    fixUnitId: `harness-${i.taskId}`.slice(0, 120), kind: 'accessibility', title: `${i.rule} in ${i.file}`, canonicalRuleId: i.rule,
    findingIds: i.findingIds || [], status: 'ready', sourceOwner: { file: i.file, line: i.line ?? null }, evidence: [], affectedRoutes: i.routes || [], findings: [],
  }));
  const state = createReviewState({ sessionDir, reportId, sessionId, fixUnits, localRoot });
  const queued = items.map((item, n) => {
    const fixUnitId = fixUnits[n].fixUnitId;
    try {
      const edits = item.files.flatMap((f) => fileToEdits(f.path, f.before, f.after));
      const candidate = attachDiffToCandidate(validateAndBuildCandidate({ localRoot, reportId, policyVersion: '1', edits }));
      const { artifactId } = persistVerificationArtifact(sessionDir, {
        status: 'passed', candidateHash: candidate.candidateHash, diffHash: candidate.diffHash, targetFindingIds: item.findingIds || [], removedTargets: [],
        newCriticalSerious: [], build: { exitCode: 0 }, sourceTraceResolved: true, environment: { shadow: true, localLighthouse: false, psiParity: false, provenance: 'local-shadow' },
      });
      state.registerVerifiedCandidate(fixUnitId, {
        candidateHash: candidate.candidateHash, diffHash: candidate.diffHash, editIntents: candidate.edits, policyVersion: '1', rationale: item.rationale || null,
        verification: { status: 'passed', artifactId }, harness: item.evidence,
      });
      return { taskId: item.taskId, fixUnitId, registered: true };
    } catch (err) {
      return { taskId: item.taskId, fixUnitId, registered: false, reason: err.code || String(err.message).slice(0, 160) };
    }
  });
  persistReviewState(state);
  return { sessionDir, queued };
}
