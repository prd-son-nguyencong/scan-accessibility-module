import './helpers/hermetic-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MANUAL_CHECKS, runManualSubcommand, loadManualStore, summarizeManual, manualPageSentence, manualVerdict, validateManualStore, pageContentHash } from '../src/reporter/manual-checks.js';
import { buildScanReportV2 } from '../src/reporter/report-v2.js';
import { buildQaModel, renderQaHtml } from '../src/reporter/qa-report.js';
import { writeQaReport } from '../src/reporter/scan-report.js';
import { WCAG_CRITERIA } from '../src/utils/wcag-criteria.js';
import { setReportsDir } from '../src/utils/paths.js';

const tmp = () => mkdtempSync(path.join(tmpdir(), 'ada-manual-'));
const sign = (dir, id, extra = []) => runManualSubcommand(['sign', id, '--out-dir', dir, '--reviewer', 'Rae', ...extra]);
const rec = (over) => ({ item: 'zoom-reflow', page: '/', status: 'pass', reviewer: 'Rae', date: '2026-10-01', notes: '', ...over });
const store = (...signoffs) => ({ owner: 'ada-scan', version: 1, signoffs });
const report = { generatedAt: '2026-10-27T00:00:00.000Z', pages: [{ route: '/', url: 'https://example.test/', findings: [] }], summary: {}, runMetadata: { thresholds: { failed: false, pages: [{ url: 'https://example.test/', metrics: [] }] } } };

test('checklist: nine items, unique ids, every mapped criterion is a known WCAG criterion', () => {
  assert.equal(MANUAL_CHECKS.length, 9);
  assert.equal(new Set(MANUAL_CHECKS.map((c) => c.id)).size, 9);
  const known = new Set(WCAG_CRITERIA.map((c) => c.id));
  for (const c of MANUAL_CHECKS) for (const sc of c.sc) assert.ok(known.has(sc), `${c.id}: ${sc}`);
  assert.deepEqual(MANUAL_CHECKS.find((c) => c.id === 'text-spacing').sc, ['1.4.12']);
  assert.match(runManualSubcommand(['list']), /zoom-reflow\n.*\n {2}WCAG 1\.4\.4, 1\.4\.10/);
});

test('sign writes the owned file atomically, replaces the same item+page, keeps others', () => {
  const dir = tmp();
  sign(dir, 'zoom-reflow', ['--page', '/', '--status', 'pass', '--date', '2026-10-01', '--note', 'checked at 400%']);
  sign(dir, 'zoom-reflow', ['--page', '/about', '--status', 'fail', '--date', '2026-10-02']);
  sign(dir, 'zoom-reflow', ['--page', '/', '--status', 'na', '--date', '2026-10-03']);
  const data = JSON.parse(readFileSync(path.join(dir, 'manual-checks.json'), 'utf8'));
  assert.equal(data.owner, 'ada-scan');
  assert.deepEqual(data.signoffs.map((r) => [r.page, r.status, r.date]).sort(), [['/', 'na', '2026-10-03'], ['/about', 'fail', '2026-10-02']]);
  assert.deepEqual(readdirSync(dir), ['manual-checks.json']);
  setReportsDir(undefined);
});

test('schema is validated on load; a file the tool does not own is never overwritten', () => {
  const dir = tmp();
  const file = path.join(dir, 'manual-checks.json');
  for (const bad of ['{not json', '{"signoffs":[]}', JSON.stringify(store(rec({ status: 'ok' }))), JSON.stringify(store(rec({ date: '2026-02-30' }))), JSON.stringify(store(rec(), rec()))]) {
    writeFileSync(file, bad);
    assert.throws(() => sign(dir, 'focus-visible', ['--page', '/', '--status', 'pass']), /ada-scan will not overwrite it/);
    assert.equal(readFileSync(file, 'utf8'), bad);
  }
  assert.throws(() => loadManualStore(file), /not a valid ada-scan manual-checks file/);
  assert.equal(validateManualStore(store(rec({ item: 'nope' }))), 'signoffs[0].item is not a known check');
  setReportsDir(undefined);
});

test('sign rejects unknown item, bad status and missing flags without writing', () => {
  const dir = tmp();
  assert.throws(() => sign(dir, 'bogus', ['--page', '/', '--status', 'pass']), /Unknown check/);
  assert.throws(() => sign(dir, 'zoom-reflow', ['--page', '/', '--status', 'done']), /status must be one of/);
  assert.throws(() => runManualSubcommand(['sign', 'zoom-reflow', '--out-dir', dir, '--page', '/', '--status', 'pass']), /needs --reviewer/);
  assert.deepEqual(readdirSync(dir), []);
  setReportsDir(undefined);
});

test('staleness: 90 days is fresh, 91 is stale; changed content hash is stale; a site-wide sign-off covers pages; fail is counted apart', () => {
  const today = '2026-10-27';
  const s = store(
    rec({ item: 'keyboard-operation', date: '2026-07-29' }), // exactly 90 days
    rec({ item: 'focus-visible', date: '2026-07-28' }), // 91 days
    rec({ item: 'screen-reader', contentHash: 'h1' }),
    rec({ item: 'text-spacing', page: '*', status: 'na' }),
    rec({ item: 'motion-autoplay', status: 'fail' }),
  );
  const [home, other] = summarizeManual(s, [{ route: '/', contentHash: 'h2' }, { route: '/b' }], today).rows;
  assert.deepEqual([home.signed, home.failed, home.stale.map((x) => x.item)], [2, ['motion-autoplay'], ['focus-visible', 'screen-reader']]);
  assert.equal(home.stale[0].reason, 'signed off 91 days ago (limit 90)');
  assert.equal(home.stale[1].reason, 'page content changed since sign-off');
  assert.equal(home.open.length, 9 - 2 - 1 - 2);
  assert.equal(other.signed, 1); // only the site-wide text-spacing sign-off
  assert.equal(manualPageSentence('PASS', home), 'Automated passed; manual review 2 of 9 items signed off, 1 failed, 2 stale.');
});

test('QA report: per-page and overall lines state the manual count, never a bare passed or compliant', () => {
  const s = store(...MANUAL_CHECKS.slice(0, 3).map((c) => rec({ item: c.id })));
  const m = buildQaModel(report, { manual: s });
  assert.equal(m.manual.pages[0].sentence, 'Automated passed; manual review 3 of 9 items signed off.');
  assert.equal(m.manual.verdict, 'Automated checks passed; manual review 3 of 9 page items signed off. Not a statement of WCAG conformance.');
  const html = renderQaHtml(m);
  assert.ok(html.includes('Automated passed; manual review 3 of 9 items signed off.'));
  assert.doesNotMatch(html, /\bcompliant\b/i);
  const all = buildQaModel(report, { manual: store(...MANUAL_CHECKS.map((c) => rec({ item: c.id }))) });
  assert.match(all.manual.verdict, /9 of 9 page items signed off\. Every manual item is signed off; this is still not a statement of WCAG conformance\.$/);
  assert.equal(manualVerdict('FAIL', { signed: 0, total: 9, failed: 1, stale: 0 }), 'Automated checks failed; manual review 0 of 9 page items signed off, 1 failed. Manual review found failures.');
});

test('writeQaReport reads the sign-offs from the reports dir and reports an unreadable file instead of overwriting it', () => {
  const dir = tmp();
  setReportsDir(dir);
  sign(dir, 'zoom-reflow', ['--page', '/', '--status', 'pass', '--date', '2026-10-20']);
  writeQaReport(report);
  assert.equal(JSON.parse(readFileSync(path.join(dir, 'qa-report.json'), 'utf8')).manual.pages[0].signed, 1);
  writeFileSync(path.join(dir, 'manual-checks.json'), 'oops');
  writeQaReport(report);
  assert.match(readFileSync(path.join(dir, 'qa-report.html'), 'utf8'), /Manual sign-offs could not be read/);
  assert.equal(readFileSync(path.join(dir, 'manual-checks.json'), 'utf8'), 'oops');
  setReportsDir(undefined);
});

test('status honours --date: the same sign-off is fresh on day 90 and stale on day 91', () => {
  const dir = tmp();
  sign(dir, 'zoom-reflow', ['--page', '/', '--status', 'pass', '--date', '2026-01-01']);
  const at = (d) => runManualSubcommand(['status', '--out-dir', dir, '--date', d]);
  assert.equal(at('2026-04-01'), '/: 1 of 9 items signed off'); // 90 days
  assert.match(at('2026-04-02'), /^\/: 0 of 9 items signed off, 1 stale\n {2}stale: zoom-reflow \(signed off 91 days ago/);
  assert.throws(() => at('01/04/2026'), /--date must be YYYY-MM-DD/);
  setReportsDir(undefined);
});

test('content hash: ignores scripts, styles and whitespace, changes with content; sign takes the page hash from latest.json', () => {
  const a = pageContentHash('<main>Hi</main><script>var t=1</script>');
  assert.equal(a, pageContentHash('<main>Hi</main>\n<script>var t=2</script><!-- c -->'));
  assert.notEqual(a, pageContentHash('<main>Bye</main>'));
  const dir = tmp();
  writeFileSync(path.join(dir, 'latest.json'), JSON.stringify({ pages: [{ route: '/', contentHash: a }] }));
  sign(dir, 'zoom-reflow', ['--page', '/', '--status', 'pass', '--date', '2026-10-20']);
  assert.equal(loadManualStore(path.join(dir, 'manual-checks.json')).signoffs[0].contentHash, a);
  const m = buildQaModel({ ...report, pages: [{ ...report.pages[0], contentHash: pageContentHash('<main>Bye</main>') }] }, { manual: loadManualStore(path.join(dir, 'manual-checks.json')) });
  assert.deepEqual(m.manual.pages[0].stale.map((x) => x.reason), ['page content changed since sign-off']);
  setReportsDir(undefined);
});

test('report v2 carries the page content hash when the scan recorded one', () => {
  const run = { layer: 'axe', engine: { name: 'axe', version: '1' }, status: 'complete' };
  const r = buildScanReportV2([{ page: '/', url: 'https://example.test/', violations: [], scannerRuns: [run], contentHash: 'sha256:abc' }], { generatedAt: '2026-07-15T00:00:00.000Z', producer: { name: 'ada-scan', version: '1.0.1' }, target: { mode: 'url-only', url: 'https://example.test/' } });
  assert.equal(r.pages[0].contentHash, 'sha256:abc');
});
