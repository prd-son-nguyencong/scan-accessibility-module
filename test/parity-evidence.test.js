import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const evidenceUrl = new URL('./fixtures/hit-01-r1-parity.json', import.meta.url);

test('HIT-01 R1 parity evidence closes every ScanReportV2 resume condition', () => {
  const evidence = JSON.parse(readFileSync(evidenceUrl, 'utf8'));
  const allowedClassifications = new Set([
    'detected',
    'equivalent',
    'state-dependent',
    'manual-only',
    'unsupported',
    'confirmed-scanner-defect',
  ]);

  assert.equal(evidence.schemaVersion, '1.0.0');
  assert.equal(evidence.baseline.officialR2Evidence, false);
  assert.equal(evidence.resumeGate.conditions.length, 8);
  assert.equal(evidence.resumeGate.conditions.every((condition) => condition.status === 'pass'), true);

  assert.deepEqual(evidence.comparison.axe.automated.ruleIds.sort(), [
    'button-name',
    'heading-order',
    'landmark-main-is-top-level',
    'landmark-no-duplicate-main',
    'landmark-unique',
    'meta-viewport',
    'select-name',
  ]);
  assert.equal(evidence.comparison.axe.automated.issueGroups, 7);
  assert.equal(evidence.comparison.axe.automated.critical, 2);
  assert.equal(evidence.comparison.axe.automated.moderate, 5);

  assert.equal(evidence.comparison.accessScan.baselineFindings.length, 10);
  assert.equal(
    evidence.comparison.accessScan.baselineFindings.every((finding) =>
      allowedClassifications.has(finding.classification)
    ),
    true,
  );
  assert.equal(
    evidence.comparison.accessScan.baselineFindings.filter((finding) =>
      finding.classification === 'state-dependent'
    ).length,
    4,
  );

  assert.deepEqual(evidence.comparison.nuChecker.automated.raw, {
    errors: 21,
    warnings: 14,
    total: 35,
  });
  assert.equal(evidence.comparison.nuChecker.automated.ruleFamilies.includes('w3c-duplicate-id'), true);
  assert.equal(evidence.comparison.nuChecker.automated.ruleFamilies.includes('w3c-nested-interactive'), true);
  assert.equal(evidence.comparison.nuChecker.automated.ruleFamilies.includes('w3c-main-landmark-structure'), true);

  assert.deepEqual(
    evidence.comparison.lighthouseAccessibility.automated.ruleIds.sort(),
    ['button-name', 'heading-order', 'meta-viewport', 'select-name'],
  );
  assert.equal(evidence.comparison.psiMobile.automated.provenance.comparableToPsi, false);
  assert.equal(evidence.comparison.psiMobile.automated.provenance.fallbackReason.code, 'quota-exceeded');
  assert.equal(JSON.stringify(evidence).includes('project_number'), false);

  for (const run of evidence.automatedEvidence.scannerRuns) {
    assert.ok(run.engine.name);
    assert.ok(run.engine.version);
    assert.equal(run.pageState, 'initial');
  }
});
