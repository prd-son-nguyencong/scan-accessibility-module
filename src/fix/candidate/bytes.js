import { CandidateIntentError } from './intent.js';

export function splitLinesWithByteRanges(bytes) {
  const lines = [];
  let lineStart = 0;
  for (let i = 0; i <= bytes.length; i += 1) {
    if (i === bytes.length || bytes[i] === 0x0a) {
      let contentEnd = i;
      if (contentEnd > lineStart && bytes[contentEnd - 1] === 0x0d) {
        contentEnd -= 1;
      }
      const lineBytes = bytes.subarray(lineStart, contentEnd);
      const text = new TextDecoder('utf-8', { fatal: true }).decode(lineBytes);
      lines.push({
        lineNumber: lines.length + 1,
        start: lineStart,
        contentEnd,
        lineEnd: i === bytes.length ? bytes.length : i + 1,
        text,
        lineBytes,
      });
      lineStart = i === bytes.length ? bytes.length : i + 1;
    }
  }
  return lines;
}

export function normalizedBlockFromBytes(bytes, startLine, endLine) {
  const lines = splitLinesWithByteRanges(bytes);
  if (startLine < 1 || endLine > lines.length || endLine < startLine) {
    throw new CandidateIntentError('INVALID_RANGE', 'Block range exceeds file line count.');
  }
  const parts = [];
  const byteAtCodeUnit = [];
  for (let lineNumber = startLine; lineNumber <= endLine; lineNumber += 1) {
    const line = lines[lineNumber - 1];
    const trimmed = line.text.replace(/[ \t]+$/, '');
    for (let index = 0; index < trimmed.length; index += 1) {
      byteAtCodeUnit.push(line.start + Buffer.byteLength(trimmed.slice(0, index), 'utf8'));
    }
    parts.push(trimmed);
    if (lineNumber < endLine) {
      byteAtCodeUnit.push(lines[lineNumber - 1].lineEnd);
    }
  }
  return {
    normalized: parts.join('\n'),
    byteAtCodeUnit,
    lines,
  };
}

export function countNeedleInHaystack(haystack, needle) {
  if (!needle.length) return 0;
  let count = 0;
  let index = 0;
  while (index <= haystack.length - needle.length) {
    const found = haystack.indexOf(needle, index);
    if (found === -1) break;
    count += 1;
    index = found + (needle.length || 1);
  }
  return count;
}

export function resolveEditByteOffsets(bytes, oldText, startLine, endLine) {
  const needle = Buffer.from(String(oldText), 'utf8');
  const { normalized, byteAtCodeUnit } = normalizedBlockFromBytes(bytes, startLine, endLine);
  const occurrences = countNeedleInHaystack(normalized, oldText);
  if (occurrences === 0) {
    throw new CandidateIntentError('OLD_TEXT_OUTSIDE_BLOCK', 'oldText was not found inside the declared block range.');
  }
  if (occurrences > 1) {
    throw new CandidateIntentError('NON_UNIQUE_OLD_TEXT', 'oldText must be unique within the bound block.');
  }
  const pos = normalized.indexOf(oldText);
  const startOffset = byteAtCodeUnit[pos];
  const endOffset = startOffset + Buffer.byteLength(normalized.slice(pos, pos + oldText.length), 'utf8');
  return { startOffset, endOffset };
}

export function applyEditToBytes(bytes, edit) {
  const oldBytes = Buffer.from(edit.oldText, 'utf8');
  const newBytes = Buffer.from(edit.newText, 'utf8');
  const actual = bytes.subarray(edit.startOffset, edit.endOffset);
  if (!actual.equals(oldBytes)) {
    throw new CandidateIntentError('STALE_PREIMAGE', 'Recorded oldText does not match bytes at offsets.');
  }
  return Buffer.concat([bytes.subarray(0, edit.startOffset), newBytes, bytes.subarray(edit.endOffset)]);
}

export function applyEditsToBytes(bytes, edits) {
  const ordered = [...edits].sort((a, b) => b.startOffset - a.startOffset);
  return ordered.reduce((next, edit) => applyEditToBytes(next, edit), bytes);
}

export function decodeUtf8Bytes(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new CandidateIntentError('INVALID_UTF8', 'Source file is not valid UTF-8.');
  }
}
