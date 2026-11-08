#!/usr/bin/env node
// Source-attribution accuracy: traces hand-labelled findings in their site and compares with the location a reviewer named.
//   node scripts/trace-eval.js [--rows <rows.json>] [--site name=dir ...] [--min 0.85] [--json]
// Default rows: test/fixtures/trace-eval/rows.json against the neutral mini site in test/fixtures/trace-eval/site-A.
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { evalRows, loadRows, siteRoots } from './lib/trace-eval.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const rowsFile = flag('--rows') || path.join(REPO, 'test/fixtures/trace-eval/rows.json');
const min = Number(flag('--min') ?? 0.85);
const sites = { 'site-A': path.join(REPO, 'test/fixtures/trace-eval/site-A') };
args.forEach((a, i) => { if (a === '--site') { const [k, v] = args[i + 1].split('='); sites[k] = v; } });

const report = await evalRows(loadRows(rowsFile), siteRoots(sites, process.cwd()));
if (args.includes('--json')) console.log(JSON.stringify(report, null, 2));
else {
  for (const r of report.rows) console.log(`${r.strict ? 'ok  ' : r.lenient ? 'cand' : 'FAIL'} ${r.id} ${r.rule} ${r.route} -> ${r.got} (${r.method}/${r.confidence}) expected ${r.expected.join(' | ')}`);
  console.log(`strict ${report.strict}/${report.total} (${(100 * report.strict / report.total).toFixed(0)}%), with candidate lists ${report.lenient}/${report.total} (${(100 * report.lenient / report.total).toFixed(0)}%)`);
}
process.exit(report.strict / report.total >= min ? 0 : 1);
