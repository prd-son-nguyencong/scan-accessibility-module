import { createHash } from 'node:crypto';
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
import path from 'node:path';
import { CIS_VALIDATION_LIMITS } from '../cis/limits.js';

export class ContextBrokerError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = 'ContextBrokerError';
    this.code = code;
  }
}

/**
 * @param {string} text
 */
export function hashBlockText(text) {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

/**
 * @param {string} rootReal
 * @param {string} relativePath
 */
function resolveCandidatePath(rootReal, relativePath) {
  const normalized = path.normalize(String(relativePath).replace(/\\/g, '/'));
  if (path.isAbsolute(normalized)) {
    throw new ContextBrokerError('CONTEXT_PATH_DENIED', 'Absolute paths are not allowlisted.');
  }
  if (normalized.split(path.sep).includes('..')) {
    throw new ContextBrokerError('CONTEXT_PATH_DENIED', 'Path traversal is not allowlisted.');
  }

  const candidate = path.resolve(rootReal, normalized);
  const relative = path.relative(rootReal, candidate);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new ContextBrokerError('CONTEXT_PATH_DENIED', 'Resolved path escapes local root.');
  }
  return candidate;
}

/**
 * @param {string} rootReal
 * @param {string} candidatePath
 */
function assertContainedRegularFile(rootReal, candidatePath) {
  if (!existsSync(candidatePath)) {
    throw new ContextBrokerError('CONTEXT_FILE_MISSING', 'Allowlisted source file is missing.');
  }

  const lst = lstatSync(candidatePath);
  if (lst.isSymbolicLink()) {
    throw new ContextBrokerError('CONTEXT_SYMLINK_RETARGET', 'Binding path was retargeted to a symlink.');
  }
  if (!lst.isFile()) {
    throw new ContextBrokerError(
      'CONTEXT_UNSUPPORTED_EXTENSION',
      'Binding path must refer to a regular file.',
    );
  }

  const resolved = realpathSync(candidatePath);
  const relative = path.relative(rootReal, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new ContextBrokerError('CONTEXT_SYMLINK_ESCAPE', 'Resolved path escapes local root.');
  }

  return lst;
}

/**
 * @param {string} filePath
 */
function assertSupportedTextFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (!CIS_VALIDATION_LIMITS.allowedTextExtensions.includes(ext)) {
    throw new ContextBrokerError(
      'CONTEXT_UNSUPPORTED_EXTENSION',
      `Extension ${ext || '(none)'} is not allowlisted for context blocks.`,
    );
  }
}

/**
 * @param {number} fd
 * @param {number | undefined} startLine
 * @param {number | undefined} endLine
 * @param {string} filePath
 */
function readTextRangeFromFd(fd, startLine, endLine, filePath) {
  assertSupportedTextFile(filePath);
  const stat = fstatSync(fd);
  if (!stat.isFile()) {
    throw new ContextBrokerError('CONTEXT_UNSUPPORTED_EXTENSION', 'Binding path must refer to a regular file.');
  }
  if (stat.size > CIS_VALIDATION_LIMITS.maxBlockBytes) {
    throw new ContextBrokerError('CONTEXT_BLOCK_TOO_LARGE', 'Context block exceeds maxBlockBytes.');
  }

  const raw = Buffer.alloc(stat.size);
  readSync(fd, raw, 0, stat.size, 0);
  if (raw.includes(0)) {
    throw new ContextBrokerError('CONTEXT_UNSUPPORTED_EXTENSION', 'Binary content is not allowlisted.');
  }

  const text = raw.toString('utf8');
  const lines = text.split('\n');
  const start = startLine == null ? 1 : startLine;
  const end = endLine == null ? lines.length : endLine;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
    throw new ContextBrokerError('CONTEXT_BINDING_DENIED', 'Invalid line range binding.');
  }
  if (end > lines.length) {
    throw new ContextBrokerError('CONTEXT_RANGE_OUT_OF_BOUNDS', 'Line range end exceeds file length.');
  }

  const slice = lines.slice(start - 1, end).join('\n');
  if (Buffer.byteLength(slice, 'utf8') > CIS_VALIDATION_LIMITS.maxBlockBytes) {
    throw new ContextBrokerError('CONTEXT_BLOCK_TOO_LARGE', 'Context block exceeds maxBlockBytes.');
  }
  return slice;
}

/**
 * @param {string} rootReal
 * @param {string} relativeFile
 * @param {{ dev: number, ino: number } | null} [identity]
 * @param {number | undefined} [startLine]
 * @param {number | undefined} [endLine]
 */
function openBindingForRead(rootReal, relativeFile, identity, startLine, endLine) {
  const candidatePath = resolveCandidatePath(rootReal, relativeFile);
  assertContainedRegularFile(rootReal, candidatePath);

  let fd;
  try {
    fd = openSync(candidatePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (error?.code === 'ELOOP') {
      throw new ContextBrokerError('CONTEXT_SYMLINK_RETARGET', 'Binding path was retargeted to a symlink.');
    }
    throw error;
  }

  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) {
      throw new ContextBrokerError('CONTEXT_UNSUPPORTED_EXTENSION', 'Binding path must refer to a regular file.');
    }
    if (identity && (stat.dev !== identity.dev || stat.ino !== identity.ino)) {
      throw new ContextBrokerError('CONTEXT_FILE_REPLACED', 'Allowlisted source file was replaced on disk.');
    }
    const text = readTextRangeFromFd(fd, startLine, endLine, candidatePath);
    return {
      candidatePath,
      stat,
      text,
      sha256: hashBlockText(text),
      bytes: Buffer.byteLength(text, 'utf8'),
    };
  } finally {
    closeSync(fd);
  }
}

/**
 * @param {Array<{ blockId: string, file: string, startLine?: number, endLine?: number }>} nextBindings
 * @param {string} rootReal
 */
function buildBindingMap(nextBindings, rootReal) {
  /** @type {Map<string, {
   *   blockId: string,
   *   file: string,
   *   startLine?: number,
   *   endLine?: number,
   *   dev: number,
   *   ino: number,
   *   sha256: string,
   *   bytes: number,
   * }>} */
  const candidate = new Map();
  const seenIds = new Set();

  for (const binding of nextBindings) {
    if (!binding?.blockId || typeof binding.blockId !== 'string') {
      throw new ContextBrokerError('CONTEXT_BINDING_DENIED', 'Each binding requires an opaque blockId.');
    }
    if (seenIds.has(binding.blockId)) {
      throw new ContextBrokerError('CONTEXT_BINDING_DENIED', 'Duplicate blockId in bindings.');
    }
    seenIds.add(binding.blockId);
    if (/\//.test(binding.blockId) || binding.blockId.includes('..')) {
      throw new ContextBrokerError('CONTEXT_BINDING_DENIED', 'Block IDs must not resemble paths.');
    }

    const opened = openBindingForRead(
      rootReal,
      binding.file,
      null,
      binding.startLine,
      binding.endLine,
    );
    candidate.set(binding.blockId, {
      blockId: binding.blockId,
      file: binding.file,
      startLine: binding.startLine,
      endLine: binding.endLine,
      dev: opened.stat.dev,
      ino: opened.stat.ino,
      sha256: opened.sha256,
      bytes: opened.bytes,
    });
  }

  return candidate;
}

/**
 * @param {{
 *   localRoot: string,
 *   bindings?: Array<{ blockId: string, file: string, startLine?: number, endLine?: number }>,
 * }} options
 */
export function createContextBroker({ localRoot, bindings = [] }) {
  const rootReal = realpathSync(localRoot);
  /** @type {Map<string, ReturnType<typeof buildBindingMap> extends Map<string, infer V> ? V : never>} */
  let bindingRecords = buildBindingMap(bindings, rootReal);

  function materializeBlock(record, verification = {}) {
    const opened = openBindingForRead(
      rootReal,
      record.file,
      { dev: record.dev, ino: record.ino },
      record.startLine,
      record.endLine,
    );

    if (opened.sha256 !== record.sha256 || opened.bytes !== record.bytes) {
      throw new ContextBrokerError('CONTEXT_STALE', 'Allowlisted source block changed on disk.');
    }
    if (verification.expectedSha256 && verification.expectedSha256 !== opened.sha256) {
      throw new ContextBrokerError('CONTEXT_HASH_MISMATCH', 'Supplied block hash does not match current content.');
    }
    if (verification.expectedBytes != null && verification.expectedBytes !== opened.bytes) {
      throw new ContextBrokerError('CONTEXT_HASH_MISMATCH', 'Supplied block bytes do not match current content.');
    }

    return {
      blockId: record.blockId,
      sha256: opened.sha256,
      bytes: opened.bytes,
      text: opened.text,
    };
  }

  return {
    registerBindings(nextBindings) {
      const candidate = buildBindingMap(nextBindings, rootReal);
      bindingRecords = candidate;
    },
    listBlockIds() {
      return [...bindingRecords.keys()];
    },
    getKnownBlockHashes() {
      return Object.fromEntries([...bindingRecords.entries()].map(([id, record]) => [id, record.sha256]));
    },
    readByRequestedPath(_requestedPath) {
      throw new ContextBrokerError(
        'CONTEXT_PATH_DENIED',
        'Direct path reads are denied; use opaque block IDs from the controller.',
      );
    },
    getBlock(blockId, verification = {}) {
      const record = bindingRecords.get(blockId);
      if (!record) {
        throw new ContextBrokerError('CONTEXT_BLOCK_UNKNOWN', `Unknown block ID ${blockId}.`);
      }
      return materializeBlock(record, verification);
    },
    getBlocks(blockIds) {
      if (!Array.isArray(blockIds)) {
        throw new ContextBrokerError('CONTEXT_BINDING_DENIED', 'blockIds must be an array.');
      }
      if (blockIds.length === 0 || blockIds.length > CIS_VALIDATION_LIMITS.maxContextBlockIds) {
        throw new ContextBrokerError('CONTEXT_BINDING_DENIED', 'Requested block ID count is out of bounds.');
      }
      const seen = new Set();
      return blockIds.map((blockId) => {
        if (seen.has(blockId)) {
          throw new ContextBrokerError('CONTEXT_BINDING_DENIED', 'Duplicate block ID request.');
        }
        seen.add(blockId);
        return this.getBlock(blockId);
      });
    },
  };
}
