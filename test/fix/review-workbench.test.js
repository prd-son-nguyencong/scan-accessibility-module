import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const html = readFileSync(
  new URL('../../src/fix/review/workbench.html', import.meta.url),
  'utf8',
);

test('workbench shell avoids untrusted innerHTML and prompt usage', () => {
  assert.doesNotMatch(html, /\beval\s*\(/);
  assert.doesNotMatch(html, /\bon[a-z]+\s*=/i);
  assert.doesNotMatch(html, /window\.prompt/);
  assert.match(html, /textContent/);
  assert.doesNotMatch(html, /\.innerHTML\s*=\s*(?!['"`]\s*['"`])/);
});

test('workbench title reflects accessibility and performance review', () => {
  assert.match(html, /Accessibility &amp; Performance Fix Review/);
});

test('workbench exposes type facet and manual mapping dialog', () => {
  assert.match(html, /id="filter-type"/);
  assert.match(html, /<dialog id="manual-map-dialog"/);
  assert.match(html, /candidateUsable/);
  assert.match(html, /useBtn\.disabled = !candidateUsable/);
});

test('workbench verified facet matches unit.verified and batch accept is wired', () => {
  assert.match(html, /statusFilter === 'verified'/);
  assert.match(html, /unit\.verified/);
  assert.match(html, /batchAcceptVerified/);
  assert.match(html, /\/api\/fix-units\/batch\/accept/);
});

test('workbench merge controls and resize handler are present', () => {
  assert.match(html, /mergeUnits/);
  assert.match(html, /\/merge/);
  assert.match(html, /window\.addEventListener\('resize'/);
});

test('workbench uses dialog forms for reject and revise', () => {
  assert.match(html, /<dialog id="reject-dialog"/);
  assert.match(html, /<dialog id="revise-dialog"/);
  assert.match(html, /revision_requested/);
});

test('workbench uses List tab semantics and scrubs token fragment', () => {
  assert.match(html, /id="tab-list"/);
  assert.match(html, /List<\/button>/);
  assert.match(html, /history\.replaceState/);
  assert.doesNotMatch(html, /headers\[TOKEN_HEADER\].*origin/);
  assert.doesNotMatch(html, /origin:\s*state\.origin/);
});

test('workbench exposes status facet buttons and performance metric-first navigation', () => {
  assert.match(html, /class="status-facets"/);
  assert.match(html, /data-status="verified"/);
  assert.match(html, /performance\?\.metrics/);
  assert.match(html, /accessibility\?\.traceInbox/);
});

test('workbench narrow layout uses width-only media query and hidden tab panels', () => {
  assert.match(html, /@media \(max-width: 960px\)/);
  assert.doesNotMatch(html, /min-resolution/);
  assert.match(html, /panel\.hidden/);
  assert.match(html, /tabIndex/);
});

test('workbench stores review token in sessionStorage and debounces search writes', () => {
  assert.match(html, /ada-review-session-token/);
  assert.match(html, /sessionStorage\.setItem/);
  assert.match(html, /readStoredToken/);
  assert.match(html, /scheduleSearchPersist/);
  assert.match(html, /persistSeq/);
});

test('workbench only offers mapping controls for unresolved trace entries', () => {
  assert.match(html, /if \(!entry\.unresolved\)/);
});

test('workbench always offers manual mapping for unresolved trace entries', () => {
  assert.match(html, /function appendManualMappingButton/);
  assert.match(html, /appendManualMappingButton\(item, entry\.findingId\)/);
  assert.doesNotMatch(html, /if \(!hasCandidates\)/);
});

test('workbench accessibility review renders snippets and evidence before candidate diff', () => {
  assert.match(html, /function renderSourceSnippets/);
  assert.match(html, /function renderScannerEvidence/);
  assert.match(html, /renderSourceSnippets\(accessibility\.snippets/);
  assert.match(html, /renderScannerEvidence\(accessibility\.evidence/);
  assert.match(html, /Candidate diff/);
  const reviewIdx = html.indexOf('function renderAccessibilityReview');
  const diffIdx = html.indexOf("appendText(section, 'h3', 'Candidate diff')");
  assert.ok(reviewIdx >= 0 && diffIdx > reviewIdx);
});

test('workbench performance review renders owner candidates before multi-file plan', () => {
  assert.match(html, /function renderOwnerCandidates/);
  assert.match(html, /renderOwnerCandidates\(performance/);
  const ownersIdx = html.indexOf('function renderOwnerCandidates');
  const planIdx = html.indexOf("appendText(section, 'h3', 'Multi-file plan')");
  assert.ok(ownersIdx >= 0 && planIdx > ownersIdx);
});

test('workbench avoids global horizontal overflow clipping', () => {
  assert.doesNotMatch(html, /overflow-x:\s*hidden/);
  assert.match(html, /overflow-wrap:\s*anywhere/);
  assert.match(html, /\.pane-body \{[^}]*overflow:\s*auto/);
  assert.match(html, /\.review-section pre \{[^}]*overflow:\s*auto/);
});

test('workbench disabled use candidate includes explanatory note', () => {
  assert.match(html, /trace-candidate-note/);
  assert.match(html, /Missing valid file, line, or preimage hash/);
});

test('workbench exposes exact diff approval and apply actions', () => {
  assert.match(html, /id="approve-diff-btn"/);
  assert.match(html, /approveExactDiff/);
  assert.match(html, /\/api\/apply/);
  assert.match(html, /Diff hash:/);
  assert.match(html, /acceptBtn\.disabled = !unit \|\| !unit\.acceptAllowed \|\| !unit\.candidateHash/);
});
