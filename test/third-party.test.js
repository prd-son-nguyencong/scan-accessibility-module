import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isThirdPartyHtml,
  isTemplateDevArtifact,
  resolveIncludeThirdParty,
} from '../src/utils/third-party.js';

const SELECTORS = ['.d3afa4', '._72cec8', '.apply-', '[data-testid^="olivia"]'];
const TOKENS = ['{{', '}}', '{%', '%}'];

test('isThirdPartyHtml matches configured selectors', () => {
  assert.equal(isThirdPartyHtml('<div class="d3afa4">x</div>', SELECTORS), true);
  assert.equal(isThirdPartyHtml('<button class="apply-now">x</button>', SELECTORS), true);
  assert.equal(isThirdPartyHtml('<div class="hero">x</div>', SELECTORS), false);
});

test('isThirdPartyHtml with empty selector list disables filtering', () => {
  assert.equal(isThirdPartyHtml('<div class="d3afa4">x</div>', []), false);
});

test('remote URL scans include third-party content by default', () => {
  assert.equal(resolveIncludeThirdParty({ isRemoteUrl: true }), true);
  assert.equal(resolveIncludeThirdParty({ isRemoteUrl: false }), false);
});

test('third-party CLI flags override the scan-mode default', () => {
  assert.equal(resolveIncludeThirdParty({
    isRemoteUrl: true,
    excludeRequested: true,
  }), false);
  assert.equal(resolveIncludeThirdParty({
    isRemoteUrl: false,
    includeRequested: true,
  }), true);
});

test('isTemplateDevArtifact detects token-only nodes', () => {
  assert.equal(isTemplateDevArtifact('<h1>{{data:hero_heading}}</h1>', TOKENS), true);
  assert.equal(isTemplateDevArtifact('<p>{% if x %}{% endif %}</p>', TOKENS), true);
});

test('isTemplateDevArtifact keeps nodes with real content', () => {
  assert.equal(isTemplateDevArtifact('<h1>Real heading</h1>', TOKENS), false);
  assert.equal(isTemplateDevArtifact('<h1>Hi {{data:name}}</h1>', TOKENS), false);
});

test('isTemplateDevArtifact keeps tag-only semantic elements without template tokens', () => {
  const realElements = [
    '<button class="hamburger"><span class="hamburger-bar"></span></button>',
    '<meta name="viewport" content="width=device-width, user-scalable=no">',
    '<select id="page-size-select" aria-labelledby="page-size-select">',
    '<main class="c-jobs__main">',
    '<main>',
  ];

  for (const html of realElements) {
    assert.equal(isTemplateDevArtifact(html, TOKENS), false, html);
  }
});
