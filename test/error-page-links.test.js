import './helpers/hermetic-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { downgradeErrorPage, ERROR_PAGE_LINK_REASON } from '../src/scanner/origin.js';

test('links on an error page mirror the failed path: needs-review; the same dead link on a normal page stays confirmed', () => {
  const mk = () => ['dead-link-404', 'dead-link-server-error', 'broken-link'].map((ruleId) => ({ ruleId, layer: 'links', verdict: 'confirmed', kind: 'deterministic', linkTarget: { url: 'https://other.example/404', status: 404, reason: null }, fix: { hint: 'x' } }));
  for (const v of downgradeErrorPage(mk(), 'http://127.0.0.1:1/404', ['/404', '/500'])) {
    assert.deepEqual([v.verdict, v.reason, v.linkTarget.reason], ['needs-review', ERROR_PAGE_LINK_REASON, ERROR_PAGE_LINK_REASON]);
  }
  assert.ok(downgradeErrorPage(mk(), 'http://127.0.0.1:1/careers', ['/404', '/500']).every((v) => v.verdict === 'confirmed'));
  const empty = [{ ruleId: 'dead-link-empty-href', layer: 'links', verdict: 'confirmed', fix: { hint: 'x' } }];
  assert.equal(downgradeErrorPage(empty, 'http://127.0.0.1:1/404', ['/404'])[0].verdict, 'confirmed', 'an empty href is a markup fact, not a mirrored path');
});
