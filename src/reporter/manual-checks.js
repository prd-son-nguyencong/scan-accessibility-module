// Manual verification workflow (T-E11.9): the standing checklist, tool-owned sign-offs in <reports dir>/manual-checks.json,
// and the per-page summary the QA report shows. Nothing here says "compliant": a person signs each item off for each page.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { getReportsDir, setReportsDir } from '../utils/paths.js';
import { CliError, parseCliArgs } from '../utils/cli-args.js';

export const STALE_DAYS = 90;
export const MANUAL_STATUSES = ['pass', 'fail', 'na'];
const OWNER = 'ada-scan';
const DAY_MS = 86400000;

export const MANUAL_CHECKS = Object.freeze([
  { id: 'keyboard-operation', title: 'Keyboard-only use: every control reachable and operable, no keyboard trap, sensible order', sc: ['2.1.1', '2.1.2', '2.4.3', '3.2.1'] },
  { id: 'focus-visible', title: 'Visible focus: the focused control is always visible and not hidden behind other content', sc: ['2.4.7', '2.4.11'] },
  { id: 'screen-reader', title: 'Screen reader: names, roles, states and reading order make sense when announced', sc: ['1.3.1', '1.3.2', '2.4.6', '4.1.2'] },
  { id: 'zoom-reflow', title: 'Zoom 200% and 400% (320 px wide): no lost content or horizontal scrolling', sc: ['1.4.4', '1.4.10'] },
  { id: 'text-spacing', title: 'Text spacing overrides (line, paragraph, letter, word) lose no content', sc: ['1.4.12'] },
  { id: 'captions-audio-description', title: 'Captions, transcripts and audio description for audio and video', sc: ['1.2.1', '1.2.2', '1.2.3', '1.2.5'] },
  { id: 'motion-autoplay', title: 'Motion and auto-play: moving content can be paused, no audio starts alone, no flashing', sc: ['1.4.2', '2.2.2', '2.3.1'] },
  { id: 'error-identification', title: 'Form errors are identified in text, say how to fix them, and can be reviewed before submit', sc: ['3.3.1', '3.3.2', '3.3.3', '3.3.4'] },
  { id: 'content-readability', title: 'Content: meaningful alt text, clear link text, plain language, correct headings and page language', sc: ['1.1.1', '2.4.4', '2.4.6', '3.1.1', '3.1.2'] },
]);

/** Hash of a page's rendered markup without scripts, styles, comments and whitespace runs, so only content edits change it. */
export const pageContentHash = (html) => `sha256:${createHash('sha256').update(String(html).replace(/<(script|style)\b[\s\S]*?<\/\1>|<!--[\s\S]*?-->/gi, '').replace(/\s+/g, ' ').trim()).digest('hex')}`;

const ITEM_IDS = new Set(MANUAL_CHECKS.map((c) => c.id));
export const ALL_PAGES = '*';

const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);
const str = (v) => typeof v === 'string' && v.trim() !== '';

/** Returns the first schema problem of a parsed manual-checks.json, or null. */
export function validateManualStore(s) {
  if (!s || typeof s !== 'object' || Array.isArray(s)) return 'not an object';
  if (s.owner !== OWNER) return `missing "owner": "${OWNER}" marker`;
  if (s.version !== 1) return 'unsupported version';
  if (!Array.isArray(s.signoffs)) return '"signoffs" must be an array';
  const seen = new Set();
  for (const [i, r] of s.signoffs.entries()) {
    const at = `signoffs[${i}]`;
    if (!r || typeof r !== 'object') return `${at} is not an object`;
    if (!ITEM_IDS.has(r.item)) return `${at}.item is not a known check`;
    if (!str(r.page)) return `${at}.page is required`;
    if (!MANUAL_STATUSES.includes(r.status)) return `${at}.status must be one of ${MANUAL_STATUSES.join(', ')}`;
    if (!str(r.reviewer)) return `${at}.reviewer is required`;
    if (!isDate(r.date)) return `${at}.date must be YYYY-MM-DD`;
    if (typeof r.notes !== 'string') return `${at}.notes must be a string`;
    if (r.contentHash !== undefined && !str(r.contentHash)) return `${at}.contentHash must be a non-empty string`;
    const key = `${r.item}|${r.page}`;
    if (seen.has(key)) return `${at} repeats ${r.item} for ${r.page}`;
    seen.add(key);
  }
  return null;
}

export const manualChecksFile = () => path.join(getReportsDir(), 'manual-checks.json');

/** Missing file = empty store. A file that is not a valid tool-owned store throws and is never overwritten. */
export function loadManualStore(file = manualChecksFile()) {
  if (!existsSync(file)) return { owner: OWNER, version: 1, signoffs: [] };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new CliError(`${file} is not valid JSON (${err.message}); fix or remove it, ada-scan will not overwrite it.`);
  }
  const problem = validateManualStore(parsed);
  if (problem) throw new CliError(`${file} is not a valid ada-scan manual-checks file: ${problem}; ada-scan will not overwrite it.`);
  return parsed;
}

export function saveManualStore(store, file = manualChecksFile()) {
  const problem = validateManualStore(store);
  if (problem) throw new Error(`refusing to write invalid manual-checks store: ${problem}`);
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`);
  renameSync(tmp, file);
  return file;
}

/** Adds or replaces the sign-off for (item, page). Returns a new store. */
export function signOff(store, { item, page, status, reviewer, date, notes = '', contentHash }) {
  const record = { item, page, status, reviewer, date, notes, ...(contentHash ? { contentHash } : {}) };
  const next = { ...store, signoffs: [...store.signoffs.filter((r) => !(r.item === item && r.page === page)), record] };
  const problem = validateManualStore(next);
  if (problem) throw new CliError(`Invalid sign-off: ${problem}`);
  return next;
}

/** Why a sign-off no longer counts: older than STALE_DAYS, or the page content hash differs from the recorded one. null = fresh. */
export function staleReason(record, today, pageHash) {
  const age = Math.floor((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${record.date}T00:00:00Z`)) / DAY_MS);
  if (age > STALE_DAYS) return `signed off ${age} days ago (limit ${STALE_DAYS})`;
  if (record.contentHash && pageHash && record.contentHash !== pageHash) return 'page content changed since sign-off';
  return null;
}

/** Per-page counts. A page-specific sign-off wins over a site-wide one (page "*"). Items signed off = fresh pass or na. */
export function summarizeManual(store, pages, today) {
  const total = MANUAL_CHECKS.length;
  const rows = pages.map(({ route, contentHash }) => {
    let signed = 0;
    const failed = [];
    const stale = [];
    const open = [];
    for (const c of MANUAL_CHECKS) {
      const rec = store.signoffs.find((r) => r.item === c.id && r.page === route) || store.signoffs.find((r) => r.item === c.id && r.page === ALL_PAGES);
      const why = rec && staleReason(rec, today, contentHash);
      if (!rec) open.push(c.id);
      else if (why) stale.push({ item: c.id, reason: why });
      else if (rec.status === 'fail') failed.push(c.id);
      else signed += 1;
    }
    return { route, signed, total, failed, stale, open };
  });
  const sum = (k) => rows.reduce((n, r) => n + (typeof r[k] === 'number' ? r[k] : r[k].length), 0);
  return { rows, signed: sum('signed'), total: total * rows.length, failed: sum('failed'), stale: sum('stale') };
}

const tail = (failed, stale) => `${failed ? `, ${failed} failed` : ''}${stale ? `, ${stale} stale` : ''}`;
const AUTO_WORD = { PASS: 'passed', FAIL: 'failed', INCOMPLETE: 'incomplete' };

/** One line per page; never a bare "passed" or "compliant". */
export function manualPageSentence(auto, r) {
  return `Automated ${AUTO_WORD[auto] || 'not run'}; manual review ${r.signed} of ${r.total} items signed off${tail(r.failed.length, r.stale.length)}.`;
}

/** Overall verdict line for the QA report. */
export function manualVerdict(auto, sum) {
  const base = `Automated checks ${AUTO_WORD[auto] || 'not run'}; manual review ${sum.signed} of ${sum.total} page items signed off${tail(sum.failed, sum.stale)}.`;
  return `${base} ${sum.failed ? 'Manual review found failures.' : sum.signed === sum.total && sum.total ? 'Every manual item is signed off; this is still not a statement of WCAG conformance.' : 'Not a statement of WCAG conformance.'}`;
}

const MANUAL_OPTIONS = {
  help: { type: 'boolean', short: 'h' },
  page: { type: 'string' }, status: { type: 'string' }, reviewer: { type: 'string' }, note: { type: 'string' },
  date: { type: 'string' }, 'content-hash': { type: 'string' }, 'out-dir': { type: 'string' },
};

export const MANUAL_USAGE = `ada-scan manual - record human sign-offs for checks no scanner can make
  ada-scan manual list                       the checklist with WCAG criteria and item ids
  ada-scan manual sign <id> --page <route|*> --status pass|fail|na --reviewer <name> [--note <text>] [--date YYYY-MM-DD] [--content-hash <h>]
  ada-scan manual status [--page <route>] [--date YYYY-MM-DD]  sign-off counts per page (sign-offs older than ${STALE_DAYS} days are stale)
  --out-dir <dir>                            reports directory (default .ada-scan); sign-offs live in <dir>/manual-checks.json`;

/** The content hash the latest scan recorded for `route`, so a sign-off goes stale when that page changes. */
function latestPageHash(route) {
  try {
    return JSON.parse(readFileSync(path.join(getReportsDir(), 'latest.json'), 'utf8')).pages.find((p) => p.route === route)?.contentHash;
  } catch {
    return undefined;
  }
}

/** `ada-scan manual ...`; returns the text to print. */
export function runManualSubcommand(rawArgs, { now = () => new Date().toISOString().slice(0, 10) } = {}) {
  const [action, maybeId, ...rest] = rawArgs;
  if (!action || action.startsWith('-')) return MANUAL_USAGE;
  const withId = action === 'sign';
  const values = parseCliArgs(withId ? rest : [maybeId, ...rest].filter((a) => a !== undefined), MANUAL_OPTIONS);
  if (values.help) return MANUAL_USAGE;
  if (values['out-dir']) setReportsDir(values['out-dir']);
  if (action === 'list') {
    return MANUAL_CHECKS.map((c) => `${c.id}\n  ${c.title}\n  WCAG ${c.sc.join(', ')}`).join('\n');
  }
  if (action === 'sign') {
    const date = values.date || now();
    for (const [flag, v] of [['--page', values.page], ['--status', values.status], ['--reviewer', values.reviewer]]) {
      if (!v) throw new CliError(`manual sign needs ${flag}.`);
    }
    if (!ITEM_IDS.has(maybeId)) throw new CliError(`Unknown check "${maybeId}". Run "ada-scan manual list".`);
    const contentHash = values['content-hash'] || latestPageHash(values.page);
    const store = signOff(loadManualStore(), { item: maybeId, page: values.page, status: values.status, reviewer: values.reviewer, date, notes: values.note || '', contentHash });
    return `Saved ${maybeId} on ${values.page} as ${values.status}: ${saveManualStore(store)}`;
  }
  if (action === 'status') {
    const today = values.date || now();
    if (!isDate(today)) throw new CliError('--date must be YYYY-MM-DD.');
    const store = loadManualStore();
    const routes = values.page ? [values.page] : [...new Set(store.signoffs.map((r) => r.page))];
    const sum = summarizeManual(store, (routes.length ? routes : [ALL_PAGES]).map((route) => ({ route })), today);
    return sum.rows.map((r) => `${r.route}: ${r.signed} of ${r.total} items signed off${tail(r.failed.length, r.stale.length)}${r.stale.length ? `\n  stale: ${r.stale.map((s) => `${s.item} (${s.reason})`).join('; ')}` : ''}`).join('\n');
  }
  throw new CliError(`Unknown manual command "${action}".\n${MANUAL_USAGE}`);
}
