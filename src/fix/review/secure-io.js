import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';

export class SecureIoError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SecureIoError';
    this.code = code;
  }
}

const { O_RDONLY, O_NOFOLLOW } = constants;

function readExactUtf8(fd, size) {
  const buffer = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const bytesRead = readSync(fd, buffer, offset, size - offset, null);
    if (bytesRead === 0) {
      throw new SecureIoError('INVALID_FILE', 'File read was incomplete.');
    }
    offset += bytesRead;
  }
  return buffer.toString('utf8');
}

export function readBoundedFile(filePath, maxBytes) {
  if (!filePath) return null;

  let fd;
  try {
    fd = openSync(filePath, O_RDONLY | O_NOFOLLOW);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    if (error?.code === 'ELOOP') {
      throw new SecureIoError('SYMLINK_FILE', 'Symlink files are not allowed.');
    }
    throw error;
  }

  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) {
      throw new SecureIoError('INVALID_FILE', 'Expected a regular file.');
    }
    if (stat.size > maxBytes) {
      throw new SecureIoError('FILE_TOO_LARGE', 'File exceeds the allowed size.');
    }
    if (stat.size === 0) return '';
    return readExactUtf8(fd, stat.size);
  } finally {
    closeSync(fd);
  }
}

export function readBoundedJsonLines(filePath, maxBytes, maxLines) {
  const raw = readBoundedFile(filePath, maxBytes);
  if (raw == null) return [];
  const lines = raw.split('\n');
  if (lines.length > maxLines) {
    throw new SecureIoError('FILE_TOO_LARGE', 'File exceeds the allowed line count.');
  }
  return lines;
}
