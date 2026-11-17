import './helpers/hermetic-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Ajv from 'ajv';
import { buildScanReportV2 } from '../src/reporter/report-v2.js';
import { buildSarif, sarifLevel } from '../src/reporter/sarif.js';
import { writeSarif } from '../src/reporter/scan-report.js';
import { parseCliArgs } from '../src/utils/cli-args.js';
import { setReportsDir } from '../src/utils/paths.js';

const ctx = { generatedAt: '2026-07-15T00:00:00.000Z', producer: { name: 'ada-scan', version: '1.0.1' }, target: { mode: 'url-only', url: 'https://example.test/' } };
const axeRun = { layer: 'axe', engine: { name: 'axe-core', version: '4.12.1' }, status: 'complete' };
const v = (id, impact, verdict, extra = {}) => ({
  ruleId: id, layer: 'axe', impact, verdict, wcagRef: '1.1.1',
  element: { selector: `.${id}-${impact}`, outerHTML: `<i class="${id}-${impact}"></i>` },
  fix: { hint: `fix ${id}` }, evidence: { failureSummary: 'Fix any of the following: x' }, ...extra,
});
const traced = { source: { file: 'src/partials/jobs/card.liquid', line: 12, confidence: 'medium', method: 'partial-map' } };
const lowTrace = { source: { file: 'src/pages/index.liquid', line: 3, confidence: 'low', method: 'page-level' } };

const report = buildScanReportV2([
  { page: '/', url: 'https://example.test/', scannerRuns: [axeRun], violations: [
    v('image-alt', 'critical', 'confirmed', traced),
    v('image-alt', 'minor', 'confirmed'),
    v('color-contrast', 'moderate', 'likely', lowTrace),
    v('region', 'serious', 'needs-review'),
  ] },
  { page: '/about', url: 'https://example.test/about', scannerRuns: [axeRun], violations: [v('label', 'serious', 'confirmed')] },
], ctx);

test('severity + verdict mapping table', () => {
  const table = [
    ['critical', 'confirmed', 'error'], ['serious', 'confirmed', 'error'], ['moderate', 'confirmed', 'warning'],
    ['minor', 'confirmed', 'note'], ['critical', 'likely', 'warning'], ['serious', 'needs-review', 'note'],
    ['critical', undefined, 'error'],
  ];
  for (const [impact, verdict, level] of table) assert.equal(sarifLevel(impact, verdict), level, `${impact}/${verdict}`);
});

test('SARIF 2.1.0 structure, locations, fingerprints and rules', () => {
  const sarif = buildSarif(report);
  assert.equal(sarif.version, '2.1.0');
  assert.match(sarif.$schema, /sarif-2\.1\.0/);
  assert.equal(sarif.runs.length, 1);
  const [run] = sarif.runs;
  assert.equal(run.tool.driver.name, 'ada-scan');
  assert.deepEqual(run.tool.driver.rules.map((r) => [r.id, r.defaultConfiguration.level, r.properties.tags]), [
    ['color-contrast', 'warning', ['wcag:1.1.1']],
    ['image-alt', 'error', ['wcag:1.1.1']],
    ['label', 'error', ['wcag:1.1.1']],
    ['region', 'note', ['wcag:1.1.1']],
  ]);
  const ruleIds = new Set(run.tool.driver.rules.map((r) => r.id));
  for (const r of run.results) {
    assert.ok(ruleIds.has(r.ruleId));
    assert.ok(['error', 'warning', 'note'].includes(r.level));
    assert.equal(typeof r.message.text, 'string');
    assert.ok(r.message.text);
    assert.equal(r.locations.length, 1);
    assert.ok(r.locations[0].physicalLocation.artifactLocation.uri);
    assert.match(r.partialFingerprints['stableId/v1'], /^sha256:[0-9a-f]{64}$/);
  }
  const by = (rule, level) => run.results.find((r) => r.ruleId === rule && r.level === level);
  // Traced finding: source file + line, no URL.
  assert.deepEqual(by('image-alt', 'error').locations[0].physicalLocation, {
    artifactLocation: { uri: 'src/partials/jobs/card.liquid', uriBaseId: '%SRCROOT%' }, region: { startLine: 12 },
  });
  assert.equal(by('image-alt', 'error').properties.sourceConfidence, 'medium');
  // Untraced and low-confidence (page-level) findings: page URL + logical selector, no guessed file/line.
  assert.deepEqual(by('image-alt', 'note').locations[0], {
    physicalLocation: { artifactLocation: { uri: 'https://example.test/' } },
    logicalLocations: [{ name: '.image-alt-minor', kind: 'element' }],
  });
  assert.equal(by('color-contrast', 'warning').locations[0].physicalLocation.artifactLocation.uri, 'https://example.test/');
  assert.equal(by('color-contrast', 'warning').locations[0].physicalLocation.region, undefined);
  assert.deepEqual(by('region', 'note').properties, { verdict: 'needs-review', impact: 'serious', sourceConfidence: 'none', ownership: 'source', origin: { owner: 'site', kind: 'site-source', label: 'Site source' } });
  assert.equal(by('label', 'error').locations[0].physicalLocation.artifactLocation.uri, 'https://example.test/about');
  assert.ok(!JSON.stringify(sarif).includes(process.env.HOME || '/Users/'));
});

test('ownership is passed through from the finding (source by default)', () => {
  const owned = structuredClone(report);
  owned.pages[0].findings[0].ownership = 'platform';
  const results = buildSarif(owned).runs[0].results;
  assert.equal(results[0].properties.ownership, 'platform');
  assert.equal(results[1].properties.ownership, 'source');
});

test('--sarif flag: bare means default, with a path keeps it; writeSarif default lands in the reports dir', () => {
  assert.equal(parseCliArgs(['--sarif']).sarif, '');
  assert.equal(parseCliArgs(['--sarif', '--fix']).sarif, '');
  assert.equal(parseCliArgs(['--sarif', 'out/x.sarif', '--fix']).sarif, 'out/x.sarif');
  assert.equal(parseCliArgs(['--fix']).sarif, undefined);
  const dir = mkdtempSync(path.join(tmpdir(), 'sarif-'));
  setReportsDir(dir);
  const file = writeSarif(report, '');
  assert.equal(file, path.join(dir, 'scan.sarif'));
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).version, '2.1.0');
  const custom = writeSarif(report, path.join(dir, 'sub', 'a.sarif'));
  assert.equal(JSON.parse(readFileSync(custom, 'utf8')).runs[0].results.length, 5);
});

test('published JSON Schema accepts real reports and rejects broken ones', () => {
  const schema = JSON.parse(readFileSync(new URL('../docs/schema/scan-report-v2.schema.json', import.meta.url), 'utf8'));
  const validate = new Ajv({ strict: false }).compile(schema);
  assert.ok(validate(report), JSON.stringify(validate.errors));
  const empty = buildScanReportV2([{ page: '/', url: 'https://example.test/', scannerRuns: [axeRun], violations: [] }], ctx);
  assert.ok(validate(empty), JSON.stringify(validate.errors));

  const badImpact = structuredClone(report);
  badImpact.pages[0].findings[0].impact = 'huge';
  assert.equal(validate(badImpact), false);
  const absolute = structuredClone(report);
  absolute.pages[0].findings[0].source.file = '/Users/x/src/a.liquid';
  assert.equal(validate(absolute), false);
  const noVersion = structuredClone(report);
  delete noVersion.schemaVersion;
  assert.equal(validate(noVersion), false);
});
