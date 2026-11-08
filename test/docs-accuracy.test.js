import './helpers/hermetic-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { applyBlock, hasRepoInputs, readInputs, renderAccuracy, START, END } from '../scripts/docs-accuracy.js';

// Before the eval:truth branch is merged the two inputs are not in docs/; read them from that branch. After the merge the repo files are used.
const REF = 'm1-confirmed-truth-eval';
let inputs;
try { inputs = readInputs(hasRepoInputs() ? undefined : REF); } catch { inputs = null; }
const skip = inputs ? false : `docs/accuracy-measured.md is not in this checkout and branch ${REF} is not available`;

const read = (f) => readFileSync(new URL(`../docs/${f}`, import.meta.url), 'utf8');

test('developer guide ACCURACY block and accuracy-commitments.md are current (run npm run docs:accuracy)', { skip }, () => {
  const { doc, block } = renderAccuracy(inputs);
  assert.equal(read('accuracy-commitments.md'), doc);
  assert.equal(read('developer-guide.md'), applyBlock(read('developer-guide.md'), block));
});

test('the guide states recall, the false-positive rate and that real-site recall is unmeasured and lower', () => {
  const guide = read('developer-guide.md');
  const block = guide.slice(guide.indexOf(START), guide.indexOf(END));
  assert.match(block, /Recall of the confirmed tier, measured on seeded fixtures/);
  assert.match(block, /Confirmed false-positive rate/);
  assert.match(block, /Real-site recall is unmeasured/);
  assert.match(block, /real-site recall is lower than the seeded recall/);
  assert.match(block, /\d+ of \d+ seeded violations \(\d/);
  assert.doesNotMatch(guide, /Numbers pending/);
  assert.doesNotMatch(guide + read('accuracy-commitments.md'), /[\u2013\u2014]/);
});

test('renderAccuracy builds the statement from the tables and refuses malformed input', () => {
  const measured = `(2 seeded violations, 3 clean twins)
## Overall

| Scope | Violations | Confirmed | Confirmed recall | 95% interval | Clean twins | Confirmed on clean | Of which the labelled criterion | Confirmed false-positive rate | 95% interval |
|---|---|---|---|---|---|---|---|---|---|
| All fixtures | 2 | 1 | 50% | 9.5% to 90.5% | 3 | 1 | 0 | 33.3% | 6.1% to 79.2% |
| Validated criteria (1) | 2 | 1 | 50% | 9.5% to 90.5% | 3 | 1 | 0 | 33.3% | 6.1% to 79.2% |
| Advisory criteria (0) | 0 | 0 | 0% | 0% | 0 | 0 | 0 | 0% | 0% |

## Per success criterion

| SC | Title | Status | Violations | Confirmed | Confirmed recall | 95% interval | Clean twins | Confirmed on clean | Of which the labelled criterion | Confirmed false-positive rate | 95% interval | Min recall | Max false positive |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1.1.1 | Non-text Content | validated | 2 | 1 | 50% | 9.5% to 90.5% | 3 | 1 | 0 | 33.3% | 6.1% to 79.2% | 50% | 34% |
`;
  const commitments = JSON.stringify({ rules: { '1.1.1': { status: 'validated', minRecall: 0.5, maxFalsePositive: 0.34 } } });
  const { block, doc } = renderAccuracy({ measured, commitments });
  assert.match(block, /1 of 2 seeded violations \(50%, 95% interval 9\.5% to 90\.5%\)/);
  assert.match(block, /1 of 3 clean twins \(33\.3%, 95% interval 6\.1% to 79\.2%\)/);
  assert.match(doc, /\| 1\.1\.1 \| Non-text Content \| validated \| 1 of 2 \|.*\| 50% \| 34% \|/);
  assert.throws(() => renderAccuracy({ measured: 'nothing', commitments }), /fixture counts/);
  assert.throws(() => renderAccuracy({ measured: measured.replace('## Overall', '## Totals'), commitments }), /no "## Overall"/);
  assert.throws(() => applyBlock('no markers', block), /ACCURACY markers/);
});
