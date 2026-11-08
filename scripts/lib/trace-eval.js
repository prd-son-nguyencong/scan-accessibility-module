import { readFileSync } from 'node:fs';
import path from 'node:path';
import { traceToPartials } from '../../src/index.js';

/**
 * Source-attribution accuracy against hand-labelled rows. A row is a finding (rule, selector, html, route) plus the
 * location a reviewer says a developer must edit (`expected`: `file:line` or `file:from-to`, any of several listed).
 * Strict = the traced primary source is one of them. Lenient = strict, or the finding is not claimed (confidence low) and an
 * expected location is among its candidates (the report then says "locate among candidates").
 */

const PAGE_FOR = (route) => `src/pages/${route === '/' ? 'index' : route.replace(/^\//, '')}.liquid`;

function matches(expected, file, line) {
  return expected.some((spec) => {
    const m = /^(.+?):(\d+)(?:-(\d+))?$/.exec(spec);
    return m && m[1] === file && line >= Number(m[2]) && line <= Number(m[3] || m[2]);
  });
}

/** Traces one labelled row inside its site root and returns the finding's source fields. */
export async function traceRow(row, root) {
  const v = {
    ruleId: row.rule,
    rule: row.rule,
    layer: row.layer || 'axe',
    ...(row.layer === 'links' ? { linkTarget: {} } : {}),
    element: { outerHTML: row.html || '', selector: row.selector || '' },
    evidence: { fact: row.fact || '' },
    source: { mode: 'url', file: 'unknown', line: null, confidence: 'none', method: 'unresolved' },
  };
  const page = PAGE_FOR(row.route);
  v.source.page = page;
  await traceToPartials([v], `http://127.0.0.1:1${row.route}`, root);
  return v;
}

/** @returns {{ rows: object[], strict: number, lenient: number, total: number }} */
export async function evalRows(rows, roots) {
  const out = [];
  for (const row of rows) {
    const v = await traceRow(row, roots[row.site]);
    const { file, line, confidence } = v.source;
    const strict = Boolean(file && line && matches(row.expected, file, line));
    const cands = (v.sourceCandidates || []).concat(v.source.templateSource ? [v.source.templateSource] : []);
    const lenient = strict || (confidence === 'low' && cands.some((c) => matches(row.expected, c.file, c.line)));
    const alsoOk = (row.alsoAt || []).every((spec) => cands.some((c) => matches([spec], c.file, c.line)));
    out.push({ id: row.id, rule: row.rule, route: row.route, got: `${file}:${line}`, method: v.source.method, confidence, strict, lenient, alsoOk, expected: row.expected });
  }
  const count = (key) => out.filter((r) => r[key]).length;
  return { rows: out, strict: count('strict'), lenient: count('lenient'), total: out.length };
}

export const loadRows = (file) => JSON.parse(readFileSync(file, 'utf8'));
export const siteRoots = (map, base) => Object.fromEntries(Object.entries(map).map(([k, v]) => [k, path.resolve(base, v)]));
