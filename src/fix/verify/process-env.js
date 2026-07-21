export const ALLOWED_COMMAND_ENV_KEYS = Object.freeze([
  'PATH',
  'HOME',
  'TMPDIR',
  'TEMP',
  'TMP',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'CI',
  'NODE',
  'ADA_SCAN_ROOT',
]);

export function buildCommandEnvironment(extra = {}) {
  const env = {};
  for (const key of ALLOWED_COMMAND_ENV_KEYS) {
    if (process.env[key] != null) env[key] = process.env[key];
  }
  env.CI = '1';
  for (const [key, value] of Object.entries(extra || {})) {
    if (typeof key !== 'string' || key.includes('=')) continue;
    if (ALLOWED_COMMAND_ENV_KEYS.includes(key) || key.startsWith('ADA_FIX_')) {
      env[key] = String(value);
    }
  }
  return env;
}
