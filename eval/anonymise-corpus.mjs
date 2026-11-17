#!/usr/bin/env node
// Rewrite a corpus file so it can be committed: aliases for sites, hashed route/selector where they carry a denied term,
// only the fields compare.mjs and metrics.mjs use. The real-name to alias map stays in eval/site-map.local.json (gitignored).
// usage: node eval/anonymise-corpus.mjs <in.json> [out.json]   (out defaults to in, i.e. in place)
import fs from 'node:fs';
import { aliasFor, anonymiseRow, committedMaxAlias, loadSiteMap, saveSiteMap } from './anonymise.mjs';

const [inFile, outFile = inFile] = process.argv.slice(2);
if (!inFile) { console.error('usage: anonymise-corpus.mjs <in.json> [out.json]'); process.exit(2); }
const map = loadSiteMap();
const hadMap = Object.keys(map.sites || {}).length > 0;
const raw = JSON.parse(fs.readFileSync(inFile, 'utf8'));
// Sorted real names make the first numbering reproducible; aliasFor starts above every alias the committed corpus already uses.
for (const n of [...new Set(raw.map((r) => r.site))].sort()) aliasFor(n, map);
if (!hadMap && committedMaxAlias() > 0) {
  console.error(`warning: no private site map and eval/corpus.json already uses aliases up to s${committedMaxAlias()}; new sites start above that. A site already in the corpus gets a second alias here, merge it by hand.`);
}
const rows = raw.map((r) => anonymiseRow(r, map));
rows.sort((x, y) => (x.site + x.route + x.rule + x.selector).localeCompare(y.site + y.route + y.rule + y.selector));
fs.writeFileSync(outFile, JSON.stringify(rows, null, 1) + '\n');
saveSiteMap(map);
console.log(`${rows.length} rows, ${new Set(rows.map((r) => r.site)).size} sites, ${rows.filter((r) => r.route.startsWith('h:') || r.selector.startsWith('h:')).length} rows with a hashed route or selector`);
