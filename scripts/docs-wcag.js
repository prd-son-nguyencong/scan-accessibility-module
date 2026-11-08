import { writeFileSync } from 'node:fs';
import { renderWcagCoverageDoc } from './lib/wcag-coverage-doc.js';

writeFileSync(new URL('../docs/wcag-coverage.md', import.meta.url), await renderWcagCoverageDoc());
