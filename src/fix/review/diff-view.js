export const REVIEW_DIFF_VIEW_PATH = '/review/diff-view.js';
export const MAX_DIFF_BYTES = 64 * 1024;
export const MAX_DIFF_FILES = 8;
export const MAX_DIFF_ROWS = 4096;
export const MAX_DIFF_PATH_CHARS = 260;
export const MAX_DIFF_ROW_TEXT_CHARS = 8192;

const FILE_OLD_PREFIX = '--- a/';
const FILE_NEW_PREFIX = '+++ b/';
const HUNK_HEADER_PATTERN = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@$/;
const META_LINE_PATTERN = /^\\ No newline at end of file$/;

let candidateDiffViewCache = new WeakMap();

function normalizeDiffSourcePath(file = '') {
  if (file == null) return '';
  return String(file)
    .replace(/\\/g, '/')
    .replace(/^(?:\.\/)+/, '')
    .replace(/\/+/g, '/');
}

function utf8ByteLength(value) {
  return new TextEncoder().encode(String(value)).length;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const entry of Object.values(value)) deepFreeze(entry);
  return value;
}

function malformed(reason = 'MALFORMED_UNIFIED_DIFF') {
  return deepFreeze({ ok: false, reason });
}

function isAbsolutePath(normalized) {
  return normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized);
}

function validateDiffPath(rawPath) {
  if (typeof rawPath !== 'string' || rawPath.length === 0 || rawPath.length > MAX_DIFF_PATH_CHARS) {
    return null;
  }
  if (rawPath.includes('\\') || rawPath.startsWith('/')) {
    return null;
  }
  const normalized = normalizeDiffSourcePath(rawPath);
  if (!normalized || isAbsolutePath(normalized)) {
    return null;
  }
  for (const segment of normalized.split('/')) {
    if (!segment || segment === '.' || segment === '..') {
      return null;
    }
  }
  return normalized;
}

function splitDiffLines(patchText) {
  const normalized = patchText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (!normalized.endsWith('\n')) {
    return null;
  }
  const body = normalized.slice(0, -1);
  if (body.length === 0) {
    return null;
  }
  return body.split('\n');
}

function parseHunkHeader(line) {
  const match = HUNK_HEADER_PATTERN.exec(line);
  if (!match) return null;
  return {
    oldStart: Number.parseInt(match[1], 10),
    oldCount: match[2] == null ? 1 : Number.parseInt(match[2], 10),
    newStart: Number.parseInt(match[3], 10),
    newCount: match[4] == null ? 1 : Number.parseInt(match[4], 10),
  };
}

function isValidHunkHeader(header) {
  if (!header) return false;
  if (header.oldCount === 0 && header.newCount === 0) return false;
  if (header.oldStart === 0 && header.oldCount !== 0) return false;
  if (header.newStart === 0 && header.newCount !== 0) return false;
  if (header.oldCount > 0 && header.oldStart < 1) return false;
  if (header.newCount > 0 && header.newStart < 1) return false;
  return true;
}

function pushRow(rows, row) {
  if (row.text.length > MAX_DIFF_ROW_TEXT_CHARS) {
    throw new Error('ROW_TOO_LONG');
  }
  rows.push(row);
}

function parseFileSection(lines, startIndex) {
  if (!lines[startIndex]?.startsWith(FILE_OLD_PREFIX)) {
    return null;
  }
  if (!lines[startIndex + 1]?.startsWith(FILE_NEW_PREFIX)) {
    return null;
  }

  const oldPath = validateDiffPath(lines[startIndex].slice(FILE_OLD_PREFIX.length));
  const newPath = validateDiffPath(lines[startIndex + 1].slice(FILE_NEW_PREFIX.length));
  if (!oldPath || !newPath) {
    return null;
  }

  const rows = [];
  let index = startIndex + 2;
  let oldLine = null;
  let newLine = null;
  let oldUsed = 0;
  let newUsed = 0;
  let expectedOld = 0;
  let expectedNew = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (line.startsWith(FILE_OLD_PREFIX)) {
      break;
    }

    if (line.startsWith('@@ ')) {
      if (rows.length > 0 && (oldUsed !== expectedOld || newUsed !== expectedNew)) {
        return null;
      }
      const header = parseHunkHeader(line);
      if (!isValidHunkHeader(header)) {
        return null;
      }
      oldUsed = 0;
      newUsed = 0;
      expectedOld = header.oldCount;
      expectedNew = header.newCount;
      oldLine = header.oldStart;
      newLine = header.newStart;
      pushRow(rows, {
        kind: 'hunk',
        oldLine: null,
        newLine: null,
        text: line,
      });
      index += 1;
      continue;
    }

    if (expectedOld === 0 && expectedNew === 0) {
      return null;
    }

    if (line.startsWith(' ')) {
      pushRow(rows, {
        kind: 'context',
        oldLine,
        newLine,
        text: line.slice(1),
      });
      oldLine += 1;
      newLine += 1;
      oldUsed += 1;
      newUsed += 1;
      index += 1;
      continue;
    }

    if (line.startsWith('-')) {
      pushRow(rows, {
        kind: 'removed',
        oldLine,
        newLine: null,
        text: line.slice(1),
      });
      oldLine += 1;
      oldUsed += 1;
      index += 1;
      if (lines[index] && META_LINE_PATTERN.test(lines[index])) {
        pushRow(rows, {
          kind: 'meta',
          oldLine: null,
          newLine: null,
          text: lines[index],
        });
        index += 1;
      }
      continue;
    }

    if (line.startsWith('+')) {
      pushRow(rows, {
        kind: 'added',
        oldLine: null,
        newLine,
        text: line.slice(1),
      });
      newLine += 1;
      newUsed += 1;
      index += 1;
      if (lines[index] && META_LINE_PATTERN.test(lines[index])) {
        pushRow(rows, {
          kind: 'meta',
          oldLine: null,
          newLine: null,
          text: lines[index],
        });
        index += 1;
      }
      continue;
    }

    if (META_LINE_PATTERN.test(line)) {
      return null;
    }

    return null;
  }

  if (expectedOld !== oldUsed || expectedNew !== newUsed) {
    return null;
  }
  if (rows.length === 0 || !rows.some((row) => row.kind === 'hunk')) {
    return null;
  }

  return {
    file: deepFreeze({
      oldPath,
      newPath,
      rows: deepFreeze(rows),
    }),
    nextIndex: index,
  };
}

export function parseUnifiedDiff(patchText) {
  try {
    if (typeof patchText !== 'string') {
      return malformed();
    }
    if (utf8ByteLength(patchText) > MAX_DIFF_BYTES) {
      return malformed();
    }

    const lines = splitDiffLines(patchText);
    if (!lines) {
      return malformed();
    }
    if (lines.length > MAX_DIFF_ROWS * 4) {
      return malformed();
    }

    const files = [];
    let additions = 0;
    let removals = 0;
    let totalRows = 0;
    let index = 0;

    while (index < lines.length) {
      if (files.length >= MAX_DIFF_FILES) {
        return malformed();
      }
      const section = parseFileSection(lines, index);
      if (!section) {
        return malformed();
      }
      for (const row of section.file.rows) {
        totalRows += 1;
        if (totalRows > MAX_DIFF_ROWS) {
          return malformed();
        }
        if (row.kind === 'added') additions += 1;
        if (row.kind === 'removed') removals += 1;
      }
      files.push(section.file);
      index = section.nextIndex;
    }

    if (files.length === 0) {
      return malformed();
    }

    return deepFreeze({
      ok: true,
      additions,
      removals,
      files,
    });
  } catch {
    return malformed();
  }
}

export function getCandidateDiffView(candidate) {
  if (!candidate || typeof candidate !== 'object') {
    return parseUnifiedDiff(candidate?.diff);
  }
  const cached = candidateDiffViewCache.get(candidate);
  if (cached) {
    return cached;
  }
  const parsed = parseUnifiedDiff(candidate.diff);
  candidateDiffViewCache.set(candidate, parsed);
  return parsed;
}

export function resetCandidateDiffViewCacheForTests() {
  candidateDiffViewCache = new WeakMap();
}

function appendVisuallyHidden(parent, text) {
  const label = document.createElement('span');
  label.className = 'visually-hidden';
  label.textContent = text;
  parent.appendChild(label);
}

function createGutterCell(lineNumber, side) {
  const cell = document.createElement('td');
  cell.className = 'diff-gutter diff-gutter-' + side;
  cell.setAttribute('role', 'cell');
  if (lineNumber == null) {
    cell.textContent = '';
    cell.setAttribute('aria-hidden', 'true');
  } else {
    cell.textContent = String(lineNumber);
  }
  return cell;
}

function createMarkerCell(kind) {
  const cell = document.createElement('td');
  cell.className = 'diff-marker';
  cell.setAttribute('role', 'cell');
  if (kind === 'added') {
    cell.textContent = '+';
    appendVisuallyHidden(cell, 'Added');
  } else if (kind === 'removed') {
    cell.textContent = '\u2212';
    appendVisuallyHidden(cell, 'Removed');
  } else if (kind === 'context') {
    cell.textContent = ' ';
    cell.setAttribute('aria-hidden', 'true');
  } else {
    cell.textContent = '';
    cell.setAttribute('aria-hidden', 'true');
  }
  return cell;
}

function createCodeCell(kind, text) {
  const cell = document.createElement('td');
  cell.className = 'diff-code diff-row-' + kind;
  cell.setAttribute('role', 'cell');
  const code = document.createElement('code');
  code.textContent = text;
  cell.appendChild(code);
  return cell;
}

function appendDiffRow(tableBody, row) {
  const tr = document.createElement('tr');
  tr.className = 'diff-row diff-row-' + row.kind;
  tr.setAttribute('role', 'row');

  if (row.kind === 'hunk') {
    const cell = document.createElement('td');
    cell.colSpan = 4;
    cell.className = 'diff-hunk';
    cell.setAttribute('role', 'cell');
    cell.textContent = row.text;
    tr.appendChild(cell);
  } else if (row.kind === 'meta') {
    const cell = document.createElement('td');
    cell.colSpan = 4;
    cell.className = 'diff-meta';
    cell.setAttribute('role', 'cell');
    cell.textContent = row.text;
    tr.appendChild(cell);
  } else {
    tr.appendChild(createGutterCell(row.oldLine, 'old'));
    tr.appendChild(createGutterCell(row.newLine, 'new'));
    tr.appendChild(createMarkerCell(row.kind));
    tr.appendChild(createCodeCell(row.kind, row.text));
  }

  tableBody.appendChild(tr);
}

export function renderUnifiedDiff(parent, diff) {
  if (!parent || !diff?.ok) {
    return false;
  }

  const container = document.createElement('div');
  container.className = 'unified-diff';

  const summary = document.createElement('p');
  summary.className = 'diff-summary';
  summary.textContent = diff.additions + ' addition(s), ' + diff.removals + ' removal(s)';
  container.appendChild(summary);

  for (const file of diff.files) {
    const fileSection = document.createElement('section');
    fileSection.className = 'diff-file';

    const heading = document.createElement('h4');
    heading.className = 'diff-file-heading';
    heading.textContent = file.oldPath === file.newPath
      ? file.newPath
      : file.oldPath + ' → ' + file.newPath;
    fileSection.appendChild(heading);

    const scroll = document.createElement('div');
    scroll.className = 'diff-scroll';

    const table = document.createElement('table');
    table.className = 'diff-table';
    table.setAttribute('role', 'table');
    table.setAttribute('aria-label', 'Unified diff for ' + file.newPath);

    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    headRow.setAttribute('role', 'row');
    for (const label of ['Old line', 'New line', 'Change', 'Code']) {
      const th = document.createElement('th');
      th.scope = 'col';
      th.className = 'visually-hidden';
      th.textContent = label;
      headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    tbody.setAttribute('role', 'rowgroup');
    for (const row of file.rows) {
      appendDiffRow(tbody, row);
    }
    table.appendChild(tbody);
    scroll.appendChild(table);
    fileSection.appendChild(scroll);
    container.appendChild(fileSection);
  }

  parent.appendChild(container);
  return true;
}

function appendDiffNote(parent, message) {
  const note = document.createElement('p');
  note.className = 'diff-fallback-note';
  note.textContent = message;
  parent.appendChild(note);
}

function appendRawDiffPre(parent, text) {
  const scroll = document.createElement('div');
  scroll.className = 'diff-scroll diff-raw-scroll';
  const pre = document.createElement('pre');
  pre.className = 'diff-raw';
  pre.textContent = text;
  scroll.appendChild(pre);
  parent.appendChild(scroll);
}

export function renderDiffContent(parent, diff, options = {}) {
  if (!parent || !diff) {
    return;
  }
  if (diff.view?.ok && renderUnifiedDiff(parent, diff.view)) {
    return;
  }
  if (diff.viewTrimmed || options.snapshotDiffTrimmed) {
    appendDiffNote(
      parent,
      'Structured diff view was omitted from this snapshot to stay within size limits; showing exact canonical diff text.',
    );
  } else if (diff.view && diff.view.ok === false) {
    appendDiffNote(parent, 'Structured diff view unavailable; showing canonical diff text.');
  }
  appendRawDiffPre(parent, diff.text || '');
}
