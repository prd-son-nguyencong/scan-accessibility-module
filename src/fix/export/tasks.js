// `ada-scan fix --export`: one task per actionable finding (markdown + JSON sidecar) plus tasks/INDEX.md, for a developer
// or an AI tool to work from. No AI, no network. Writes only <outDir>/tasks/ files that carry the ada-scan marker.
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { IMPACT_ORDER } from '../../schema.js';
import { wcagLevel } from '../../reporter/qa-report.js';
import { suggestedAction } from '../../tracer/ownership.js';
import { contrastTokens } from '../../tracer/structural-source.js';
import { NEVER_CHANGE_COLOURS, PAGE_WIDE_RULES, fillRecipe, parseElement, renderDiff, textOf } from './recipes.js';

export const MARKER = 'ada-scan:generated';
const VERDICT_RANK = { confirmed: 0, likely: 1, 'needs-review': 2 };
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const sevIndex = (impact) => IMPACT_ORDER.indexOf(impact);
const trimRoute = (r) => (String(r || '/').replace(/\/+$/, '') || '/');
const verdictOf = (f) => f.verdict || 'confirmed';

/** WCAG criteria ("1.4.3") and level ("AA") from axe-style tags (wcag143, wcag2aa) or "WCAG 1.4.3". */
export function parseWcag(wcagRef) {
  const criteria = [];
  let level = null;
  for (const token of String(wcagRef || '').split(',').map((t) => t.trim()).filter(Boolean)) {
    const tag = /^wcag(\d)(\d)(\d+)$/i.exec(token);
    const dotted = /^WCAG\s+(\d+\.\d+\.\d+)$/i.exec(token);
    const c = tag ? `${tag[1]}.${tag[2]}.${tag[3]}` : dotted?.[1];
    if (c && !criteria.includes(c)) criteria.push(c);
    level = level || wcagLevel(token);
  }
  return { criteria: criteria.sort(), level };
}

/** Lines of a local file, read inside the source root only; null when unreadable. */
function readSource(root, file) {
  if (!root || !file) return null;
  try {
    const real = realpathSync(path.resolve(root, file));
    if (!real.startsWith(realpathSync(root) + path.sep)) return null;
    return readFileSync(real, 'utf8').split(/\r?\n/);
  } catch {
    return null;
  }
}

/** Five lines around `line`; null when unreadable. */
function excerptFor(lines, line) {
  if (!lines || !Number.isInteger(line) || line < 1 || line > lines.length) return null;
  const from = Math.max(1, line - 2);
  const to = Math.min(lines.length, from + 4);
  const out = [];
  for (let n = from; n <= to; n += 1) out.push(`${n === line ? '>' : ' '} ${String(n).padStart(4)} | ${lines[n - 1]}`);
  return out.join('\n');
}

/** True when source line `line` holds the opening tag of the element (unknown tag: assume yes). A trace can be a few lines off. */
const lineHasTag = (lines, line, tag) => !tag || !lines || Boolean(lines[line - 1] && new RegExp(`<${tag}(?=[\\s>/])`, 'i').test(lines[line - 1]));

/** Variable of the innermost Liquid for-loop open at the element on `line` (only what precedes the element's tag on that line counts), or null. */
function loopAt(lines, line, tag) {
  if (!lines || !Number.isInteger(line)) return null;
  const stack = [];
  for (let i = 0; i < Math.min(line, lines.length); i += 1) {
    let text = lines[i];
    if (i === line - 1 && tag) { const at = text.search(new RegExp(`<${tag}(?=[\\s>/])`, 'i')); if (at >= 0) text = text.slice(0, at); }
    for (const m of text.matchAll(/\{%-?\s*(?:for\s+(\w+)\s+in|(endfor))\b/g)) { if (m[2]) stack.pop(); else stack.push(m[1]); }
  }
  return stack.length ? stack[stack.length - 1] : null;
}

// Behaviour rules whose cause is script-set state (tabindex, focus handling): the fix is in src/scripts, not in a template.
const SCRIPT_RULES = new Set(['menu-links-unreachable-by-keyboard', 'focus-lost-after-escape', 'aria-hidden-focus-script']);
/** src/scripts files that set tabindex or handle keys (the likely home of the fix), at most 4; the entry point index.js always leads when it exists (it wires every module). [] when no root. */
function scriptCandidates(root) {
  if (!root) return [];
  const out = [];
  const go = (d, depth) => {
    let names;
    try { names = readdirSync(path.join(root, d), { withFileTypes: true }); } catch { return; }
    for (const e of names.sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = `${d}/${e.name}`;
      if (e.isDirectory() && depth < 1) go(rel, depth + 1);
      else if (/\.(?:js|mjs)$/.test(e.name) && /tabindex|keydown|Escape/.test((readSource(root, rel) || []).join('\n'))) out.push(rel);
    }
  };
  go('src/scripts', 0);
  const entry = 'src/scripts/index.js';
  return [...new Set([...(readSource(root, entry) ? [entry] : []), ...out])].slice(0, 4);
}

const walkLiquid = (root, dir) => {
  const out = [];
  const go = (d) => {
    let names;
    try { names = readdirSync(path.join(root, d), { withFileTypes: true }); } catch { return; }
    for (const e of names.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.isDirectory()) go(`${d}/${e.name}`); else if (e.name.endsWith('.liquid')) out.push(`${d}/${e.name}`);
    }
  };
  go(dir);
  return out;
};

const ROLES = {
  'skip-link-missing': [[/<body[\s>]/i, 'layout: has <body>; put the skip link directly after it'], [/<main[\s>]/i, 'has <main>; give it id="main-content" here'], [/<header[\s>]/i, 'header partial; the skip link must come before it']],
  'skip-link-target-missing': [[/<main[\s>]/i, 'has <main>; its id must equal the skip link href'], [/<body[\s>]/i, 'layout: has <body>; the skip link usually lives here']],
  region: [[/<main[\s>]/i, 'has <main>; page content must sit inside a landmark'], [/<body[\s>]/i, 'layout: has <body>']],
  'document-title': [[/<title[\s>]|<head[\s>]/i, 'has <head>; the page needs a non-empty <title>']],
  'html-has-lang': [[/<html[\s>]/i, 'layout: has <html>; set lang here']],
};
ROLES['missing-main-landmark'] = ROLES.region;
// Rules whose fix lives in each page's own template (the shared layout alone cannot fix them).
const PAGE_SPECIFIC = { 'page-has-heading-one': 'page template; put the one <h1> here or in the partial it renders', 'missing-h1': 'page template; put the one <h1> here or in the partial it renders', region: 'page template; its content must sit inside <main>', 'missing-main-landmark': 'page template; its content must sit inside <main>', 'document-title': 'page template; check it does not blank the <title>' };

/** Template of a route: src/pages/<route>.liquid or <route>/index.liquid ('/' is index); null when the file does not exist locally. */
function pageTemplate(root, route) {
  const r = String(route || '/').replace(/^\/+|\/+$/g, '').split('?')[0];
  return [`src/pages/${r || 'index'}.liquid`, `src/pages/${r}/index.liquid`].find((f) => readSource(root, f)) || null;
}

/** Page-wide root causes (skip link, h1, landmarks) have no line: find the files that play the role (layout with <body>, <main>, header partial) and the page templates of the listed pages. */
const MAX_PAGE_LIKELY = 12;
function likelyLocations(root, rule, pages = []) {
  const out = [];
  let omitted = 0;
  if (root) {
    const files = [...walkLiquid(root, 'src/layouts'), ...walkLiquid(root, 'src/partials'), ...walkLiquid(root, 'src/pages')];
    for (const [re, why] of ROLES[rule] || []) {
      let n = 0;
      for (const f of files) {
        const lines = readSource(root, f);
        const i = lines ? lines.findIndex((l) => re.test(l)) : -1;
        if (i >= 0 && n < 3) { out.push({ file: f, line: i + 1, role: why }); n += 1; }
      }
    }
    if (PAGE_SPECIFIC[rule]) {
      // Dependency distance from the page: 0 = the page's own template, 1 = a partial it renders (so an edit there is in scope too, max 8 per page).
      // Nearest first, route order within a distance, and at most MAX_PAGE_LIKELY entries: a 40-page site must not turn the task into a whole-site scope.
      const near = [], far = [];
      for (const route of pages) {
        const f = pageTemplate(root, route);
        if (!f || out.some((o) => o.file === f) || near.some((o) => o.file === f)) continue;
        near.push({ file: f, line: null, role: `${PAGE_SPECIFIC[rule]} (${route})` });
        const names = [...new Set([...(readSource(root, f) || []).join('\n').matchAll(/\{%-?\s*(?:render|include)\s+['"]([^'"]+)['"]/g)].map((m) => m[1]))].slice(0, 8);
        for (const n of names) {
          const pf = [`src/partials/${n}.liquid`, `src/components/${n}.liquid`].find((c) => readSource(root, c));
          if (pf && !out.some((o) => o.file === pf) && !far.some((o) => o.file === pf)) far.push({ file: pf, line: null, role: `partial rendered by ${f}; the h1 may go here instead` });
        }
      }
      const ordered = [...near, ...far];
      out.push(...ordered.slice(0, MAX_PAGE_LIKELY));
      omitted = Math.max(0, ordered.length - MAX_PAGE_LIKELY);
    }
  }
  if (!out.length) return [{ file: null, line: null, role: 'the layout that contains <body> (usually src/layouts/), the header partial and the page templates; not found locally' }];
  out.omitted = omitted;
  return out;
}

/** First 300 characters of the element's markup, extended to the end of its opening tag (capped at 1500) so the tag and every attribute survive. */
const clipHtml = (html, open) => html.slice(0, Math.min(1500, Math.max(300, open ? html.indexOf(open) + open.length : 0)));

/** Source path relative to the root; an absolute path outside it is reduced to its name so no home path leaks. */
function relFile(root, file) {
  if (!file) return null;
  const f = String(file).replace(/\\/g, '/');
  if (!path.isAbsolute(f)) return f.replace(/^\.\//, '');
  const rel = root ? path.relative(root, f) : '';
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep).join('/') : path.basename(f);
}

/** Compact selector pattern for a task: nth-of-type indexes folded, at most three distinct shapes. */
function selectorPattern(occurrences, given) {
  if (given) return String(given);
  const shapes = [...new Set(occurrences.map((o) => o.selector).filter(Boolean).map((x) => x.replace(/:nth-(of-type|child)\(\d+\)/g, ':nth-$1(n)')))];
  if (!shapes.length) return '(page-wide, no selector)';
  return shapes.length <= 3 ? shapes.join(' | ') : `${shapes.slice(0, 3).join(' | ')} | ${shapes.length - 3} more`;
}

function matchesPage(item, page) {
  const want = trimRoute(page);
  return trimRoute(item.route) === want || item.name === page;
}

/**
 * Pure task model from a ScanReportV2. Filters: severity (this level or worse), rule, page, max; needs-review is left out
 * unless includeNeedsReview. Platform- and third-party-owned findings are never tasks: they go to `notActionable`.
 */
/** Traced tasks grouped per source file; inside a file the highest line comes first so edits apply bottom-up and line numbers stay valid. */
export function groupByFile(tasks) {
  const m = new Map();
  for (const t of tasks) if (t.source && !t.requiresDesignDecision) m.set(t.source.file, [...(m.get(t.source.file) || []), t]);
  return [...m].sort(([a], [b]) => a.localeCompare(b)).map(([file, ts]) => ({
    file, fileBase: `file-${slug(file)}`,
    tasks: [...ts].sort((a, b) => (b.source.line ?? 0) - (a.source.line ?? 0) || a.rule.localeCompare(b.rule) || a.id.localeCompare(b.id)),
  }));
}

export function buildTaskSet(report, { severity, rule, page, max, includeNeedsReview = false, sourceRoot = null } = {}) {
  const rules = rule ? String(rule).split(',').map((r) => r.trim()) : null;
  const root = sourceRoot ? path.resolve(sourceRoot) : null;
  const omitted = { needsReview: 0, info: 0 };
  const taskGroups = new Map();
  const outside = new Map();
  for (const pg of report.pages || []) {
    for (const f of pg.findings || []) {
      const item = { f, route: pg.route ?? f.route, url: pg.url ?? null, name: pg.name };
      if (severity && !(sevIndex(f.impact) >= 0 && sevIndex(f.impact) <= sevIndex(severity))) {
        if (f.impact === 'info') omitted.info += 1;
        continue;
      }
      if (rules && !rules.includes(f.nativeRuleId) && !rules.includes(f.canonicalRuleId)) continue;
      if (page && !matchesPage(item, page)) continue;
      if (f.impact === 'info') { omitted.info += 1; continue; }
      // Vendor DOM is always needs-review at most; it still belongs in the not-your-code list, never in a fix task.
      if (verdictOf(f) === 'needs-review' && !includeNeedsReview && f.ownership !== 'third-party') { omitted.needsReview += 1; continue; }
      const s = f.source || {};
      const owner = f.ownership || 'source';
      if (owner !== 'source') {
        const key = `${f.nativeRuleId}|${owner}|${f.origin?.vendor || f.origin?.kind || ''}`;
        outside.set(key, [...(outside.get(key) || []), item]);
        continue;
      }
      const traced = Boolean(s.file) && (s.confidence === 'high' || s.confidence === 'medium');
      const file = traced ? relFile(root, s.file) : null;
      const key = traced ? `${f.nativeRuleId}|${file}:${s.line ?? ''}` : `${f.nativeRuleId}|?|${f.element?.selector}`;
      taskGroups.set(key, [...(taskGroups.get(key) || []), item]);
    }
  }

  const byOcc = (a, b) => `${a.route}|${a.f.element?.selector}|${a.f.stableId}`.localeCompare(`${b.route}|${b.f.element?.selector}|${b.f.stableId}`);
  let tasks = [...taskGroups.values()].map((items) => {
    items.sort(byOcc);
    const { f } = items[0];
    const s = f.source || {};
    const traced = Boolean(s.file) && (s.confidence === 'high' || s.confidence === 'medium');
    const file = traced ? relFile(root, s.file) : null;
    const { criteria, level } = parseWcag(f.wcagRef);
    const worst = items.reduce((a, i) => (sevIndex(i.f.impact) < sevIndex(a) ? i.f.impact : a), f.impact);
    const verdict = items.reduce((a, i) => (VERDICT_RANK[verdictOf(i.f)] < VERDICT_RANK[a] ? verdictOf(i.f) : a), verdictOf(f));
    const id = f.stableId || f.findingId;
    const occurrences = items.map((i) => ({ route: i.route, url: i.url, selector: i.f.element?.selector ?? '', count: i.f.count ?? 1, stableId: i.f.stableId || i.f.findingId }));
    const candidates = [...new Map([...(f.sourceCandidates || [])].map((c) => [`${relFile(root, c.file)}:${c.line}`, { file: relFile(root, c.file), line: c.line, confidence: c.confidence }])).values()]
      .sort((a, b) => `${a.file}:${a.line}`.localeCompare(`${b.file}:${b.line}`));
    const lines = traced ? readSource(root, s.file ? relFile(root, s.file) : null) : null;
    const line = traced && Number.isInteger(s.line) ? s.line : null;
    const ev = f.evidence || {};
    const evidence = [...new Set([ev.proof?.fact, ev.failureSummary, ev.message, ev.visibleText ? `visible text "${ev.visibleText}", accessible name "${ev.accessibleName ?? ''}"` : null,
      ev.occurrences?.pattern ? `${ev.occurrences.count} occurrences in the same container, selector pattern ${ev.occurrences.pattern}` : null, ev.reviewReason, f.fix?.hint]
      .filter((x) => typeof x === 'string' && x.trim()).map((x) => x.replace(/\s+/g, ' ').trim().slice(0, 600)))];
    const html = String(f.element?.outerHTML || '');
    const el = parseElement(html);
    const pattern = selectorPattern(occurrences, ev.occurrences?.pattern);
    const problem = f.evidence?.message || f.fix?.hint || f.nativeRuleId;
    // A line that does not hold the element says nothing about the element's loop (the trace can be off).
    const loopVar = lines && lineHasTag(lines, line, el.tag) ? loopAt(lines, line, el.tag) : null;
    const cx = {
      rule: f.nativeRuleId, html, tag: el.tag, attrs: el.attrs, text: textOf(html), evidence, problem, hint: f.fix?.hint || '', pattern, file, target: report.target?.url ?? null,
      line: line && lines ? lines[line - 1] : null, inLoop: Boolean(loopVar), loopVar,
      pages: [...new Set(items.map((i) => i.route))], measured: Array.isArray(ev.measured) ? null : ev.measured?.contrast, visibleText: ev.visibleText, accessibleName: ev.accessibleName,
      tokens: null,
    };
    if (root && /foreground color:/i.test(evidence.join(' '))) { try { cx.tokens = contrastTokens(html, evidence.join(' '), root); } catch { cx.tokens = null; } }
    const scriptFiles = SCRIPT_RULES.has(String(f.nativeRuleId).toLowerCase()) ? scriptCandidates(root) : [];
    if (scriptFiles.length) cx.evidence = [...cx.evidence, `Script fix: this behaviour is usually set by script, not by the template. Candidates: ${scriptFiles.join(', ')}. Edit the script (not only the template) when the template markup is already correct.`];
    const recipe = fillRecipe(cx);
    const locked = Boolean(recipe.designLocked);
    const change = !locked && recipe.change && file && line ? { file, line, before: recipe.change.before, after: recipe.change.after, diff: renderDiff(file, line, recipe.change) } : null;
    const pageWide = !traced && PAGE_WIDE_RULES.has(String(f.nativeRuleId).toLowerCase());
    return {
      id,
      fileBase: `${slug(f.nativeRuleId)}-${slug(id).slice(0, 12)}`,
      rule: f.nativeRuleId,
      layer: f.layer,
      wcag: { criteria, level },
      severity: worst,
      verdict,
      confidence: s.confidence || 'none',
      source: traced ? { file, line, excerpt: excerptFor(lines, line), ...(lines && line && !lineHasTag(lines, line, el.tag) ? { elementOnLine: false } : {}) } : null,
      ...(traced ? {} : { untraced: true }),
      locateManually: traced ? null : { reason: s.traceReason || 'unresolved', candidates, ...(pageWide ? (() => { const likely = likelyLocations(root, String(f.nativeRuleId).toLowerCase(), [...new Set(items.map((i) => i.route))]); return { likely, ...(likely.omitted ? { likelyOmitted: likely.omitted } : {}) }; })() : {}) },
      element: { selector: f.element?.selector ?? '', html: clipHtml(html, el.open) },
      problem,
      evidence: cx.evidence,
      ...(scriptFiles.length ? { scriptFiles } : {}),
      selectorPattern: pattern,
      fix: { hint: f.fix?.hint || '', example: recipe.after, recipe: recipe.recipe, intent: recipe.intent, before: recipe.before, after: recipe.after, cautions: recipe.cautions, verify: recipe.verify },
      proposedChange: change,
      ...(locked ? { requiresDesignDecision: true, designOwner: recipe.designOwner } : {}),
      occurrences,
      pages: [...new Set(items.map((i) => i.route))],
      ids: occurrences.map((o) => o.stableId),
    };
  });
  tasks.sort((a, b) => sevIndex(a.severity) - sevIndex(b.severity)
    || String(a.pages[0]).localeCompare(String(b.pages[0])) || a.rule.localeCompare(b.rule)
    || String(a.source?.file).localeCompare(String(b.source?.file)) || (a.source?.line ?? 0) - (b.source?.line ?? 0) || a.id.localeCompare(b.id));
  const totalTasks = tasks.length;
  if (Number.isInteger(max) && max >= 0) tasks = tasks.slice(0, max);

  const notActionable = [...outside.values()].map((items) => {
    items.sort(byOcc);
    return {
      rule: items[0].f.nativeRuleId,
      ownership: items[0].f.ownership,
      ...(items[0].f.origin ? { origin: { owner: items[0].f.origin.owner, kind: items[0].f.origin.kind, ...(items[0].f.origin.vendor ? { vendor: items[0].f.origin.vendor } : {}), label: items[0].f.origin.label }, suggestedAction: suggestedAction(items[0].f.origin) } : {}),
      severity: items.reduce((a, i) => (sevIndex(i.f.impact) < sevIndex(a) ? i.f.impact : a), items[0].f.impact),
      pages: [...new Set(items.map((i) => i.route))],
      findings: items.length,
    };
  }).sort((a, b) => sevIndex(a.severity) - sevIndex(b.severity) || a.rule.localeCompare(b.rule) || a.ownership.localeCompare(b.ownership));
  return { target: report.target?.url ?? null, tasks, totalTasks, notActionable, omitted, byFile: groupByFile(tasks) };
}

const list = (items) => items.map((i) => `- ${i}`).join('\n');
const pageList = (pages, n = 5) => (pages.length <= n ? pages.join(', ') : `${pages.slice(0, n).join(', ')} and ${pages.length - n} more`);
const occLine = (o) => `${o.route} - \`${o.selector}\`${o.count > 1 ? ` (${o.count}x)` : ''}`;
const fence = (lang, body) => `\`\`\`${lang}\n${body}\n\`\`\``;
const loc = (t) => (t.source ? `${t.source.file}${t.source.line ? `:${t.source.line}` : ''}` : (t.locateManually.candidates.length ? 'locate among candidates' : 'locate manually'));

/** Task sections at heading level `h` (## for a task file, ### inside a per-file task). */
function sections(t, { target, h = '##' } = {}) {
  const hh = (n) => `${h} ${n}`;
  const where = t.source
    ? `\`${loc(t)}\` (trace confidence: ${t.confidence})${t.source.elementOnLine === false ? '\n\nThe traced line does not contain the element below: the trace may be a few lines off, search the file around it.' : ''}${t.source.excerpt ? `\n\n${fence('', t.source.excerpt)}` : ''}`
    : `Untraced: locate manually. ada-scan could not pin this to one source line (${t.locateManually.reason}).${t.locateManually.likely ? `\n\nLikely location by role (page-wide root cause, shared by every page):\n${list(t.locateManually.likely.map((l) => (l.file ? `\`${l.file}${l.line ? `:${l.line}` : ''}\` (${l.role})` : l.role)))}${t.locateManually.likelyOmitted ? `\n- and ${t.locateManually.likelyOmitted} more further from the page (nearest listed first)` : ''}` : ''}${t.locateManually.candidates.length ? `\n\nCandidates:\n${list(t.locateManually.candidates.map((c) => `\`${c.file}${c.line ? `:${c.line}` : ''}\` (${c.confidence})`))}` : ''}${t.element.html ? '\n\nSearch the templates for the element below on the listed pages.' : ''}`;
  const occ = t.occurrences.slice(0, 12).map(occLine);
  const f = t.fix;
  const d = t.designOwner;
  const fixBody = f.recipe
    ? `${f.intent}\n\nBefore:\n\n${fence('liquid', f.before)}\n\nAfter:\n\n${fence('liquid', f.after)}`
    : f.intent;
  const owner = d ? `${hh('For the design owner')}\n\nThis is a design decision. ada-scan makes no edit and proposes no diff.\n\n${list([`Current ratio: ${d.currentRatio || 'see Evidence'}`, `Required ratio: ${d.requiredRatio}`, ...(d.foreground ? [`Colours: ${d.foreground} on ${d.background || 'its background'}`] : []), ...d.producedBy.map((x) => `Produced by: ${x}`), ...(d.nearestPassing ? [`For information only, nearest passing colour in the same hue: ${d.nearestPassing}`] : [])])}\n\nQuestions for the designer:\n\n${list(d.questions)}\n` : '';
  const proposed = t.proposedChange
    ? `\n\n${hh('Proposed change')}\n\nA suggestion built from the excerpt above: adapt it to the surrounding code before applying.\n\n${fence('diff', t.proposedChange.diff)}`
    : '';
  const pages = pageList(t.pages);
  return `${hh('Where')}

${where}

${d ? `Colour chain: ${d.producedBy.join('; ')}\n\n` : ''}Pages (${t.pages.length}): ${pages}

${occ.length ? `${list(occ)}${t.occurrences.length > occ.length ? `\n- and ${t.occurrences.length - occ.length} more (see ${t.fileBase}.json)` : ''}\n\n` : ''}${t.element.html ? `Element:\n\n${fence('html', t.element.html)}\n\n` : ''}${hh('Evidence')}

${list(t.evidence)}

${owner || `${hh('Fix')}\n\n${fixBody}${proposed}\n`}

${hh('Do not')}

${list(f.cautions)}

${hh('Verify')}

- Command: \`ada-scan --url ${target || '<site url>'}\` (compares with the baseline saved by \`ada-scan --baseline\`; fixed findings are listed as fixed)
- Criterion: rule \`${t.rule}\` no longer reported on ${t.pages.length > 1 ? `pages ${pages}` : `page ${pages}`} for selector pattern \`${t.selectorPattern}\`; ids listed in the \`${t.fileBase}.json\` sidecar.
- Check: ${f.verify}
`;
}

export function renderTask(t, { target } = {}) {
  return `<!-- ${MARKER} -->
# ${t.rule}: ${t.problem}

- Task id: \`${t.id}\`
- Rule: \`${t.rule}\` (${t.layer})
- WCAG: ${t.wcag.criteria.length ? t.wcag.criteria.join(', ') : 'n/a'}${t.wcag.level ? ` level ${t.wcag.level}` : ''}
- Severity: ${t.severity}
- Verdict: ${t.verdict}

${sections(t, { target })}`;
}

/** One combined task per source file: its tasks bottom-up (highest line first) so every line number is still valid when it is edited. */
export function renderFileTask(g, { target } = {}) {
  return `<!-- ${MARKER} -->
# ${g.file}: ${g.tasks.length} fix${g.tasks.length === 1 ? '' : 'es'} in one pass

Edit \`${g.file}\` once. Apply the changes in the order below (highest line first), so the line numbers shown stay valid.

${g.tasks.map((t, i) => `## ${i + 1}. Line ${t.source.line ?? '?'}: ${t.rule}

- Severity: ${t.severity}, WCAG: ${t.wcag.criteria.join(', ') || 'n/a'}${t.wcag.level ? ` level ${t.wcag.level}` : ''}, verdict: ${t.verdict}
- Problem: ${t.problem}
- Task id: \`${t.id}\`

${sections({ ...t, fileBase: g.fileBase }, { target, h: '###' })}`).join('\n')}`;
}

export const NOT_YOUR_CODE_FILE = 'not-your-code.md';

/** Findings in code the site team does not own, with who owns it and what to do about it. Separate from the dev task list on purpose. */
export function renderNotYourCode(set) {
  const rows = set.notActionable.map((n) => `- [${n.severity}] \`${n.rule}\` - ${n.origin?.label || n.ownership} - ${n.findings} finding(s) on ${n.pages.join(', ')}\n  - Action: ${n.suggestedAction || 'Report to the platform team or the vendor.'}`);
  return `<!-- ${MARKER} -->
# Not your code

${set.target ? `Target: ${set.target}\n\n` : ''}These findings sit in vendor scripts, Paradox platform widgets or cross-origin iframes. They are not in the site's source, so no task was
written for them and they stay out of the quality gate. Send them to the owner named on each line.

${rows.length ? rows.join('\n') : 'None.'}
`;
}

export function renderIndex(set, { includeNeedsReview, groupByFile = false } = {}) {
  const bySev = IMPACT_ORDER.map((s) => `${s} ${set.tasks.filter((t) => t.severity === s).length}`).join(', ');
  const occ = (t) => t.occurrences.reduce((n, o) => n + o.count, 0);
  const link = (t) => (groupByFile && t.source ? `[${groupByFileBase(set, t)}.md](${groupByFileBase(set, t)}.md)` : `[${t.fileBase}.md](${t.fileBase}.md)`);
  const work = set.tasks.filter((t) => !t.requiresDesignDecision);
  const design = set.tasks.filter((t) => t.requiresDesignDecision);
  const rows = work.map((t) => `| ${t.severity} | \`${t.rule}\` | ${t.source ? `\`${loc(t)}\`` : loc(t)} | ${t.pages.length}: ${pageList(t.pages, 3)} | ${occ(t)} | ${link(t)} |`);
  const byFile = set.byFile.map((g) => `### \`${g.file}\`${groupByFile ? ` ([${g.fileBase}.md](${g.fileBase}.md))` : ''}\n\n${g.tasks.map((t, i) => `${i + 1}. line ${t.source.line ?? '?'}: \`${t.rule}\` (${t.severity})${groupByFile ? '' : ` - [${t.fileBase}.md](${t.fileBase}.md)`}`).join('\n')}`);
  return `<!-- ${MARKER} -->
# ada-scan fix tasks

${set.target ? `Target: ${set.target}\n\n` : ''}- Tasks: ${set.tasks.length}${set.totalTasks > set.tasks.length ? ` of ${set.totalTasks} (limited by --max)` : ''} (${bySev})
- Not actionable in source: ${set.notActionable.length}${set.notActionable.length ? ` (see ${NOT_YOUR_CODE_FILE})` : ''}
- Left out: ${set.omitted.needsReview} needs-review finding(s)${includeNeedsReview ? ' (included)' : ' (use --include-needs-review)'}, ${set.omitted.info} informational

## Prompt for your AI tool

\`\`\`
Read INDEX.md in this folder. Work only from "Tasks" and "By file". Work file by file using "By file": open each source file once and apply every fix listed for it,
bottom-up (highest line first) so line numbers stay valid. Each task's ${groupByFile ? 'file' : 'markdown file'} has Where, Evidence, Fix, Do not and Verify; its
"Proposed change" is a suggestion to adapt, not a patch to paste. Edit the shared partial or layout once, put per-item values in
the .liquid.json sidecar, keep {{data:..}}, {{component:..}}, {{snippet:..}} and data-pdk-* untouched, and prefer Tailwind utilities
the project already uses. Tasks that say "locate manually" or name a likely location by role: find the file, then fix it the same way.
${NEVER_CHANGE_COLOURS}
Tasks under "Design decisions (do not change colours)" are not yours to fix: skip them. Do not edit anything listed under "Not actionable in source". Then tell me to rescan with ada-scan.
\`\`\`

## Tasks

${rows.length ? `| Severity | Rule | File | Pages | Occurrences | Task |\n| --- | --- | --- | --- | --- | --- |\n${rows.join('\n')}` : 'None.'}

## Design decisions (do not change colours)

Colours follow the design. These tasks are excluded from the work list above; they are for the design owner. ${NEVER_CHANGE_COLOURS}

${design.length ? design.map((t) => `- [${t.severity}] \`${t.rule}\` - ${t.pages.length}: ${pageList(t.pages, 3)} - ${t.source ? `\`${loc(t)}\`` : loc(t)} - [${t.fileBase}.md](${t.fileBase}.md)`).join('\n') : 'None.'}

## By file

${byFile.length ? `Apply the fixes of one file in the order shown (highest line first).\n\n${byFile.join('\n\n')}` : 'None.'}

## Not actionable in source

${set.notActionable.length ? set.notActionable.map((n) => `- [${n.severity}] \`${n.rule}\` - ${n.origin?.label || n.ownership} - ${n.findings} finding(s) on ${n.pages.join(', ')}`).join('\n') : 'None.'}
`;
}
const groupByFileBase = (set, t) => set.byFile.find((g) => g.file === t.source.file).fileBase;

/** 'absent' | 'owned' (regular file whose header carries the marker) | 'foreign' (anything else, symlinks included, even dangling). */
export function ownership(file) {
  let st;
  try { st = lstatSync(file); } catch { return 'absent'; }
  if (!st.isFile()) return 'foreign';
  return readFileSync(file, 'utf8').split('\n', 8).some((l) => l.includes(MARKER)) ? 'owned' : 'foreign';
}

/** Writes a file this tool owns: creates it or replaces a marked one; throws rather than overwrite anything else. */
export function writeOwned(file, content) {
  const own = ownership(file);
  if (own === 'foreign') throw new Error(`refusing to overwrite ${file}: it is not an ada-scan file`);
  if (own === 'owned' && readFileSync(file, 'utf8') === content) return;
  writeFileSync(file, content);
}

/** Writes tasks/ under outDir and removes stale marked task files from an earlier export. Returns the directory and file names. */
export function writeTaskSet(set, outDir, { includeNeedsReview = false, groupByFile: grouped = false } = {}) {
  const dir = path.join(outDir, 'tasks');
  mkdirSync(dir, { recursive: true });
  const files = new Map([['INDEX.md', renderIndex(set, { includeNeedsReview, groupByFile: grouped })]]);
  if (set.notActionable.length) files.set(NOT_YOUR_CODE_FILE, renderNotYourCode(set));
  const json = (o) => `${JSON.stringify({ generator: MARKER, ...o }, null, 2)}\n`;
  for (const t of set.tasks) {
    if (grouped && t.source && !t.requiresDesignDecision) continue;
    files.set(`${t.fileBase}.md`, renderTask(t, { target: set.target }));
    const { fileBase, ...rest } = t;
    files.set(`${fileBase}.json`, json(rest));
  }
  if (grouped) {
    for (const g of set.byFile) {
      files.set(`${g.fileBase}.md`, renderFileTask(g, { target: set.target }));
      files.set(`${g.fileBase}.json`, json({ file: g.file, tasks: g.tasks.map(({ fileBase, ...rest }) => rest) }));
    }
  }
  for (const [name, content] of files) writeOwned(path.join(dir, name), content);
  for (const name of readdirSync(dir)) {
    const file = path.join(dir, name);
    if (!files.has(name) && /^[a-z0-9._-]+\.(md|json)$/.test(name) && ownership(file) === 'owned') unlinkSync(file);
  }
  return { dir, files: [...files.keys()] };
}
