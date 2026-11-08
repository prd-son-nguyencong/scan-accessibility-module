import { existsSync, readFileSync, statSync, statfsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { parseCliArgs } from '../utils/cli-args.js';
import { withTimeout } from '../utils/with-timeout.js';
import { getDirname, getProjectRoot } from '../utils/paths.js';
import { planTracingBuild } from '../tracer/vite-wrapper.js';

const PKG_ROOT = path.resolve(getDirname(import.meta.url), '../..');
const OPTIONS = {
  help: { type: 'boolean', short: 'h' },
  json: { type: 'boolean' },
  url: { type: 'string' },
  'out-dir': { type: 'string' },
};
const CIS_VARS = ['CIS_PROXY_URL', 'CIS_AUTH_TOKEN', 'CIS_MODEL', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY'];
const LAUNCH_MS = 20_000;
const MiB = 1024 * 1024;

const r = (status, name, detail, hint) => ({ status, name, detail, ...(hint ? { hint } : {}) });
const ver = (s) => String(s).replace(/^[^\d]*/, '').split('.').slice(0, 3).map((n) => parseInt(n, 10) || 0);
const cmp = (a, b) => { for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; };
const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };
const isLoopback = (u) => { try { return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(u).hostname); } catch { return false; } };

const real = {
  env: process.env,
  nodeVersion: process.versions.node,
  root: () => getProjectRoot(),
  pkgRoot: PKG_ROOT,
  config: async (root) => (await import('../utils/config.js')).loadConfig(root),
  exec: (cmd, args) => {
    try { return execFileSync(cmd, args, { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; }
  },
  launchChromium: async () => {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ headless: true });
    await browser.close();
  },
  fetch: (url, init) => fetch(url, init),
  statfs: (p) => { const s = statfsSync(p); return s.bavail * s.bsize; },
};

function checkNode(d) {
  const want = readJson(path.join(d.pkgRoot, 'package.json'))?.engines?.node;
  const have = d.nodeVersion;
  if (want && cmp(ver(have), ver(want)) < 0) return r('FAIL', 'node', `Node ${have} is older than engines.node ${want}`, `Install Node ${ver(want).join('.')} or newer (see .nvmrc)`);
  const nvmrc = path.join(d.root, '.nvmrc');
  if (existsSync(nvmrc)) {
    const pinned = readFileSync(nvmrc, 'utf8').trim();
    if (ver(pinned)[0] !== ver(have)[0]) return r('WARN', 'node', `Node ${have} differs from .nvmrc ${pinned}`, `Run "nvm use" in ${d.root}`);
  }
  return r('PASS', 'node', `Node ${have}${want ? ` satisfies ${want}` : ''}`);
}

async function checkBrowser(d) {
  try {
    await withTimeout(d.launchChromium(), LAUNCH_MS, 'chromium launch');
    return r('PASS', 'chromium', 'Playwright Chromium launched and closed');
  } catch (err) {
    const timedOut = err.name === 'TimeoutError';
    return r('FAIL', 'chromium', timedOut ? `Chromium did not launch within ${LAUNCH_MS / 1000}s` : `Chromium cannot launch: ${String(err.message).split('\n')[0]}`,
      timedOut ? 'Kill stray chrome/headless_shell processes and retry' : 'Run "npx playwright install chromium" (Linux: add --with-deps)');
  }
}

function checkPackageManager(d) {
  const lockPm = [['pnpm-lock.yaml', 'pnpm'], ['package-lock.json', 'npm'], ['yarn.lock', 'yarn']].filter(([f]) => existsSync(path.join(d.root, f)));
  const issues = [];
  let hint;
  if (lockPm.length > 1) {
    issues.push(`several lockfiles (${lockPm.map(([f]) => f).join(', ')})`);
    hint = 'Keep one lockfile and delete the others';
  }
  const pkgMtime = existsSync(path.join(d.root, 'package.json')) ? statSync(path.join(d.root, 'package.json')).mtimeMs : 0;
  for (const [f] of lockPm) {
    if (statSync(path.join(d.root, f)).mtimeMs + 1000 < pkgMtime) {
      issues.push(`${f} is older than package.json`);
      hint ??= 'Run your install command to refresh the lockfile, then commit it';
    }
  }
  const v = lockPm.some(([, pm]) => pm === 'pnpm') ? d.exec('pnpm', ['--version']) : null;
  if (v && ver(v)[0] >= 11) {
    const set = d.env.pnpm_config_verify_deps_before_run;
    if (!['false', 'ignore'].includes(set)) {
      issues.push(`pnpm ${v} runs an implicit "pnpm install" before every script when the lockfile is stale; a host postinstall can then re-enter pnpm and the build looks hung`);
      hint ??= 'ada-scan sets pnpm_config_verify_deps_before_run=false for its own build (no implicit install, lockfile untouched); set the same variable in your shell for pnpm dev/build, or refresh the lockfile';
    }
  }
  // A module nested in another pnpm workspace is installed by the parent's pnpm.
  for (let dir = path.dirname(d.pkgRoot); ; dir = path.dirname(dir)) {
    if (existsSync(path.join(dir, 'pnpm-workspace.yaml'))) {
      issues.push(`module sits inside the pnpm workspace at ${dir}, so the parent's install and postinstall can run for it`);
      hint ??= 'Run pnpm commands from the host root with pnpm_config_verify_deps_before_run=false, or keep the module outside the workspace';
      break;
    }
    if (path.dirname(dir) === dir) break;
  }
  return issues.length ? r('WARN', 'package-manager', issues.join('; '), hint) : r('PASS', 'package-manager', lockPm.length ? `${lockPm[0][1]} lockfile${v ? `, pnpm ${v}` : ''}` : 'no lockfile found');
}

async function probe(d, url, init = {}) {
  return d.fetch(url, { ...init, signal: AbortSignal.timeout(5000), redirect: 'manual' });
}

async function checkDevServer(d, config) {
  if (!isLoopback(config.baseUrl)) return r('PASS', 'dev-server', 'no local URL configured, nothing to probe');
  try {
    await probe(d, config.baseUrl, { method: 'HEAD' });
    return r('PASS', 'dev-server', `${config.baseUrl} is reachable`);
  } catch {
    return r('WARN', 'dev-server', `${config.baseUrl} is not reachable`, `A scan starts it itself; to start it by hand run "${config.devCommand}"`);
  }
}

function checkBuildScript(d, config) {
  const [cmd, ...args] = String(config.buildCommand).split(/\s+/);
  if (!['pnpm', 'npm', 'yarn'].includes(cmd)) return r('PASS', 'build-script', `custom buildCommand "${config.buildCommand}"`);
  const script = args[0] === 'run' ? args[1] : args[0];
  const scripts = readJson(path.join(d.root, 'package.json'))?.scripts ?? {};
  return scripts[script]
    ? r('PASS', 'build-script', `"${script}" script present`)
    : r('WARN', 'build-script', `no "${script}" script in ${path.join(d.root, 'package.json')}; source tracing needs the instrumented build`, 'Add the script or set buildCommand in .scan-config.json');
}

function checkTracingReady(d, config) {
  const plan = planTracingBuild(d.root, config);
  if (plan.mode === 'unavailable') return r('WARN', 'tracing-ready', `source tracing cannot be set up automatically: ${plan.reason}`, plan.remedy);
  if (plan.mode === 'wrapped') return r('PASS', 'tracing-ready', `${path.basename(plan.configFile)} lacks the instrumentation plugin; the scan adds it through a temporary config (project untouched)`);
  return r('PASS', 'tracing-ready', plan.configFile ? `${path.basename(plan.configFile)} registers the instrumentation plugin` : `custom buildCommand "${plan.buildCommand}", tracing left to it`);
}

function checkCis(d) {
  const present = CIS_VARS.filter((n) => d.env[n]);
  return present.length
    ? r('PASS', 'cis-env', `set: ${present.join(', ')}`)
    : r('WARN', 'cis-env', `none of ${CIS_VARS.join(', ')} is set; scans work, CIS auto-fix does not`, 'Run "pnpm cis:configure" or export the variables (values are never printed)');
}

function checkOutDir(d, outDir) {
  const target = existsSync(outDir) ? outDir : d.root;
  let tmp;
  try {
    tmp = mkdtempSync(path.join(target, '.ada-doctor-'));
    writeFileSync(path.join(tmp, 'probe'), 'ok');
    return r('PASS', 'out-dir', `${outDir} is writable${target === outDir ? '' : ' (will be created)'}`);
  } catch (err) {
    return r('FAIL', 'out-dir', `${target} is not writable: ${err.code || err.message}`, 'Fix permissions or pass --out-dir to a writable path');
  } finally {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  }
}

function checkDisk(d, outDir) {
  let free;
  try { free = d.statfs(existsSync(outDir) ? outDir : d.root); } catch (err) { return r('WARN', 'disk-space', `cannot read free space: ${err.message}`); }
  const mib = Math.floor(free / MiB);
  if (mib < 200) return r('FAIL', 'disk-space', `${mib} MiB free`, 'Free at least 1 GiB; scans write reports and screenshots');
  return mib < 1024 ? r('WARN', 'disk-space', `${mib} MiB free`, 'Free at least 1 GiB for large scans') : r('PASS', 'disk-space', `${mib} MiB free`);
}

async function checkUrl(d, url) {
  const chain = [];
  let cur = url;
  try {
    for (let hop = 0; hop <= 5; hop++) {
      let res = await probe(d, cur, { method: 'HEAD' });
      if (res.status === 405 || res.status === 501) res = await probe(d, cur, { method: 'GET' });
      chain.push(`${res.status} ${cur}`);
      const loc = res.status >= 300 && res.status < 400 && res.headers.get('location');
      if (!loc) {
        const robots = res.headers.get('x-robots-tag') || '';
        const noindex = /noindex/i.test(robots);
        const detail = chain.join(' -> ') + (noindex ? ' (X-Robots-Tag: noindex, so SEO gates are skipped unless --seo-gate)' : '');
        return res.status >= 400
          ? r('FAIL', 'url', detail, 'Check the URL, VPN and authentication')
          : r('PASS', 'url', detail);
      }
      cur = new URL(loc, cur).href;
    }
    return r('FAIL', 'url', `more than 5 redirects: ${chain.join(' -> ')}`, 'Scan the final URL directly');
  } catch (err) {
    return r('FAIL', 'url', `${chain.length ? `${chain.join(' -> ')}; ` : ''}${cur} unreachable: ${err.cause?.code || err.message}`, 'Check the URL, network and VPN');
  }
}

/** Runs every check; `deps` overrides the real environment (tests). Returns the result list. */
export async function runChecks({ url, outDir } = {}, deps = {}) {
  const d = { ...real, ...deps };
  d.root = typeof d.root === 'function' ? d.root() : d.root;
  let config;
  try { config = await d.config(d.root); } catch (err) {
    return [r('FAIL', 'config', err.message, 'Fix .scan-config.json')];
  }
  const out = path.resolve(outDir ?? path.join(d.root, '.ada-scan'));
  const results = [checkNode(d), await checkBrowser(d), checkPackageManager(d), await checkDevServer(d, config), checkBuildScript(d, config), checkTracingReady(d, config), checkCis(d), checkOutDir(d, out), checkDisk(d, out)];
  if (url) results.push(await checkUrl(d, url));
  return results;
}

/** `ada-scan doctor [--url <url>] [--json] [--out-dir <dir>]`; returns the exit code (1 when any check FAILs). */
export async function runDoctor(argv = [], deps = {}, log = console.log) {
  const v = parseCliArgs(argv, OPTIONS);
  if (v.help) {
    log('Usage: ada-scan doctor [--url <url>] [--json] [--out-dir <dir>]\nChecks the environment; contacts the network only with --url. Exit 1 when a check FAILs.');
    return 0;
  }
  if (v.url && !/^https?:\/\//i.test(v.url)) {
    const { CliError } = await import('../utils/cli-args.js');
    throw new CliError(`--url must start with http:// or https://: ${v.url}`);
  }
  const results = await runChecks({ url: v.url, outDir: v['out-dir'] }, deps);
  const failed = results.some((x) => x.status === 'FAIL');
  if (v.json) log(JSON.stringify({ ok: !failed, checks: results }, null, 2));
  else {
    for (const x of results) {
      log(`${x.status.padEnd(4)}  ${x.name.padEnd(16)} ${x.detail}`);
      if (x.hint && x.status !== 'PASS') log(`      fix: ${x.hint}`);
    }
    log(failed ? '\nFAIL: fix the items above before scanning.' : '\nNo blocking problems.');
  }
  return failed ? 1 : 0;
}
