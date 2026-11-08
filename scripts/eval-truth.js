import './lib/hermetic.js';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { COMMITMENTS_URL, checkCommitments, computeConfirmed, pct, proposeCommitments, renderAccuracy, runConfirmed } from './lib/confirmed-eval.js';

// node scripts/eval-truth.js [--update-commitments] [--save-raw FILE | --from-raw FILE] [--only REGEX (partial run: do not commit its docs)]
const args = process.argv.slice(2);
const opt = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : null);
const fromRaw = opt('--from-raw');
const started = Date.now();

const results = fromRaw
  ? JSON.parse(readFileSync(fromRaw, 'utf8'))
  : await runConfirmed({ only: opt('--only'), onProgress: (n, total) => process.stderr.write(`\rscanned ${n}/${total}`) });
if (!fromRaw) process.stderr.write('\n');
if (opt('--save-raw')) writeFileSync(opt('--save-raw'), JSON.stringify(results, null, 1));

const metrics = computeConfirmed(results);
if (!opt('--only') && (args.includes('--update-commitments') || !existsSync(COMMITMENTS_URL))) writeFileSync(COMMITMENTS_URL, `${JSON.stringify(proposeCommitments(metrics), null, 2)}\n`);
const commitments = JSON.parse(readFileSync(COMMITMENTS_URL, 'utf8'));
if (!opt('--only')) writeFileSync(new URL('../docs/accuracy-measured.md', import.meta.url), `${renderAccuracy(metrics, commitments)}\n`);

const ci = (c) => (c ? `[${pct(c.lo)}, ${pct(c.hi)}]` : '[-]');
const line = (name, s) => `${name.padEnd(8)} recall ${`${s.confirmed}/${s.violations}`.padEnd(7)} ${pct(s.recall).padStart(6)} ${ci(s.recallCi).padEnd(16)} false-positive ${`${s.falsePositives}/${s.clean}`.padEnd(6)} ${pct(s.fpRate).padStart(6)} ${ci(s.fpCi)}  ${commitments.rules?.[s.sc ?? '']?.status ?? ''}`;
console.log('Confirmed tier, Wilson 95% intervals');
for (const s of metrics.perSc) console.log(line(s.sc, s));
console.log(line('OVERALL', metrics.overall));
const problems = checkCommitments(metrics, commitments);
console.log(`validated: ${Object.entries(commitments.rules).filter(([, c]) => c.status === 'validated').map(([sc]) => sc).join(', ')}`);
console.log(`advisory: ${Object.entries(commitments.rules).filter(([, c]) => c.status !== 'validated').map(([sc]) => sc).join(', ')}`);
if (!fromRaw) console.log(`finished in ${Math.round((Date.now() - started) / 1000)}s`);
for (const p of problems) console.error(`FAIL ${p}`);
process.exitCode = problems.length ? 1 : 0;
