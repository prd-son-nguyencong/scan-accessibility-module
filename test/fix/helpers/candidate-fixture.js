import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildSourcePreimage } from '../../../src/tracer/preimage.js';
import { hashFileContent, validateAndBuildCandidate } from '../../../src/fix/candidate/intent.js';
import { attachDiffToCandidate } from '../../../src/fix/candidate/diff.js';
import { persistVerificationArtifact } from '../../../src/fix/verify/artifact.js';

export function writeFixtureSource(root, relPath = 'src/partials/jobs/sort.liquid', content = '<select id="sort-select"></select>\n') {
  const full = join(root, relPath);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content, 'utf8');
  return { relPath, content };
}

export function buildFixtureEditIntents(root, {
  relPath = 'src/partials/jobs/sort.liquid',
  line = 1,
  oldText = '<select id="sort-select">',
  newText = '<select id="sort-select" aria-label="Sort">',
  content = '<select id="sort-select"></select>\n',
} = {}) {
  writeFixtureSource(root, relPath, content);
  const preimage = buildSourcePreimage(content, line);
  return [{
    file: relPath,
    blockRange: { startLine: line, endLine: line },
    expectedBlockSha256: preimage.preimageSha256,
    expectedFileSha256: hashFileContent(content),
    oldText,
    newText,
  }];
}

export function buildValidatedCandidate(root, {
  reportId = 'sha256:fixture-report',
  policyVersion = '1',
  editIntents = null,
  ...editOptions
} = {}) {
  const intents = editIntents || buildFixtureEditIntents(root, editOptions);
  const candidate = attachDiffToCandidate(validateAndBuildCandidate({
    localRoot: root,
    reportId,
    policyVersion,
    edits: intents,
  }));
  return {
    candidateHash: candidate.candidateHash,
    diffHash: candidate.diffHash,
    diff: candidate.diff,
    editIntents: candidate.edits,
    policyVersion: candidate.policyVersion,
    promptVersion: candidate.promptVersion,
    modelId: candidate.modelId,
    verified: false,
    conflictFree: true,
    verification: { status: 'pending' },
  };
}

export function persistPassedVerificationArtifact(sessionDir, { candidateHash, diffHash }) {
  return persistVerificationArtifact(sessionDir, {
    status: 'passed',
    candidateHash,
    diffHash,
    targetFindingIds: [],
    removedTargets: [],
    newCriticalSerious: [],
    build: { exitCode: 0 },
    sourceTraceResolved: true,
    manualChecks: [],
    manualChecksAcknowledged: true,
    environment: {
      shadow: true,
      localLighthouse: false,
      psiParity: false,
      provenance: 'local-shadow',
    },
  }).artifactId;
}

export function buildVerifiedCandidateRecord(root, sessionDir, options = {}) {
  const base = buildValidatedCandidate(root, options);
  const artifactId = persistPassedVerificationArtifact(sessionDir, {
    candidateHash: base.candidateHash,
    diffHash: base.diffHash,
  });
  return {
    ...base,
    verified: true,
    verification: { status: 'passed', artifactId },
  };
}

export function attachFixtureCandidate(unit, candidateRecord) {
  unit.candidate = candidateRecord;
  unit.candidateHash = candidateRecord.candidateHash;
  return unit;
}

export function withFixtureCandidates(fixUnits, candidateRecord) {
  return fixUnits.map((unit) => {
    const next = structuredClone(unit);
    if (unit.status === 'ready' && unit.kind === 'accessibility') {
      attachFixtureCandidate(next, structuredClone(candidateRecord));
    }
    return next;
  });
}
