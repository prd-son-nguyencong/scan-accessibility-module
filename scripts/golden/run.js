#!/usr/bin/env node
// Golden runner: scans the local Paradox fixture site (axe + accessScan only),
// normalizes findings and diffs them against test/golden/expected.json.
//   node scripts/golden/run.js            compare, exit 1 on diff
//   node scripts/golden/run.js --approve  rewrite expected.json (intentional change)
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startParadoxSite, PARADOX_SITE_DIR } from '../../test/helpers/paradox-site-server.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const EXPECTED_PATH = path.join(REPO, 'test/golden/expected.json');
export const ROUTES = ['/', '/benefits', '/jobs'];
const SCAN_TIMEOUT_MS = 180_000;

async function pinnedVersions(axeVersion) {
  const require = createRequire(import.meta.url);
  const playwright = require('playwright/package.json').version;
  const { chromium } = require('playwright');
  const browser = await chromium.launch();
  const chromiumVersion = browser.version();
  await browser.close();
  return { playwright, chromium: chromiumVersion, axe: axeVersion };
}

async function scanRoute(baseUrl, route, root) {
  const args = [
    path.join(REPO, 'bin/ada-scan.js'), '--url', baseUrl + route,
    '--layers', 'axe,accessScan', '--no-psi', '--no-fail',
  ];
  // Reports land in <ADA_SCAN_ROOT>/.ada-scan, so a temp root keeps tracked reports untouched.
  const child = spawn(process.execPath, args, {
    cwd: root,
    env: { ...process.env, ADA_SCAN_ROOT: root, ADA_SCAN_DEPLOYMENT_URL: '' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  const timer = setTimeout(() => child.kill(), SCAN_TIMEOUT_MS);
  const code = await new Promise((resolve) => child.on('close', resolve));
  clearTimeout(timer);
  try {
    return JSON.parse(await readFile(path.join(root, '.ada-scan/latest.json'), 'utf8'));
  } catch {
    throw new Error(`scan of ${route} produced no report (exit ${code}): ${stderr.slice(-500)}`);
  }
}

/** Drops volatile fields (ids, hashes, source paths, timestamps, ports); key = layer:rule|selector|route. */
export function normalizeReport(report, into = {}) {
  for (const page of report.pages) {
    for (const f of page.findings) {
      const key = `${f.layer}:${f.canonicalRuleId}|${f.element?.selector ?? ''}|${f.route}`;
      into[key] = { impact: f.impact, wcag: f.wcagRef ?? null, count: f.count };
    }
  }
  return into;
}

export async function collectFindings({ siteDir = PARADOX_SITE_DIR, variant = 'local' } = {}) {
  // Loopback URLs make the CLI run the host build; the temp root's no-op buildCommand skips it.
  const site = await startParadoxSite({ variant, host: '::1', dir: siteDir });
  const findings = {};
  let axeVersion = null;
  try {
    for (const route of ROUTES) {
      const root = await mkdtemp(path.join(os.tmpdir(), 'ada-golden-'));
      await writeFile(path.join(root, '.scan-config.json'), JSON.stringify({ buildCommand: 'node -e 0' }));
      try {
        const report = await scanRoute(site.url, route, root);
        axeVersion ??= report.scanners.find((s) => s.layer === 'axe')?.engine?.version ?? null;
        normalizeReport(report, findings);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  } finally {
    await site.close();
  }
  const sorted = Object.fromEntries(Object.entries(findings).sort(([a], [b]) => (a < b ? -1 : 1)));
  return { versions: await pinnedVersions(axeVersion), findings: sorted };
}

export function diffFindings(expected, actual) {
  const lines = [];
  for (const key of Object.keys(expected)) {
    if (!(key in actual)) lines.push(`- missing  ${key}  ${JSON.stringify(expected[key])}`);
    else if (JSON.stringify(expected[key]) !== JSON.stringify(actual[key])) {
      lines.push(`~ changed  ${key}  ${JSON.stringify(expected[key])} -> ${JSON.stringify(actual[key])}`);
    }
  }
  for (const key of Object.keys(actual)) if (!(key in expected)) lines.push(`+ new      ${key}  ${JSON.stringify(actual[key])}`);
  return lines;
}

export async function runGolden({ approve = false, expectedPath = EXPECTED_PATH, siteDir, variant, log = console.log } = {}) {
  const actual = await collectFindings({ siteDir, variant });
  if (approve) {
    await writeFile(expectedPath, `${JSON.stringify(actual, null, 2)}\n`);
    log(`golden approved: ${Object.keys(actual.findings).length} findings written to ${path.relative(REPO, expectedPath)}`);
    log('Review the git diff of the golden file before committing: a changed golden must be explained.');
    return { ok: true, diff: [] };
  }
  const expected = JSON.parse(await readFile(expectedPath, 'utf8'));
  for (const [name, version] of Object.entries(expected.versions || {})) {
    if (actual.versions[name] !== version) {
      log(`warning: ${name} is ${actual.versions[name]}, golden was recorded with ${version}; diffs may be tool drift`);
    }
  }
  const diff = diffFindings(expected.findings, actual.findings);
  if (diff.length) log(`golden mismatch (${diff.length}):\n${diff.join('\n')}\nIf intentional, rerun with --approve and review the diff.`);
  else log(`golden ok: ${Object.keys(actual.findings).length} findings match`);
  return { ok: diff.length === 0, diff };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const approve = process.argv.includes('--approve');
  runGolden({ approve }).then(({ ok }) => process.exit(ok ? 0 : 1), (err) => { console.error(err.message); process.exit(2); });
}
