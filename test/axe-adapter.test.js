import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as scanner from '../src/index.js';

test('axeToUnified retains source confidence, raw tags, and viewport evidence', () => {
  assert.equal(typeof scanner.axeToUnified, 'function');

  const viewport = { name: 'mobile', width: 390, height: 844 };
  const result = {
    violations: [{
      id: 'button-name',
      impact: 'moderate',
      tags: ['cat.name-role-value', 'wcag2a', 'wcag412'],
      description: 'Ensure buttons have discernible text',
      help: 'Buttons must have discernible text',
      helpUrl: 'https://dequeuniversity.com/rules/axe/button-name',
      nodes: [{
        impact: 'critical',
        html: '<button class="hamburger"></button>',
        target: ['.hamburger'],
        failureSummary: 'Fix the button text alternative',
        viewports: [viewport],
        source: {
          file: 'src/partials/layout/header.liquid',
          line: 42,
          snippetId: 'header-menu',
          confidence: 'high',
          method: 'instrumented-dom',
        },
      }],
    }],
  };

  const [finding] = scanner.axeToUnified(result, 'https://example.com', 'local');

  assert.equal(finding.impact, 'critical');
  assert.equal(finding.source.mode, 'local');
  assert.equal(finding.source.confidence, 'high');
  assert.equal(finding.source.method, 'instrumented-dom');
  assert.deepEqual(finding.evidence, {
    issueType: 'automatic',
    tags: result.violations[0].tags,
    impact: 'critical',
    help: 'Buttons must have discernible text',
    helpUrl: 'https://dequeuniversity.com/rules/axe/button-name',
    failureSummary: 'Fix the button text alternative',
    ruleGroupNodeCount: 1,
    viewports: [viewport],
  });
});

test('axeToUnified excludes nodes marked as local template artifacts', () => {
  const result = {
    violations: [{
      id: 'empty-heading',
      impact: 'moderate',
      tags: ['wcag2a'],
      nodes: [{
        html: '<h1>{{data:hero_heading}}</h1>',
        target: ['h1'],
        devArtifact: true,
      }],
    }],
  };

  assert.deepEqual(scanner.axeToUnified(result, 'http://localhost:1234', 'local'), []);
});

test('deduplicateViolations retains distinct axe targets with identical HTML', () => {
  assert.equal(typeof scanner.deduplicateViolations, 'function');

  const result = {
    violations: [{
      id: 'button-name',
      impact: 'critical',
      tags: ['wcag2a'],
      nodes: [
        {
          html: '<button class="icon-button"></button>',
          target: ['button:nth-of-type(1)'],
        },
        {
          html: '<button class="icon-button"></button>',
          target: ['button:nth-of-type(2)'],
        },
      ],
    }],
  };
  const unified = scanner.axeToUnified(result, 'https://example.com', 'url');

  assert.equal(unified.length, 2);
  assert.equal(scanner.deduplicateViolations(unified).length, 2);
});
