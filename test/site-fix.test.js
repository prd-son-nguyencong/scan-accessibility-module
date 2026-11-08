import './helpers/hermetic-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { attachSiteFix, SITE_FIX_NOTE } from '../src/tracer/site-fix.js';
import { buildScanReportV2 } from '../src/reporter/report-v2.js';

const mkRoot = (files) => {
  const root = mkdtempSync(path.join(tmpdir(), 'ada-sitefix-'));
  for (const [f, text] of Object.entries(files)) { mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); writeFileSync(path.join(root, f), text); }
  return root;
};
const row = () => ({ origin: { owner: 'third-party', kind: 'vendor-script', vendor: 'onetrust', label: 'Cookie consent overlay', evidence: [] }, siteFix: { note: SITE_FIX_NOTE, candidate: null } });

test('a third-party overlay finding names the global stylesheet rule where the site adds scroll/bottom padding', () => {
  const root = mkRoot({ 'src/styles/base.css': ':root { --a: 1; }\n\nbody {\n  margin: 0;\n}\n', 'src/partials/layout/head.liquid': '<script src="https://cdn.cookielaw.org/x.js"></script>\n' });
  try {
    const rows = [row()];
    attachSiteFix(rows, root);
    assert.deepEqual([rows[0].siteFix.candidate.file, rows[0].siteFix.candidate.line, rows[0].siteFix.candidate.method], ['src/styles/base.css', 3, 'global-stylesheet']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('without a global html/body rule the head partial that loads the vendor script is the candidate; with neither it is null, never a fake file', () => {
  const root = mkRoot({ 'src/partials/layout/head.liquid': '<meta charset="utf-8">\n<script src="https://cdn.cookielaw.org/x.js"></script>\n' });
  const empty = mkRoot({ 'src/pages/index.liquid': '<main></main>' });
  try {
    const rows = [row()];
    attachSiteFix(rows, root);
    assert.deepEqual([rows[0].siteFix.candidate.file, rows[0].siteFix.candidate.line, rows[0].siteFix.candidate.method], ['src/partials/layout/head.liquid', 2, 'vendor-script-loader']);
    const none = [row()];
    attachSiteFix(none, empty);
    assert.equal(none[0].siteFix.candidate, null);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(empty, { recursive: true, force: true }); }
});

test('the report keeps siteFix on a third-party finding (owner stays the vendor)', () => {
  const v = { ruleId: 'FocusNotObscuredFooter', layer: 'accessScan', impact: 'serious', kind: 'deterministic', verdict: 'confirmed', element: { selector: 'a.x', outerHTML: '<a class="x" href="#">x</a>' }, source: {}, fix: { hint: 'h' },
    evidence: { proof: { type: 'element-from-point', fact: 'y 845-869px, footer y 839-900px, viewport 1280x900px' } }, ...row(), siteFix: { note: SITE_FIX_NOTE, candidate: { file: 'src/styles/base.css', line: 3, method: 'global-stylesheet', confidence: 'low' } } };
  const f = buildScanReportV2([{ page: 'p', url: 'https://example.test/', scannerRuns: [{ layer: 'axe', engine: { name: 'axe', version: '1' }, status: 'complete' }], violations: [v] }], { producer: { version: '0.0.0' }, agreementPolicy: 'off' }).pages[0].findings[0];
  assert.equal(f.origin.owner, 'third-party');
  assert.equal(f.siteFix.candidate.file, 'src/styles/base.css');
  assert.equal(f.source.file, null);
});
