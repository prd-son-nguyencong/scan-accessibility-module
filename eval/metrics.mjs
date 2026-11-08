#!/usr/bin/env node
// Precision and file:line accuracy with Wilson 95% intervals, overall and blind-only.
// usage: node eval/metrics.mjs <rows.json> [--by-site]   rows: [{site, blind, verdict: TP|FP|UNV, sourceOk: yes|no|n/a}]
// Output only ever shows site aliases (s01 ...). A real name is translated through the private eval/site-map.local.json;
// a name that is not in the map prints as "unmapped" so a customer name can never reach a shared report.
import fs from 'node:fs';
import { loadSiteMap } from './anonymise.mjs';

export function wilson(k, n, z = 1.96) {
  if (!n) return { p: null, lo: null, hi: null };
  const p = k / n, d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n), m = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return { p, lo: (c - m) / d, hi: (c + m) / d };
}

export function metrics(rows) {
  const tp = rows.filter((r) => r.verdict === 'TP').length;
  const fp = rows.filter((r) => r.verdict === 'FP').length;
  const unv = rows.filter((r) => r.verdict === 'UNV').length;
  const src = rows.filter((r) => r.verdict === 'TP' && r.sourceOk === 'yes').length;
  return { rows: rows.length, tp, fp, unv, precision: { k: tp, n: tp + fp, ...wilson(tp, tp + fp) }, fileLine: { k: src, n: tp, ...wilson(src, tp) } };
}

const pct = (x) => (x == null ? 'n/a' : `${(x * 100).toFixed(1)}%`);
const line = (name, m) => `${name}: rows ${m.rows} (TP ${m.tp}, FP ${m.fp}, UNV ${m.unv})\n` +
  `  precision ${m.precision.k}/${m.precision.n} = ${pct(m.precision.p)} (Wilson 95% ${pct(m.precision.lo)} to ${pct(m.precision.hi)})\n` +
  `  file:line ${m.fileLine.k}/${m.fileLine.n} = ${pct(m.fileLine.p)} (Wilson 95% ${pct(m.fileLine.lo)} to ${pct(m.fileLine.hi)})`;

export const aliasOf = (site, map = loadSiteMap()) => (/^s\d{2,}$/.test(site) ? site : map.sites?.[site] || 'unmapped');

if (import.meta.url === `file://${process.argv[1]}`) {
  const f = process.argv[2];
  if (!f) { console.error('usage: metrics.mjs <rows.json>'); process.exit(2); }
  const rows = JSON.parse(fs.readFileSync(f, 'utf8'));
  console.log(line('overall', metrics(rows)));
  console.log(line('blind only', metrics(rows.filter((r) => r.blind === true))));
  if (process.argv.includes('--by-site')) {
    const map = loadSiteMap(), by = {};
    for (const r of rows) (by[aliasOf(r.site, map)] ||= []).push(r);
    for (const k of Object.keys(by).sort()) console.log(line(k, metrics(by[k])));
  }
}
