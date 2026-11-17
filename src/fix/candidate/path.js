import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from 'node:fs';
import { isAbsolute, relative, resolve, dirname } from 'node:path';
import { normalizeSourcePath } from '../../reporter/fingerprint.js';
import { assertPathContainedInRoot, resolveTrustedRoot } from '../controller/local-attestation.js';
import { CandidateIntentError } from './intent.js';

const { O_RDONLY, O_NOFOLLOW } = constants;

export function validateRelativeCandidatePath(file) {
  const normalized = normalizeSourcePath(file);
  if (!normalized || normalized.includes('..') || isAbsolute(normalized)) {
    throw new CandidateIntentError('PATH_TRAVERSAL', 'Edit paths must be relative and contained.');
  }
  if (isAbsolute(file) || String(file).includes('\\')) {
    throw new CandidateIntentError('ABSOLUTE_PATH', 'Absolute or non-POSIX paths are not allowed.');
  }
  for (const segment of normalized.split('/')) {
    if (!segment || segment === '.' || segment === '..') {
      throw new CandidateIntentError('PATH_TRAVERSAL', 'Edit paths must not contain traversal segments.');
    }
  }
  return normalized;
}

export function resolveSecureSourceFile(localRoot, relativePath, { maxBytes }) {
  const file = validateRelativeCandidatePath(relativePath);
  const rootCheck = resolveTrustedRoot(localRoot);
  if (!rootCheck.ok) {
    throw new CandidateIntentError(rootCheck.reason || 'LOCAL_ROOT_MISSING', 'Local root is unavailable.');
  }
  const lexicalPath = resolve(rootCheck.localRoot, file);
  const lexicalRelative = relative(rootCheck.localRoot, lexicalPath);
  if (lexicalRelative.startsWith('..') || isAbsolute(lexicalRelative)) {
    throw new CandidateIntentError('PATH_TRAVERSAL', 'Edit path escapes local root.');
  }
  let current = rootCheck.localRoot;
  const segments = lexicalRelative.split(/[/\\]/).filter(Boolean);
  for (const [index, segment] of segments.entries()) {
    current = resolve(current, segment);
    let componentStat;
    try {
      componentStat = lstatSync(current);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        throw new CandidateIntentError('FILE_NOT_FOUND', 'Source file was not found.');
      }
      throw error;
    }
    if (componentStat.isSymbolicLink()) {
      throw new CandidateIntentError('SYMLINK_ESCAPE', 'Symlink source paths are not allowed.');
    }
    if (index < segments.length - 1 && !componentStat.isDirectory()) {
      throw new CandidateIntentError('INVALID_FILE', 'Source path contains a non-directory component.');
    }
  }

  const contained = assertPathContainedInRoot(rootCheck.localRoot, lexicalPath);
  if (!contained.ok) {
    throw new CandidateIntentError(contained.reason || 'PATH_TRAVERSAL', 'Edit path escapes local root.');
  }
  const stat = lstatSync(contained.resolvedPath);
  if (stat.isSymbolicLink()) {
    throw new CandidateIntentError('SYMLINK_ESCAPE', 'Symlink source files are not allowed.');
  }
  if (!stat.isFile()) {
    throw new CandidateIntentError('INVALID_FILE', 'Expected a regular source file.');
  }
  let realTarget;
  try {
    realTarget = realpathSync(contained.resolvedPath);
  } catch {
    throw new CandidateIntentError('SYMLINK_ESCAPE', 'Unable to resolve source file realpath.');
  }
  const rel = relative(rootCheck.localRoot, realTarget);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new CandidateIntentError('SYMLINK_ESCAPE', 'Symlink escapes local root.');
  }
  for (const segment of rel.split(/[/\\]/)) {
    if (segment === '..') {
      throw new CandidateIntentError('SYMLINK_ESCAPE', 'Resolved path escapes local root.');
    }
  }
  const bytes = readSecureFileBytes(realTarget, maxBytes);
  return {
    file,
    resolvedPath: realTarget,
    bytes,
    mode: stat.mode & 0o777,
  };
}

export function readSecureFileBytes(filePath, maxBytes) {
  let fd;
  try {
    fd = openSync(filePath, O_RDONLY | O_NOFOLLOW);
  } catch (error) {
    if (error?.code === 'ELOOP') {
      throw new CandidateIntentError('SYMLINK_ESCAPE', 'Symlink files are not allowed.');
    }
    if (error?.code === 'ENOENT') {
      throw new CandidateIntentError('FILE_NOT_FOUND', 'Source file was not found.');
    }
    throw error;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) {
      throw new CandidateIntentError('INVALID_FILE', 'Expected a regular file.');
    }
    if (stat.size > maxBytes) {
      throw new CandidateIntentError('FILE_TOO_LARGE', 'Source file exceeds allowed size.');
    }
    const buffer = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < stat.size) {
      const read = readSync(fd, buffer, offset, stat.size - offset, null);
      if (read === 0) {
        throw new CandidateIntentError('INVALID_FILE', 'File read was incomplete.');
      }
      offset += read;
    }
    if (buffer.includes(0)) {
      throw new CandidateIntentError('NUL_BYTE', 'Binary or NUL content is not allowed.');
    }
    return buffer;
  } finally {
    closeSync(fd);
  }
}

export function assertDestinationContained(rootDir, relativePath) {
  const normalized = validateRelativeCandidatePath(relativePath);
  const rootCheck = resolveTrustedRoot(rootDir);
  if (!rootCheck.ok) {
    throw new CandidateIntentError(rootCheck.reason || 'LOCAL_ROOT_MISSING', 'Destination root is unavailable.');
  }
  const dest = resolve(rootCheck.localRoot, normalized);
  let resolvedRoot;
  let resolvedDest;
  try {
    resolvedRoot = realpathSync(rootCheck.localRoot);
    resolvedDest = existsSync(dest) ? realpathSync(dest) : resolve(resolvedRoot, normalized);
  } catch {
    throw new CandidateIntentError('PATH_TRAVERSAL', 'Destination path escapes workspace.');
  }
  const rel = relative(resolvedRoot, resolvedDest);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new CandidateIntentError('PATH_TRAVERSAL', 'Destination path escapes workspace.');
  }
  const parent = dirname(resolvedDest);
  const parentRel = relative(resolvedRoot, parent);
  if (parentRel.startsWith('..') || isAbsolute(parentRel)) {
    throw new CandidateIntentError('PATH_TRAVERSAL', 'Destination parent escapes workspace.');
  }
  return resolvedDest;
}
