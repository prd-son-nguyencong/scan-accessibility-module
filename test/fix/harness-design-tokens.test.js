import assert from 'node:assert/strict';
import test from 'node:test';
import { extractDesignTokens } from '../../src/fix/harness/tokens.js';

const keys = (css) => [...extractDesignTokens(css).keys()];

test('a focus ring built from keywords, widths and currentColor adds no design token', () => {
  assert.deepEqual(keys('a:focus { outline: none; }'), []);
  assert.deepEqual(keys('a:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }'), []);
});

test('an outline with a literal colour, var() or outline-color still counts as a design decision', () => {
  assert.deepEqual(keys('a { outline: 2px solid #00f; }'), ['outline: 2px solid #00f']);
  assert.deepEqual(keys('a { outline: 2px solid var(--ring); }'), ['outline: 2px solid var(--ring)']);
  assert.deepEqual(keys('a { outline-color: red; }'), ['outline-color: red']);
});
