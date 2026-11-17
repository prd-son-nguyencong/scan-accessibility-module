import { writeFileSync } from 'node:fs';
import { renderVerdictDoc } from './lib/verdict-doc.js';

writeFileSync(new URL('../docs/verdict-matrix.md', import.meta.url), await renderVerdictDoc());
