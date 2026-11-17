// Keeps ambient ADA_SCAN_* and CIS_* settings out of the measurement, like test/helpers/hermetic-env.mjs, so the numbers do not depend on the shell.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

for (const key of Object.keys(process.env)) if (/^(ADA_SCAN_|CIS_)/.test(key) || key === 'SCAN_MODE') delete process.env[key];
process.env.ADA_SCAN_NO_DOTENV = '1';
process.env.ADA_SCAN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
