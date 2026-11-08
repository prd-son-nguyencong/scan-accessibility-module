import { readFileSync, writeFileSync, existsSync, lstatSync, unlinkSync } from 'fs';
import path from 'path';
import { getDirname, getProjectRoot } from '../utils/paths.js';
import { CliError } from '../utils/cli-args.js';

const PKG_ROOT = path.resolve(getDirname(import.meta.url), '../../');
const FLAGS = ['--force', '--dry-run'];

const SCRIPTS = {
  scan: 'ada-scan',
  'scan:url': 'ada-scan --url',
  'scan:baseline': 'ada-scan --baseline',
  'scan:export': 'ada-scan fix --export',
  'scan:doctor': 'ada-scan doctor',
};

/**
 * Creates `.scan-config.json` at the project root and nothing else: it never edits
 * vite.config, package.json or any other file, and never replaces an existing config
 * without --force. Everything else is printed as instructions.
 */
export async function runInit(argv = []) {
  const bad = argv.find((a) => !FLAGS.includes(a));
  if (bad) throw new CliError(`init: unknown argument ${bad} (supported: ${FLAGS.join(', ')})`);
  const force = argv.includes('--force');
  const dryRun = argv.includes('--dry-run');
  const root = getProjectRoot();
  const dest = path.join(root, '.scan-config.json');
  const text = readFileSync(path.join(PKG_ROOT, 'templates', 'scan-config.default.json'), 'utf8');

  console.log(`ada-scan init\nProject root: ${root}\n`);
  if (dryRun) {
    console.log(`Dry run: nothing is written. ${existsSync(dest) ? (force ? 'With --force this would replace' : 'Existing file kept; --force would replace') : 'This would create'} ${dest}:\n`);
    console.log(text);
    return;
  }
  if (existsSync(dest) && !force) {
    console.log('.scan-config.json already exists; left as is (--force replaces it, --dry-run shows the new content).');
  } else {
    // --force replaces the path itself (a symlink is removed, never written through); 'wx' never follows links.
    if (force && lstatSync(dest, { throwIfNoEntry: false })) unlinkSync(dest);
    writeFileSync(dest, text, { flag: 'wx' });
    console.log(`Wrote ${dest}${force ? ' (replaced)' : ''}.`);
  }
  printNextSteps();
}

function printNextSteps() {
  console.log(`
Nothing else was changed. Do these yourself:
  1. Edit .scan-config.json: baseUrl, devCommand, buildCommand, pages (placeholder "/" only).
     For a preview site scan with a URL instead: ada-scan --url <url> [--sitemap <url>].
  2. Source tracing in a Vite project: register the plugin in vite.config.*
       import { scanInstrumentationPlugin } from 'ada-scan/vite';
       export default defineConfig({ plugins: [scanInstrumentationPlugin(), /* existing plugins */] });
  3. Optional package.json scripts:
${JSON.stringify(SCRIPTS, null, 2).replace(/^/gm, '       ')}
  4. Install the browser once: npx playwright install chromium
  5. Add .ada-scan/ to .gitignore (reports, history and baseline are written there).
  6. Check the setup: npx ada-scan doctor
`);
}
