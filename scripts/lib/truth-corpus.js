import { readFileSync } from 'node:fs';
import { AxeBuilder } from '@axe-core/playwright';
import { getBrowser, closeBrowser, newPage } from '../../src/scanner/browser.js';
import { installRuntimeHooks } from '../../src/scanner/access-scan/runtime/index.js';
import { scanWithAccessScan } from '../../src/scanner/access-scan/index.js';
import { validateHtml } from '../../src/scanner/html-validate.js';
import { WCAG_CRITERIA } from '../../src/utils/wcag-criteria.js';
import { FAST, SEED_DIR, listSeeds } from './seeds.js';
import { ruleDocFacts } from './rule-doc.js';
import { rulesBySuccessCriterion } from './wcag-coverage-doc.js';

export const TRUTH_DIR = new URL('../../test/fixtures/truth-corpus/', import.meta.url);
export const ENGINES = ['axe', 'accessScan', 'accessScanHeuristic', 'htmlValidate'];
const GUESSING = 'accessScanHeuristic'; // reported per layer, never counted in the any-layer and agreement figures
const LABEL = { axe: 'axe', accessScan: 'accessScan (deterministic)', accessScanHeuristic: 'accessScan (heuristic)', htmlValidate: 'html-validate' };
const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const WORKERS = 2;

/**
 * Every labeled case: { id, sc, truth: 'violation'|'clean', url }. Truth comes from how the fixture was authored (a hand-written
 * violation of the criterion, or its clean twin), never from an engine run. truth-corpus/labels.json names the criterion per pair;
 * the older rule-seeds take the criterion their rule declares (bad = violation, good = clean).
 */
export async function loadCases() {
  const cases = [];
  const { cases: pairs } = JSON.parse(readFileSync(new URL('labels.json', TRUTH_DIR), 'utf8'));
  for (const p of pairs) {
    cases.push({ id: `truth-corpus/${p.bad}`, sc: p.sc, truth: 'violation', url: new URL(p.bad, TRUTH_DIR) });
    cases.push({ id: `truth-corpus/${p.good}`, sc: p.sc, truth: 'clean', url: new URL(p.good, TRUTH_DIR) });
  }
  const scByRule = Object.fromEntries((await ruleDocFacts()).rules.map((r) => [r.id, r.standard.criterion]));
  for (const s of listSeeds()) {
    if (!/^\d+\.\d+\.\d+$/.test(scByRule[s.ruleId] ?? '')) continue; // best-practice rule: no criterion to label
    cases.push({ id: `rule-seeds/${s.ruleId}/${s.file}`, sc: scByRule[s.ruleId], truth: s.expect === 'bad' ? 'violation' : 'clean', url: new URL(`${s.ruleId}/${s.file}`, SEED_DIR) });
  }
  return cases.sort((a, b) => a.id.localeCompare(b.id));
}

/** { layer: { ruleId: Set<sc> } } from the same registries the coverage matrix uses; accessScan splits by rule kind. */
export async function criteriaByRule() {
  const out = Object.fromEntries(ENGINES.map((e) => [e, {}]));
  const add = (layer, id, sc) => (out[layer][id] ??= new Set()).add(sc);
  for (const [sc, byEngine] of Object.entries(await rulesBySuccessCriterion())) {
    for (const id of byEngine.axe) add('axe', id, sc);
    for (const id of byEngine.htmlValidate) add('htmlValidate', id, sc);
  }
  for (const r of (await ruleDocFacts()).rules) {
    if (r.status === 'active' && /^\d+\.\d+\.\d+$/.test(r.standard.criterion)) add(r.kind === 'deterministic' ? 'accessScan' : 'accessScanHeuristic', r.id, r.standard.criterion);
  }
  return out;
}

/** True when the layer has at least one rule for the criterion. */
export const coversFrom = (byRule) => (layer, sc) => Object.values(byRule[layer]).some((scs) => scs.has(sc));

// An iframe that settles late can destroy the execution context mid-run; shortcut: one retry, no wait on the frame.
async function analyzeAxe(page) {
  try {
    return await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  } catch {
    return new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  }
}

/** Runs every layer over each case; adds `found` = { engine: [criteria of the findings] }. */
export async function runEngines(cases, byRule) {
  const browser = await getBrowser();
  const queue = [...cases];
  const results = [];
  const scs = (engine, ids) => [...new Set(ids.flatMap((id) => [...(byRule[engine][id] ?? [])]))].sort();
  // A fresh page per fixture: a reused page leaked state between cases and made the generated doc differ from run to run.
  const worker = async () => {
    for (let c = queue.shift(); c; c = queue.shift()) {
      const page = await newPage(browser);
      try {
        await installRuntimeHooks(page);
        const html = readFileSync(c.url, 'utf8');
        await page.setContent(html);
        const axe = await analyzeAxe(page);
        const access = await scanWithAccessScan(page, `fixture://truth/${c.id}`, { skipNavigation: true, ...FAST });
        const hv = await validateHtml(html);
        results.push({
          ...c,
          found: {
            axe: scs('axe', axe.violations.map((v) => v.id)),
            accessScan: scs('accessScan', access.map((v) => v.ruleId)),
            accessScanHeuristic: scs('accessScanHeuristic', access.map((v) => v.ruleId)),
            htmlValidate: scs('htmlValidate', hv.map((v) => v.rule)),
          },
        });
      } finally {
        await page.context().close();
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: WORKERS }, worker));
  } finally {
    await closeBrowser();
  }
  return results.sort((a, b) => a.id.localeCompare(b.id));
}

const pct = (n, d) => (d ? `${Math.round((n / d) * 100)}%` : '-');
const frac = (n, d) => (d ? `${n}/${d}` : '-');

/**
 * Pure metrics over run results. A finding counts for a case only when its rule maps to the case's criterion.
 * `covers(engine, sc)` says whether the engine has any rule for the criterion; cases outside that are out of scope for the engine.
 */
export function computeMetrics(results, covers) {
  const flagged = (r, engine) => r.found[engine].includes(r.sc);
  const engines = ENGINES.map((engine) => {
    const own = results.filter((r) => covers(engine, r.sc));
    const bad = own.filter((r) => r.truth === 'violation');
    const good = own.filter((r) => r.truth === 'clean');
    return {
      engine,
      violations: bad.length,
      detected: bad.filter((r) => flagged(r, engine)).length,
      clean: good.length,
      falsePositives: good.filter((r) => flagged(r, engine)).length,
      outOfScope: results.filter((r) => r.truth === 'violation' && !covers(engine, r.sc)).length,
    };
  });
  const solid = ENGINES.filter((e) => e !== GUESSING);
  const shared = results.filter((r) => solid.filter((e) => covers(e, r.sc)).length >= 2);
  const agreed = shared.filter((r) => new Set(solid.filter((e) => covers(e, r.sc)).map((e) => flagged(r, e))).size === 1).length;
  const perSc = [...new Set(results.map((r) => r.sc))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).map((sc) => {
    const own = results.filter((r) => r.sc === sc);
    const bad = own.filter((r) => r.truth === 'violation');
    const good = own.filter((r) => r.truth === 'clean');
    const byEngine = Object.fromEntries(ENGINES.map((e) => [e, covers(e, sc) ? bad.filter((r) => flagged(r, e)).length : null]));
    const any = bad.filter((r) => solid.some((e) => flagged(r, e))).length;
    return { sc, violations: bad.length, clean: good.length, byEngine, any, falsePositives: good.filter((r) => solid.some((e) => flagged(r, e))).length };
  });
  return { engines, shared: shared.length, agreed, perSc };
}

/** Renders docs/truth-metrics.md (deterministic: no timings). */
export function renderTruthMetrics(results, covers) {
  const m = computeMetrics(results, covers);
  const bad = results.filter((r) => r.truth === 'violation').length;
  const titles = Object.fromEntries(WCAG_CRITERIA.map((c) => [c.id, c.title]));
  const solid = ENGINES.filter((e) => e !== GUESSING);
  const hit = (r) => solid.some((e) => r.found[e].includes(r.sc));
  const missed = results.filter((r) => r.truth === 'violation' && !hit(r));
  const flaggedClean = results.filter((r) => r.truth === 'clean' && hit(r));
  const handWritten = new Set(results.filter((r) => r.id.startsWith('truth-corpus/')).map((r) => r.sc));
  const fullNoPair = WCAG_CRITERIA.filter((c) => c.coverage === 'full' && !handWritten.has(c.id)).map((c) => c.id);
  const onlyOlder = [...new Set(results.map((r) => r.sc))].filter((sc) => !handWritten.has(sc)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const low = m.perSc.filter((s) => s.violations && s.any / s.violations < 0.9);
  const lines = [
    '# Truth-corpus metrics',
    '',
    '<!-- GENERATED by `npm run truth:metrics` from test/fixtures/truth-corpus and test/fixtures/rule-seeds. Do not edit by hand. -->',
    '',
    `${results.length} hand-written fixtures (${bad} seeded violations, ${results.length - bad} clean twins) are each labeled with one WCAG success criterion and a truth: the fixture violates that criterion or it does not. The label comes from how the fixture was authored against the criterion text (\`test/fixtures/truth-corpus/labels.json\` states the reason per pair; the older rule-seeds take the criterion their rule declares), never from an engine run. Every layer runs on every fixture (accessScan is split into its deterministic and heuristic rules, because heuristics guess and trip on tiny pages); a finding counts only when its rule maps to the labeled criterion (same mapping as docs/wcag-coverage.md).`,
    '',
    '- **Recall** measures how many seeded violations the layer flags, among the criteria it has any rule for (scope is the criterion, not the individual rule, so a layer is also charged for seeds written for the rule of another layer). It says nothing about violations nobody seeded, and the seeds are small and clear-cut, so it overstates recall on real pages.',
    '- **False-positive rate** measures how many clean fixtures the engine flags for the labeled criterion. Clean twins are minimal pages, so it understates the rate on real pages.',
    '- **Agreement** measures how often layers that cover the same criterion give the same flagged/not-flagged verdict on a fixture. Agreement is not accuracy: two layers can agree and both be wrong.',
    '- Truth is not parity. The commercial-parity corpus (`scripts/accessscan-corpus`) measures how closely accessScan matches another tool on real pages. It stays a supplementary metric: matching a tool is not the same as being right, and a miss against that corpus can be correct here.',
    '',
    '## Per engine and layer',
    '',
    '| Layer | Seeded violations in scope | Detected | Recall | Clean fixtures in scope | Flagged | False-positive rate | Violations outside its rules |',
    '|---|---|---|---|---|---|---|---|',
    ...m.engines.map((e) => `| ${LABEL[e.engine]} | ${e.violations} | ${e.detected} | ${pct(e.detected, e.violations)} | ${e.clean} | ${e.falsePositives} | ${pct(e.falsePositives, e.clean)} | ${e.outOfScope} |`),
    '',
    `**Agreement** (deterministic layers only)**:** ${frac(m.agreed, m.shared)} fixtures covered by two or more layers got the same verdict from all of them (${pct(m.agreed, m.shared)}).`,
    '',
    '## Per success criterion',
    '',
    'Engine columns show violations flagged / seeded; `n/a` means the engine has no rule for the criterion. "Any deterministic layer" counts a violation once when axe, accessScan (deterministic) or html-validate flags it. The heuristic layer is shown but left out of it and out of agreement: it guesses (for example it flags the thin `<main>` of every minimal fixture), so counting it would hide misses.',
    '',
    `| SC | Title | Violations | Clean | ${ENGINES.map((e) => LABEL[e]).join(' | ')} | Any deterministic layer | Recall (any) | Clean flagged by any |`,
    `|${'---|'.repeat(7 + ENGINES.length)}`,
    ...m.perSc.map((s) => `| ${s.sc} | ${titles[s.sc] ?? ''} | ${s.violations} | ${s.clean} | ${ENGINES.map((e) => (s.byEngine[e] === null ? 'n/a' : frac(s.byEngine[e], s.violations))).join(' | ')} | ${s.any} | ${pct(s.any, s.violations)} | ${s.falsePositives} |`),
    '',
    '## Seed coverage gaps',
    '',
    `- Criteria the coverage matrix marks full without a hand-written truth-corpus pair: ${fullNoPair.length ? fullNoPair.join(', ') : 'none'}.`,
    `- Criteria seeded only by the older rule-seeds (written for one rule, not against the criterion text): ${onlyOlder.length ? onlyOlder.join(', ') : 'none'}.`,
    '',
    '## Recall below 90%',
    '',
    ...(low.length ? low.map((s) => `- ${s.sc} ${titles[s.sc] ?? ''}: ${s.any} of ${s.violations} seeded violations flagged by any deterministic layer (${pct(s.any, s.violations)}).`) : ['None: every criterion with seeds has at least 90% recall across deterministic layers.']),
    '',
    '## Misses and false positives (deterministic layers)',
    '',
    ...(missed.length ? missed.map((r) => `- Missed by every deterministic layer: \`${r.id}\` (SC ${r.sc})`) : ['No seeded violation is missed by all deterministic layers.']),
    ...(flaggedClean.length ? flaggedClean.map((r) => `- Clean fixture flagged: \`${r.id}\` (SC ${r.sc}) by ${solid.filter((e) => r.found[e].includes(r.sc)).map((e) => LABEL[e]).join(', ')}`) : ['No clean fixture is flagged by a deterministic layer.']),
    '',
  ];
  return lines.join('\n');
}

/** { results, covers } for the whole corpus. */
export async function runTruth() {
  const [cases, byRule] = await Promise.all([loadCases(), criteriaByRule()]);
  return { results: await runEngines(cases, byRule), covers: coversFrom(byRule) };
}
