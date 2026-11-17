#!/usr/bin/env node
// Writes every page of a PDK/Liquid site into `pages` of .scan-config.json, so `ada-scan` scans the whole site.
// Run it from the site root: node <path-to-ada-scan>/templates/list-pages.mjs [pagesRoot]
// shortcut: it reads template files only, so pages that exist only on the platform (job ids, search results) are not listed; add them by hand or use --sitemap.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const configFile = '.scan-config.json';
const config = existsSync(configFile) ? JSON.parse(readFileSync(configFile, 'utf8')) : {};
const root = process.argv[2] ?? config.source?.pagesRoot ?? 'src/pages';
if (!existsSync(root)) {
  console.error(`No folder ${root}. Run this from the site root, or pass the pages folder as the first argument.`);
  process.exit(1);
}

const walk = (dir) => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]));
config.pages = walk(root)
  .filter((f) => f.endsWith('.liquid'))
  .map((f) => relative(root, f).replace(/\.liquid$/, '').replace(/\/index$/, ''))
  .sort()
  .map((p) => (p === 'index' || p === '' ? { path: '/', name: 'homepage' } : { path: `/${p}`, name: p.replace(/\//g, '-') }));

writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`);
console.log(`${config.pages.length} pages written to ${configFile}:`);
for (const p of config.pages) console.log(`  ${p.path}`);
