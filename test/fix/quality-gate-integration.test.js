import { createHash } from 'node:crypto';
import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSourcePreimage } from '../../src/tracer/preimage.js';
import {
  applyTraceResultsToFindings,
  createSourceTraceInbox,
  traceAllFindings,
} from '../../src/fix/trace/inbox.js';
import { buildTraceCandidatesFromFindings } from '../../src/fix/trace/candidates.js';
import { createProductionScannerAdapter } from '../../src/fix/verify/scanner.js';
import { createStaticSiteAdapter } from '../../src/fix/verify/site.js';
import {
  buildVerificationKey,
  compareVerificationFindings,
} from '../../src/fix/verify/verification-key.js';
import { readAndVerifyArtifact } from '../../src/fix/verify/artifact.js';
import { evaluateQualityGate } from '../../src/fix/eval/poc-gates.js';
import { runFullPocHttpSession } from './helpers/poc-session.js';

const BENCHMARK_DIR = fileURLToPath(new URL('../fixtures/fix/scanner-benchmark', import.meta.url));
const EXPECTED_TARGETS = JSON.parse(
  readFileSync(join(BENCHMARK_DIR, 'expected-targets.json'), 'utf8'),
);

function findingIdFor(label) {
  return `sha256:${createHash('sha256').update(label).digest('hex')}`;
}

function runTraceCorpus(root) {
  const pagesDir = join(root, 'src', 'pages');
  mkdirSync(pagesDir, { recursive: true });
  const findings = [];
  for (let index = 0; index < 100; index += 1) {
    const rel = `src/pages/case-${String(index).padStart(3, '0')}.liquid`;
    const content = `{% layout %}\n<main>\n  <button id="btn-${index}">Go</button>\n</main>\n`;
    writeFileSync(join(root, rel), content);
    const preimage = buildSourcePreimage(content, 3);
    findings.push({
      findingId: findingIdFor(`quality-case-${index}`),
      route: `/case-${index}`,
      pageState: 'initial',
      category: 'accessibility',
      layer: 'axe',
      nativeRuleId: 'button-name',
      canonicalRuleId: 'button-name',
      impact: 'critical',
      source: {
        file: rel,
        line: 3,
        confidence: 'high',
        method: 'instrumentation-manifest',
        preimageSha256: preimage.preimageSha256,
        preimageRange: preimage.range,
      },
    });
  }

  const sessionDir = join(root, 'scan-reports', 'fix-sessions', 'quality-corpus');
  mkdirSync(sessionDir, { recursive: true });
  const inbox = createSourceTraceInbox({
    reportId: 'sha256:quality-corpus',
    localRoot: root,
    sessionDir,
    candidates: buildTraceCandidatesFromFindings(findings),
  });
  const traceResults = traceAllFindings(inbox, findings);
  const traced = applyTraceResultsToFindings(findings, traceResults);

  return traced.map((finding) => {
    const result = traceResults.find((row) => row.findingId === finding.findingId);
    const partials = result?.partials || [];
    const top = partials[0];
    return {
      ambiguous: partials.filter((row) => row.confidence === 'high').length > 1,
      expectedFile: finding.source?.file || null,
      expectedLine: finding.source?.line || null,
      actualFile: top?.file || null,
      actualLine: top?.line || null,
    };
  });
}

function normalizeDetected(findings) {
  return findings.map((finding) => ({
    canonicalRuleId: finding.canonicalRuleId || finding.ruleId || finding.nativeRuleId,
    route: finding.route || '/',
    pageState: finding.pageState || 'initial',
    selector: finding.selector || finding.element?.selector || null,
  }));
}

test('quality gate is derived from real trace, scanner, shadow-build, and review evidence', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-quality-gate-'));
  let siteHandle = null;
  let pocSession = null;
  try {
    const traceRoot = join(root, 'trace');
    mkdirSync(traceRoot, { recursive: true });
    const traceCases = runTraceCorpus(traceRoot);

    const scannerRoot = join(root, 'scanner');
    const siteRoot = join(scannerRoot, 'site');
    mkdirSync(siteRoot, { recursive: true });
    cpSync(BENCHMARK_DIR, siteRoot, { recursive: true });
    siteHandle = await createStaticSiteAdapter({ outDir: '.' }).start(siteRoot);
    const scanner = createProductionScannerAdapter();
    const baselineScan = await scanner({
      siteUrl: siteHandle.url,
      routes: ['/'],
      layers: ['accessibility'],
      targetFindingIds: [],
    });
    const detectorDetected = normalizeDetected(baselineScan.findings);
    const detectedKeys = new Set(detectorDetected.map((item) => buildVerificationKey(item)));
    assert.ok(
      EXPECTED_TARGETS.filter((item) => detectedKeys.has(buildVerificationKey(item))).length
        / EXPECTED_TARGETS.length >= 0.9,
    );

    const benchmarkHtmlPath = join(siteRoot, 'index.html');
    const benchmarkHtml = readFileSync(benchmarkHtmlPath, 'utf8');
    writeFileSync(
      benchmarkHtmlPath,
      benchmarkHtml.replace(
        '<button id="btn-1"></button>',
        '<button id="btn-1" aria-label="Button 1"></button>',
      ),
    );
    const afterScan = await scanner({
      siteUrl: siteHandle.url,
      routes: ['/'],
      layers: ['accessibility'],
      targetFindingIds: [],
    });
    const detectorDelta = compareVerificationFindings(
      baselineScan.findings,
      afterScan.findings,
      [],
    );

    const pocRoot = join(root, 'poc');
    mkdirSync(pocRoot, { recursive: true });
    pocSession = await runFullPocHttpSession(pocRoot);
    assert.equal(pocSession.applyStatus, 200);
    const snapshot = pocSession.cli.reviewState.getSnapshot();
    const acceptedUnit = snapshot.units.find((row) => row.reviewStatus === 'accepted');
    assert.ok(acceptedUnit?.candidate?.verified);
    const artifact = readAndVerifyArtifact(
      pocSession.sessionDir,
      acceptedUnit.candidate.verification.artifactId,
      {
        candidateHash: acceptedUnit.candidate.candidateHash,
        diffHash: acceptedUnit.candidate.diffHash,
      },
    );

    const unitFindingIds = pocSession.cli.fixUnits.flatMap((unit) => unit.findingIds || []);
    const gate = evaluateQualityGate({
      traceCases,
      acceptedBuildExitCodes: [artifact.build.exitCode],
      detectorTargets: EXPECTED_TARGETS,
      detectorDetected,
      newCriticalSerious: detectorDelta.newCriticalSerious,
      manualChecksRetained: artifact.manualChecks.length > 0
        && acceptedUnit.candidate.manualChecks.length === artifact.manualChecks.length,
      manualChecksAcknowledged: artifact.manualChecksAcknowledged,
      unitFindingIds,
    });

    assert.equal(gate.ok, true, JSON.stringify(gate));
    assert.equal(detectorDelta.newCriticalSerious.length, 0);
    assert.ok(gate.precision >= 0.99);
    assert.ok(gate.closure >= 0.9);
  } finally {
    await pocSession?.cli?.reviewServer?.close().catch(() => {});
    await siteHandle?.stop().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
});
