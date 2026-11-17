import { readFileSync } from 'node:fs';
import path from 'node:path';
import fg from 'fast-glob';

const MAX_FILES = 600;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Every `file:line` under src/ that authors `id="<id>"` (templates, partials and SVG sprite files). */
export function idDefinitions(root, id) {
  const rx = new RegExp(`\\sid\\s*=\\s*["']${esc(id)}["']`);
  const out = [];
  for (const file of fg.sync(['src/**/*.{liquid,svg,html}'], { cwd: root, ignore: ['**/node_modules/**'] }).sort().slice(0, MAX_FILES)) {
    let text;
    try { text = readFileSync(path.join(root, file), 'utf8'); } catch { continue; }
    text.split('\n').forEach((line, i) => { if (rx.test(line)) out.push({ file, line: i + 1 }); });
  }
  return out;
}

/**
 * An SVG sprite whose `<symbol id>` is repeated: every `<use href="#id">` draws the first symbol. The finding names where the id is authored
 * (all lines are candidates, the proof lists them) so the author sees which copy wins and which are dead.
 */
export function attachDuplicateIdSources(violations, root) {
  for (const v of violations) {
    if ((v.ruleId || v.rule) !== 'duplicate-id-referenced' || !v.evidence?.sprite || !v.evidence.id) continue;
    const defs = idDefinitions(root, v.evidence.id);
    if (defs.length < 2) continue;
    const lines = defs.map((d) => `${d.file}:${d.line}`);
    v.evidence = { ...v.evidence, definitions: defs, proof: { type: 'measured-fact', fact: `id "${v.evidence.id}" exists ${v.evidence.occurrences} times in the live DOM and <use href="#${v.evidence.id}"> resolves to the first; authored at ${lines.join(' and ')}` } };
    v.sourceCandidates = [...(v.sourceCandidates || []), ...defs.map((d) => ({ file: d.file, line: d.line, confidence: 'low', method: 'duplicate-id-definition' }))];
  }
}
