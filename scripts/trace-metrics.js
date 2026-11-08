import { writeFileSync } from 'node:fs';
import { renderTraceMetrics } from './lib/trace-metrics.js';

writeFileSync(new URL('../docs/trace-metrics.md', import.meta.url), renderTraceMetrics());
