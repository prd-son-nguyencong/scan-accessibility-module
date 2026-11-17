// Keeps ambient shell/.env settings out of tests. Load first: `node --import`
// (npm test) or as the first import of a test file run directly.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

for (const key of Object.keys(process.env)) {
  // ADA_SCAN_TEST_* are opt-in test flags (e.g. ADA_SCAN_TEST_LIGHTHOUSE), not ambient config.
  if ((/^(ADA_SCAN_|CIS_)/.test(key) && !key.startsWith('ADA_SCAN_TEST_')) || key === 'SCAN_MODE') delete process.env[key];
}
process.env.ADA_SCAN_NO_DOTENV = '1';
process.env.ADA_SCAN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
