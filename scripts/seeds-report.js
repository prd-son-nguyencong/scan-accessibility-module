import { writeFileSync } from 'node:fs';
import { deterministicRules, renderSeedsCoverage, runSeeds } from './lib/seeds.js';

const doc = renderSeedsCoverage(await runSeeds(), await deterministicRules());
writeFileSync(new URL('../docs/seeds-coverage.md', import.meta.url), doc);
process.stdout.write(doc);
