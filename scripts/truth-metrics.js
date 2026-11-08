import { writeFileSync } from 'node:fs';
import { renderTruthMetrics, runTruth } from './lib/truth-corpus.js';

const { results, covers } = await runTruth();
const doc = renderTruthMetrics(results, covers);
writeFileSync(new URL('../docs/truth-metrics.md', import.meta.url), doc);
process.stdout.write(doc);
