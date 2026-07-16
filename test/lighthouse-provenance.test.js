import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as lighthouse from '../src/scanner/lighthouse.js';
import * as scanner from '../src/index.js';
import { normalizeLighthouseViolation } from '../src/schema.js';

test('createLighthouseProvenance marks PSI API results as comparable', () => {
  assert.equal(typeof lighthouse.createLighthouseProvenance, 'function');
  assert.deepEqual(lighthouse.createLighthouseProvenance({
    requestedSource: 'psi-api',
    actualSource: 'psi-api',
  }), {
    requestedSource: 'psi-api',
    actualSource: 'psi-api',
    comparableToPsi: true,
    fallbackReason: null,
  });
});

test('createLighthouseProvenance redacts quota fallback details', () => {
  const error = new Error(
    "PSI API 429: Too Many Requests — Quota exceeded for consumer 'project_number:123456789'"
  );
  const provenance = lighthouse.createLighthouseProvenance({
    requestedSource: 'psi-api',
    actualSource: 'local',
    fallbackError: error,
  });

  assert.deepEqual(provenance, {
    requestedSource: 'psi-api',
    actualSource: 'local',
    comparableToPsi: false,
    fallbackReason: {
      code: 'quota-exceeded',
      status: 429,
    },
  });
  assert.equal(JSON.stringify(provenance).includes('123456789'), false);
});

test('classifyPsiFailure distinguishes timeout and invalid responses', () => {
  assert.deepEqual(
    lighthouse.classifyPsiFailure(new Error('PSI API timed out after 90s')),
    { code: 'timeout', status: null },
  );
  assert.deepEqual(
    lighthouse.classifyPsiFailure(new Error('PSI response missing lighthouseResult')),
    { code: 'invalid-response', status: null },
  );
});

test('buildLighthouseScoreEntry persists only sanitized fallback provenance', () => {
  assert.equal(typeof scanner.buildLighthouseScoreEntry, 'function');
  const rawError = "Quota exceeded for consumer 'project_number:123456789'";
  const entry = scanner.buildLighthouseScoreEntry({
    scores: { performance: 60 },
    lighthouse: { mobile: {}, desktop: {} },
    source: 'local-fallback',
    provenance: {
      requestedSource: 'psi-api',
      actualSource: 'local',
      comparableToPsi: false,
      fallbackReason: { code: 'quota-exceeded', status: 429 },
    },
    rawError,
  });
  const serialized = JSON.stringify(entry);

  assert.equal(entry.source, 'local-fallback');
  assert.equal(entry.provenance.fallbackReason.code, 'quota-exceeded');
  assert.equal(serialized.includes('123456789'), false);
});

test('formatLighthouseSource reports failed PSI without calling it local', () => {
  assert.equal(typeof scanner.formatLighthouseSource, 'function');
  assert.equal(scanner.formatLighthouseSource({
    source: 'error',
    provenance: {
      requestedSource: 'psi-api',
      actualSource: 'error',
      comparableToPsi: false,
      fallbackReason: { code: 'quota-exceeded', status: 429 },
    },
  }), 'PSI unavailable; not PSI-comparable (quota-exceeded)');
});

test('enrichReportForHtml restores persisted lighthouseScores with provenance', () => {
  assert.equal(typeof scanner.enrichReportForHtml, 'function');
  const persisted = {
    timestamp: '2026-07-15T00:00:00.000Z',
    pages: [{
      page: 'remote',
      lighthouseScores: {
        remote: {
          source: 'local-fallback',
          lighthouse: { mobile: {}, desktop: {} },
          provenance: {
            requestedSource: 'psi-api',
            actualSource: 'local',
            comparableToPsi: false,
            fallbackReason: { code: 'quota-exceeded', status: 429 },
          },
        },
      },
    }],
  };

  const enriched = scanner.enrichReportForHtml(persisted);
  assert.equal(enriched.lighthouse.remote.source, 'local-fallback');
  assert.equal(enriched.lighthouse.remote.provenance.comparableToPsi, false);
});

test('extractAccessibilityAudits retains failed nodes and raw audit totals', () => {
  assert.equal(typeof lighthouse.extractAccessibilityAudits, 'function');
  const accessibility = lighthouse.extractAccessibilityAudits({
    categories: {
      accessibility: {
        auditRefs: [
          { id: 'select-name', weight: 7 },
          { id: 'button-name', weight: 7 },
          { id: 'manual-audit', weight: 0 },
          { id: 'not-applicable-audit', weight: 0 },
        ],
      },
    },
    audits: {
      'select-name': {
        score: 0,
        scoreDisplayMode: 'binary',
        title: 'Select elements have accessible names',
        description: 'Select controls need names.',
        details: {
          items: [
            {
              node: {
                selector: '#sort',
                snippet: '<select id="sort"></select>',
                nodeLabel: 'Sort',
                explanation: 'Element has no accessible name.',
              },
            },
          ],
        },
      },
      'button-name': { score: 1, scoreDisplayMode: 'binary', title: 'Buttons have names' },
      'manual-audit': { score: null, scoreDisplayMode: 'manual', title: 'Manual check' },
      'not-applicable-audit': { score: null, scoreDisplayMode: 'notApplicable', title: 'N/A check' },
    },
  });

  assert.deepEqual(accessibility.summary, {
    rawAuditCount: 4,
    issueGroups: 1,
    affectedNodes: 1,
    passed: 1,
    manual: 1,
    notApplicable: 1,
    incomplete: 0,
  });
  assert.equal(accessibility.failedAudits[0].id, 'select-name');
  assert.equal(accessibility.failedAudits[0].nodes[0].selector, '#sort');
});

test('generateLighthouseAccessibilityViolations merges viewport evidence', () => {
  assert.equal(typeof lighthouse.generateLighthouseAccessibilityViolations, 'function');
  const failedAudit = {
    id: 'select-name',
    title: 'Select elements have accessible names',
    description: 'Select controls need names.',
    score: 0,
    weight: 7,
    nodes: [{
      selector: '#sort',
      snippet: '<select id="sort"></select>',
      nodeLabel: 'Sort',
      explanation: 'Element has no accessible name.',
    }],
  };
  const violations = lighthouse.generateLighthouseAccessibilityViolations({
    mobile: {
      device: 'mobile',
      viewport: { width: 412, height: 823 },
      accessibility: { failedAudits: [failedAudit] },
    },
    desktop: {
      device: 'desktop',
      viewport: { width: 1350, height: 940 },
      accessibility: { failedAudits: [failedAudit] },
    },
  });

  assert.equal(violations.length, 1);
  assert.equal(violations[0].rule, 'select-name');
  assert.equal(violations[0].category, 'accessibility');
  assert.equal(violations[0].selector, '#sort');
  assert.deepEqual(
    violations[0].evidence.viewports.map((viewport) => viewport.name),
    ['mobile', 'desktop'],
  );

  const normalized = normalizeLighthouseViolation(violations[0], 'url', {
    url: 'https://example.test/',
  });
  assert.equal(normalized.category, 'accessibility');
  assert.equal(normalized.element.selector, '#sort');
  assert.equal(normalized.evidence.viewports.length, 2);
});
