// G8 fact collectors (docs/fix-harness.md section 4): project build, html-validate error count, Paradox export validity, formatter check.
// Each collector returns a plain fact; collectBuildFacts() assembles the input of gates.evaluateBuildValidity plus notes for the report.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { runManagedCommand } from '../verify/shadow.js';
import { validateHtml } from '../../scanner/html-validate.js';

const tail = (s, n = 1500) => String(s || '').slice(-n);

/** Total bytes of regular files under dir (0 when missing). */
export function dirSize(dir) {
  let n = 0;
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const st = statSync(join(d, name));
      if (st.isDirectory()) walk(join(d, name)); else if (st.isFile()) n += st.size;
    }
  };
  if (existsSync(dir)) walk(dir);
  return n;
}

/** Runs the project build in `root`. Never throws for a failing build: { ok, exitCode, durationMs, outputBytes, stderrTail }. */
export async function runBuild({ root, build, outDir = 'dist', signal, timeoutMs }) {
  const started = Date.now();
  try {
    const r = await runManagedCommand(build.command, build.args || [], root, { signal, timeoutMs });
    return { ok: r.code === 0, exitCode: r.code, durationMs: Date.now() - started, outputBytes: dirSize(join(root, outDir)), stdoutTail: tail(r.stdout), stderrTail: tail(r.stderr) };
  } catch (err) {
    return { ok: false, exitCode: null, error: err.code || err.message, durationMs: Date.now() - started, outputBytes: 0, stdoutTail: '', stderrTail: tail(err.message) };
  }
}

/**
 * html-validate error count over the served documents of `routes` (warnings do not count). `validate(html)` is injectable.
 * A route that cannot be fetched or validated is recorded in `skipped` ({ route, reason }) and left out of the totals: it never aborts the run.
 */
export async function countHtmlValidateErrors({ baseUrl, routes, validate = validateHtml, fetchImpl = fetch }) {
  const byRoute = {};
  const hashes = {}; // sha256 of each served document: lets the caller tell which routes an edit changed
  const skipped = [];
  let total = 0;
  for (const route of routes) {
    try {
      const res = await fetchImpl(new URL(route, baseUrl).href);
      if (!res.ok) throw new Error(`answered ${res.status}`);
      const html = await res.text();
      const n = (await validate(html)).filter((v) => v.type === 'error').length;
      hashes[route] = createHash('sha256').update(html).digest('hex');
      byRoute[route] = n;
      total += n;
    } catch (err) { skipped.push({ route, reason: String(err.message).slice(0, 160) }); }
  }
  return { total, byRoute, hashes, skipped };
}

/** Totals over the routes measured on both sides, so a route skipped on one side cannot fake a regression or an improvement. */
export function compareHtmlErrors(before, after) {
  const common = Object.keys(before.byRoute).filter((r) => r in after.byRoute);
  const sum = (m) => common.reduce((n, r) => n + m.byRoute[r], 0);
  return { before: sum(before), after: sum(after) };
}

/**
 * Paradox export validity. Applicable when the project has a plugins/paradox-export.* file or a built export file exists. Valid = parses
 * as a non-empty JSON object/array and keeps every top-level key of the baseline export. Not applicable = valid with a note
 * (a project without the export plugin has nothing to validate).
 */
export function checkExport({ root, outDir = 'dist', exportFile = null, baselineKeys = null }) {
  const file = exportFile || `${outDir}/paradox-export.json`;
  const abs = join(root, file);
  const plugin = existsSync(join(root, 'plugins')) && readdirSync(join(root, 'plugins')).some((n) => /^paradox-export\./.test(n));
  if (!existsSync(abs)) return plugin ? { applicable: true, valid: false, file, reason: 'EXPORT_MISSING' } : { applicable: false, valid: true, file, reason: 'no export plugin or export file in the project' };
  try {
    const json = JSON.parse(readFileSync(abs, 'utf8'));
    if (!json || typeof json !== 'object') return { applicable: true, valid: false, file, reason: 'EXPORT_NOT_OBJECT' };
    const keys = Array.isArray(json) ? [] : Object.keys(json).sort();
    if (Array.isArray(json) ? !json.length : !keys.length) return { applicable: true, valid: false, file, reason: 'EXPORT_EMPTY' };
    const lost = (baselineKeys || []).filter((k) => !keys.includes(k));
    return lost.length ? { applicable: true, valid: false, file, keys, reason: 'EXPORT_KEYS_LOST', lost } : { applicable: true, valid: true, file, keys };
  } catch {
    return { applicable: true, valid: false, file, reason: 'EXPORT_INVALID_JSON' };
  }
}

const PRETTIER_CONFIG = ['.prettierrc', '.prettierrc.json', '.prettierrc.yml', '.prettierrc.yaml', '.prettierrc.js', '.prettierrc.cjs', '.prettierrc.mjs', 'prettier.config.js', 'prettier.config.cjs', 'prettier.config.mjs'];

/**
 * Formatter check on the touched files. `formatCheck` ({command,args}, files are appended) overrides the auto mode. Auto mode runs the
 * project's own prettier (node_modules/prettier in the shadow) when a prettier config exists; otherwise it is skipped with a note
 * (skipped counts as clean and is reported as such, never as a pass of a real check).
 */
export async function checkFormatter({ root, files, formatCheck = null, signal }) {
  const present = files.filter((f) => existsSync(join(root, f)));
  if (!present.length) return { clean: true, skipped: true, note: 'no touched files to check', files: [] };
  let command = formatCheck;
  if (!command) {
    const hasConfig = PRETTIER_CONFIG.some((n) => existsSync(join(root, n))) || /"prettier"\s*:/.test(existsSync(join(root, 'package.json')) ? readFileSync(join(root, 'package.json'), 'utf8') : '');
    if (!hasConfig) return { clean: true, skipped: true, note: 'no prettier config in the project', files: present };
    const bin = join(root, 'node_modules', 'prettier', 'bin', 'prettier.cjs');
    if (!existsSync(bin)) return { clean: true, skipped: true, note: 'prettier is not installed in the shadow (no node_modules); add verifyInstallCommand or shareNodeModules to enable', files: present };
    command = { command: 'node', args: [bin, '--check'] };
  }
  try {
    const r = await runManagedCommand(command.command, [...(command.args || []), ...present], root, { signal });
    return { clean: r.code === 0, skipped: false, exitCode: r.code, files: present, output: tail(`${r.stdout}\n${r.stderr}`, 800) };
  } catch (err) {
    return { clean: false, skipped: false, error: err.code || err.message, files: present };
  }
}

/**
 * Assembles the G8 input. baseline = { htmlErrors, exportKeys } measured on the accepted state; the returned `measured` becomes the next baseline.
 * Any fact that cannot be measured is left null/absent so evaluateBuildValidity fails closed.
 */
export async function collectBuildFacts({ root, buildResult, outDir, baseUrl, routes, touchedFiles, baseline, config = {}, signal, htmlErrors = null }) {
  const notes = [];
  const measured = { htmlErrors: null, exportKeys: baseline?.exportKeys ?? null };
  let htmlValidate = null;
  if (buildResult?.ok) {
    try {
      measured.htmlErrors = htmlErrors || await countHtmlValidateErrors({ baseUrl, routes, validate: config.validateHtml, fetchImpl: config.fetchImpl });
      if (baseline?.htmlErrors) htmlValidate = compareHtmlErrors(baseline.htmlErrors, measured.htmlErrors);
      for (const k of measured.htmlErrors.skipped) notes.push(`html-validate skipped ${k.route}: ${k.reason}`);
    } catch (err) { notes.push(`html-validate failed: ${String(err.message).slice(0, 200)}`); }
  }
  const exp = buildResult?.ok ? checkExport({ root, outDir, exportFile: config.exportFile, baselineKeys: baseline?.exportKeys }) : null;
  if (exp?.keys) measured.exportKeys = exp.keys;
  if (exp && !exp.applicable) notes.push(`export: ${exp.reason}`);
  const fmt = buildResult?.ok ? await checkFormatter({ root, files: touchedFiles, formatCheck: config.formatCheck, signal }) : null;
  if (fmt?.skipped) notes.push(`formatter skipped: ${fmt.note}`);
  return {
    facts: {
      build: buildResult ? { ok: buildResult.ok, exitCode: buildResult.exitCode, outputBytes: buildResult.outputBytes, durationMs: buildResult.durationMs } : undefined,
      htmlValidate: htmlValidate || undefined,
      exportValid: exp ? exp.valid : null,
      formatterClean: fmt ? fmt.clean : null,
    },
    measured,
    detail: { export: exp, formatter: fmt },
    notes,
  };
}
