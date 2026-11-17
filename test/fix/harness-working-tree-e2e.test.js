// End to end: `ada-scan fix --harness --from-working-tree` on a fixture project (git repo, report, editor edits in the working tree, harness).
// Chromium: run this file alone. Fake scanner (reads the served pages), real shadow build, real gates.
import '../helpers/hermetic-env.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { requireBrowser } from '../helpers/require-browser.js';
import { HARNESS_SITE_SRC } from '../helpers/harness-site.mjs';
import { buildScanReportV2 } from '../../src/reporter/report-v2.js';
import { runFixSubcommand } from '../../src/index.js';
import { VIEWPORTS } from '../../src/fix/harness/index.js';
import { closeBrowser } from '../../src/scanner/browser.js';

const work = mkdtempSync(join(tmpdir(), 'wt-e2e-'));
after(async () => { await closeBrowser(); rmSync(work, { recursive: true, force: true }); });

const git = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
const HEADER = 'src/partials/header.liquid', INDEX = 'src/pages/index.liquid';

async function fakeScanner({ siteUrl, routes }) {
  const findings = [];
  for (const route of routes) {
    const html = await (await fetch(new URL(route, siteUrl))).text();
    if (/<button\b(?![^>]*aria-label)[^>]*>\s*<span/.test(html)) findings.push({ findingId: `btn|${route}`, canonicalRuleId: 'button-name', route, selector: '#menu-btn' });
    if (/<img\b(?![^>]*\balt=)[^>]*>/.test(html)) findings.push({ findingId: `img|${route}`, canonicalRuleId: 'image-alt', route, selector: 'img' });
  }
  return { findings, executedLayers: ['fake'], sourceTraceResolved: true };
}

const axe = { layer: 'axe', engine: { name: 'axe-core', version: '4.12.1' }, status: 'complete' };
const finding = (ruleId, selector, outerHTML, file, line) => ({ ruleId, layer: 'axe', impact: 'critical', verdict: 'confirmed', wcagRef: 'wcag2a, wcag412', element: { selector, outerHTML }, fix: { hint: 'fix it' },
  evidence: { failureSummary: 'measured on the live DOM' }, source: { file, line, confidence: 'medium', mode: 'local', method: 'marker' } });

test('--from-working-tree verifies real export tasks: offset trace line, blank line above the edit, stray hunk in the report, edits left in place', async (t) => {
  if (!(await requireBrowser(t))) return;
  const dir = join(work, 'proj');
  mkdirSync(dir, { recursive: true });
  cpSync(HARNESS_SITE_SRC, join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'build.mjs'), `import { renderHarnessSite } from ${JSON.stringify(new URL('../helpers/harness-site.mjs', import.meta.url).href)};\nrenderHarnessSite('src', 'dist');\n`);
  writeFileSync(join(dir, '.scan-config.json'), JSON.stringify({ verifyBuildCommand: 'node build.mjs', outDir: 'dist' }));
  writeFileSync(join(dir, '.gitignore'), 'dist\n.ada-scan\n');
  // A blank line above the img (the old context-line conversion failed there).
  writeFileSync(join(dir, INDEX), readFileSync(join(dir, INDEX), 'utf8').replace('    <img', '\n    <img'));
  git(dir, 'init', '-q'); git(dir, 'config', 'user.email', 't@t'); git(dir, 'config', 'user.name', 't'); git(dir, 'add', '.'); git(dir, 'commit', '-q', '-m', 'base');

  const indexLines = readFileSync(join(dir, INDEX), 'utf8').split('\n');
  const imgLine = indexLines.findIndex((l) => l.includes('<img')) + 1;
  // The trace names header.liquid:8 (the closing tag) for a button on line 3: five lines off, outside the +-3 allowlist radius.
  const report = buildScanReportV2([{ name: '/', page: '/', url: 'http://localhost:1234/', scannerRuns: [axe], violations: [
    finding('button-name', '#menu-btn', '<button class="menu-btn" id="menu-btn" type="button" aria-controls="site-nav" aria-expanded="false"><span class="menu-icon"></span></button>', HEADER, 8),
    finding('image-alt', 'img', '<img src="/pic.svg" width="320" height="120">', INDEX, imgLine),
  ] }], { generatedAt: '2026-10-27T00:00:00.000Z', producer: { name: 'ada-scan', version: '1.0.1' }, target: { mode: 'local-only', url: 'http://localhost:1234/' } });
  const reportPath = join(dir, 'report.json');
  writeFileSync(reportPath, JSON.stringify(report));

  // What the editor agent did, uncommitted: both fixes plus one stray edit no task owns.
  const edit = (file, from, to) => { const p = join(dir, file); const s = readFileSync(p, 'utf8'); assert.ok(s.includes(from), from); writeFileSync(p, s.replace(from, to)); };
  edit(HEADER, '<button class="menu-btn"', '<button class="menu-btn" aria-label="Menu"');
  edit(INDEX, '<img src="/pic.svg"', '<img alt="" src="/pic.svg"');
  edit(INDEX, '<html>', '<html lang="en">'); // line 2: far from every task
  const diffBefore = git(dir, 'diff', 'HEAD');

  const logs = []; const orig = console.log; console.log = (...a) => logs.push(a.join(' '));
  let res;
  try {
    res = await runFixSubcommand(['--harness', '--from-working-tree', '--report', reportPath, '--source', dir, '--out-dir', join(dir, '.ada-scan')],
      { harnessConfig: { scanner: fakeScanner, viewports: [VIEWPORTS[0], VIEWPORTS[2]], perfRuns: 0, maxRepairs: 0, routes: ['/'], snapshotBudgetMs: 120000 } });
  } finally { console.log = orig; }

  assert.equal(res.dryRun, true);
  assert.equal(res.accepted.length, 2, JSON.stringify(res.table));
  assert.deepEqual(res.unassigned.map((u) => u.path), [INDEX]);
  assert.equal(git(dir, 'diff', 'HEAD'), diffBefore, 'the working tree is untouched');
  const md = readFileSync(res.files.reportMarkdown, 'utf8');
  assert.match(md, /the edits stay in your working tree/);
  assert.match(md, new RegExp(`${INDEX}:\\d+`));
  assert.match(md, /Changed hunks not verified: no scanned task claims them, or their task was skipped \(1\)/);
  assert.match(logs.join('\n'), /always a dry run/);
});
