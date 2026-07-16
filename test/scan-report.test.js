import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as reporter from '../src/reporter/scan-report.js';
import * as scanner from '../src/index.js';

test('buildSummary aggregates axe rule groups separately from affected nodes', () => {
  assert.equal(typeof reporter.buildSummary, 'function');

  const axeSummary = {
    totalIssueGroups: 3,
    automaticIssues: 3,
    guidedIssues: null,
    manualIssues: null,
    bestPractice: 1,
    affectedNodes: 3,
    incompleteCount: 1,
    artifactNodeCount: 0,
    artifactViolationGroupsSkipped: 0,
    impact: { critical: 1, serious: 0, moderate: 2, minor: 0 },
    viewports: [
      { name: 'desktop', width: 1280, height: 900 },
      { name: 'mobile', width: 390, height: 844 },
    ],
    unsupportedIssueTypes: ['guided', 'manual'],
    tags: ['wcag2a', 'best-practice'],
    testEngine: { name: 'axe-core', version: '4.12.1' },
  };
  const violations = [
    { ruleId: 'button-name', layer: 'axe', impact: 'critical', source: {} },
    { ruleId: 'heading-order', layer: 'axe', impact: 'moderate', source: {} },
    { ruleId: 'meta-viewport', layer: 'axe', impact: 'moderate', source: {} },
  ];

  const summary = reporter.buildSummary([{
    page: 'homepage',
    url: 'https://example.com',
    violations,
    axeSummary,
  }]);

  assert.equal(summary.totalViolations, 3);
  assert.deepEqual(summary.axe, {
    pages: 1,
    totalIssueGroups: 3,
    automaticIssues: 3,
    guidedIssues: null,
    manualIssues: null,
    bestPractice: 1,
    affectedNodes: 3,
    incompleteResults: 1,
    artifactNodeCount: 0,
    artifactViolationGroupsSkipped: 0,
    impact: { critical: 1, serious: 0, moderate: 2, minor: 0 },
    viewportRuns: 2,
    viewportMatrix: [
      { name: 'desktop', width: 1280, height: 900 },
      { name: 'mobile', width: 390, height: 844 },
    ],
    unsupportedIssueTypes: ['guided', 'manual'],
    tags: ['best-practice', 'wcag2a'],
    engines: [{ name: 'axe-core', version: '4.12.1' }],
  });
});

test('buildSummary counts collapsed violation occurrences', () => {
  const summary = reporter.buildSummary([{
    page: 'homepage',
    url: 'https://example.com',
    violations: [{
      ruleId: 'duplicate-id',
      layer: 'w3c',
      impact: 'serious',
      count: 3,
      source: {},
    }],
  }]);

  assert.equal(summary.totalViolations, 3);
  assert.equal(summary.layerCounts.w3c, 3);
  assert.equal(summary.violationsByRule['duplicate-id'], 3);
  assert.deepEqual(summary.topViolations[0], { id: 'duplicate-id', count: 3 });
});

test('countViolationOccurrences distinguishes fix units from message occurrences', () => {
  assert.equal(typeof scanner.countViolationOccurrences, 'function');
  assert.equal(scanner.countViolationOccurrences([
    { ruleId: 'w3c-html-error', count: 2 },
    { ruleId: 'w3c-html-warning', count: 1 },
    { ruleId: 'w3c-html-warning' },
  ]), 4);
});
