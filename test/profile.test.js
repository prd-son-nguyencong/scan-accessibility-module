import './helpers/hermetic-env.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { scanOnePage } from '../src/index.js';
import { parseCliArgs, CliError } from '../src/utils/cli-args.js';
import { validateConfig } from '../src/utils/config.js';
import { buildReportBundle } from '../src/reporter/scan-report.js';
import { buildHtml } from '../src/reporter/html.js';
import { closeBrowser } from '../src/scanner/browser.js';
import { requireBrowser } from './helpers/require-browser.js';
import { startParadoxSite } from './helpers/paradox-site-server.js';

after(() => closeBrowser());

test('--profile and config profile accept only the two known profiles', () => {
  assert.equal(parseCliArgs(['--profile', 'commercial-parity']).profile, 'commercial-parity');
  assert.throws(() => parseCliArgs(['--profile', 'parity']), (e) => e instanceof CliError && e.exitCode === 2);
  assert.deepEqual(validateConfig({ profile: 'standards' }), []);
  assert.match(validateConfig({ profile: 'x' }).join(), /profile must be/);
});

test('standards is the default on a remote-style scan; commercial-parity adds a supplementary section outside the gate', async (t) => {
  if (!await requireBrowser(t)) return;
  const site = await startParadoxSite();
  try {
    const scan = (profile) => scanOnePage(
      { name: 'home', url: `${site.url}/` },
      { layers: { accessScan: true }, skipRules: [], ...(profile ? { profile } : {}) },
      { isUrlMode: true, includeThirdParty: true },
    );
    const std = await scan();
    assert.equal(std.parity, undefined);
    assert.ok(std.scannerRuns.every((r) => r.layer !== 'accessScan' || r.evidence.profile === 'standards'));

    const par = await scan('commercial-parity');
    // Same gating findings and the same profile: parity never leaks into violations or scannerRuns.
    assert.deepEqual(par.violations.map((v) => v.ruleId).sort(), std.violations.map((v) => v.ruleId).sort());
    assert.ok(par.scannerRuns.every((r) => r.layer !== 'accessScan' || r.evidence.profile === 'standards'));
    assert.ok(par.parity && Array.isArray(par.parity.findings));
    const standardIds = new Set(std.violations.map((v) => `${v.ruleId}|${v.element.selector}`));
    assert.ok(par.parity.findings.every((v) => !standardIds.has(`${v.ruleId}|${v.element.selector}`)));

    const parity = { profile: 'commercial-parity', gating: false, pages: [{ url: par.url, error: null, findings: [{ ruleId: 'Demo<Rule>', impact: 'minor', wcagRef: null, selector: 'main', html: '', count: 1 }] }] };
    const ctx = { producer: { name: 'ada-scan', version: '0.0.0-test' } };
    const base = buildReportBundle([std], ctx);
    const withParity = buildReportBundle([par], { ...ctx, profiles: ['standards', 'commercial-parity'], parity });
    assert.deepEqual(withParity.report.summary, base.report.summary);
    assert.deepEqual(withParity.report.runMetadata.profiles, ['standards', 'commercial-parity']);
    const html = buildHtml({ ...withParity.legacyReport, lighthouse: {} });
    assert.match(html, /Supplementary: commercial-parity profile/);
    assert.match(html, /Demo&lt;Rule&gt;/);
    assert.doesNotMatch(buildHtml({ ...base.legacyReport, lighthouse: {} }), /Supplementary: commercial-parity/);
  } finally {
    await site.close();
  }
});
