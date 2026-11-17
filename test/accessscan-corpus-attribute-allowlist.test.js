import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildOuterHtmlFromAttributes,
  filterAllowlistedReplayAttributes,
  findCommittedAttributeViolations,
  isMalformedSerializedAttributeValue,
  isReplayEssentialAttribute,
  parseElementOuterHtmlStructure,
  snapshotAttributesAgreeWithOuterHtml,
  stripNonAllowlistedAttributesFromHtml,
} from '../src/scanner/access-scan/corpus/attribute-allowlist.js';
import {
  sanitizeOracleSnippetHtml,
} from '../scripts/accessscan-corpus/lib/oracle-snippet-sanitize.js';
import {
  sanitizeSnapshotElement,
} from '../scripts/accessscan-corpus/lib/sanitize.js';

test('isMalformedSerializedAttributeValue detects object serialization leaks', () => {
  assert.equal(isMalformedSerializedAttributeValue('[object Object]'), true);
  assert.equal(isMalformedSerializedAttributeValue('[object Array]'), true);
  assert.equal(isMalformedSerializedAttributeValue('neutral-text-0-abcdef12'), false);
});

test('stripNonAllowlistedAttributesFromHtml removes framework and typo attributes', () => {
  const html = stripNonAllowlistedAttributesFromHtml('<apply-widget vce-ready="" receipient="[object Object]" />');
  assert.equal(html.includes('vce-ready'), false);
  assert.equal(html.includes('receipient'), false);
  assert.equal(html.includes('[object Object]'), false);
  assert.match(html, /<apply-widget\s*\/>/);
});

test('filterAllowlistedReplayAttributes keeps semantic accessibility attributes only', () => {
  const attrs = filterAllowlistedReplayAttributes({
    role: 'img',
    'aria-label': 'neutral-text-0-abcdef12',
    'vce-ready': '',
    receipient: '[object Object]',
    class: 'logo',
  });
  assert.deepEqual(attrs, {
    'aria-label': 'neutral-text-0-abcdef12',
    role: 'img',
  });
});

test('sanitizeSnapshotElement reconciles outerHTML with sanitized attributes', () => {
  const sanitized = sanitizeSnapshotElement({
    tag: 'div',
    attributes: {
      receipient: 'neutral-text-0-9ab2265a neutral-text-1-684e9c91',
      'aria-label': 'neutral-text-0-abcdef12',
    },
    outerHTML: '<div receipient="[object Object]" aria-label="neutral-text-0-abcdef12" />',
    text: '',
    visibleText: '',
    accessibleName: '',
    selector: 'div',
    reportSelector: 'div',
  });

  assert.equal(sanitized.attributes.receipient, undefined);
  assert.deepEqual(sanitized.attributes, { 'aria-label': 'neutral-text-0-abcdef12' });
  assert.equal(sanitized.outerHTML.includes('[object Object]'), false);
  assert.equal(sanitized.outerHTML.includes('receipient'), false);
  assert.equal(snapshotAttributesAgreeWithOuterHtml(
    /** @type {Record<string, string>} */ (sanitized.attributes),
    String(sanitized.outerHTML),
  ), true);
});

test('sanitizeOracleSnippetHtml strips malformed and framework-specific attributes', () => {
  const html = sanitizeOracleSnippetHtml('<apply-widget vce-ready="" receipient="[object Object]" />');
  assert.equal(html.includes('vce-ready'), false);
  assert.equal(html.includes('receipient'), false);
  assert.equal(html.includes('[object Object]'), false);
});

test('findCommittedAttributeViolations flags object serialization and framework attrs', () => {
  const violations = findCommittedAttributeViolations('<div vce-ready="" receipient="[object Object]" />', 'page.html');
  assert.ok(violations.some((entry) => /malformed serialized/i.test(entry)));
  assert.ok(violations.some((entry) => /non-allowlisted framework attribute "vce-ready"/i.test(entry)));
  assert.ok(violations.some((entry) => /non-allowlisted framework attribute "receipient"/i.test(entry)));
  assert.equal(isReplayEssentialAttribute('aria-label', 'neutral-text-0-abcdef12'), true);
  assert.equal(findCommittedAttributeViolations('<img aria-label="neutral-text-0-abcdef12" alt="neutral-alt-0-abcdef12" />', 'snippet').length, 0);
});

test('findCommittedAttributeViolations ignores plain text that is not markup attributes', () => {
  const violations = findCommittedAttributeViolations('<title>Neutral page title</title>', 'page.html');
  assert.equal(violations.length, 0);
});

test('buildOuterHtmlFromAttributes renders self-closing replay markup', () => {
  const html = buildOuterHtmlFromAttributes('apply-widget', {}, '', true);
  assert.equal(html, '<apply-widget />');
  const parsed = parseElementOuterHtmlStructure('<div aria-label="x">inner</div>');
  assert.equal(parsed.tag, 'div');
  assert.equal(parsed.innerHtml, 'inner');
  assert.equal(parsed.selfClosing, false);
});
