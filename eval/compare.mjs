#!/usr/bin/env node
// Compare a ScanReportV2 with the ground-truth corpus.
// usage: node eval/compare.mjs <report.json> [--site <name>] [--corpus eval/corpus.json] [--json]
// Match key: exact route|rule|selector, else route|rule. Only confirmed findings count as "confirmed".
// The committed corpus uses site aliases (s01 ...) and stores a route or selector as "h:<hash>" when it carries a customer term,
// so every lookup tries the literal string and its hash. --site accepts an alias or, with the private eval/site-map.local.json, a real name.
import fs from 'node:fs';
import { resolveSite, variants } from './anonymise.mjs';

export function compare(report, corpus, site) {
  site = resolveSite(site);
  const rows = site ? corpus.filter((r) => r.site === site) : corpus;
  const confirmed = [];
  const routes = new Set();
  for (const p of report.pages || []) {
    for (const v of variants(p.route)) routes.add(v);
    for (const f of p.findings || []) {
      if (f.verdict !== 'confirmed') continue;
      const rules = new Set([f.nativeRuleId, f.canonicalRuleId, ...(f.nativeRuleIds || [])].filter(Boolean));
      confirmed.push({ route: f.route ?? p.route, rules, selector: f.element?.selector ?? '' });
    }
  }
  const exact = new Map(), loose = new Map();
  for (const r of rows) {
    exact.set(`${r.route}|${r.rule}|${r.selector}`, r);
    (loose.get(`${r.route}|${r.rule}`) || loose.set(`${r.route}|${r.rule}`, []).get(`${r.route}|${r.rule}`)).push(r);
  }
  const tally = { TP: 0, FP: 0, UNV: 0 };
  const matched = new Set(), unreviewed = [];
  for (const c of confirmed) {
    let hit = null;
    for (const rule of c.rules) for (const r of variants(c.route)) for (const s of variants(c.selector)) { hit = hit || exact.get(`${r}|${rule}|${s}`); }
    if (!hit) for (const rule of c.rules) for (const r of variants(c.route)) { hit = hit || (loose.get(`${r}|${rule}`) || [])[0]; }
    if (hit) { if (!matched.has(hit)) { matched.add(hit); tally[hit.verdict] = (tally[hit.verdict] || 0) + 1; } }
    else unreviewed.push({ route: c.route, rule: [...c.rules][0], selector: c.selector });
  }
  // a corpus TP is "lost" when its route was scanned but no confirmed finding matched it
  const lost = rows.filter((r) => r.verdict === 'TP' && routes.has(r.route) && !matched.has(r));
  return { corpusRows: rows.length, confirmed: confirmed.length, tally, unreviewed, lost };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const a = process.argv.slice(2);
  const opt = (k) => (a.includes(k) ? a[a.indexOf(k) + 1] : undefined);
  const file = a.find((x, i) => !x.startsWith('--') && (i === 0 || !a[i - 1].startsWith('--')));
  if (!file) { console.error('usage: compare.mjs <report.json> [--site s] [--corpus f] [--json]'); process.exit(2); }
  const corpus = JSON.parse(fs.readFileSync(opt('--corpus') || new URL('./corpus.json', import.meta.url), 'utf8'));
  const res = compare(JSON.parse(fs.readFileSync(file, 'utf8')), corpus, opt('--site'));
  if (a.includes('--json')) console.log(JSON.stringify(res, null, 1));
  else {
    console.log(`corpus rows ${res.corpusRows}; confirmed findings ${res.confirmed}`);
    console.log(`matched: TP ${res.tally.TP}, FP ${res.tally.FP}, UNV ${res.tally.UNV}`);
    console.log(`unreviewed confirmed rows: ${res.unreviewed.length}`);
    for (const u of res.unreviewed) console.log(`  ${u.route} | ${u.rule} | ${u.selector}`);
    console.log(`corpus TPs lost (route scanned, no longer confirmed): ${res.lost.length}`);
    for (const r of res.lost) console.log(`  ${r.site} ${r.route} | ${r.rule} | ${r.selector}`);
  }
}
