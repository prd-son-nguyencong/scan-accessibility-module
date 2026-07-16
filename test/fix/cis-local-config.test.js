import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertBundleRedacted } from '../../scripts/lib/cis-redaction.js';
import {
  CIS_KEYS,
  extractBrunoCisSettings,
  mergeEnvSettings,
  writeEnvAtomic,
} from '../../scripts/lib/cis-local-config.js';
import { loadTrustedCaBundle } from '../../src/fix/cis/ca.js';
import { runCisConfigureCli } from '../../scripts/cis-configure.js';
import { __transactionTestHooks } from '../../src/fix/apply/transaction.js';
import { fingerprintForCaPem, TEST_CA_PATH } from './helpers/cis-ca-fixture.js';

const SENTINEL_FEATURE_KEY = 'secret-test-feature-key-value';
const SENTINEL_HOST = 'cis.example.test';
const SENTINEL_BASE = `https://${SENTINEL_HOST}/ml/inference/cis`;
const SENTINEL_MODEL = 'anthropic.claude-sonnet-4-20250514-v1:0';

function modelsSource(url = `${SENTINEL_BASE}/v1alpha1/models`, featureKey = SENTINEL_FEATURE_KEY) {
  return `meta {\n  name: get-models\n}\n\nget {\n  url: ${url}\n}\n\nheaders {\n  Wd-PCA-Feature-Key: ${featureKey}\n}\n`;
}

function predictionsSource(body = `{"target":{"provider":"aws","model":"${SENTINEL_MODEL}"}}`) {
  return `meta {\n  name: predictions\n}\n\npost {\n  url: https://example.test/predictions\n}\n\nbody:json {\n${body}\n}\n`;
}

function brunoCollection(root, {
  models = modelsSource(),
  predictions = predictionsSource(),
} = {}) {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'get-models.bru'), models, { mode: 0o600 });
  writeFileSync(join(root, 'predictions.bru'), predictions, { mode: 0o600 });
}

function assertNoSentinelLeak(output) {
  assert.equal(output.includes(SENTINEL_FEATURE_KEY), false, 'feature key leaked');
  assert.equal(output.includes(SENTINEL_HOST), false, 'host leaked');
  assert.equal(output.includes(SENTINEL_BASE), false, 'base URL leaked');
  assert.equal(output.includes(SENTINEL_MODEL), false, 'model leaked');
  assert.equal(output.includes(TEST_CA_PATH), false, 'CA path leaked');
}

test('extractBrunoCisSettings extracts HTTPS models URL, feature key, provider, and model', () => {
  const extracted = extractBrunoCisSettings({
    modelsSource: modelsSource(),
    predictionsSource: predictionsSource(),
  });
  assert.equal(extracted.baseUrl, SENTINEL_BASE);
  assert.equal(extracted.allowedHost, SENTINEL_HOST);
  assert.equal(extracted.provider, 'aws');
  assert.equal(extracted.model, SENTINEL_MODEL);
  assert.equal(extracted.featureKey, SENTINEL_FEATURE_KEY);
  assert.deepEqual(Object.keys(extracted).sort(), [
    'allowedHost',
    'baseUrl',
    'featureKey',
    'model',
    'provider',
  ]);
});

test('extractBrunoCisSettings strips query and hash from models URL only', () => {
  const extracted = extractBrunoCisSettings({
    modelsSource: modelsSource(`${SENTINEL_BASE}/v1alpha1/models?bypass_auth=true&model=#frag`),
    predictionsSource: predictionsSource(),
  });
  assert.equal(extracted.baseUrl, SENTINEL_BASE);
});

test('extractBrunoCisSettings parses balanced JSON with escaped strings', () => {
  const extracted = extractBrunoCisSettings({
    modelsSource: modelsSource(),
    predictionsSource: predictionsSource(
      '{"target":{"provider":"aws","model":"anthropic.claude-sonnet-4-20250514-v1:0"},"note":"brace: \\"}"}',
    ),
  });
  assert.equal(extracted.model, SENTINEL_MODEL);
});

test('extractBrunoCisSettings rejects duplicate models URLs', () => {
  const source = `${modelsSource()}\nget {\n  url: ${SENTINEL_BASE}/v1alpha1/models\n}\n`;
  assert.throws(() => extractBrunoCisSettings({ modelsSource: source, predictionsSource: predictionsSource() }), /exactly once/i);
});

test('extractBrunoCisSettings rejects Bruno variable feature keys', () => {
  assert.throws(
    () =>
      extractBrunoCisSettings({
        modelsSource: modelsSource(`${SENTINEL_BASE}/v1alpha1/models`, '{{featureKey}}'),
        predictionsSource: predictionsSource(),
      }),
    /exactly once|invalid/i,
  );
});

test('extractBrunoCisSettings rejects duplicate feature keys', () => {
  const source = `${modelsSource()}\nheaders {\n  Wd-PCA-Feature-Key: ${SENTINEL_FEATURE_KEY}\n}\n`;
  assert.throws(() => extractBrunoCisSettings({ modelsSource: source, predictionsSource: predictionsSource() }), /exactly once/i);
});

test('extractBrunoCisSettings rejects non-HTTPS models URLs', () => {
  assert.throws(
    () =>
      extractBrunoCisSettings({
        modelsSource: modelsSource(`http://${SENTINEL_HOST}/ml/inference/cis/v1alpha1/models`),
        predictionsSource: predictionsSource(),
      }),
    /HTTPS/i,
  );
});

test('extractBrunoCisSettings rejects models URLs without /v1alpha1/models suffix', () => {
  assert.throws(
    () =>
      extractBrunoCisSettings({
        modelsSource: modelsSource(`${SENTINEL_BASE}/v1alpha1/model`),
        predictionsSource: predictionsSource(),
      }),
    /HTTPS|models/i,
  );
});

test('extractBrunoCisSettings rejects missing provider or model', () => {
  assert.throws(
    () =>
      extractBrunoCisSettings({
        modelsSource: modelsSource(),
        predictionsSource: predictionsSource('{"target":{"provider":"aws"}}'),
      }),
    /invalid/i,
  );
  assert.throws(
    () =>
      extractBrunoCisSettings({
        modelsSource: modelsSource(),
        predictionsSource: predictionsSource('{"target":{"model":"anthropic.claude-sonnet-4"}}'),
      }),
    /invalid/i,
  );
});

test('extractBrunoCisSettings rejects models URLs with embedded username', () => {
  assert.throws(
    () =>
      extractBrunoCisSettings({
        modelsSource: modelsSource(`https://user@${SENTINEL_HOST}/ml/inference/cis/v1alpha1/models`),
        predictionsSource: predictionsSource(),
      }),
    /credentials|HTTPS/i,
  );
});

test('extractBrunoCisSettings rejects models URLs with embedded password', () => {
  assert.throws(
    () =>
      extractBrunoCisSettings({
        modelsSource: modelsSource(`https://user:secret@${SENTINEL_HOST}/ml/inference/cis/v1alpha1/models`),
        predictionsSource: predictionsSource(),
      }),
    /credentials|HTTPS/i,
  );
});

test('extractBrunoCisSettings rejects decoy JSON objects inside body:json wrapper', () => {
  assert.throws(
    () =>
      extractBrunoCisSettings({
        modelsSource: modelsSource(),
        predictionsSource: predictionsSource(
          `{"decoy":true}\n{"target":{"provider":"aws","model":"${SENTINEL_MODEL}"}}`,
        ),
      }),
    /ambiguous|exactly once/i,
  );
});

test('extractBrunoCisSettings rejects trailing non-whitespace inside body:json wrapper', () => {
  assert.throws(
    () =>
      extractBrunoCisSettings({
        modelsSource: modelsSource(),
        predictionsSource: predictionsSource(`{"target":{"provider":"aws","model":"${SENTINEL_MODEL}"}}\ntrailing`),
      }),
    /ambiguous|exactly once/i,
  );
});

test('extractBrunoCisSettings rejects trailing content after body:json wrapper', () => {
  const predictions = `${predictionsSource()}\ndecoy: value\n`;
  assert.throws(
    () =>
      extractBrunoCisSettings({
        modelsSource: modelsSource(),
        predictionsSource: predictions,
      }),
    /ambiguous|exactly once/i,
  );
});

test('extractBrunoCisSettings rejects multiple body:json sections', () => {
  const predictions = `${predictionsSource()}\nbody:json {\n{"target":{"provider":"aws","model":"${SENTINEL_MODEL}"}}\n}\n`;
  assert.throws(
    () =>
      extractBrunoCisSettings({
        modelsSource: modelsSource(),
        predictionsSource: predictions,
      }),
    /exactly once|ambiguous/i,
  );
});

test('mergeEnvSettings replaces export and indented managed keys canonically', () => {
  const existing = 'export CIS_PROXY_URL="old"\n  CIS_MODEL = old-model\n';
  const merged = mergeEnvSettings(existing, {
    CIS_PROXY_URL: SENTINEL_BASE,
    CIS_AUTH_TOKEN: SENTINEL_FEATURE_KEY,
    CIS_ALLOWED_HOSTS: SENTINEL_HOST,
    CIS_PROVIDER: 'aws',
    CIS_MODEL: SENTINEL_MODEL,
    CIS_CA_BUNDLE_PATH: TEST_CA_PATH,
    CIS_CA_SHA256: fingerprintForCaPem(readFileSync(TEST_CA_PATH, 'utf8')),
  });
  assert.match(merged, /^CIS_PROXY_URL="https:\/\/cis\.example\.test\/ml\/inference\/cis"/m);
  assert.match(merged, /^CIS_MODEL="anthropic\.claude-sonnet-4-20250514-v1:0"/m);
  assert.equal(/\bexport CIS_/.test(merged), false);
  assert.equal(/^\s+CIS_MODEL/m.test(merged), false);
});

test('mergeEnvSettings rejects cross-form duplicate managed keys', () => {
  assert.throws(
    () =>
      mergeEnvSettings('export CIS_PROXY_URL=one\nCIS_PROXY_URL=two\n', {
        CIS_PROXY_URL: SENTINEL_BASE,
        CIS_AUTH_TOKEN: SENTINEL_FEATURE_KEY,
        CIS_ALLOWED_HOSTS: SENTINEL_HOST,
        CIS_PROVIDER: 'aws',
        CIS_MODEL: SENTINEL_MODEL,
        CIS_CA_BUNDLE_PATH: TEST_CA_PATH,
        CIS_CA_SHA256: fingerprintForCaPem(readFileSync(TEST_CA_PATH, 'utf8')),
      }),
    /Duplicate CIS_PROXY_URL/i,
  );
  assert.throws(
    () =>
      mergeEnvSettings('  export CIS_MODEL = one\nexport CIS_MODEL=two\n', {
        CIS_PROXY_URL: SENTINEL_BASE,
        CIS_AUTH_TOKEN: SENTINEL_FEATURE_KEY,
        CIS_ALLOWED_HOSTS: SENTINEL_HOST,
        CIS_PROVIDER: 'aws',
        CIS_MODEL: SENTINEL_MODEL,
        CIS_CA_BUNDLE_PATH: TEST_CA_PATH,
        CIS_CA_SHA256: fingerprintForCaPem(readFileSync(TEST_CA_PATH, 'utf8')),
      }),
    /Duplicate CIS_MODEL/i,
  );
});

test('runCisConfigureCli rejects CA leaf symlinks and binds verified path to stored env', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-cis-configure-ca-link-'));
  try {
    const collection = join(root, 'collection');
    const envPath = join(root, '.env');
    const caDir = join(root, 'ca');
    brunoCollection(collection);
    writeFileSync(envPath, '# keep\n', { mode: 0o600 });
    mkdirSync(caDir, { recursive: true });
    const realCa = join(caDir, 'ca.pem');
    writeFileSync(realCa, readFileSync(TEST_CA_PATH, 'utf8'), { mode: 0o644 });
    const linkCa = join(caDir, 'ca-link.pem');
    symlinkSync(realCa, linkCa);
    const caSha256 = fingerprintForCaPem(readFileSync(realCa, 'utf8'));
    const stderr = [];

    const linkCode = await runCisConfigureCli({
      argv: [
        'node',
        'cis-configure.js',
        '--collection',
        collection,
        '--env',
        envPath,
        '--ca-bundle',
        linkCa,
        '--ca-sha256',
        caSha256,
      ],
      stdoutWrite: () => {},
      stderrWrite: (chunk) => stderr.push(String(chunk)),
    });

    assert.notEqual(linkCode, 0);
    assert.match(stderr.join(''), /CIS_CA_UNTRUSTED_PATH:/);
    assert.equal(readFileSync(envPath, 'utf8'), '# keep\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runCisConfigureCli passes the same canonical CA path to loader and env', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-cis-configure-ca-bind-'));
  try {
    const collection = join(root, 'collection');
    const envPath = join(root, '.env');
    const caDir = join(root, 'trusted');
    brunoCollection(collection);
    writeFileSync(envPath, '# keep\n', { mode: 0o600 });
    mkdirSync(caDir, { recursive: true });
    const caPath = join(caDir, 'ca.pem');
    writeFileSync(caPath, readFileSync(TEST_CA_PATH, 'utf8'), { mode: 0o644 });
    const caSha256 = fingerprintForCaPem(readFileSync(caPath, 'utf8'));
    let loaderPath = null;

    const code = await runCisConfigureCli({
      argv: [
        'node',
        'cis-configure.js',
        '--collection',
        collection,
        '--env',
        envPath,
        '--ca-bundle',
        caPath,
        '--ca-sha256',
        caSha256,
      ],
      stdoutWrite: () => {},
      stderrWrite: () => {},
      loadTrustedCaBundle: (filePath, expectedSha256) => {
        loaderPath = filePath;
        return loadTrustedCaBundle(filePath, expectedSha256);
      },
    });

    assert.equal(code, 0);
    const envContents = readFileSync(envPath, 'utf8');
    const storedPath = envContents.match(/^CIS_CA_BUNDLE_PATH=(.+)$/m)?.[1];
    assert.ok(storedPath);
    assert.equal(JSON.parse(storedPath), loaderPath);
    assert.equal(loaderPath.endsWith(`${join('trusted', 'ca.pem')}`), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('extractBrunoCisSettings rejects malformed JSON bodies', () => {
  assert.throws(
    () =>
      extractBrunoCisSettings({
        modelsSource: modelsSource(),
        predictionsSource: predictionsSource('{"target":{"provider":"aws","model":'),
      }),
    /JSON|incomplete|missing|ambiguous/i,
  );
});

test('mergeEnvSettings preserves unrelated lines and replaces managed keys once', () => {
  const existing = `# comment\nUNRELATED=keep\nCIS_PROXY_URL="old"\n\nCIS_MODEL=old-model\n`;
  const merged = mergeEnvSettings(existing, {
    CIS_PROXY_URL: SENTINEL_BASE,
    CIS_AUTH_TOKEN: SENTINEL_FEATURE_KEY,
    CIS_ALLOWED_HOSTS: SENTINEL_HOST,
    CIS_PROVIDER: 'aws',
    CIS_MODEL: SENTINEL_MODEL,
    CIS_CA_BUNDLE_PATH: TEST_CA_PATH,
    CIS_CA_SHA256: fingerprintForCaPem(readFileSync(TEST_CA_PATH, 'utf8')),
  });
  assert.match(merged, /^# comment\nUNRELATED=keep\n/);
  assert.match(merged, /CIS_PROXY_URL="https:\/\/cis\.example\.test\/ml\/inference\/cis"/);
  assert.match(merged, /CIS_MODEL="anthropic\.claude-sonnet-4-20250514-v1:0"/);
  assert.equal(merged.endsWith('\n'), true);
  assert.equal(merged.includes('\n\n\n'), false);
});

test('mergeEnvSettings appends missing managed keys in fixed order', () => {
  const merged = mergeEnvSettings('', {
    CIS_PROXY_URL: SENTINEL_BASE,
    CIS_AUTH_TOKEN: SENTINEL_FEATURE_KEY,
    CIS_ALLOWED_HOSTS: SENTINEL_HOST,
    CIS_PROVIDER: 'aws',
    CIS_MODEL: SENTINEL_MODEL,
    CIS_CA_BUNDLE_PATH: TEST_CA_PATH,
    CIS_CA_SHA256: fingerprintForCaPem(readFileSync(TEST_CA_PATH, 'utf8')),
  });
  const keys = merged
    .trim()
    .split('\n')
    .map((line) => line.split('=')[0]);
  assert.deepEqual(keys, [...CIS_KEYS]);
});

test('mergeEnvSettings rejects duplicate managed keys', () => {
  assert.throws(
    () =>
      mergeEnvSettings('CIS_PROXY_URL=one\nCIS_PROXY_URL=two\n', {
        CIS_PROXY_URL: SENTINEL_BASE,
        CIS_AUTH_TOKEN: SENTINEL_FEATURE_KEY,
        CIS_ALLOWED_HOSTS: SENTINEL_HOST,
        CIS_PROVIDER: 'aws',
        CIS_MODEL: SENTINEL_MODEL,
        CIS_CA_BUNDLE_PATH: TEST_CA_PATH,
        CIS_CA_SHA256: fingerprintForCaPem(readFileSync(TEST_CA_PATH, 'utf8')),
      }),
    /Duplicate CIS_PROXY_URL/i,
  );
});

test('mergeEnvSettings rejects undefined and newline values', () => {
  const settings = Object.fromEntries(CIS_KEYS.map((key) => [key, 'ok']));
  settings.CIS_MODEL = undefined;
  assert.throws(() => mergeEnvSettings('', settings), /undefined/i);
  settings.CIS_MODEL = 'ok';
  settings.CIS_PROVIDER = 'bad\nvalue';
  assert.throws(() => mergeEnvSettings('', settings), /invalid/i);
  settings.CIS_PROVIDER = 'ok\0value';
  assert.throws(() => mergeEnvSettings('', settings), /invalid/i);
});

test('writeEnvAtomic writes mode 0600 atomically', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-cis-env-'));
  try {
    const envPath = join(root, '.env');
    writeEnvAtomic(envPath, 'CIS_PROXY_URL="https://example.test"\n');
    const mode = fstatSync(openSync(envPath, constants.O_RDONLY)).mode & 0o777;
    closeSync(openSync(envPath, constants.O_RDONLY));
    assert.equal(mode, 0o600);
    assert.equal(readFileSync(envPath, 'utf8'), 'CIS_PROXY_URL="https://example.test"\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('writeEnvAtomic rejects symlink and non-regular destinations', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-cis-env-bad-'));
  try {
    const target = join(root, 'target.env');
    const link = join(root, 'link.env');
    writeFileSync(target, 'keep\n', { mode: 0o600 });
    symlinkSync(target, link);
    assert.throws(() => writeEnvAtomic(link, 'x\n'), /symlink/i);
    mkdirSync(join(root, 'dir.env'));
    assert.throws(() => writeEnvAtomic(join(root, 'dir.env'), 'x\n'), /regular file/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('writeEnvAtomic leaves no temp artifacts when rename fails', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-cis-env-rename-'));
  const envPath = join(root, '.env');
  const previousRename = __transactionTestHooks.renameSync;
  try {
    __transactionTestHooks.renameSync = () => {
      throw new Error('forced rename failure');
    };
    assert.throws(() => writeEnvAtomic(envPath, 'CIS_PROXY_URL="x"\n'), /forced rename failure/);
    const leftovers = readdirSync(root).filter((entry) => entry.includes('.tmp'));
    assert.deepEqual(leftovers, []);
    assert.equal(existsSync(envPath), false);
  } finally {
    __transactionTestHooks.renameSync = previousRename;
    rmSync(root, { recursive: true, force: true });
  }
});

test('cis-configure script is import-safe and redacted', async () => {
  const source = readFileSync(new URL('../../scripts/cis-configure.js', import.meta.url), 'utf8');
  assert.match(source, /runCisConfigureCli/);
  assert.match(source, /parseArgs/);
  assert.match(source, /loadTrustedCaBundle/);
  assert.match(source, /writeEnvAtomic/);
  assert.match(source, /isMain/);
  assertBundleRedacted(source, 'scripts/cis-configure.js');
});

test('runCisConfigureCli success prints exact updated key list and writes managed env keys', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-cis-configure-'));
  try {
    const collection = join(root, 'collection');
    const envPath = join(root, '.env');
    brunoCollection(collection);
    writeFileSync(envPath, '# keep\nOTHER=value\n', { mode: 0o600 });
    const caSha256 = fingerprintForCaPem(readFileSync(TEST_CA_PATH, 'utf8'));
    const stdout = [];
    const stderr = [];

    const code = await runCisConfigureCli({
      argv: [
        'node',
        'cis-configure.js',
        '--collection',
        collection,
        '--env',
        envPath,
        '--ca-bundle',
        TEST_CA_PATH,
        '--ca-sha256',
        caSha256,
      ],
      stdoutWrite: (chunk) => stdout.push(String(chunk)),
      stderrWrite: (chunk) => stderr.push(String(chunk)),
    });

    assert.equal(code, 0);
    assert.equal(stderr.join(''), '');
    assert.equal(stdout.join(''), `${JSON.stringify({ ok: true, updated: [...CIS_KEYS] })}\n`);
    const envContents = readFileSync(envPath, 'utf8');
    assert.match(envContents, /^# keep\nOTHER=value\n/);
    for (const key of CIS_KEYS) {
      assert.match(envContents, new RegExp(`^${key}=`, 'm'));
    }
    assert.equal(fstatSync(openSync(envPath, constants.O_RDONLY)).mode & 0o777, 0o600);
    closeSync(openSync(envPath, constants.O_RDONLY));
    assertNoSentinelLeak(stdout.join('') + stderr.join(''));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runCisConfigureCli failure is redacted and leaves env unchanged without temp artifacts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-cis-configure-fail-'));
  try {
    const collection = join(root, 'collection');
    const envPath = join(root, '.env');
    brunoCollection(collection, {
      models: modelsSource(`${SENTINEL_BASE}/v1alpha1/models`, '{{featureKey}}'),
    });
    const original = '# untouched\nCIS_PROXY_URL="old"\n';
    writeFileSync(envPath, original, { mode: 0o600 });
    const caSha256 = fingerprintForCaPem(readFileSync(TEST_CA_PATH, 'utf8'));
    const stdout = [];
    const stderr = [];

    const code = await runCisConfigureCli({
      argv: [
        'node',
        'cis-configure.js',
        '--collection',
        collection,
        '--env',
        envPath,
        '--ca-bundle',
        TEST_CA_PATH,
        '--ca-sha256',
        caSha256,
      ],
      stdoutWrite: (chunk) => stdout.push(String(chunk)),
      stderrWrite: (chunk) => stderr.push(String(chunk)),
    });

    assert.notEqual(code, 0);
    assert.equal(stdout.join(''), '');
    assert.match(stderr.join(''), /CIS_CONFIGURE_INVALID:/);
    assert.equal(readFileSync(envPath, 'utf8'), original);
    assert.deepEqual(readdirSync(root).filter((entry) => entry.includes('.tmp')), []);
    assertNoSentinelLeak(stderr.join(''));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
