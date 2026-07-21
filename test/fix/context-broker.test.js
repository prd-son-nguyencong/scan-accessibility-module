import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createContextBroker, hashBlockText } from '../../src/fix/context/broker.js';

function makeWorkspace() {
  const root = mkdtempSync(path.join(tmpdir(), 'ada-broker-'));
  mkdirSync(path.join(root, 'src', 'partials'), { recursive: true });
  writeFileSync(
    path.join(root, 'src', 'partials', 'sample.liquid'),
    '<select id="sort-select">\n  <option>Jobs</option>\n</select>\n',
    'utf8',
  );
  writeFileSync(path.join(root, '.env'), 'SECRET=super-secret-token-abc123\n', 'utf8');
  mkdirSync(path.join(root, '.git'), { recursive: true });
  writeFileSync(path.join(root, '.git', 'config'), '[core]\n', 'utf8');
  mkdirSync(path.join(root, 'src', 'assets'), { recursive: true });
  writeFileSync(path.join(root, 'src', 'assets', 'logo.bin'), Buffer.from([0, 1, 2, 3]));
  return root;
}

test('broker emits opaque blocks with sha256 hashes and no paths', () => {
  const root = makeWorkspace();
  const broker = createContextBroker({
    localRoot: root,
    bindings: [{ blockId: 'ctx_1', file: 'src/partials/sample.liquid', startLine: 1, endLine: 2 }],
  });
  const block = broker.getBlock('ctx_1');
  assert.equal(block.blockId, 'ctx_1');
  assert.match(block.sha256, /^sha256:[a-f0-9]{64}$/);
  assert.ok(block.text.includes('<select id="sort-select">'));
  assert.equal(Object.prototype.hasOwnProperty.call(block, 'file'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(block, 'path'), false);
});

test('broker returns blocks only by known opaque IDs', () => {
  const root = makeWorkspace();
  const broker = createContextBroker({
    localRoot: root,
    bindings: [{ blockId: 'ctx_1', file: 'src/partials/sample.liquid' }],
  });
  assert.throws(
    () => broker.getBlock('ctx_missing'),
    (error) => error.code === 'CONTEXT_BLOCK_UNKNOWN',
  );
});

test('broker fails closed on stale hash verification mismatch', () => {
  const root = makeWorkspace();
  const broker = createContextBroker({
    localRoot: root,
    bindings: [{ blockId: 'ctx_1', file: 'src/partials/sample.liquid' }],
  });
  assert.throws(
    () => broker.getBlock('ctx_1', { expectedSha256: 'sha256:' + '0'.repeat(64) }),
    (error) => error.code === 'CONTEXT_HASH_MISMATCH',
  );
});

test('broker re-reads disk and rejects drift after registration', () => {
  const root = makeWorkspace();
  const filePath = path.join(root, 'src', 'partials', 'sample.liquid');
  const broker = createContextBroker({
    localRoot: root,
    bindings: [{ blockId: 'ctx_1', file: 'src/partials/sample.liquid' }],
  });
  broker.getBlock('ctx_1');
  writeFileSync(filePath, '<select id="mutated"></select>\n', 'utf8');
  assert.throws(
    () => broker.getBlock('ctx_1'),
    (error) => error.code === 'CONTEXT_STALE',
  );
});

test('registerBindings is atomic and preserves prior bindings on failure', () => {
  const root = makeWorkspace();
  const broker = createContextBroker({
    localRoot: root,
    bindings: [{ blockId: 'ctx_1', file: 'src/partials/sample.liquid' }],
  });
  assert.throws(
    () => broker.registerBindings([
      { blockId: 'ctx_1', file: 'src/partials/sample.liquid' },
      { blockId: 'ctx_bad', file: 'src/partials/missing.liquid' },
    ]),
    (error) => error.code === 'CONTEXT_FILE_MISSING',
  );
  assert.deepEqual(broker.listBlockIds(), ['ctx_1']);
  broker.getBlock('ctx_1');
});

test('broker rejects range end beyond file length', () => {
  const root = makeWorkspace();
  assert.throws(
    () => createContextBroker({
      localRoot: root,
      bindings: [{ blockId: 'ctx_1', file: 'src/partials/sample.liquid', startLine: 1, endLine: 999 }],
    }),
    (error) => error.code === 'CONTEXT_RANGE_OUT_OF_BOUNDS',
  );
});

for (const attemptedPath of [
  '../.env',
  '.git/config',
  '/etc/passwd',
  'src/assets/logo.bin',
  'symlink-outside-root',
]) {
  test(`denies ${attemptedPath}`, async () => {
    const root = makeWorkspace();
    if (attemptedPath === 'symlink-outside-root') {
      const outside = mkdtempSync(path.join(tmpdir(), 'ada-outside-'));
      writeFileSync(path.join(outside, 'secret.txt'), 'outside', 'utf8');
      symlinkSync(outside, path.join(root, 'escape-link'));
      assert.throws(
        () => createContextBroker({
          localRoot: root,
          bindings: [{ blockId: 'ctx_escape', file: 'escape-link/secret.txt' }],
        }),
        (error) => error.code === 'CONTEXT_SYMLINK_ESCAPE' || error.code === 'CONTEXT_PATH_DENIED',
      );
      return;
    }

    const broker = createContextBroker({ localRoot: root, bindings: [] });
    await assert.rejects(
      () => Promise.resolve().then(() => broker.readByRequestedPath(attemptedPath)),
      (error) => error.code === 'CONTEXT_PATH_DENIED',
    );

    if (attemptedPath.startsWith('/')) {
      assert.throws(
        () => createContextBroker({
          localRoot: root,
          bindings: [{ blockId: 'ctx_bad', file: attemptedPath }],
        }),
        (error) => error.code === 'CONTEXT_PATH_DENIED',
      );
      return;
    }

    assert.throws(
      () => createContextBroker({
        localRoot: root,
        bindings: [{ blockId: 'ctx_bad', file: attemptedPath }],
      }),
      (error) => [
        'CONTEXT_PATH_DENIED',
        'CONTEXT_UNSUPPORTED_EXTENSION',
        'CONTEXT_FILE_MISSING',
        'CONTEXT_SYMLINK_ESCAPE',
      ].includes(error.code),
    );
  });
}

test('broker rejects missing allowlisted files', () => {
  const root = makeWorkspace();
  assert.throws(
    () => createContextBroker({
      localRoot: root,
      bindings: [{ blockId: 'ctx_missing', file: 'src/partials/missing.liquid' }],
    }),
    (error) => error.code === 'CONTEXT_FILE_MISSING',
  );
});

test('broker rejects oversized blocks', () => {
  const root = makeWorkspace();
  writeFileSync(path.join(root, 'src', 'partials', 'huge.liquid'), 'x'.repeat(70_000), 'utf8');
  assert.throws(
    () => createContextBroker({
      localRoot: root,
      bindings: [{ blockId: 'ctx_huge', file: 'src/partials/huge.liquid' }],
    }),
    (error) => error.code === 'CONTEXT_BLOCK_TOO_LARGE',
  );
});

test('hashBlockText is stable for identical content', () => {
  const text = '<div>same</div>';
  assert.equal(hashBlockText(text), hashBlockText(text));
});

test('rejects symlink retarget before reading outside bytes', () => {
  const root = makeWorkspace();
  const target = path.join(root, 'src', 'partials', 'sample.liquid');
  const outside = mkdtempSync(path.join(tmpdir(), 'ada-outside-'));
  writeFileSync(path.join(outside, 'secret.liquid'), '<secret>outside</secret>\n', 'utf8');

  const broker = createContextBroker({
    localRoot: root,
    bindings: [{ blockId: 'ctx_1', file: 'src/partials/sample.liquid' }],
  });
  broker.getBlock('ctx_1');

  unlinkSync(target);
  symlinkSync(path.join(outside, 'secret.liquid'), target);

  assert.throws(
    () => broker.getBlock('ctx_1'),
    (error) => error.code === 'CONTEXT_SYMLINK_RETARGET' || error.code === 'CONTEXT_SYMLINK_ESCAPE',
  );
});

test('rejects regular file replacement via dev/ino identity mismatch', () => {
  const root = makeWorkspace();
  const target = path.join(root, 'src', 'partials', 'sample.liquid');

  const broker = createContextBroker({
    localRoot: root,
    bindings: [{ blockId: 'ctx_1', file: 'src/partials/sample.liquid' }],
  });
  broker.getBlock('ctx_1');

  unlinkSync(target);
  writeFileSync(target, '<select id="replaced">new</select>\n', 'utf8');

  assert.throws(
    () => broker.getBlock('ctx_1'),
    (error) => error.code === 'CONTEXT_FILE_REPLACED' || error.code === 'CONTEXT_STALE',
  );
});
