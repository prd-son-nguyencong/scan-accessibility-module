import { writeFileSync } from 'node:fs';
import { renderRuleCoverageDoc } from './lib/rule-doc.js';

writeFileSync(new URL('../docs/accessscan-rule-coverage.md', import.meta.url), await renderRuleCoverageDoc());
