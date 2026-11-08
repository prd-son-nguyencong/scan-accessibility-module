// Runs the instrumented build against the probe so a test can signal this process.
import { fileURLToPath } from 'node:url';
import { buildInstrumented } from '../../src/tracer/build-instrumented.js';
const probe = fileURLToPath(new URL('./group-probe.mjs', import.meta.url));
console.log('READY');
buildInstrumented(true, { buildCommand: `${process.execPath} ${probe}`, buildTimeoutMs: 60000 }).catch(() => process.exit(9));
