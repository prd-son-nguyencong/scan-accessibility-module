#!/usr/bin/env node
// Calibration: scans the neutral fixture site in test/fixtures/calibration (one page per known false-positive / true-positive class)
// and scores the report against labels.json. Fails when confirmed-tier precision is below 0.98 or a known false-positive class is confirmed.
//   node scripts/calibrate.js [--min-precision 0.98] [--json] [--report <latest.json>] [--save <file>] [--pages /a,/b]   (--report scores an existing report, no scan; --save keeps the scan's report)
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startParadoxSite } from '../test/helpers/paradox-site-server.js';
import { scoreCalibration } from './lib/calibration.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(REPO, 'test/fixtures/calibration');
const SCAN_TIMEOUT_MS = 600_000;
const LAYERS = 'axe,accessScan,htmlValidate,screenReader,keyboard,links';
// Layers the scan does not run are switched off in the config; names mirror DEFAULT_CONFIG.layers.
const OFF = ['w3c', 'lighthouse', 'ariaLive', 'focusTrap', 'dynamicContent'];

/** Serves the fixture pages; `__EXT__` in a page becomes the second origin (an "external" site on another port). */
async function serveSite(ext) {
  const names = (await readdir(path.join(DIR, 'site'))).filter((n) => n.endsWith('.html'));
  const routes = {};
  for (const n of names) {
    const body = (await readFile(path.join(DIR, 'site', n), 'utf8')).replaceAll('__EXT__', ext.url);
    const send = (req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(body); };
    routes[n === 'index.html' ? '/' : `/${n.replace(/\.html$/, '')}`] = send;
  }
  routes['/slow.js'] = (req, res) => { setTimeout(() => { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(''); }, 1500); }; // a slow blocking resource: shifts timing so the probe path differs
  return startParadoxSite({ host: '::1', dir: path.join(DIR, 'site'), routes });
}

async function scanRoute(siteUrl, route) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ada-calibrate-'));
  const config = {
    buildCommand: 'node -e 0',
    layers: Object.fromEntries(OFF.map((l) => [l, false])),
    tracing: { vendors: [{ id: 'vendor-a', name: 'Vendor A', category: 'chat', patterns: { class: ['^va-'] } }] },
  };
  await writeFile(path.join(root, '.scan-config.json'), JSON.stringify(config));
  const child = spawn(process.execPath, [path.join(REPO, 'bin/ada-scan.js'), '--url', siteUrl + route, '--layers', LAYERS, '--no-psi', '--no-fail', '--allow-incomplete'], {
    cwd: root, env: { ...process.env, ADA_SCAN_ROOT: root, ADA_SCAN_DEPLOYMENT_URL: '' }, stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  const timer = setTimeout(() => child.kill(), SCAN_TIMEOUT_MS);
  const code = await new Promise((resolve) => child.on('close', resolve));
  clearTimeout(timer);
  try { return JSON.parse(await readFile(path.join(root, '.ada-scan/latest.json'), 'utf8')); }
  catch { throw new Error(`scan produced no report (exit ${code}): ${stderr.slice(-500)}`); }
  finally { await rm(root, { recursive: true, force: true }); }
}

export async function runCalibration({ report = null, save = null, only = null } = {}) {
  const spec = JSON.parse(await readFile(path.join(DIR, 'labels.json'), 'utf8'));
  let latest = report;
  if (!latest) {
    const ext = await startParadoxSite({ host: '127.0.0.1', dir: path.join(DIR, 'external'), routes: { '/blocked': (q, r) => r.writeHead(403).end('blocked') } });
    const site = await serveSite(ext);
    try {
      latest = { pages: [] };
      for (const route of spec.pages.filter((r) => !only || only.includes(r))) latest.pages.push(...(await scanRoute(site.url, route)).pages); // one CLI run per page, like the golden runner
    } finally { await site.close(); await ext.close(); }
  }
  if (save) await writeFile(save, JSON.stringify(latest));
  const findings = latest.pages.flatMap((p) => p.findings);
  return { spec, ...scoreCalibration(spec.labels, findings), findingCount: findings.length };
}

const cli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (cli) {
  const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : null; };
  const min = Number(arg('--min-precision') ?? 0.98);
  const rep = arg('--report');
  runCalibration({ report: rep ? JSON.parse(await readFile(rep, 'utf8')) : null, save: arg('--save'), only: arg('--pages')?.split(',') ?? null }).then((r) => {
    const t = r.confirmedTier;
    if (process.argv.includes('--json')) console.log(JSON.stringify({ confirmedTier: { ...t, unexplained: t.unexplained.map((f) => `${f.route} ${f.nativeRuleId} ${f.element?.selector}`) }, tiers: r.tiers, fpConfirmed: r.fpConfirmed, missed: r.missed }, null, 2));
    else {
      console.log(`calibration: ${r.findingCount} findings; tiers ${JSON.stringify(r.tiers)}`);
      console.log(`confirmed tier (verdict confirmed, owner site): ${t.correct}/${t.total} correct, precision ${(t.precision * 100).toFixed(1)}%, recall of confirmed true positives ${(t.recall * 100).toFixed(1)}%`);
      for (const f of t.unexplained) console.log(`  unexplained confirmed: ${f.route} ${f.nativeRuleId} ${f.element?.selector || ''}`);
      for (const x of r.fpConfirmed) console.log(`  FP class ${x.class} not downgraded: ${x.id}: ${x.why}`);
      for (const x of r.missed) console.log(`  missed true positive ${x.class}: ${x.id}: ${x.why}`);
    }
    process.exit(t.precision < min || r.fpConfirmed.length ? 1 : 0);
  }, (err) => { console.error(err.message); process.exit(2); });
}
