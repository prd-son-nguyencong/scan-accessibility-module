import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { createInterface } from 'readline';
import { getDirname, getProjectRoot } from '../utils/paths.js';

const PKG_ROOT = path.resolve(getDirname(import.meta.url), '../../');
const IS_WINDOWS = process.platform === 'win32';

const HOST_SCRIPTS = {
  scan: 'ada-scan',
  'scan:fix': 'ada-scan --fix',
  'scan:fix:cursor': 'ada-scan --fix --fix-mode cursor',
  'scan:fix:vscode': 'ada-scan --fix --fix-mode vscode',
  'scan:fix:windsurf': 'ada-scan --fix --fix-mode windsurf',
  'scan:fix:codex': 'ada-scan --fix --fix-mode codex',
  'scan:fix:claude': 'ada-scan --fix --fix-mode claude',
  'scan:fix:cis': 'ada-scan --fix --fix-mode cis',
  'scan:url': 'ada-scan --url',
  'scan:baseline': 'ada-scan --baseline',
  'scan:report': 'ada-scan --report-only',
};

const IMPORT_LINE = "import { scanInstrumentationPlugin } from 'ada-scan/vite';";

export async function runInit(argv = []) {
  const flags = new Set(argv);
  const force = flags.has('--force');
  const yes = flags.has('--yes') || flags.has('-y');
  const skipBrowsers = flags.has('--no-browsers');
  const root = getProjectRoot();

  console.log('\nada-scan init');
  console.log('=============');
  console.log(`Host root: ${root}\n`);

  scaffoldConfig(root, force);
  injectVitePlugin(root);
  addHostScripts(root);
  if (!skipBrowsers) await installBrowsers(yes);
  printNextSteps();
}

function scaffoldConfig(root, force) {
  const dest = path.join(root, '.scan-config.json');
  const template = path.join(PKG_ROOT, 'templates', 'scan-config.default.json');
  if (existsSync(dest) && !force) {
    console.log('• .scan-config.json already exists — leaving as-is (use --force to overwrite).');
    return;
  }
  copyFileSync(template, dest);
  console.log(`• Wrote .scan-config.json${force ? ' (overwritten)' : ''}.`);
}

function findViteConfig(root) {
  for (const name of ['vite.config.ts', 'vite.config.js', 'vite.config.mjs']) {
    const p = path.join(root, name);
    if (existsSync(p)) return p;
  }
  return null;
}

function injectVitePlugin(root) {
  const configPath = findViteConfig(root);
  if (!configPath) {
    console.log('• No vite.config found. Add the plugin manually:');
    printViteSnippet();
    return;
  }

  let content = readFileSync(configPath, 'utf8');
  if (content.includes('ada-scan/vite')) {
    console.log(`• ${path.basename(configPath)} already registers scanInstrumentationPlugin — skipped.`);
    return;
  }

  const pluginsMatch = content.match(/plugins\s*:\s*\[/);
  if (!pluginsMatch) {
    console.log(`• Could not find a "plugins: [" array in ${path.basename(configPath)}. Add manually:`);
    printViteSnippet();
    return;
  }

  // Insert the import after the final top-level import statement.
  const importMatches = [...content.matchAll(/^import .*$/gm)];
  if (importMatches.length > 0) {
    const last = importMatches[importMatches.length - 1];
    const at = last.index + last[0].length;
    content = content.slice(0, at) + '\n' + IMPORT_LINE + content.slice(at);
  } else {
    content = IMPORT_LINE + '\n' + content;
  }

  // Insert the plugin at the start of the plugins array (re-find after import insert).
  const idx = content.search(/plugins\s*:\s*\[/);
  const insertAt = content.indexOf('[', idx) + 1;
  content = content.slice(0, insertAt) + 'scanInstrumentationPlugin(), ' + content.slice(insertAt);

  writeFileSync(configPath, content, 'utf8');
  console.log(`• Registered scanInstrumentationPlugin() in ${path.basename(configPath)}.`);
}

function printViteSnippet() {
  console.log('\n    ' + IMPORT_LINE);
  console.log('    export default defineConfig({');
  console.log('      plugins: [scanInstrumentationPlugin(), /* …existing plugins */],');
  console.log('    });\n');
}

function addHostScripts(root) {
  const pkgPath = path.join(root, 'package.json');
  if (!existsSync(pkgPath)) {
    console.log('• No package.json at host root — skipped script wiring.');
    return;
  }
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  pkg.scripts = pkg.scripts || {};
  let added = 0;
  for (const [name, cmd] of Object.entries(HOST_SCRIPTS)) {
    if (!pkg.scripts[name]) {
      pkg.scripts[name] = cmd;
      added += 1;
    }
  }
  if (added > 0) {
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
    console.log(`• Added ${added} scan script(s) to package.json.`);
  } else {
    console.log('• Scan scripts already present in package.json — skipped.');
  }
}

async function installBrowsers(yes) {
  const proceed = yes || (await confirm('Install Playwright Chromium browser now? [Y/n] '));
  if (!proceed) {
    console.log('• Skipped browser install. Run later: npx playwright install chromium');
    return;
  }
  console.log('• Installing Playwright Chromium...');
  const result = spawnSync('npx', ['playwright', 'install', 'chromium'], {
    stdio: 'inherit',
    shell: IS_WINDOWS,
  });
  if (result.status !== 0) {
    console.log('  Browser install did not complete. Run manually: npx playwright install chromium');
  }
}

function confirm(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      const a = answer.trim().toLowerCase();
      resolve(a === '' || a === 'y' || a === 'yes');
    });
  });
}

function printNextSteps() {
  console.log('\nNext steps:');
  console.log('  1. Review .scan-config.json (baseUrl, buildCommand, devCommand, thirdParty).');
  console.log('  2. For AI fix modes, add keys to .env:');
  console.log('       ANTHROPIC_API_KEY=…   (claude)   pnpm add @anthropic-ai/sdk');
  console.log('       OPENAI_API_KEY=…      (codex)    pnpm add openai');
  console.log('       CIS_PROXY_URL / CIS_AUTH_TOKEN / CIS_MODEL   (cis)');
  console.log('       GOOGLE_API_KEY=…      (PageSpeed Insights, higher rate limits)');
  console.log('  3. Run your first scan:  pnpm scan   (or: npx ada-scan --url https://example.com)\n');
}
