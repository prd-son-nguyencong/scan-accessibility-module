import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as w3c from '../src/scanner/w3c.js';

test('canonicalizeW3cDescription treats Nu smart quotes and DOM quotes equally', () => {
  assert.equal(typeof w3c.canonicalizeW3cDescription, 'function');
  assert.equal(
    w3c.canonicalizeW3cDescription('Duplicate ID “location-label”.'),
    w3c.canonicalizeW3cDescription('Duplicate ID "location-label".'),
  );
  assert.equal(
    w3c.canonicalizeW3cDescription('The “type” attribute is unnecessary for JavaScript resources.'),
    w3c.canonicalizeW3cDescription('The "type" attribute is unnecessary for JavaScript resources.'),
  );
});

test('filterSupplementalW3cIssues removes quote-only duplicates but retains new details', () => {
  assert.equal(typeof w3c.filterSupplementalW3cIssues, 'function');
  const apiMessages = [
    { message: 'Duplicate ID “location-label”.' },
    { message: 'A “script” element with “type=module” must not have a “defer” attribute.' },
  ];
  const supplemental = [
    { description: 'Duplicate ID "location-label".' },
    { description: 'A "script" element with "type=module" must not have a "defer" attribute.' },
    { description: 'Duplicate ID "different-label".' },
  ];

  assert.deepEqual(
    w3c.filterSupplementalW3cIssues(apiMessages, supplemental),
    [{ description: 'Duplicate ID "different-label".' }],
  );
});

test('buildW3cRunMetadata preserves raw totals and supplemental dedup counts', () => {
  assert.equal(typeof w3c.buildW3cRunMetadata, 'function');
  const messages = [
    { type: 'error', message: 'Duplicate ID “one”.' },
    { type: 'error', message: 'Template {{ token }}' },
    { type: 'info', subType: 'warning', message: 'Section lacks heading.' },
    { type: 'info', message: 'Trailing slash info.' },
  ];
  const metadata = w3c.buildW3cRunMetadata({
    messages,
    isArtifact: (message) => message.message.includes('{{'),
    engineVersion: null,
    supplemental: {
      candidateCount: 3,
      addedCount: 1,
      suppressedCount: 2,
    },
    emittedViolations: [
      { type: 'error', count: 1 },
      { type: 'warning', count: 2 },
      { type: 'info', count: 1 },
    ],
  });

  assert.deepEqual(metadata, {
    layer: 'w3c',
    engine: { name: 'Nu Html Checker', version: null },
    pageState: 'initial',
    status: 'complete',
    raw: {
      messageCount: 4,
      errors: 2,
      warnings: 1,
      infos: 1,
      other: 0,
      artifactFilteredCount: 1,
    },
    supplemental: {
      candidateCount: 3,
      addedCount: 1,
      suppressedCount: 2,
    },
    emitted: {
      actionableOccurrences: 3,
      actionableFixUnits: 2,
      infoFixUnits: 1,
    },
  });
});

test('classifyW3cRule maps HIT-01 message families to stable native rules', () => {
  assert.equal(typeof w3c.classifyW3cRule, 'function');
  const cases = [
    ['The element “button” must not appear as a descendant of the “a” element.', 'w3c-nested-interactive'],
    ['Bad value “button” for attribute “type” on element “a”: Subtype missing.', 'w3c-nested-interactive'],
    ['Duplicate ID “location-label”.', 'w3c-duplicate-id'],
    ['The first occurrence of ID “location-label” was here.', 'w3c-duplicate-id'],
    ['The “main” element must not appear as a descendant of the “section” element.', 'w3c-main-in-section'],
    ['The “main” element must not appear as a descendant of the “main” element.', 'w3c-main-nested'],
    ['A document must not include more than one visible “main” element.', 'w3c-multiple-main'],
    ['Stray end tag “main”.', 'w3c-main-landmark-structure'],
    ['A “script” element with “type=module” must not have a “defer” attribute.', 'w3c-module-defer'],
    ['The heading “h3” follows the heading “h1”, skipping 1 heading level.', 'w3c-heading-order'],
    ['Consider avoiding viewport values that prevent users from resizing documents.', 'w3c-viewport-zoom'],
    ['Section lacks heading. Consider using “h2”-“h6” elements.', 'w3c-section-heading'],
    ['The “type” attribute is unnecessary for JavaScript resources.', 'w3c-script-type-unnecessary'],
  ];

  for (const [message, expected] of cases) {
    assert.equal(w3c.classifyW3cRule({ message, type: 'error' }), expected);
  }
  assert.equal(
    w3c.classifyW3cRule({ message: 'Unknown error.', type: 'error' }),
    'w3c-html-error',
  );
  assert.equal(
    w3c.classifyW3cRule({ message: 'Unknown warning.', type: 'info', subType: 'warning' }),
    'w3c-html-warning',
  );
});

test('deduplicateW3cViolations keeps distinct Nu messages on the same extract', () => {
  assert.equal(typeof w3c.deduplicateW3cViolations, 'function');
  const extract = '<main class="c-jobs__main">';
  const deduped = w3c.deduplicateW3cViolations([
    {
      rule: 'w3c-main-in-section',
      description: 'The "main" element must not appear as a descendant of the "section" element.',
      line: 681,
      element: { extract },
    },
    {
      rule: 'w3c-main-nested',
      description: 'The "main" element must not appear as a descendant of the "main" element.',
      line: 681,
      element: { extract },
    },
    {
      rule: 'w3c-multiple-main',
      description: 'A document must not include more than one visible "main" element.',
      line: 681,
      element: { extract },
    },
  ]);
  assert.equal(deduped.length, 3);
  assert.deepEqual(deduped.map((item) => item.rule).sort(), [
    'w3c-main-in-section',
    'w3c-main-nested',
    'w3c-multiple-main',
  ].sort());
});
