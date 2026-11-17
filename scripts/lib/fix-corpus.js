// Seeded-fault corpus (test/fixtures/fix-corpus): manifest loading, task/context building and a static renderer. Rendering follows harness-site.mjs, plus what the corpus needs:
// `{% render "name" %}`, `{% for x in list %}` over the sidecar JSON of the page or partial, `{{ x.field }}`, `{{ forloop.index }}`.
// Backend tags (`{{data:..}}`, `{{component:..}}`, `{{snippet:..}}`, `{{attribute:..}}`) stay literal, exactly as in harness-site.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

export const CORPUS_DIR = new URL('../../test/fixtures/fix-corpus', import.meta.url).pathname;
export const loadManifest = () => JSON.parse(readFileSync(join(CORPUS_DIR, 'manifest.json'), 'utf8'));

const sidecar = (file) => (existsSync(`${file}.json`) ? JSON.parse(readFileSync(`${file}.json`, 'utf8')) : {});
const get = (scope, expr) => expr.split('.').reduce((v, k) => (v == null ? v : v[k]), scope);

function expand(text, scope, srcDir) {
  let out = text.replace(/\{%-?\s*render\s+"([\w/-]+)"\s*-?%\}/g, (_, n) => {
    const f = join(srcDir, 'partials', `${n}.liquid`);
    return expand(readFileSync(f, 'utf8').trimEnd(), { ...scope, ...sidecar(f) }, srcDir);
  });
  out = out.replace(/\{%-?\s*for\s+(\w+)\s+in\s+([\w.]+)\s*-?%\}([\s\S]*?)\{%-?\s*endfor\s*-?%\}/g, (_, v, list, body) =>
    (get(scope, list) || []).map((item, i) => expand(body, { ...scope, [v]: item, forloop: { index: i + 1, index0: i } }, srcDir)).join(''));
  return out.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (m, expr) => { const v = get(scope, expr); return v == null ? m : String(v); });
}

/** Renders src/pages/*.liquid to outDir/*.html and copies styles, scripts and assets flat into outDir. */
export function renderCorpusSite(srcDir, outDir) {
  mkdirSync(outDir, { recursive: true });
  for (const f of readdirSync(join(srcDir, 'pages')).filter((n) => n.endsWith('.liquid'))) {
    const file = join(srcDir, 'pages', f);
    writeFileSync(join(outDir, f.replace('.liquid', '.html')), expand(readFileSync(file, 'utf8'), sidecar(file), srcDir));
  }
  for (const d of ['styles', 'scripts', 'assets']) for (const f of readdirSync(join(srcDir, d))) cpSync(join(srcDir, d, f), join(outDir, f));
}

/** Applies manifest edits ({ path, find, replace }, each `find` must occur exactly once) under a site root. Returns { path: after }. */
export function applyManifestEdits(root, edits) {
  const files = {};
  for (const e of edits) {
    const p = join(root, e.path);
    const text = files[e.path] ?? readFileSync(p, 'utf8');
    const n = text.split(e.find).length - 1;
    if (n !== 1) throw new Error(`edit anchor must occur once (found ${n}) in ${e.path}: ${e.find.slice(0, 60)}`);
    files[e.path] = text.replace(e.find, () => e.replace);
  }
  for (const [p, t] of Object.entries(files)) writeFileSync(join(root, p), t);
  return files;
}

const IDS = (id) => [`sha256:${createHash('sha256').update(id).digest('hex')}`];

/** Export-task shaped object (src/fix/export/tasks.js) plus the harness fields (allowlist, routes, designLock, documented, targets) for one defect.
 * `targets` are snapshot selectors the fix is meant to move; most defects change nothing visible, so it is empty (a wrong fix is then not exempted). */
export function taskFor(site, defect) {
  return {
    id: defect.id, ids: IDS(defect.id), rule: defect.rule, routes: site.routes, designLock: defect.designLock, tier: 'confirmed',
    source: { file: defect.file, line: defect.line }, element: defect.element, evidence: defect.evidence,
    ...(defect.visibleText ? { visibleText: defect.visibleText, accessibleName: defect.accessibleName } : {}),
    allowlist: [defect.scope], documented: defect.documented || [], targets: defect.targets || [],
  };
}

/** Fixer context for a task: the allowlisted files and read-only scripts and styles of the site tree at `root` (reads only). */
export function contextFor(root, site, task) {
  const rd = (rel) => readFileSync(join(root, rel), 'utf8');
  const files = {};
  for (const e of task.allowlist) files[e.file] = { text: rd(e.file) };
  // page-wide tasks may need the partials around the page (body, main and head can live in another file)
  if (task.allowlist.some((e) => e.startLine == null)) for (const f of readdirSync(join(root, 'src/partials')).sort()) files[`src/partials/${f}`] ??= { text: rd(`src/partials/${f}`) };
  const readonly = {};
  for (const d of ['scripts', 'styles']) for (const f of readdirSync(join(root, 'src', d)).sort()) readonly[`src/${d}/${f}`] = rd(`src/${d}/${f}`);
  return { files, readonly, ...(site.siteLang ? { siteLang: site.siteLang } : {}) };
}
