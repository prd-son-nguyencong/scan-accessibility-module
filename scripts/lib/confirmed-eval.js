import http from 'node:http';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanOnePage } from '../../src/index.js';
import { buildReportBundle } from '../../src/reporter/scan-report.js';
import { DEFAULT_CONFIG, mergeConfig } from '../../src/utils/config.js';
import { closeBrowser } from '../../src/scanner/browser.js';
import { WCAG_CRITERIA } from '../../src/utils/wcag-criteria.js';
import { ENGINES, criteriaByRule, loadCases } from './truth-corpus.js';

const FIXTURES = fileURLToPath(new URL('../../test/fixtures/', import.meta.url));
export const COMMITMENTS_URL = new URL('../../docs/accuracy-commitments.json', import.meta.url);
const WORKERS = Math.max(2, Math.min(8, os.cpus().length - 2)); // each worker drives one page of the shared browser
// Layers that need no network. w3c, links and lighthouse call out (or measure performance, not WCAG) and are left out.
const OFFLINE = { w3c: false, links: false, lighthouse: false };

/** Wilson score interval for k of n at 95%: { lo, hi } as fractions, null when n is 0. */
export function wilson(k, n, z = 1.959964) {
  if (!n) return null;
  const p = k / n;
  const d = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / d;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return { lo: Math.max(0, centre - half), hi: Math.min(1, centre + half) };
}

/** Success criteria a report finding speaks for: the criterion in its wcagRef text, plus every criterion its rule maps to in the registries. */
export function findingScs(finding, byRule) {
  const scs = new Set([...String(finding.wcagRef ?? '').matchAll(/\b(\d\.\d\.\d{1,2})\b/g)].map((m) => m[1]));
  for (const id of [finding.nativeRuleId, finding.canonicalRuleId]) {
    for (const layer of ENGINES) for (const sc of byRule[layer][id] ?? []) scs.add(sc);
  }
  return [...scs].sort();
}

/** Serves test/fixtures over loopback so the real scanner navigates to each fixture like a site. */
function serveFixtures() {
  const server = http.createServer((req, res) => {
    const file = path.join(FIXTURES, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!file.startsWith(FIXTURES)) return res.writeHead(403).end();
    let body;
    try {
      body = readFileSync(file);
    } catch {
      return res.writeHead(404).end();
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(body);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, origin: `http://127.0.0.1:${server.address().port}` })));
}

/**
 * Runs the real pipeline for one fixture (scanOnePage with every offline layer, then the report builder that assigns verdict tiers)
 * and returns { status, findings: [{ verdict, scs, rule, layer }] } for the finding rows of the report.
 */
async function reportFor(c, origin, config, byRule) {
  const rel = path.relative(FIXTURES, fileURLToPath(c.url)).split(path.sep).join('/');
  const page = { name: c.id, url: `${origin}/${rel}` };
  let pr;
  for (let attempt = 0; ; attempt++) {
    try {
      pr = await scanOnePage(page, config, { isUrlMode: true, includeThirdParty: true });
      break;
    } catch (err) {
      if (attempt) return { status: 'failed', error: err.message.split('\n')[0], findings: [] };
    }
  }
  const { report } = buildReportBundle([pr], { producer: { name: 'ada-scan', version: 'eval' } });
  const rows = report.pages.flatMap((p) => p.findings);
  return {
    status: report.pages[0]?.status ?? pr.status,
    findings: rows.map((f) => ({ verdict: f.verdict, scs: findingScs(f, byRule), rule: f.nativeRuleId, layer: f.layer })),
  };
}

/** Scans every labelled fixture through the real scan and report pipeline. Returns cases with `status` and `findings`. */
export async function runConfirmed({ workers = WORKERS, only = null, onProgress = () => {} } = {}) {
  const [all, byRule, { server, origin }] = await Promise.all([loadCases(), criteriaByRule(), serveFixtures()]);
  const cases = only ? all.filter((c) => new RegExp(only).test(c.id)) : all; // a development aid: the committed numbers come from the full run
  const config = mergeConfig(DEFAULT_CONFIG, { layers: OFFLINE });
  const queue = [...cases];
  const results = [];
  const log = console.log;
  const warn = console.warn;
  console.log = () => {}; // scanOnePage narrates every layer
  console.warn = () => {};
  try {
    await Promise.all(Array.from({ length: workers }, async () => {
      for (let c = queue.shift(); c; c = queue.shift()) {
        const { status, findings, error } = await reportFor(c, origin, config, byRule);
        results.push({ id: c.id, sc: c.sc, truth: c.truth, status, ...(error ? { error } : {}), findings });
        onProgress(results.length, cases.length);
      }
    }));
  } finally {
    console.log = log;
    console.warn = warn;
    await closeBrowser();
    server.close();
  }
  return results.sort((a, b) => a.id.localeCompare(b.id));
}

const confirmedFor = (r, sc) => r.findings.some((f) => f.verdict === 'confirmed' && f.scs.includes(sc));
const confirmedAny = (r) => r.findings.filter((f) => f.verdict === 'confirmed');
/** Strongest verdict the labelled criterion got on a fixture: confirmed, likely, needs-review or none. */
const bestVerdict = (r, sc) => ['confirmed', 'likely', 'needs-review'].find((v) => r.findings.some((f) => f.verdict === v && f.scs.includes(sc))) ?? 'none';

const rate = (k, n) => (n ? k / n : null);
const bySc = (a, b) => a.localeCompare(b, undefined, { numeric: true });

/**
 * Pure metrics. Confirmed recall: violation fixtures with a confirmed finding for the labelled criterion.
 * Confirmed false-positive rate: clean twins with any confirmed finding (any criterion, any rule).
 */
export function computeConfirmed(results) {
  const scanned = (r) => !['failed', 'skipped-empty'].includes(r.status); // a fixture whose scan did not complete says nothing: left out of every denominator
  const tally = (rows, sc) => {
    const bad = rows.filter((r) => r.truth === 'violation' && scanned(r));
    const good = rows.filter((r) => r.truth === 'clean' && scanned(r));
    const hit = bad.filter((r) => confirmedFor(r, sc ?? r.sc)).length;
    const fp = good.filter((r) => confirmedAny(r).length).length;
    const fpSame = good.filter((r) => confirmedFor(r, sc ?? r.sc)).length;
    // Every clean twin of the corpus, whatever criterion it was written for, with a confirmed finding that speaks for this criterion: a false alarm of this criterion's rules.
    const fpFinding = sc ? results.filter((r) => r.truth === 'clean' && scanned(r) && confirmedFor(r, sc)).length : null;
    return { fpSame, fpFinding, violations: bad.length, confirmed: hit, recall: rate(hit, bad.length), recallCi: wilson(hit, bad.length), clean: good.length, falsePositives: fp, fpRate: rate(fp, good.length), fpCi: wilson(fp, good.length) };
  };
  const perSc = [...new Set(results.map((r) => r.sc))].sort(bySc).map((sc) => ({ sc, ...tally(results.filter((r) => r.sc === sc), sc) }));
  return {
    overall: tally(results, null),
    perSc,
    missed: results.filter((r) => r.truth === 'violation' && !confirmedFor(r, r.sc)).map((r) => ({ id: r.id, sc: r.sc, best: bestVerdict(r, r.sc), status: r.status })),
    falseAlarms: results.filter((r) => r.truth === 'clean' && confirmedAny(r).length).map((r) => ({ id: r.id, sc: r.sc, found: [...new Set(confirmedAny(r).map((f) => `${f.rule} (${f.scs.join(',') || 'no criterion'})`))].sort() })),
    unscanned: results.filter((r) => ['failed', 'skipped-empty'].includes(r.status)).map((r) => ({ id: r.id, status: r.status })),
  };
}

// A criterion is validated only with evidence behind it: enough fixtures on both sides and a confirmed recall that is not a coin flip.
export const MIN_FIXTURES = 3;
export const MIN_RECALL = 0.6;
export const MAX_UNSCANNED = 2; // shortcut: today only rule-seeds/MetaRefresh/good.html is skipped-empty; raise only with a stated reason
const floor2 = (x) => Math.floor(x * 100 + 1e-9) / 100;
const ceil2 = (x) => Math.ceil(x * 100 - 1e-9) / 100;

/**
 * Starting commitments: each criterion at its measured value (recall rounded down, false-positive rate rounded up, so today's run
 * passes). Advisory, with the reason, when confirmed recall is under 60% or the criterion has fewer than 3 violation fixtures or fewer than
 * 3 clean twins; it is then reported and never fails the run.
 */
export function proposeCommitments(metrics) {
  const rules = {};
  for (const s of metrics.perSc) {
    const reason = s.violations < MIN_FIXTURES || s.clean < MIN_FIXTURES ? `fewer than ${MIN_FIXTURES} violation fixtures or clean twins (${s.violations} and ${s.clean})` : (s.recall ?? 0) < MIN_RECALL ? `confirmed recall ${pct(s.recall)} is under ${MIN_RECALL * 100}%` : null;
    rules[s.sc] = {
      status: reason ? 'advisory' : 'validated',
      ...(reason ? { reason } : {}),
      minRecall: floor2(s.recall ?? 0),
      maxFalsePositive: ceil2(s.fpRate ?? 0),
      maxFindingFalsePositives: s.fpFinding,
    };
  }
  return { note: 'Per success criterion (the unit the truth corpus labels). Measured by `npm run eval:truth` over the CONFIRMED tier. A validated criterion fails the run when its confirmed recall drops below minRecall or its confirmed false-positive rate rises above maxFalsePositive; advisory criteria are reported and never fail the run. Thresholds start at the measured value (recall rounded down, false-positive rate rounded up); tighten them when a fix lands, never loosen them to pass.', rules };
}

/** Violations of the commitments: validated criteria below their floor, and measured criteria with no commitment. */
export function checkCommitments(metrics, commitments) {
  const problems = [];
  const rules = commitments.rules ?? {};
  for (const s of metrics.perSc) {
    const c = rules[s.sc];
    if (!c) { problems.push(`${s.sc}: measured but has no entry in docs/accuracy-commitments.json (run with --update-commitments once and review the diff)`); continue; }
    if (c.status !== 'validated') continue;
    if ((s.recall ?? 0) + 1e-9 < c.minRecall) problems.push(`${s.sc}: confirmed recall ${pct(s.recall)} is below minRecall ${pct(c.minRecall)}`);
    if ((s.fpRate ?? 0) - 1e-9 > c.maxFalsePositive) problems.push(`${s.sc}: confirmed false-positive rate ${pct(s.fpRate)} is above maxFalsePositive ${pct(c.maxFalsePositive)}`);
    if (s.fpFinding > (c.maxFindingFalsePositives ?? 0)) problems.push(`${s.sc}: ${s.fpFinding} clean twins carry a confirmed finding for this criterion, above maxFindingFalsePositives ${c.maxFindingFalsePositives ?? 0}`);
  }
  if (metrics.unscanned.length > MAX_UNSCANNED) problems.push(`${metrics.unscanned.length} fixtures did not complete a scan (limit ${MAX_UNSCANNED}): ${metrics.unscanned.map((u) => u.id).join(', ')}`);
  return problems;
}

export const pct = (x) => (x === null || x === undefined ? '-' : `${(x * 100).toFixed(1).replace(/\.0$/, '')}%`);
const interval = (ci) => (ci ? `${pct(ci.lo)} to ${pct(ci.hi)}` : '-');

/** Renders docs/accuracy-measured.md (deterministic: no timings, no dates). */
export function renderAccuracy(metrics, commitments) {
  const titles = Object.fromEntries(WCAG_CRITERIA.map((c) => [c.id, c.title]));
  const o = metrics.overall;
  const statusOf = (sc) => commitments.rules?.[sc]?.status ?? 'none';
  const row = (name, s) => `| ${name} | ${s.violations} | ${s.confirmed} | ${pct(s.recall)} | ${interval(s.recallCi)} | ${s.clean} | ${s.falsePositives} | ${s.fpSame} | ${s.fpFinding ?? '-'} | ${pct(s.fpRate)} | ${interval(s.fpCi)} |`;
  const validated = metrics.perSc.filter((s) => statusOf(s.sc) === 'validated');
  const advisory = metrics.perSc.filter((s) => statusOf(s.sc) !== 'validated');
  return [
    '# Measured accuracy of confirmed findings',
    '',
    '<!-- GENERATED by `npm run eval:truth` from test/fixtures/truth-corpus, test/fixtures/rule-seeds and docs/accuracy-commitments.json. Do not edit by hand. -->',
    '',
    `Every labelled fixture (${o.violations} seeded violations, ${o.clean} clean twins; labels in \`test/fixtures/truth-corpus/labels.json\` and the rule-seeds) is served from a local static server and scanned by the real pipeline: \`scanOnePage\` with every offline layer (axe, accessScan, html-validate, keyboard, focus trap, aria-live, dynamic content, screen reader) and the same report builder the CLI uses, so the verdict tier is the one a URL scan shows a user. w3c, link checking and Lighthouse need the network and are left out. No LLM runs. This is the CONFIRMED tier; \`docs/truth-metrics.md\` measures which engine layer flags a case.`,
    '',
    '**What this does not measure.** These are URL scans of static fixtures. A local scan with a source adapter also runs `demoteUntraced`, which turns every site-owned confirmed finding without a traced `file:line` into `likely`, and `scanPages` applies configured `ruleDemotions`; neither runs here, so confirmed recall for local-source scans is not measured and is lower than the figures below by every finding the tracer cannot place. A page that redirects itself after a delay is scanned as the requested page: the scanner reads the refresh target from the loaded document and stops that navigation, so a timed `<meta http-equiv="refresh">` (3, 5, 10 and 600 second fixtures) is judged on the page that carries it.',
    '',
    '- **Confirmed recall**: seeded violation fixtures with a finding at verdict `confirmed` for the labelled success criterion. A `likely` or `needs-review` finding is not a hit.',
    '- **Confirmed false-positive rate**: clean twins with any `confirmed` finding, for any criterion or rule. A clean twin is a minimal page, so the rate understates what real pages produce, and the seeds are clear-cut, so recall overstates it. A confirmed finding for another criterion can be a real defect in the twin (an older seed with two adjacent small buttons, for example) rather than a false alarm: the column "of which the labelled criterion" counts the twins confirmed for their own criterion, and the table below names every finding.',
    '- **95% interval**: Wilson score interval. With a handful of fixtures per criterion the intervals are wide; read them before reading the percentage.',
    '- **Status** comes from `docs/accuracy-commitments.json`: `validated` criteria fail `npm run eval:truth` when they fall below their threshold; `advisory` criteria are reported only. A criterion is `validated` only with at least 3 violation fixtures, at least 3 clean twins and a confirmed recall of at least 60% when the commitments were set; the reason a criterion is advisory is in the commitments file.',
    '- **Confirmed by this criterion on any twin**: clean twins anywhere in the corpus, whatever criterion they were written for, that carry a confirmed finding speaking for this criterion. This is the false-alarm count of the criterion\'s own rules; `validated` criteria fail the run when it rises above `maxFindingFalsePositives`. A confirmed finding can still be a real defect in an older seed (small adjacent buttons), so read the table of findings below.',
    '',
    '## Overall',
    '',
    '| Scope | Violations | Confirmed | Confirmed recall | 95% interval | Clean twins | Confirmed on clean | Of which the labelled criterion | Confirmed by this criterion on any twin | Confirmed false-positive rate | 95% interval |',
    '|---|---|---|---|---|---|---|---|---|---|---|',
    row('All fixtures', o),
    row(`Validated criteria (${validated.length})`, sum(validated)),
    row(`Advisory criteria (${advisory.length})`, sum(advisory)),
    '',
    '## Per success criterion',
    '',
    '| SC | Title | Status | Violations | Confirmed | Confirmed recall | 95% interval | Clean twins | Confirmed on clean | Of which the labelled criterion | Confirmed by this criterion on any twin | Confirmed false-positive rate | 95% interval | Min recall | Max false positive | Max on any twin |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
    ...metrics.perSc.map((s) => `| ${s.sc} | ${titles[s.sc] ?? ''} | ${statusOf(s.sc)} | ${s.violations} | ${s.confirmed} | ${pct(s.recall)} | ${interval(s.recallCi)} | ${s.clean} | ${s.falsePositives} | ${s.fpSame} | ${s.fpFinding} | ${pct(s.fpRate)} | ${interval(s.fpCi)} | ${pct(commitments.rules?.[s.sc]?.minRecall)} | ${pct(commitments.rules?.[s.sc]?.maxFalsePositive)} | ${commitments.rules?.[s.sc]?.maxFindingFalsePositives ?? '-'} |`),
    '',
    '## Misses: violations with no confirmed finding for their criterion',
    '',
    'Best tier says what the criterion got instead: `likely` or `needs-review` means a finding exists but the tool would not stand behind it; `none` means nothing flagged the criterion.',
    '',
    ...(metrics.missed.length ? ['| Fixture | SC | Best tier for the criterion |', '|---|---|---|', ...metrics.missed.map((m) => `| \`${m.id}\` | ${m.sc} | ${m.best} |`)] : ['None.']),
    '',
    '## Confirmed findings on clean twins',
    '',
    ...(metrics.falseAlarms.length ? ['| Fixture | SC | Confirmed rule (criterion) |', '|---|---|---|', ...metrics.falseAlarms.map((m) => `| \`${m.id}\` | ${m.sc} | ${m.found.map((f) => `\`${f}\``).join(', ')} |`)] : ['None.']),
    '',
    ...(metrics.unscanned.length ? ['## Fixtures the scan did not complete', '', ...metrics.unscanned.map((u) => `- \`${u.id}\`: status ${u.status}`), ''] : []),
  ].join('\n');
}

function sum(rows) {
  const violations = rows.reduce((n, s) => n + s.violations, 0);
  const confirmed = rows.reduce((n, s) => n + s.confirmed, 0);
  const clean = rows.reduce((n, s) => n + s.clean, 0);
  const falsePositives = rows.reduce((n, s) => n + s.falsePositives, 0);
  const fpSame = rows.reduce((n, s) => n + s.fpSame, 0);
  const fpFinding = rows.reduce((n, s) => n + s.fpFinding, 0);
  return { fpSame, fpFinding, violations, confirmed, recall: rate(confirmed, violations), recallCi: wilson(confirmed, violations), clean, falsePositives, fpRate: rate(falsePositives, clean), fpCi: wilson(falsePositives, clean) };
}
