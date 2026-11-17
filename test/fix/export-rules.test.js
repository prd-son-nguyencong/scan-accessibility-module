import '../helpers/hermetic-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildScanReportV2 } from '../../src/reporter/report-v2.js';
import { runFixSubcommand } from '../../src/index.js';
import { buildTaskSet, writeTaskSet } from '../../src/fix/export/tasks.js';

const ctx = { generatedAt: '2026-10-27T00:00:00.000Z', producer: { name: 'ada-scan', version: '1.0.1' }, target: { mode: 'url-only', url: 'https://site-001.example.test/' } };
const page = { name: '/', page: '/', url: 'https://site-001.example.test/', scannerRuns: [{ layer: 'axe', engine: { name: 'axe-core', version: '4.12.1' }, status: 'complete' }],
  violations: [{ ruleId: 'image-alt', layer: 'axe', impact: 'critical', verdict: 'confirmed', wcagRef: 'wcag2a, wcag111', element: { selector: 'img.a', outerHTML: '<img class="a">' }, fix: { hint: 'Add alt' },
    source: { file: 'src/partials/home/hero.liquid', line: 4, confidence: 'medium', mode: 'local', method: 'marker' } }] };
const report = buildScanReportV2([page], ctx);
const sha = (f) => createHash('sha256').update(readFileSync(f)).digest('hex');

function project({ precreateOut = true } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'ada-rules-'));
  const out = path.join(root, '.ada-scan');
  mkdirSync(out);
  const rep = path.join(out, 'report.json');
  writeFileSync(rep, JSON.stringify(report));
  if (!precreateOut) { const keep = path.join(root, 'report.json'); writeFileSync(keep, JSON.stringify(report)); return fresh(root, keep); }
  writeFileSync(path.join(root, 'CLAUDE.md'), '# mine\n');
  const run = (...extra) => runFixSubcommand(['--export', '--report', rep, '--source', root, '--out-dir', out, ...extra]);
  return { root, out, rep, run };
}

function fresh(root, rep) {
  const out = path.join(root, 'newout');
  mkdirSync(path.join(root, '.cursor/rules'), { recursive: true });
  return { root, out, rep, run: (...extra) => runFixSubcommand(['--export', '--report', rep, '--source', root, '--out-dir', out, ...extra]) };
}

test('cursor: creates tasks and one marked rules file with frontmatter; re-run only updates marked files', async () => {
  const { root, out, run } = project();
  await run('--target', 'cursor');
  const mdc = path.join(root, '.cursor/rules/ada-scan.mdc');
  const text = readFileSync(mdc, 'utf8');
  assert.ok(text.startsWith('---\n'));
  assert.match(text, /managed by ada-scan, regenerated; edits will be overwritten/);
  assert.match(text, /\.ada-scan\/tasks\/INDEX\.md/);
  assert.match(text, /ada-scan --url https:\/\/site-001\.example\.test\/` \(it compares with the baseline/);
  assert.ok(existsSync(path.join(out, 'tasks/INDEX.md')));
  await run('--target', 'cursor');
  assert.equal(readFileSync(mdc, 'utf8'), text);
  assert.deepEqual(readdirSync(path.join(root, '.cursor')), ['rules']);
});

test('an existing unmarked rules file is refused and left byte-identical; rules go to the out dir', async () => {
  const { root, out, run } = project();
  mkdirSync(path.join(root, '.cursor/rules'), { recursive: true });
  const mdc = path.join(root, '.cursor/rules/ada-scan.mdc');
  writeFileSync(mdc, 'my own rules');
  await assert.rejects(() => run('--target', 'cursor'), /not managed by ada-scan/);
  assert.equal(readFileSync(mdc, 'utf8'), 'my own rules');
  assert.match(readFileSync(path.join(out, 'ada-scan-rules.md'), 'utf8'), /read `.*INDEX\.md`/i);
});

test('claude: writes .claude/ada-scan.md, prints the import line, never touches CLAUDE.md', async () => {
  const { root, run } = project();
  const before = sha(path.join(root, 'CLAUDE.md'));
  const lines = [];
  const log = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try { await run('--target', 'claude'); } finally { console.log = log; }
  assert.ok(lines.join('\n').includes('@.claude/ada-scan.md'));
  assert.ok(!readFileSync(path.join(root, '.claude/ada-scan.md'), 'utf8').startsWith('---'));
  assert.equal(sha(path.join(root, 'CLAUDE.md')), before);
});

test('dry run writes nothing; generic writes tasks only; bad target is rejected', async () => {
  const { root, out, run } = project();
  await run('--target', 'cursor', '--dry-run');
  assert.ok(!existsSync(path.join(out, 'tasks')) && !existsSync(path.join(root, '.cursor')));
  await run('--target', 'generic');
  assert.ok(existsSync(path.join(out, 'tasks/INDEX.md')) && !existsSync(path.join(root, '.cursor')) && !existsSync(path.join(root, '.claude')));
  await assert.rejects(() => run('--target', 'vim'), /--target must be one of/);
});

test('a hostile task id or rule cannot leave the tasks folder', () => {
  const evil = structuredClone(report);
  evil.pages[0].findings[0].stableId = '../../../escape';
  evil.pages[0].findings[0].nativeRuleId = '..\\..\\x/y';
  const out = mkdtempSync(path.join(tmpdir(), 'ada-rules-evil-'));
  const { dir, files } = writeTaskSet(buildTaskSet(evil), path.join(out, 'o'));
  assert.ok(files.every((n) => /^[A-Za-z0-9._-]+$/.test(n) && !n.includes('..')), files.join());
  assert.deepEqual(readdirSync(out), ['o']);
  assert.deepEqual(readdirSync(path.join(out, 'o')), ['tasks']);
  assert.equal(readdirSync(dir).length, files.length);
});

test('refusal with a not-yet-existing --out-dir still writes tasks and the fallback, and exits non-zero', async () => {
  const { root, out, run } = project({ precreateOut: false });
  const mdc = path.join(root, '.cursor/rules/ada-scan.mdc');
  writeFileSync(mdc, 'my own rules');
  await assert.rejects(() => run('--target', 'cursor'), /not managed by ada-scan/);
  assert.equal(readFileSync(mdc, 'utf8'), 'my own rules');
  assert.ok(existsSync(path.join(out, 'tasks/INDEX.md')) && existsSync(path.join(out, 'ada-scan-rules.md')));
});

test('a file that only mentions the marker deeper in the body is not tool-owned', async () => {
  const { root, run } = project();
  mkdirSync(path.join(root, '.cursor/rules'), { recursive: true });
  const mdc = path.join(root, '.cursor/rules/ada-scan.mdc');
  const mine = `${'my rules\n'.repeat(20)}note: ada-scan:generated\n`;
  writeFileSync(mdc, mine);
  await assert.rejects(() => run('--target', 'cursor'), /not managed by ada-scan/);
  assert.equal(readFileSync(mdc, 'utf8'), mine);
});

test('a dangling symlink at the rules path is refused, not followed', async () => {
  const { root, run } = project();
  mkdirSync(path.join(root, '.cursor/rules'), { recursive: true });
  const mdc = path.join(root, '.cursor/rules/ada-scan.mdc');
  const victim = path.join(root, 'victim.txt');
  symlinkSync(victim, mdc);
  await assert.rejects(() => run('--target', 'cursor'), /not managed by ada-scan/);
  assert.ok(!existsSync(victim) && lstatSync(mdc).isSymbolicLink());
});
