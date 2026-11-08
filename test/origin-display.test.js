import './helpers/hermetic-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Ajv from 'ajv';
import { buildScanReportV2 } from '../src/reporter/report-v2.js';
import { enrichReportForHtml } from '../src/index.js';
import { buildHtml } from '../src/reporter/html.js';
import { unpackData } from './helpers/report-ui-fixture.mjs';
import { buildQaModel, renderQaHtml } from '../src/reporter/qa-report.js';
import { buildSarif } from '../src/reporter/sarif.js';
import { ownerLines } from '../src/reporter/scan-report.js';
import { ownerBadge } from '../src/reporter/origin-display.js';
import { evaluateGate, formatGate } from '../src/utils/thresholds.js';

const ctx = { generatedAt: '2026-10-28T00:00:00.000Z', producer: { name: 'ada-scan', version: '1.0.1' }, target: { mode: 'url-only', url: 'https://example.test/' } };
const runs = [{ layer: 'axe', engine: { name: 'axe-core', version: '4.12.1' }, status: 'complete' }];
const O = {
  site: { owner: 'site', kind: 'site-source', label: 'Site source', evidence: [] },
  injected: { owner: 'site', kind: 'injected-runtime', label: 'Runtime-injected DOM (injecting script unknown)', evidence: ['not in the served HTML (injected root <div#m1>)'] },
  widget: { owner: 'platform', kind: 'react-widget', label: 'Paradox React widget: JobList', evidence: ['inside data-react-component'] },
  component: { owner: 'platform', kind: 'platform-component', label: 'Paradox platform component: chat widget', evidence: ['inside chat widget root'] },
  vendor: { owner: 'third-party', kind: 'vendor-script', vendor: 'vendor-a', label: 'Consent banner (vendor-script: vendor-a)', evidence: ['class "va-window"', 'script https://cdn.vendor-a.example/a.js'] },
  iframe: { owner: 'third-party', kind: 'iframe', label: 'Cross-origin iframe content', evidence: ['inside a cross-origin iframe'] },
};
const viol = (name, ruleId, extra = {}) => ({
  ruleId, nativeRuleId: ruleId, layer: 'axe', category: 'accessibility', impact: 'serious', verdict: 'confirmed', count: 1, wcagRef: 'WCAG2A',
  element: { selector: `.${name}`, outerHTML: `<div class="${name}"></div>` }, fix: { hint: 'fix it' }, origin: O[name], ...(O[name].owner === 'site' ? { evidence: { failureSummary: 'Fix any of the following: x' } } : { evidence: { proof: { type: 'attribute-value', fact: 'measured on the live DOM' } } }), // not-site rows stay confirmed only with a measured proof
  ...extra,
});
const pageOf = (url, violations) => ({ name: url, page: url, url: `https://example.test${url}`, status: 'ok', violations, scannerRuns: runs, lighthouseScores: {} });
const KINDS = ['site', 'injected', 'widget', 'component', 'vendor', 'iframe'];
const pages = ['/', '/about'].map((u) => pageOf(u, KINDS.map((k) => viol(k, 'button-name'))));
const report = buildScanReportV2(pages, ctx);

test('ownerBadge: exact labels for every owner kind', () => {
  assert.deepEqual(KINDS.map((k) => ownerBadge(O[k]).text), ['Site', 'Injected at runtime', 'Platform React widget', 'Platform component', 'Third-party: vendor-a', 'iframe']);
  assert.deepEqual(ownerBadge(undefined), { key: 'site', text: 'Site' });
});

test('scan-visual: every finding carries its owner, Not your code is grouped by vendor, the split counts it', () => {
  const html = buildHtml({ ...enrichReportForHtml(report), v2: report });
  const d = unpackData(html);
  assert.equal(d.f.length, 12);
  assert.deepEqual([...new Set(d.f.map((f) => f.ol))].sort(), ['Injected at runtime', 'Platform React widget', 'Platform component', 'Site code', 'Third party: vendor-a', 'iframe'].sort());
  assert.deepEqual([...new Set(d.f.map((f) => f.o))].sort(), ['iframe', 'injected', 'platform', 'site', 'third-party']);
  assert.deepEqual(d.f.find((f) => f.o === 'third-party' && f.ok === 'vendor-script').oe, ['class "va-window"', 'script https://cdn.vendor-a.example/a.js']);
  // 4 foreign kinds on each of 2 pages = 8 occurrences
  assert.match(html, /<h2 id="h-nyc"><svg[^>]*>.*?<\/svg> Not your code \(8\)<\/h2>/);
  assert.match(html, /<th scope="row" data-l="Owner">Third-party: vendor-a<br><small class="muted">Consent banner[^<]*<\/small><\/th><td class="num" data-l="Occurrences">2<\/td>/);
  assert.match(html, /<th scope="row" data-l="Owner">Paradox React widget: JobList<br>/);
  assert.match(html, /Report to the platform team/);
  assert.match(html, /<option value="third-party">|data-view="b=theirs"/);
  // CSP safe: one plain script (the report's own) plus the JSON data block, no inline handlers
  assert.equal((html.match(/<script>/g) || []).length, 2); // theme script + the report's own
  assert.equal((html.match(/<script/g) || []).length, 3); // plus the JSON data block
  assert.doesNotMatch(html.replace(/<script[^>]*>[\s\S]*?<\/script>/g, ''), / on(click|change)=/);
});

test('scan-visual: a report with only site findings has no Not your code section', () => {
  const only = buildScanReportV2([pageOf('/', [viol('site', 'button-name')])], ctx);
  const html = buildHtml(enrichReportForHtml(only));
  assert.doesNotMatch(html, /id="h-nyc"/);
  assert.deepEqual(unpackData(html).f.map((f) => f.ol), ['Site code']);
});

test('gate rows state how many third-party and platform findings were excluded; counted again with the flags', () => {
  const gate = (o) => evaluateGate([{ name: '/', url: 'https://example.test/', findings: report.pages[0].findings, lighthouseScores: {} }], {}, { layers: { axe: true }, ...o });
  // third-party rows are never confirmed, so only the platform widget and component are left out of the gate
  assert.equal(gate({}).pages[0].excluded, 2, 'widget, component');
  assert.equal(gate({ countPlatform: true }).pages[0].excluded, undefined);
  assert.ok(formatGate(gate({})).includes('    third-party and platform findings excluded (2)'));
  const withGate = buildScanReportV2(pages, { ...ctx, thresholds: gate({}) });
  const html = buildHtml(enrichReportForHtml(withGate));
  assert.match(html, /<td colspan="3">third-party and platform findings excluded \(2\)<\/td>/);
  assert.match(html, /2 third-party or platform findings were left out of the gate/);
  const qa = renderQaHtml(buildQaModel(withGate));
  assert.match(qa, /Gate: third-party and platform findings excluded \(2\)\./);
});

test('qa-report: owner column, owner badge per instance, Not your code section with suggested action', () => {
  const m = buildQaModel(report);
  assert.deepEqual(m.notYourCode.map((g) => [g.name, g.occurrences, g.pages]), [
    ['iframe', 2, ['/', '/about']], ['Paradox platform component: chat widget', 2, ['/', '/about']],
    ['Paradox React widget: JobList', 2, ['/', '/about']], ['Third-party: vendor-a', 2, ['/', '/about']],
  ]);
  assert.deepEqual(m.topIssues[0].owners, ['Injected at runtime', 'Site']);
  const html = renderQaHtml(m);
  assert.match(html, /<th scope="col">Owner<\/th>/);
  assert.match(html, /<h2 id="not-your-code">Not your code \(8\)<\/h2>/);
  assert.match(html, /<td>Injected at runtime, Site<\/td>/);
  assert.match(html, />Owner: Platform React widget<\/span>/);
  assert.match(html, /Report to the vendor \(vendor-a\) or adjust the consent \/ tag-manager \(GTM\) configuration/);
  assert.match(html, /Report to the platform team/);
});

test('console: one line per owner, nothing when all findings are the site\'s', () => {
  assert.deepEqual(ownerLines(report), [
    'Owner site:         2',
    'Owner platform:     4',
    'Owner third-party:  2 (vendor-a 2)',
    'Owner injected:     2',
    'Owner iframe:       2',
  ]);
  assert.deepEqual(ownerLines(buildScanReportV2([pageOf('/', [viol('site', 'x')])], ctx)), []);
});

test('SARIF: origin in properties, platform and third-party results are notes whatever their impact', () => {
  const sarif = buildSarif(report);
  const by = (sel) => sarif.runs[0].results.find((r) => r.locations[0].logicalLocations[0].name === `.${sel}`);
  assert.equal(by('site').level, 'error');
  assert.equal(by('injected').level, 'note', 'injected DOM is never confirmed, so a note');
  for (const k of ['widget', 'component', 'vendor', 'iframe']) assert.equal(by(k).level, 'note', k);
  assert.deepEqual(by('vendor').properties.origin, { owner: 'third-party', kind: 'vendor-script', vendor: 'vendor-a', label: O.vendor.label });
  assert.deepEqual(by('widget').properties.origin, { owner: 'platform', kind: 'react-widget', label: O.widget.label });
  assert.equal(by('site').properties.origin.owner, 'site');
});

test('JSON schema: origin of every kind and notYourCode validate; unknown owner or kind and a malformed group do not', () => {
  const schema = JSON.parse(readFileSync(new URL('../docs/schema/scan-report-v2.schema.json', import.meta.url), 'utf8'));
  const validate = new Ajv({ strict: false }).compile(schema);
  assert.ok(validate(report), JSON.stringify(validate.errors));
  assert.equal(report.notYourCode.length, 4);
  assert.deepEqual(new Set(report.pages[0].findings.map((f) => f.origin.kind)), new Set(['site-source', 'injected-runtime', 'react-widget', 'platform-component', 'vendor-script', 'iframe']));
  const badOwner = structuredClone(report);
  badOwner.pages[0].findings[0].origin.owner = 'vendor';
  assert.equal(validate(badOwner), false);
  const badKind = structuredClone(report);
  badKind.pages[0].findings[0].origin.kind = 'cdn';
  assert.equal(validate(badKind), false);
  const badGroup = structuredClone(report);
  badGroup.notYourCode[0].owner = 'site';
  assert.equal(validate(badGroup), false);
  const noAction = structuredClone(report);
  delete noAction.notYourCode[0].suggestedAction;
  assert.equal(validate(noAction), false);
});
