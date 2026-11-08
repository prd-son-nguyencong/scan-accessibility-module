#!/usr/bin/env node
// Writes docs/accuracy-commitments.md and the ACCURACY block of docs/developer-guide.md from the measured numbers.
// Inputs (repo files written by `npm run eval:truth`): docs/accuracy-measured.md and docs/accuracy-commitments.json.
// usage: node scripts/docs-accuracy.js [--from-ref <git ref>]   (--from-ref reads the two inputs with `git show`, for a branch that does not hold them yet)
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const DOC = new URL('docs/accuracy-commitments.md', root);
const GUIDE = new URL('docs/developer-guide.md', root);
export const START = '<!-- ACCURACY:START -->';
export const END = '<!-- ACCURACY:END -->';

export function readInputs(ref) {
  const get = (f) => (ref ? execFileSync('git', ['show', `${ref}:docs/${f}`], { cwd: fileURLToPath(root), encoding: 'utf8' }) : readFileSync(new URL(`docs/${f}`, root), 'utf8'));
  return { measured: get('accuracy-measured.md'), commitments: get('accuracy-commitments.json') };
}
export const hasRepoInputs = () => ['accuracy-measured.md', 'accuracy-commitments.json'].every((f) => existsSync(new URL(`docs/${f}`, root)));

// A markdown table as {head, rows}; the measured tables repeat "95% interval", so cells are read by name and occurrence.
function table(md, heading) {
  const lines = md.split('\n');
  const at = lines.findIndex((l) => l.trim() === `## ${heading}`);
  if (at < 0) throw new Error(`accuracy-measured.md has no "## ${heading}" section`);
  const rows = [];
  for (const l of lines.slice(at + 1)) {
    if (l.startsWith('## ')) break;
    if (l.startsWith('|')) rows.push(l.split('|').slice(1, -1).map((c) => c.trim().replace(/`/g, '')));
  }
  const [head, , ...body] = rows;
  if (!head || !body.length) throw new Error(`"## ${heading}" has no table`);
  const col = (row, name, nth = 0) => {
    const i = head.reduce((a, h, k) => (h === name ? [...a, k] : a), [])[nth];
    if (i === undefined || row[i] === undefined) throw new Error(`"## ${heading}" has no column "${name}"`);
    return row[i];
  };
  return { rows: body, col };
}

const pct = (x) => +(x * 100).toFixed(1);

export function renderAccuracy({ measured, commitments }) {
  const counts = /\((\d+) seeded violations, (\d+) clean twins/.exec(measured);
  if (!counts) throw new Error('accuracy-measured.md does not state the fixture counts');
  const ov = table(measured, 'Overall');
  const row = (prefix) => {
    const r = ov.rows.find((x) => x[0].startsWith(prefix));
    if (!r) throw new Error(`"## Overall" has no row "${prefix}"`);
    return r;
  };
  const all = row('All fixtures');
  const val = row('Validated criteria');
  const adv = row('Advisory criteria');
  const recall = (r) => `${ov.col(r, 'Confirmed')} of ${ov.col(r, 'Violations')} seeded violations (${ov.col(r, 'Confirmed recall')}, 95% interval ${ov.col(r, '95% interval')})`;
  const falsePos = (r) => `${ov.col(r, 'Confirmed on clean')} of ${ov.col(r, 'Clean twins')} clean twins (${ov.col(r, 'Confirmed false-positive rate')}, 95% interval ${ov.col(r, '95% interval', 1)})`;
  const rules = JSON.parse(commitments).rules;
  const sc = table(measured, 'Per success criterion');

  const block = [
    `- **Recall of the confirmed tier, measured on seeded fixtures:** ${recall(all)}. Counting only the validated criteria it is ${recall(val)}.`,
    `- **Confirmed false-positive rate:** ${falsePos(all)} had a confirmed finding. Of those, ${ov.col(all, 'Of which the labelled criterion')} were confirmed for the twin's own criterion.`,
    '- **Real-site recall is unmeasured.** The seeded fixtures are small and clear-cut, so real-site recall is lower than the seeded recall above, by an amount nobody has measured. The false-positive rate is also measured on minimal pages and understates what real pages produce. These numbers come from URL scans of the fixtures; a scan of local source also demotes findings it cannot trace to a file, so confirmed recall there is lower and not measured. A validated criterion may still have confirmed findings on a clean twin written for another criterion (counted in the measured page, column "Confirmed by this criterion on any twin"); read that page, not only the totals.',
    '- A finding at `confirmed` is the only tier the numbers speak for. `likely` and `needs-review` are not counted as hits and carry no accuracy claim.',
  ].join('\n');

  const perRows = sc.rows.map((r) => {
    const id = sc.col(r, 'SC');
    const c = rules[id] || {};
    return `| ${id} | ${sc.col(r, 'Title')} | ${sc.col(r, 'Status')} | ${sc.col(r, 'Confirmed')} of ${sc.col(r, 'Violations')} | ${sc.col(r, 'Confirmed recall')} (${sc.col(r, '95% interval')}) | ${sc.col(r, 'Confirmed on clean')} of ${sc.col(r, 'Clean twins')} | ${sc.col(r, 'Confirmed false-positive rate')} (${sc.col(r, '95% interval', 1)}) | ${c.minRecall === undefined ? 'n/a' : `${pct(c.minRecall)}%`} | ${c.maxFalsePositive === undefined ? 'n/a' : `${pct(c.maxFalsePositive)}%`} |`;
  });

  const doc = `# Accuracy commitments

<!-- GENERATED by \`npm run docs:accuracy\` from docs/accuracy-measured.md and docs/accuracy-commitments.json. Do not edit by hand. -->

This page states what the confirmed findings of ada-scan are measured to get right and wrong, and what is not measured.
The numbers come from \`npm run eval:truth\`, which scans every labelled fixture (${counts[1]} seeded violations, ${counts[2]} clean twins) through the real scan and report pipeline and writes \`docs/accuracy-measured.md\`.
No LLM takes part in that measurement.

## What is stated

${block}

Two more limits apply to every number here:

- A small sample gives a wide interval. Quote the interval, not only the percentage.
- Automation can fully check only part of WCAG. A clean scan is not a compliance statement.

## Overall

| Scope | Confirmed recall (seeded) | 95% interval | Confirmed false-positive rate (clean twins) | 95% interval |
|---|---|---|---|---|
${[all, val, adv].map((r) => `| ${r[0]} | ${ov.col(r, 'Confirmed')} of ${ov.col(r, 'Violations')} (${ov.col(r, 'Confirmed recall')}) | ${ov.col(r, '95% interval')} | ${ov.col(r, 'Confirmed on clean')} of ${ov.col(r, 'Clean twins')} (${ov.col(r, 'Confirmed false-positive rate')}) | ${ov.col(r, '95% interval', 1)} |`).join('\n')}

## By success criterion

A \`validated\` criterion fails \`npm run eval:truth\` when its confirmed recall drops below the minimum or its confirmed false-positive rate rises above the maximum. An \`advisory\` criterion had fewer than 3 fixtures on a side or a confirmed recall under 60% when the thresholds were set: it is reported and makes no commitment.

| SC | Title | Status | Confirmed / seeded | Confirmed recall (95% interval) | Confirmed on clean twins | False-positive rate (95% interval) | Committed min recall | Committed max false positive |
|---|---|---|---|---|---|---|---|---|
${perRows.join('\n')}

## Regenerate

\`npm run eval:truth\` rewrites \`docs/accuracy-measured.md\`. \`npm run docs:accuracy\` then rewrites this page and the ACCURACY block of the developer guide. \`test/docs-accuracy.test.js\` fails when either is out of date.
`;
  return { doc, block };
}

export function applyBlock(guide, block) {
  const a = guide.indexOf(START);
  const b = guide.indexOf(END);
  if (a < 0 || b < a) throw new Error('developer-guide.md has no ACCURACY markers');
  return `${guide.slice(0, a + START.length)}\n${block}\n${guide.slice(b)}`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--from-ref');
  const { doc, block } = renderAccuracy(readInputs(i > 0 ? process.argv[i + 1] : undefined));
  writeFileSync(DOC, doc);
  writeFileSync(GUIDE, applyBlock(readFileSync(GUIDE, 'utf8'), block));
}
