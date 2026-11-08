// Ground-truth labels (T-E11.6): QA marks a finding true-positive or false-positive, labels live in <reports dir>/labels.json,
// precision per rule = tp / (tp + fp), and a rule with enough labels and low precision is demoted to needs-review on later scans
// through <reports dir>/rule-demotions.json, which only `ada-scan labels apply --yes` writes.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { getReportsDir, setReportsDir } from '../utils/paths.js';
import { CliError, parseCliArgs } from '../utils/cli-args.js';
import { STABLE_ID_VERSION } from './fingerprint.js';

export const MIN_LABELS = 10;
export const MIN_PRECISION = 0.7;
export const LABEL_VERDICTS = ['true-positive', 'false-positive'];
const OWNER = 'ada-scan';

const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);
const str = (v) => typeof v === 'string' && v.trim() !== '';

export function validateLabelStore(s) {
  if (!s || typeof s !== 'object' || Array.isArray(s)) return 'not an object';
  if (s.owner !== OWNER) return `missing "owner": "${OWNER}" marker`;
  if (s.version !== 1) return 'unsupported version';
  if (!Array.isArray(s.labels)) return '"labels" must be an array';
  const seen = new Set();
  for (const [i, r] of s.labels.entries()) {
    const at = `labels[${i}]`;
    if (!r || typeof r !== 'object') return `${at} is not an object`;
    if (!str(r.stableId)) return `${at}.stableId is required`;
    if (!str(r.ruleId)) return `${at}.ruleId is required`;
    if (!LABEL_VERDICTS.includes(r.verdict)) return `${at}.verdict must be one of ${LABEL_VERDICTS.join(', ')}`;
    if (!str(r.labeler)) return `${at}.labeler is required`;
    if (!isDate(r.date)) return `${at}.date must be YYYY-MM-DD`;
    if (typeof r.note !== 'string') return `${at}.note must be a string`;
    if (!Number.isInteger(r.stableIdVersion) || r.stableIdVersion < 1) return `${at}.stableIdVersion must be a positive integer`;
    if (seen.has(r.stableId)) return `${at} repeats stableId ${r.stableId}`;
    seen.add(r.stableId);
  }
  return null;
}

export function validateDemotions(s) {
  if (!s || typeof s !== 'object' || Array.isArray(s)) return 'not an object';
  if (s.owner !== OWNER) return `missing "owner": "${OWNER}" marker`;
  if (s.version !== 1) return 'unsupported version';
  if (!Array.isArray(s.demotions)) return '"demotions" must be an array';
  for (const [i, d] of s.demotions.entries()) {
    if (!d || !str(d.ruleId)) return `demotions[${i}].ruleId is required`;
  }
  return null;
}

export const labelsFile = () => path.join(getReportsDir(), 'labels.json');
export const demotionsFile = () => path.join(getReportsDir(), 'rule-demotions.json');

/** Missing file = empty store. A file that is not a valid tool-owned store throws and is never overwritten. */
function loadOwned(file, empty, validate, name) {
  if (!existsSync(file)) return empty;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new CliError(`${file} is not valid JSON (${err.message}); fix or remove it, ada-scan will not overwrite it.`);
  }
  const problem = validate(parsed);
  if (problem) throw new CliError(`${file} is not a valid ada-scan ${name} file: ${problem}; ada-scan will not overwrite it.`);
  return parsed;
}

function saveOwned(file, store, validate) {
  const problem = validate(store);
  if (problem) throw new Error(`refusing to write an invalid store: ${problem}`);
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`);
  renameSync(tmp, file);
  return file;
}

export const loadLabels = (file = labelsFile()) => loadOwned(file, { owner: OWNER, version: 1, labels: [] }, validateLabelStore, 'labels');
export const saveLabels = (store, file = labelsFile()) => saveOwned(file, store, validateLabelStore);
export const loadDemotions = (file = demotionsFile()) => loadOwned(file, { owner: OWNER, version: 1, demotions: [] }, validateDemotions, 'rule-demotions');

/** Adds the label, or replaces the earlier one for the same stableId. Returns a new store. */
export function addLabel(store, record) {
  const next = { ...store, labels: [...store.labels.filter((r) => r.stableId !== record.stableId), record] };
  const problem = validateLabelStore(next);
  if (problem) throw new CliError(`Invalid label: ${problem}`);
  return next;
}

/** Per rule: tp, fp, n and precision = tp / n (n = tp + fp), sorted by rule id. */
export function rulePrecision(labels) {
  const rules = new Map();
  for (const l of labels) {
    const r = rules.get(l.ruleId) || { ruleId: l.ruleId, tp: 0, fp: 0 };
    r[l.verdict === 'true-positive' ? 'tp' : 'fp'] += 1;
    rules.set(l.ruleId, r);
  }
  return [...rules.values()].map((r) => ({ ...r, n: r.tp + r.fp, precision: r.tp / (r.tp + r.fp) })).sort((a, b) => a.ruleId.localeCompare(b.ruleId));
}

/** Rules with at least MIN_LABELS labels and precision below MIN_PRECISION. */
export const lowPrecisionRules = (stats) => stats.filter((r) => r.n >= MIN_LABELS && r.precision < MIN_PRECISION);

/** Labels made under another stableId algorithm: they cannot be matched to this scan's findings. */
export const staleLabels = (labels) => labels.filter((l) => l.stableIdVersion !== STABLE_ID_VERSION);

export const pct = (p) => `${Math.round(p * 1000) / 10}%`;

/**
 * Moves a finding to needs-review (and tags every finding of the rule with `demotion`) when every rule that reported it is demoted; the verdict it had is kept in
 * verdictBeforeAgreement (the baseline comparison reads it, so a fix still shows as fixed) and `demotion` says why.
 */
export function applyRuleDemotions(findings, demotedRuleIds) {
  if (!demotedRuleIds?.size) return findings;
  for (const f of findings) {
    if (!f.nativeRuleIds.every((id) => demotedRuleIds.has(id))) continue;
    // Already needs-review (e.g. single-engine under strict) keeps its verdict but is still counted as affected by the rule.
    if (f.verdict !== 'needs-review') {
      f.verdictBeforeAgreement ??= f.verdict;
      f.verdict = 'needs-review';
    }
    f.demotion = 'rule-precision';
  }
  return findings;
}

/** What a scan needs from the labels: the demotions to apply and warnings to print. Unreadable files warn; they never stop a scan. */
export function loadScanLabelContext() {
  const warnings = [];
  let demotions = [];
  try {
    demotions = loadDemotions().demotions;
  } catch (err) {
    warnings.push(`${err.message} Rule demotions were not applied.`);
  }
  try {
    const { labels } = loadLabels();
    const old = staleLabels(labels).length;
    if (old) warnings.push(`${old} label(s) were made under stable-id v${[...new Set(staleLabels(labels).map((l) => l.stableIdVersion))].join('/v')} and cannot be matched to this scan (v${STABLE_ID_VERSION}); they still count in rule precision. Re-label current findings to refresh them.`);
    const pending = lowPrecisionRules(rulePrecision(labels)).filter((r) => !demotions.some((d) => d.ruleId === r.ruleId));
    if (pending.length) warnings.push(`${pending.length} rule(s) have precision below ${pct(MIN_PRECISION)} over at least ${MIN_LABELS} labels (${pending.map((r) => `${r.ruleId} ${pct(r.precision)}`).join(', ')}); run "ada-scan labels apply --yes" to demote them to needs-review.`);
  } catch (err) {
    warnings.push(err.message);
  }
  return { demotions, warnings };
}

const LABEL_OPTIONS = {
  help: { type: 'boolean', short: 'h' },
  tp: { type: 'boolean' }, fp: { type: 'boolean' }, yes: { type: 'boolean' },
  by: { type: 'string' }, note: { type: 'string' }, date: { type: 'string' }, rule: { type: 'string' },
  'from-report': { type: 'string' }, 'out-dir': { type: 'string' },
};

export const LABEL_USAGE = `ada-scan label - record whether a finding is a real problem (ground truth from QA)
  ada-scan label <stableId> --tp|--fp --by <name> [--note <text>] [--rule <ruleId>] [--date YYYY-MM-DD]
  ada-scan label --from-report <n> --tp|--fp --by <name>   the n-th finding (1-based, report order) of the latest scan
  ada-scan labels stats                                    precision per rule, with the number of labels behind it
  ada-scan labels apply [--yes]                            list (and with --yes write) rule-demotions.json for rules with
                                                           at least ${MIN_LABELS} labels and precision below ${pct(MIN_PRECISION)}; those rules become needs-review on later scans
  --out-dir <dir>                                          reports directory (default .ada-scan); labels live in <dir>/labels.json
Each finding in the QA report shows its ready-to-copy label command.`;

function latestFindings() {
  try {
    const report = JSON.parse(readFileSync(path.join(getReportsDir(), 'latest.json'), 'utf8'));
    return { stableIdVersion: report.stableIdVersion ?? 1, findings: (report.pages || []).flatMap((p) => p.findings || []) };
  } catch {
    return { stableIdVersion: STABLE_ID_VERSION, findings: [] };
  }
}

/** `ada-scan label ...`; returns the text to print. */
export function runLabelSubcommand(rawArgs, { now = () => new Date().toISOString().slice(0, 10) } = {}) {
  const positional = rawArgs[0] && !rawArgs[0].startsWith('-') ? rawArgs[0] : undefined;
  const values = parseCliArgs(positional ? rawArgs.slice(1) : rawArgs, LABEL_OPTIONS);
  if (values.help || (!positional && !values['from-report'])) return LABEL_USAGE;
  if (values['out-dir']) setReportsDir(values['out-dir']);
  if (Boolean(values.tp) === Boolean(values.fp)) throw new CliError('label needs exactly one of --tp or --fp.');
  if (!values.by) throw new CliError('label needs --by <name>.');
  const date = values.date || now();
  if (!isDate(date)) throw new CliError('--date must be YYYY-MM-DD.');
  if (positional && values['from-report']) throw new CliError('Give a stableId or --from-report, not both.');
  const latest = latestFindings();
  let found;
  if (values['from-report']) {
    const n = Number(values['from-report']);
    found = Number.isInteger(n) ? latest.findings[n - 1] : undefined;
    if (!found) throw new CliError(`--from-report ${values['from-report']}: the latest scan has ${latest.findings.length} finding(s) (numbered from 1).`);
  } else {
    found = latest.findings.find((f) => f.stableId === positional);
  }
  const stableId = found?.stableId ?? positional;
  const ruleId = values.rule || found?.nativeRuleId;
  if (!stableId) throw new CliError('That finding has no stableId (the report predates stable ids).');
  if (!ruleId) throw new CliError(`${stableId} is not in the latest scan, so its rule is unknown; add --rule <ruleId>.`);
  const record = {
    stableId, ruleId, verdict: values.tp ? 'true-positive' : 'false-positive', labeler: values.by, date, note: values.note || '',
    stableIdVersion: found ? latest.stableIdVersion : STABLE_ID_VERSION,
  };
  return `Saved ${record.verdict} for ${ruleId} (${stableId}): ${saveLabels(addLabel(loadLabels(), record))}`;
}

/** `ada-scan labels stats|apply`; returns the text to print. */
export function runLabelsSubcommand(rawArgs) {
  const [action, ...rest] = rawArgs;
  if (!action || action.startsWith('-')) return LABEL_USAGE;
  const values = parseCliArgs(rest, LABEL_OPTIONS);
  if (values.help) return LABEL_USAGE;
  if (values['out-dir']) setReportsDir(values['out-dir']);
  if (action !== 'stats' && action !== 'apply') throw new CliError(`Unknown labels command "${action}".\n${LABEL_USAGE}`);
  const { labels } = loadLabels();
  const stats = rulePrecision(labels);
  const low = lowPrecisionRules(stats);
  if (action === 'stats') {
    const lines = stats.length
      ? ['rule  tp  fp  n  precision', ...stats.map((r) => `${r.ruleId}  ${r.tp}  ${r.fp}  ${r.n}  ${pct(r.precision)}${r.n < MIN_LABELS ? `  (fewer than ${MIN_LABELS} labels, not acted on)` : r.precision < MIN_PRECISION ? '  (below threshold)' : ''}`)]
      : ['No labels yet. Run "ada-scan label --help".'];
    const old = staleLabels(labels).length;
    if (old) lines.push(`Warning: ${old} label(s) were made under another stable-id version than this tool's v${STABLE_ID_VERSION}; they cannot be matched to current findings but still count above.`);
    return lines.join('\n');
  }
  const date = new Date().toISOString().slice(0, 10);
  const next = { owner: OWNER, version: 1, demotions: low.map((r) => ({ ruleId: r.ruleId, tp: r.tp, fp: r.fp, n: r.n, precision: Math.round(r.precision * 1000) / 1000, date })) };
  const list = low.length ? low.map((r) => `  ${r.ruleId}: ${pct(r.precision)} over ${r.n} labels`).join('\n') : '  none';
  if (!values.yes) return `Rules that would be demoted to needs-review (precision below ${pct(MIN_PRECISION)}, at least ${MIN_LABELS} labels):\n${list}\nNothing written. Re-run with --yes to write ${demotionsFile()}.`;
  loadDemotions(); // refuses to overwrite a file the tool does not own
  return `Demoted to needs-review on later scans:\n${list}\nWrote ${saveOwned(demotionsFile(), next, validateDemotions)}`;
}
