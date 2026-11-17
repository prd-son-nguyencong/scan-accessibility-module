// What a scan will trace against. A scan that silently traced the wrong repo reports file:line and sources that belong to another project,
// so every run states its project root, branch and commit first and warns when that root cannot be the site behind the URL.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { isLoopbackUrl } from '../utils/host-classify.js';

const git = (root, ...args) => {
  try { return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim() || null; } catch { return null; }
};

const portOf = (url) => { try { const u = new URL(url); return u.port || (u.protocol === 'https:' ? '443' : '80'); } catch { return null; } };

// Files where a project names the port its dev server listens on.
const PORT_FILES = /^(?:\.scan-config\.json|package\.json|\.env(?:\.[\w.-]+)?|(?:vite|vitest|astro|nuxt|next|svelte)\.config\.[cm]?[jt]s|\.scan-config\.[\w.-]+)$/;

/** True when the project root names `port` (a baseUrl, a dev script flag, a vite `port:`, an env var): evidence a dev server of this project serves it. */
export function rootNamesPort(root, port) {
  if (!port) return true;
  const re = new RegExp(`(?<![\\d])${port}(?![\\d])`);
  let names = [];
  try { names = readdirSync(root).filter((n) => PORT_FILES.test(n)); } catch { return false; }
  return names.some((n) => { try { return re.test(readFileSync(path.join(root, n), 'utf8')); } catch { return false; } });
}

/** { root, branch, commit, warnings[] } for the root a scan traces against. `url`: the local URL given with --url (a plain local scan starts its own dev server). */
export function describeTraceRoot({ root, cwd = process.cwd(), url = null } = {}) {
  const resolved = path.resolve(root);
  const warnings = [];
  const isProject = ['package.json', '.scan-config.json', 'src'].some((n) => existsSync(path.join(resolved, n)));
  if (!isProject) warnings.push(`the trace root ${resolved} is not a project (no package.json, .scan-config.json or src/); sources and file:line will be wrong or missing`);
  const rel = path.relative(resolved, path.resolve(cwd));
  if (rel.startsWith('..') || path.isAbsolute(rel)) warnings.push(`the working directory ${path.resolve(cwd)} is outside the trace root ${resolved}; check ADA_SCAN_ROOT / --source points at the site behind the URL`);
  if (url && isLoopbackUrl(url) && !rootNamesPort(resolved, portOf(url))) {
    warnings.push(`no evidence that ${resolved} serves ${new URL(url).origin} (its config, package.json and env files never name port ${portOf(url)}); the URL may belong to another project`);
  }
  return { root: resolved, branch: git(resolved, 'rev-parse', '--abbrev-ref', 'HEAD'), commit: git(resolved, 'rev-parse', '--short', 'HEAD'), warnings };
}

/** Prints the trace target and every warning; returns the description. */
export function printTraceRoot(opts, log = console.log) {
  const d = describeTraceRoot(opts);
  log(`Tracing against: ${d.root} (branch ${d.branch || 'none, not a git repo'}, commit ${d.commit || 'none'})`);
  for (const w of d.warnings) log(`\n!!! WARNING: ${w}\n`);
  return d;
}
