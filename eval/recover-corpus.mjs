#!/usr/bin/env node
// Rebuilds eval/corpus.json from workflow agent transcripts (*.jsonl + *.meta.json).
// usage: node eval/recover-corpus.mjs <workflows-dir> [out.json]
// A row is kept only when route, rule, selector AND a resolved verdict are all present in a transcript.
// Output is anonymised (site aliases, hashed route/selector when they carry a customer term; see eval/anonymise.mjs).
// Resolution: latest adjudicate verdict; else A and B reviewers agree (latest of each); else dropped (unresolved).
import fs from 'node:fs';
import path from 'node:path';
import { aliasFor, anonymiseRow, loadSiteMap, saveSiteMap } from './anonymise.mjs';

const [dir, out = new URL('./corpus.json', import.meta.url).pathname] = process.argv.slice(2);
if (!dir) { console.error('usage: recover-corpus.mjs <workflows-dir> [out.json]'); process.exit(2); }

const ID = String.raw`"id"\s*:\s*"((?:sha256:)?[0-9a-f]{5,64})"\s*,\s*"route"\s*:\s*"((?:[^"\\]|\\.)*)"\s*,\s*"rule"\s*:\s*"((?:[^"\\]|\\.)*)"`;
const SEL = /"selector"\s*:\s*"((?:[^"\\]|\\.)*)"/;
const un = (s) => { try { return JSON.parse(`"${s}"`); } catch { return null; } };

const rows = new Map(); // site|id -> {route,rule,selector}
const verdicts = []; // {key, role, verdict, sourceOk, ownerOk, ts, agent}
const textOf = (b) => (typeof b.content === 'string' ? b.content : (b.content || []).map((x) => x.text || '').join('\n'));
const scan = (s, site, agent) => {
  for (const m of s.matchAll(new RegExp(ID, 'g'))) {
    const sm = s.slice(m.index, m.index + 900).match(SEL);
    const route = un(m[2]), selector = sm && un(sm[1]);
    if (route == null || selector == null) continue;
    const key = `${site}|${m[1]}`;
    if (!rows.has(key)) rows.set(key, { id: m[1], route, rule: m[3], selector, agent });
  }
};

for (const wf of fs.readdirSync(dir)) {
  const d = path.join(dir, wf);
  if (!fs.statSync(d).isDirectory()) continue;
  for (const f of fs.readdirSync(d).filter((x) => /^agent-.*\.jsonl$/.test(x))) {
    const meta = JSON.parse(fs.readFileSync(path.join(d, f.replace('.jsonl', '.meta.json')), 'utf8'));
    const [kind, site, , lens] = meta.description.split(':');
    if (!site || (kind !== 'review' && kind !== 'adjudicate')) continue;
    const agent = `${wf}/${f}`;
    for (const l of fs.readFileSync(path.join(d, f), 'utf8').split('\n')) {
      if (!l) continue;
      let o; try { o = JSON.parse(l); } catch { continue; }
      if (o.type === 'user') {
        const c = o.message.content;
        if (typeof c === 'string') scan(c, site, agent);
        else for (const b of c) if (b.type === 'tool_result') scan(textOf(b), site, agent);
      } else if (o.type === 'assistant') {
        for (const c of o.message.content || []) {
          if (c.type === 'tool_use' && c.name === 'StructuredOutput' && Array.isArray(c.input?.verdicts)) {
            for (const v of c.input.verdicts) verdicts.push({ key: `${site}|${v.id}`, role: kind === 'adjudicate' ? 'adj' : lens, verdict: v.verdict, sourceOk: v.sourceOk, ownerOk: v.ownerOk, ts: o.timestamp, agent });
          }
        }
      }
    }
  }
}

const latest = (list) => list.reduce((a, b) => (!a || b.ts > a.ts ? b : a), null);
const byKey = new Map();
for (const v of verdicts) (byKey.get(v.key) || byKey.set(v.key, []).get(v.key)).push(v);
const map = loadSiteMap();
const corpus = [], stats = {};
const bump = (site, k) => { (stats[site] ||= { rows: 0, dropped: 0, seenNoRow: 0 })[k]++; };
for (const [key, list] of byKey) {
  const site = key.split('|')[0];
  const row = rows.get(key);
  if (!row) { bump(site, 'seenNoRow'); continue; }
  const adj = latest(list.filter((v) => v.role === 'adj'));
  const a = latest(list.filter((v) => v.role === 'A')), b = latest(list.filter((v) => v.role === 'B'));
  let fin, from;
  if (adj) { fin = adj; from = [adj]; }
  else if (a && b && a.verdict === b.verdict) {
    fin = { ...a, sourceOk: a.sourceOk === b.sourceOk ? a.sourceOk : a.verdict === 'TP' ? 'no' : a.sourceOk, ownerOk: a.ownerOk === b.ownerOk ? a.ownerOk : 'no' };
    from = [a, b];
  } else { bump(site, 'dropped'); continue; }
  corpus.push({ site, route: row.route, rule: row.rule, selector: row.selector, verdict: fin.verdict, sourceOk: fin.sourceOk ?? 'n/a', ownerOk: fin.ownerOk ?? 'n/a', reviewedAt: fin.ts, via: adj ? 'adjudicated' : 'reviewers-agree', provenance: [row.agent, ...from.map((v) => v.agent)].filter((x, i, arr) => arr.indexOf(x) === i) });
  bump(site, 'rows');
}
const safe = corpus.map((r) => anonymiseRow(r, map));
const aliased = {};
for (const [k, v] of Object.entries(stats)) aliased[aliasFor(k, map)] = v;
saveSiteMap(map);
safe.sort((x, y) => (x.site + x.route + x.rule + x.selector).localeCompare(y.site + y.route + y.rule + y.selector));
fs.writeFileSync(out, JSON.stringify(safe, null, 1) + '\n');
console.log(JSON.stringify(aliased, null, 1));
console.log('total', safe.length);
