import {
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readBoundedFile, readBoundedJsonLines, SecureIoError } from '../../src/fix/review/secure-io.js';

const { O_RDONLY, O_NOFOLLOW } = constants;

test('readBoundedFile returns null for missing files', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-secure-io-'));
  try {
    assert.equal(readBoundedFile(join(root, 'missing.txt'), 1024), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('readBoundedFile reads regular files via fd without TOCTOU lstat/readFileSync', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-secure-io-'));
  try {
    const filePath = join(root, 'sample.txt');
    writeFileSync(filePath, 'hello bounded read\n', { mode: 0o600 });
    assert.equal(readBoundedFile(filePath, 1024), 'hello bounded read\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('readBoundedFile rejects symlinks with SYMLINK_FILE', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-secure-io-'));
  try {
    const target = join(root, 'target.txt');
    const linkPath = join(root, 'link.txt');
    writeFileSync(target, 'target content\n', { mode: 0o600 });
    symlinkSync(target, linkPath);
    assert.throws(
      () => readBoundedFile(linkPath, 1024),
      (error) => error instanceof SecureIoError && error.code === 'SYMLINK_FILE',
    );
    assert.throws(
      () => openSync(linkPath, O_RDONLY | O_NOFOLLOW),
      (error) => error.code === 'ELOOP',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('readBoundedFile rejects files larger than maxBytes', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-secure-io-'));
  try {
    const filePath = join(root, 'large.txt');
    writeFileSync(filePath, '0123456789', { mode: 0o600 });
    assert.throws(
      () => readBoundedFile(filePath, 5),
      (error) => error instanceof SecureIoError && error.code === 'FILE_TOO_LARGE',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('readBoundedFile rejects directories', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-secure-io-'));
  try {
    const dirPath = join(root, 'nested');
    mkdirSync(dirPath);
    assert.throws(
      () => readBoundedFile(dirPath, 1024),
      (error) => error instanceof SecureIoError && error.code === 'INVALID_FILE',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('readBoundedFile reads the full fd size in a bounded loop', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-secure-io-'));
  try {
    const filePath = join(root, 'chunked.txt');
    const fd = openSync(filePath, 'w');
    writeSync(fd, Buffer.from('abcd'));
    closeSync(fd);

    const readFd = openSync(filePath, O_RDONLY | O_NOFOLLOW);
    const stat = fstatSync(readFd);
    const buffer = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < stat.size) {
      const bytesRead = readSync(readFd, buffer, offset, stat.size - offset, null);
      assert.ok(bytesRead > 0);
      offset += bytesRead;
    }
    closeSync(readFd);
    assert.equal(offset, stat.size);
    assert.equal(readBoundedFile(filePath, 1024), 'abcd');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('readBoundedJsonLines enforces line count after bounded read', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-secure-io-'));
  try {
    const filePath = join(root, 'lines.jsonl');
    writeFileSync(filePath, 'a\nb\nc', { mode: 0o600 });
    assert.deepEqual(readBoundedJsonLines(filePath, 1024, 3), ['a', 'b', 'c']);
    assert.throws(
      () => readBoundedJsonLines(filePath, 1024, 2),
      (error) => error instanceof SecureIoError && error.code === 'FILE_TOO_LARGE',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
