import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createProductionScannerAdapter,
  evaluateSourceTraceForBindings,
} from '../../src/fix/verify/scanner.js';
import { createStaticSiteAdapter } from '../../src/fix/verify/site.js';
import { buildVerificationKey } from '../../src/fix/verify/verification-key.js';
import { ShadowVerificationError } from '../../src/fix/verify/shadow.js';

const BENCHMARK_DIR = fileURLToPath(new URL('../fixtures/fix/scanner-benchmark', import.meta.url));
const EXPECTED_TARGETS = JSON.parse(
  readFileSync(join(BENCHMARK_DIR, 'expected-targets.json'), 'utf8'),
);

test('production scanner benchmark: >=90% closure on committed HTML with >=10 declared targets', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ada-scanner-benchmark-'));
  try {
    const siteRoot = join(root, 'site');
    mkdirSync(siteRoot, { recursive: true });
    cpSync(BENCHMARK_DIR, siteRoot, { recursive: true });

    const site = createStaticSiteAdapter({ outDir: '.' });
    const handle = await site.start(siteRoot);
    const scanner = createProductionScannerAdapter();

    try {
      const result = await scanner({
        siteUrl: handle.url,
        routes: ['/'],
        layers: ['accessibility'],
        targetFindingIds: [],
      });

      assert.ok(Array.isArray(result.findings) && result.findings.length > 0, 'scanner must return findings');
      assert.deepEqual(result.executedLayers, ['axe', 'accessScan']);

      const detected = result.findings.map((finding) => ({
        canonicalRuleId: finding.canonicalRuleId || finding.ruleId || finding.nativeRuleId,
        route: finding.route || '/',
        pageState: finding.pageState || 'initial',
        selector: finding.selector || finding.element?.selector || null,
      }));

      const detectedKeys = new Set(detected.map((item) => buildVerificationKey(item)));
      const matched = EXPECTED_TARGETS.filter((item) => detectedKeys.has(buildVerificationKey(item)));
      const closure = matched.length / EXPECTED_TARGETS.length;

      assert.ok(EXPECTED_TARGETS.length >= 10, 'fixture must declare >=10 targets');
      assert.ok(closure >= 0.9, `closure ${closure} below 90% — matched ${matched.length}/${EXPECTED_TARGETS.length}`);

      const missing = EXPECTED_TARGETS.filter((item) => !detectedKeys.has(buildVerificationKey(item)));
      if (missing.length > 0) {
        t.diagnostic(`unmatched targets: ${JSON.stringify(missing.slice(0, 3))}`);
      }
    } finally {
      await handle.stop();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('production scanner fails closed on unsupported verification layers', async () => {
  const scanner = createProductionScannerAdapter();
  await assert.rejects(
    () => scanner({
      siteUrl: 'http://127.0.0.1:8765/',
      routes: ['/'],
      layers: ['performance'],
    }),
    (error) => error instanceof ShadowVerificationError && error.code === 'UNSUPPORTED_LAYER',
  );
});

test('production scanner preserves source attestation when a bound target is fixed', () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-scanner-source-trace-'));
  try {
    const sourceDir = join(root, 'src', 'partials');
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, 'header.liquid'), '<button aria-label="Menu"></button>\n');

    const trace = evaluateSourceTraceForBindings(
      [{ file: 'src/partials/header.liquid' }],
      [],
      ['fixed-target'],
      { workspaceRoot: root },
    );

    assert.equal(trace.sourceTraceResolved, true);
    assert.deepEqual(trace.perTarget, [{
      findingId: 'fixed-target',
      resolved: true,
      file: 'src/partials/header.liquid',
    }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
