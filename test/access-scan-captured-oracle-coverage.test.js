import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadBuiltInRuleRegistry } from '../src/scanner/access-scan/engine/builtin-registry.js';
import { PROFILES } from '../src/scanner/access-scan/engine/profiles.js';
import {
  isKnownExternalCommercialRuleId,
  normalizeCorpusRuleId,
  resolveNativeRuleId,
} from '../src/reporter/rule-aliases.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COVERAGE_FIXTURE = JSON.parse(
  readFileSync(path.join(__dirname, 'fixtures/access-scan/captured-oracle-rule-coverage.json'), 'utf8'),
);
const SEEDED_SITE_CASE_IDS = [
  'site-728',
  'site-695',
  'site-731',
  'site-710',
  'site-203',
  'site-538',
  'site-375',
  'site-124',
];

function collectSanitizedCaseRuleIds() {
  /** @type {Set<string>} */
  const ruleIds = new Set();
  const corpusRoot = path.join(__dirname, 'fixtures/accessscan-corpus/cases');

  for (const caseId of SEEDED_SITE_CASE_IDS) {
    const caseDir = path.join(corpusRoot, caseId);
    const expected = JSON.parse(readFileSync(path.join(caseDir, 'expected.json'), 'utf8'));
    for (const finding of expected.findings) {
      if (finding.ruleId) ruleIds.add(String(finding.ruleId));
      if (finding.canonicalRuleId) ruleIds.add(String(finding.canonicalRuleId));
    }

    const meta = JSON.parse(readFileSync(path.join(caseDir, 'meta.json'), 'utf8'));
    for (const note of meta.notes || []) {
      for (const match of String(note).matchAll(/\b([A-Z][A-Za-z0-9]+):/g)) {
        const candidate = match[1];
        if (candidate !== 'Limitation' && candidate !== 'Reprocess') {
          ruleIds.add(candidate);
        }
      }
    }
  }

  return [...ruleIds].sort();
}

test('captured oracle coverage fixture includes every sanitized seeded-case rule id', () => {
  const caseRuleIds = collectSanitizedCaseRuleIds();
  const fixtureSet = new Set(COVERAGE_FIXTURE.ruleIds);
  const missing = caseRuleIds.filter((ruleId) => !fixtureSet.has(ruleId));

  assert.deepEqual(missing, [], `missing from captured-oracle-rule-coverage.json:\n${missing.join('\n')}`);
});

test('every captured oracle rule resolves to a registry rule with commercial-parity coverage', async () => {
  const registry = await loadBuiltInRuleRegistry({ enforceCatalogContract: true });
  const parityCheckIds = new Set(
    registry.getChecksForProfile(PROFILES.COMMERCIAL_PARITY).map(({ check }) => check.id),
  );

  /** @type {string[]} */
  const missing = [];

  for (const oracleRuleId of COVERAGE_FIXTURE.ruleIds) {
    const canonicalRuleId = normalizeCorpusRuleId(oracleRuleId);
    const nativeRuleId = isKnownExternalCommercialRuleId(oracleRuleId)
      ? resolveNativeRuleId(oracleRuleId)
      : canonicalRuleId;
    const rule = registry.getRule(nativeRuleId)
      || registry.getRule(canonicalRuleId)
      || registry.getRule(oracleRuleId);

    if (!rule) {
      missing.push(`${oracleRuleId}: registry rule not found`);
      continue;
    }

    const hasParityCheck = rule.checks.some((check) => (
      check.profiles.includes(PROFILES.COMMERCIAL_PARITY)
      && parityCheckIds.has(check.id)
    ));

    if (!hasParityCheck) {
      missing.push(`${oracleRuleId}: no commercial-parity check`);
    }
  }

  assert.deepEqual(missing, [], missing.join('\n'));
});

test('captured oracle coverage excludes standards-only extras absent from oracle union', () => {
  const oracleSet = new Set(COVERAGE_FIXTURE.ruleIds);
  for (const ruleId of COVERAGE_FIXTURE.standardsOnlyExtras) {
    assert.equal(oracleSet.has(ruleId), false, `${ruleId} must not be in captured oracle union`);
  }
});
