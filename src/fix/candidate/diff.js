import { canonicalSha256 } from '../../reporter/fingerprint.js';
import {
  applyEditsToBytes,
  splitLinesWithByteRanges,
} from './bytes.js';
import { resolveSecureSourceFile } from './path.js';
import { CANDIDATE_LIMITS, CandidateIntentError, hashFileBytes, touchedFilesForCandidate } from './intent.js';

function hunkStartLine(index, count) {
  if (count === 0) return index;
  return index + 1;
}

function unifiedDiffLines(file, oldLines, newLines) {
  const output = [`--- a/${file}`, `+++ b/${file}`];
  let oldIndex = 0;
  let newIndex = 0;
  while (oldIndex < oldLines.length || newIndex < newLines.length) {
    const oldLine = oldLines[oldIndex];
    const newLine = newLines[newIndex];
    if (oldLine === newLine) {
      oldIndex += 1;
      newIndex += 1;
      continue;
    }
    let oldEnd = oldIndex;
    let newEnd = newIndex;
    while (oldEnd < oldLines.length && newEnd < newLines.length && oldLines[oldEnd] !== newLines[newEnd]) {
      if (oldLines[oldEnd] === newLines[newEnd + 1]) {
        newEnd += 1;
      } else if (oldLines[oldEnd + 1] === newLines[newEnd]) {
        oldEnd += 1;
      } else {
        oldEnd += 1;
        newEnd += 1;
      }
    }
    if (oldEnd >= oldLines.length && newEnd < newLines.length) {
      newEnd = newLines.length;
    } else if (newEnd >= newLines.length && oldEnd < oldLines.length) {
      oldEnd = oldLines.length;
    }
    const oldCount = oldEnd - oldIndex;
    const newCount = newEnd - newIndex;
    if (oldCount === 0 && newCount === 0) {
      throw new CandidateIntentError('DIFF_GENERATION_FAILED', 'Unified diff generation made no progress.');
    }
    output.push(`@@ -${hunkStartLine(oldIndex, oldCount)},${oldCount} +${hunkStartLine(newIndex, newCount)},${newCount} @@`);
    for (let i = oldIndex; i < oldEnd; i += 1) output.push(`-${oldLines[i]}`);
    for (let i = newIndex; i < newEnd; i += 1) output.push(`+${newLines[i]}`);
    oldIndex = oldEnd;
    newIndex = newEnd;
  }
  return output;
}

function lineTextsFromBytes(bytes) {
  return splitLinesWithByteRanges(bytes).map((line) => line.text);
}

export function buildCanonicalUnifiedDiff(candidate) {
  const files = touchedFilesForCandidate(candidate);
  const sections = [];
  for (const file of files) {
    const { bytes } = resolveSecureSourceFile(candidate.localRoot, file, { maxBytes: CANDIDATE_LIMITS.maxFileBytes });
    const fileEdits = candidate.edits.filter((edit) => edit.file === file);
    for (const edit of fileEdits) {
      if (edit.expectedFileSha256 && hashFileBytes(bytes) !== edit.expectedFileSha256) {
        throw new CandidateIntentError('STALE_PREIMAGE', 'File hash mismatch while building diff.');
      }
    }
    const updated = applyEditsToBytes(bytes, fileEdits);
    sections.push(...unifiedDiffLines(file, lineTextsFromBytes(bytes), lineTextsFromBytes(updated)));
  }
  return `${sections.join('\n')}\n`;
}

export function computeDiffHash(candidateHash, diff) {
  return canonicalSha256({ candidateHash, diff });
}

export function attachDiffToCandidate(candidate) {
  const diff = buildCanonicalUnifiedDiff(candidate);
  const diffHash = computeDiffHash(candidate.candidateHash, diff);
  return Object.freeze({
    ...candidate,
    diff,
    diffHash,
  });
}

export function readSecureCandidateFile(localRoot, file) {
  return resolveSecureSourceFile(localRoot, file, { maxBytes: CANDIDATE_LIMITS.maxFileBytes });
}
