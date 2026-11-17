// Static shell of the scan report (everything that does not need a client): masthead, overview, coverage, pages, not-your-code, links, performance, run details.
// The findings explorer is built by client.js from the data block embedded here. Every dynamic string goes through the shared escape helper.
import { readFileSync } from 'node:fs';
import { escapeHtml as esc, cspMeta } from '../../utils/escape-html.js';
import { GATE_NOTE, totalsLabel } from '../wording.js';
import { wcagCoverageSentence } from '../../utils/wcag-criteria.js';
import { excludedNote } from '../../utils/thresholds.js';
import { THEME_CSS, THEME_INIT, THEME_TOGGLE_HTML, sha, wbr } from './theme.js';
export { wbr };
import { buildModel, IMPACTS, OWNERS, VERDICT_TEXT } from './model.js';

const CSS = THEME_CSS + readFileSync(new URL('./report.css', import.meta.url), 'utf8');
const CLIENT = readFileSync(new URL('./client.js', import.meta.url), 'utf8');

const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || `${one}s`)}`;
const IMPACT_LABEL = { critical: 'Critical', serious: 'Serious', moderate: 'Moderate', minor: 'Minor', info: 'Info' };
const IMPACT_LEVEL = { critical: 4, serious: 3, moderate: 2, minor: 1, info: 0 };
const IMPACT_MEANING = {
  critical: 'Blocks some people from completing a task.',
  serious: 'A major barrier; people can continue only with great difficulty.',
  moderate: 'Causes friction but has a workaround.',
  minor: 'A small inconvenience or a best-practice gap.',
  info: 'Informational. Never counted.',
};

const code = (s) => `<code>${wbr(s)}</code>`;
/** A short route stays on one line; a long one may wrap at its separators. */
const route = (s) => `<code${String(s).length <= 26 ? ' class="nw"' : ''}>${wbr(s)}</code>`;
export function pathHtml(file, line) {
  const i = String(file).lastIndexOf('/');
  return `<span class="path mono"><span class="dir">${wbr(file.slice(0, i + 1))}</span><span class="base">${wbr(file.slice(i + 1) + (line ? `:${line}` : ''))}</span></span>`;
}
const when = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`; };
const dur = (ms) => { if (!ms) return ''; const s = Math.round(ms / 1000); return s >= 120 ? `${Math.round(s / 60)} min` : `${s} s`; };
export const impactChip = (i) => `<span class="chip imp imp-${esc(i)}"><span class="meter" aria-hidden="true">${[0, 1, 2, 3].map((n) => `<b${n < (IMPACT_LEVEL[i] ?? 1) ? ' class="on"' : ''}></b>`).join('')}</span>${esc(IMPACT_LABEL[i] || i)}</span>`;
const stateChip = (s) => `<span class="chip state-chip st-${esc(s)}">${esc(s === 'ok' ? 'scanned' : s.replace('-', ' '))}</span>`;

/** Interns strings that repeat (selectors, hints, paths, snippets shared across pages) so the data block stays small. "~N" is a table reference, "~~" an escaped literal "~". */
export function pack(data) {
  const seen = new Map();
  const walk = (x) => {
    if (typeof x === 'string') { if (x.length >= 6) seen.set(x, (seen.get(x) || 0) + 1); } else if (Array.isArray(x)) x.forEach(walk); else if (x && typeof x === 'object') Object.values(x).forEach(walk);
  };
  walk(data);
  const table = []; const idx = new Map();
  for (const [s, n] of seen) if (n > 1 && (s.length - 4) * n > s.length + 6) { idx.set(s, table.length); table.push(s); }
  const enc = (x) => {
    if (typeof x === 'string') return idx.has(x) ? `~${idx.get(x)}` : (x.charCodeAt(0) === 126 ? `~${x}` : x);
    if (Array.isArray(x)) return x.map(enc);
    if (x && typeof x === 'object') { const o = {}; for (const k of Object.keys(x)) o[k] = enc(x[k]); return o; }
    return x;
  };
  return { t: table, d: enc(data) };
}
/** JSON that is safe inside a script element: no `</`, `<!--` or `<script` sequence can open or close anything, and quotes that start the escape-test payloads are encoded. */
export const safeJson = (v) => JSON.stringify(v).replace(/<(?=!--|\/|script)/gi, '\\u003c').replace(/['`\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

/** Inline icons: one family, 1.5 stroke, currentColor, decorative (aria-hidden). */
const ICONS = {
  alert: '<path d="M12 3 2.5 20h19z"/><path d="M12 10v4M12 17v.5"/>',
  check: '<circle cx="12" cy="12" r="9"/><path d="m8 12.5 3 3 5-6"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8v.5"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
};
export const icon = (name, size = 20) => `<svg class="ico" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICONS[name]}</svg>`;

/** Scanner text quotes code in `backticks`: show it as code, escaped. */
export function inline(s) {
  return String(s ?? '').split(/(`[^`]+`)/).map((part) => (part.length > 2 && part[0] === '`' && part.endsWith('`') ? `<code>${wbr(part.slice(1, -1))}</code>` : part.split(/(\s+)/).map((t) => (t.length >= 28 ? wbr(t) : esc(t))).join(''))).join('');
}


/** The headline sentence of the scan, shown in the band. */
function verdictLine(m) {
  const c = m.counts;
  let line;
  if (c.fix) line = `${plural(c.fix, 'occurrence')} in your code ${c.fix === 1 ? 'needs' : 'need'} fixing, from ${plural(c.roots, 'root cause')}.`;
  else if (c.review) line = `Nothing is confirmed in your code. ${plural(c.review, 'item')} need a person to look.`;
  else if (c.theirs) line = `Nothing to fix in your code. ${plural(c.theirs, 'occurrence')} come from code you do not own.`;
  else line = 'No automated issues found. Manual review is still required.';
  return m.incomplete ? `${line} The scan is incomplete, so a clean total is not a pass.` : line;
}

function overview(m) {
  const c = m.counts;
  const total = c.fix + c.review + c.theirs;
  const share = (n) => (total ? Math.max(n / total, 0.02) : 0);
  const gate = m.gate;
  const reasons = [];
  if (gate?.failed) {
    // One line per failing check id: the page when it is one, a count when it is many.
    const byId = new Map();
    for (const f of gate.fails) byId.set(f.id, [...(byId.get(f.id) || []), f]);
    const lines = [...byId.entries()].map(([id, list]) => (list.length === 1
      ? `${code(id)} is ${esc(list[0].actual ?? 'n/a')} against a target of ${esc(list[0].target)} on ${esc(list[0].page)}`
      : `${code(id)} misses its target of ${esc(list[0].target)} on ${list.length} of ${gate.pages.length} pages`));
    reasons.push(...lines.slice(0, 7));
    if (lines.length > 7) reasons.push(`${lines.length - 7} more failing checks, listed under Run details`);
  }
  const state = gate ? (gate.failed ? ['fail', 'Quality gate failed', 'alert'] : ['pass', 'Quality gate passed', 'check']) : ['none', 'No quality gate configured', 'info'];
  const first = (m.fixFirst.length ? m.fixFirst : m.reviewFirst);
  const rank = first.map((g) => {
    const f = m.findings[g.ks[0]];
    const rules = g.rules.length > 1 ? `${g.rules.length} rules` : g.rule;
    const src = g.src ? pathHtml(g.src.replace(/:\d+$/, ''), (g.src.match(/:(\d+)$/) || [])[1]) : '<span class="muted">Source not found: locate manually</span>';
    return `<li${g.impact === 'critical' ? ' class="is-critical"' : ''}>${impactChip(g.impact)}<div class="r-main"><strong>${code(rules)}</strong><span>${inline(g.y || '')}</span><span class="r-meta">${src}<span class="r-n">${plural(g.occ, 'occurrence')} on ${plural(g.pages.length, 'page')}${g.ks.length > 1 ? `, ${plural(g.ks.length, 'finding')}` : ''}</span></span></div><a class="btn btn-sm" href="#f-${esc(f.id)}" data-open="${esc(f.id)}">Open</a></li>`;
  }).join('');
  const kpi = (cls, n, label, text, view, extra = '') => `<div class="kpi ${cls}"><h3><a href="#findings" data-view="${esc(view)}">${esc(label)}</a></h3><p class="kpi-n">${n}</p><p class="kpi-t">${esc(text)}</p>${extra}</div>`;
  const alertBox = `<aside class="alert alert-${state[0]}" aria-labelledby="h-gate"><h3 id="h-gate">${icon(state[2], 24)}<span class="state state-${state[0]}">${esc(state[1])}</span></h3>
      ${gate ? `<p>${esc(GATE_NOTE)}${gate.excluded ? ` ${esc(plural(gate.excluded, 'third-party or platform finding'))} ${gate.excluded === 1 ? 'was' : 'were'} left out of the gate.` : ''}</p>` : '<p>No thresholds were configured, so nothing here fails a build.</p>'}
      ${reasons.length ? `<p class="alert-h">Why it failed:</p><ul>${reasons.map((r) => `<li>${r}</li>`).join('')}</ul>` : ''}
      ${gate && !gate.failed ? '<p>All gate checks passed. That covers automated checks only; manual review is still required.</p>' : ''}
    </aside>`;
  return `<section class="sec" id="overview" aria-labelledby="h-overview"><div class="wrap">
  <h2 class="sr" id="h-overview">Overview</h2>
  ${total ? `<div class="split" role="img" aria-label="${esc(`${c.fix} to fix in your code, ${c.review} need review, ${c.theirs} not your code`)}"><i class="s-fix" style="flex-grow:${share(c.fix)}"></i><i class="s-review" style="flex-grow:${share(c.review)}"></i><i class="s-theirs" style="flex-grow:${share(c.theirs)}"></i></div>` : ''}
  <div class="grid ov">
    <div class="c4">${kpi('k-fix', c.fix, 'Fix in your code', 'Confirmed or likely, in markup this project renders.', 'b=fix', gate?.failed && c.confirmedSite ? `<p class="kpi-bad">${esc(plural(c.confirmedSite, 'confirmed occurrence'))} ${c.confirmedSite === 1 ? 'fails' : 'fail'} the gate</p>` : '')}</div>
    <div class="c4">${kpi('k-review', c.review, 'Needs review', 'A person has to decide: heuristic rules, unbound platform data, unknown origin.', 'b=review')}</div>
    <div class="c4">${kpi('k-theirs', c.theirs, 'Not your code', 'Third-party scripts and platform widgets. Excluded from the gate.', 'b=theirs')}</div>
    <div class="c8">${rank ? `<div class="card fixfirst"><h3>${m.fixFirst.length ? 'Fix first' : 'Review first'}</h3><p class="lede">${m.fixFirst.length ? 'Root causes in your code, ranked by impact and then by how many occurrences one change would remove.' : 'Nothing is confirmed in your code yet. These need a person soonest.'}</p><ol class="rank">${rank}</ol></div>` : `<div class="card"><h3>Fix first</h3><p class="lede">Nothing to rank.</p></div>`}</div>
    <div class="c4">${alertBox}<p class="lede totals">${esc(totalsLabel(total, c.findings))}${c.info ? `; ${plural(c.info, 'informational item')} not counted` : ''}.</p></div>
  </div>
  </div></section>`;
}

function coverage(m) {
  const pages = m.pages;
  const n = (s) => pages.filter((p) => p.status === s).length;
  const ok = pages.length - n('failed') - n('partial') - n('skipped-empty') - n('skipped');
  const failed = pages.filter((p) => p.status === 'failed');
  const partial = pages.filter((p) => p.status === 'partial');
  const skipped = pages.filter((p) => p.status.startsWith('skipped'));
  const list = (title, items, note) => (items.length ? `<section><h3>${esc(title)} (${items.length})</h3>${note ? `<p class="lede" style="margin:0">${esc(note)}</p>` : ''}<ul>${items.join('')}</ul></section>` : '');
  const partialItems = partial.map((p) => `<li>${code(p.route)}: ${p.partial.length ? p.partial.map((r) => `${esc(r.layer)} ${esc(r.reason)}${r.gating ? '' : ' (supplementary)'}`).join(', ') : 'a layer did not complete'}</li>`);
  const engineOff = m.engines.filter((e) => Object.keys(e.other).length);
  return `<section class="sec" id="coverage" aria-labelledby="h-coverage"><div class="wrap">
  <h2 id="h-coverage">Coverage</h2>
  <p class="lede">${esc(plural(pages.length, 'page'))} in the scan: ${ok} scanned fully, ${partial.length} partial, ${failed.length} failed, ${skipped.length} skipped. ${m.incomplete ? 'Findings below do not cover the partial and failed pages.' : ''}</p>
  ${m.incomplete ? `<p class="note note-warn"><strong>Incomplete scan.</strong> A clean total is not a pass.${m.meta.allowIncomplete ? ' Exit code 2 was suppressed by --allow-incomplete.' : ''}</p>` : ''}
  <div class="cover">
    ${list('Failed', failed.map((p) => `<li>${code(p.route)}: not scanned${p.reason ? ` (${esc(p.reason)})` : ''}</li>`))}
    ${list('Partial', partialItems, 'Some layers did not finish on these pages.')}
    ${list('Skipped', skipped.map((p) => `<li>${code(p.route)}: ${esc(p.reason || 'skipped')}. Not a failure.</li>`), 'Not scanned and not counted as failed.')}
    ${list('Dropped routes', m.meta.dropped.map((d) => `<li>${code(d.route)}: not served (HTTP ${esc(d.status)})</li>`))}
    ${list('Scanner layers that did not complete', engineOff.map((e) => `<li>${esc(e.name)}: ${Object.entries(e.other).map(([k, v]) => `${v} ${esc(k)}`).join(', ')}</li>`))}
    ${list('Discovery', m.meta.discoveryWarnings.map((w) => `<li>${esc(typeof w === 'string' ? w : (w.message || w.type || 'warning'))}</li>`), m.meta.discoveryPartial ? 'The page list is partial: not every page of the site was found.' : '')}
  </div>
  ${comparison(m)}
  </div></section>`;
}

function comparison(m) {
  const c = m.comparison;
  if (!c) return '';
  const t = c.totals || {};
  const notes = [...(c.addedPages || []).map((r) => `${r}: page added, not in the baseline`), ...(c.removedPages || []).map((r) => `${r}: not scanned this time, not counted as fixed`), ...(c.notCompared || []).map((x) => `${x.route}: not compared (${x.reason})`), ...(c.warnings || []).map((w) => `Warning: ${w}`)];
  const rows = (c.pages || []).map((p) => `<tr><th scope="row" data-l="Page">${code(p.route)}</th><td class="num" data-l="Fixed">${esc(p.fixed)}</td><td class="num" data-l="Remaining">${esc(p.remaining)}</td><td class="num" data-l="New">${esc(p.new)}</td></tr>`).join('');
  return `<h3 class="sub">Compared with the baseline</h3>
  <p>Against ${esc(c.baseline?.source || 'the baseline')}${c.baseline?.generatedAt ? ` (${esc(c.baseline.generatedAt)})` : ''}: <strong>${esc(t.fixed)} fixed</strong>, <strong>${esc(t.remaining)} remaining</strong>, <strong>${esc(t.new)} new</strong>. Matched by finding id, confirmed and likely findings only.${t.needsReview ? ` Needs review is not compared: ${esc(t.needsReview.baseline)} before, ${esc(t.needsReview.current)} now.` : ''}</p>
  ${notes.length ? `<ul class="facts">${notes.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
  ${rows ? `<table class="tbl" style="margin-top:0.75rem"><thead><tr><th scope="col">Page</th><th scope="col" class="num">Fixed</th><th scope="col" class="num">Remaining</th><th scope="col" class="num">New</th></tr></thead><tbody>${rows}</tbody></table>` : ''}`;
}

function findingsSection(m) {
  const verdicts = Object.entries(VERDICT_TEXT).map(([k, [name, text]]) => `<dt><span class="chip vd vd-${k}">${esc(name)}</span></dt><dd>${esc(text)}${k === 'confirmed' ? ' Only confirmed findings in your code fail the gate.' : ''}</dd>`).join('');
  const impacts = IMPACTS.map((k) => `<dt>${impactChip(k)}</dt><dd>${esc(IMPACT_MEANING[k])}</dd>`).join('');
  const owners = OWNERS.map(([k, label]) => `<dt><span class="chip own">${esc(label)}</span></dt><dd>${esc({ site: 'Rendered from this project\'s templates and styles. This is yours to fix.', injected: 'Added by a script at run time.', unbound: 'Platform data was not bound in the local render.', unknown: 'The origin probe failed; ownership is not established.', 'third-party': 'A vendor script renders it. Report it to the vendor or change the tag configuration.', platform: 'A platform widget renders it.', iframe: 'Inside an iframe.' }[k])}</dd>`).join('');
  return `<section class="sec" id="findings" aria-labelledby="h-findings"><div class="wrap">
  <h2 id="h-findings">Findings</h2>
  <p class="lede">${esc(plural(m.counts.findings, 'finding'))} (${esc(plural(m.counts.total, 'occurrence'))}). One finding is one element on one page; findings with the same root cause are grouped.</p>
  <details class="guide"><summary>How to read verdicts, impact and owners</summary><div class="guide-body"><div><h3>Verdict</h3><dl>${verdicts}</dl></div><div><h3>Impact</h3><dl>${impacts}</dl></div><div><h3>Owner</h3><dl>${owners}</dl></div></div></details>
  </div>
  <noscript><div class="wrap"><p class="note">The findings explorer needs JavaScript. The overview, coverage, pages, links and performance sections work without it.</p></div></noscript>
  <div class="toolbar" id="toolbar"><div class="wrap">
    <div role="search" aria-label="Filter findings" id="tb">
      <div class="tb-row">
        <div class="search"><label class="sr" for="q">Search findings by rule, text, selector, file or page</label><input id="q" type="search" autocomplete="off" spellcheck="false" placeholder="Search rule, text, selector, file"><kbd aria-hidden="true">/</kbd></div>
        <div class="seg" role="group" aria-label="Show" id="seg-v"><button type="button" data-b="" aria-pressed="true">All<span class="n"></span></button><button type="button" data-b="fix" aria-pressed="false">Fix in your code<span class="n"></span></button><button type="button" data-b="review" aria-pressed="false">Needs review<span class="n"></span></button><button type="button" data-b="theirs" aria-pressed="false">Not your code<span class="n"></span></button></div>
      </div>
      <details class="filters" id="filters"><summary>Filters and sorting</summary>
        <div class="f-grid">
          <label class="fld"><span>Verdict</span><select id="f-v"></select></label>
          <label class="fld"><span>Owner</span><select id="f-o"></select></label>
          <label class="fld"><span>Impact</span><select id="f-i"></select></label>
          <label class="fld"><span>Layer</span><select id="f-L"></select></label>
          <label class="fld"><span>Rule</span><select id="f-r"></select></label>
          <label class="fld"><span>Page</span><select id="f-p"></select></label>
          <div class="fld chk"><label><input type="checkbox" id="f-src"> Has source</label></div>
          <label class="fld"><span>Sort by</span><select id="f-s"><option value="impact">Impact</option><option value="occ">Occurrences</option><option value="page">Page</option><option value="rule">Rule</option></select></label>
          <label class="fld"><span>Group by</span><select id="f-g"><option value="root">Root cause</option><option value="rule">Rule</option><option value="page">Page</option><option value="file">Source file</option><option value="none">No grouping</option></select></label>
          <div class="f-end"><button type="button" class="btn btn-sm" data-act="help" aria-haspopup="dialog">Keyboard shortcuts <kbd>?</kbd></button></div>
        </div>
      </details>
      <div class="chips" id="chips" aria-label="Active filters"></div>
    </div>
  </div></div>
  <div class="wrap">
    <div class="resultbar" id="result"></div>
    <div id="list"><p class="note">Loading findings</p></div>
  </div>
  <div class="sr" id="live" role="status" aria-live="polite"></div>
  <dialog id="help" aria-labelledby="help-h"><h2 id="help-h">Keyboard shortcuts</h2>
    <dl><dt><kbd>/</kbd></dt><dd>Focus the search box</dd><dt><kbd>j</kbd> <kbd>k</kbd></dt><dd>Next and previous finding</dd><dt><kbd>Enter</kbd> <kbd>Space</kbd></dt><dd>Open or close the focused finding</dd><dt><kbd>Esc</kbd></dt><dd>Clear the search, or leave it</dd><dt><kbd>?</kbd></dt><dd>This list</dd></dl>
    <button type="button" class="btn" data-act="close-help">Close</button></dialog>
  </section>`;
}

function notYourCode(m) {
  if (!m.nyc.length) return '';
  const total = m.nyc.reduce((n, g) => n + g.occurrences, 0);
  const rows = m.nyc.map((g) => `<tr><th scope="row" data-l="Owner">${esc(g.name)}<br><small class="muted">${esc(g.label)}</small></th><td class="num" data-l="Occurrences">${g.occurrences}</td><td data-l="Pages"><span class="pg-list">${g.pages.map(route).join('')}</span></td><td data-l="Rules"><span class="pg-list">${g.rules.map(code).join('')}</span></td><td data-l="Suggested action">${esc(g.action)}</td></tr>`).join('');
  return `<section class="sec" id="not-yours" aria-labelledby="h-nyc"><div class="wrap">
  <h2 id="h-nyc">${icon('external', 24)} Not your code (${total})</h2>
  <p class="lede">Third-party scripts and platform widgets render this markup, so it cannot be fixed in the site source. One row per vendor or component. None of it counts in the quality gate unless <code>gate.countThirdParty</code> or <code>gate.countPlatform</code> is set.</p>
  <table class="tbl"><thead><tr><th scope="col">Owner</th><th scope="col" class="num">Occurrences</th><th scope="col">Pages</th><th scope="col">Rules</th><th scope="col">Suggested action</th></tr></thead><tbody>${rows}</tbody></table>
  </div></section>`;
}

function pagesSection(m) {
  const rows = m.pages.map((p) => `<tr><th scope="row" data-l="Page"><a href="#findings" data-view="p=${p.i}">${wbr(p.route)}</a></th><td data-l="Status">${stateChip(p.status)}</td><td class="num" data-l="Fix in your code">${p.fix}</td><td class="num" data-l="Needs review">${p.review}</td><td class="num" data-l="Not your code">${p.theirs}</td><td data-l="Note">${p.reason ? esc(p.reason) : ''}</td></tr>`).join('');
  return `<section class="sec" id="pages" aria-labelledby="h-pages"><div class="wrap">
  <h2 id="h-pages">Pages</h2>
  <p class="lede">Occurrences per page. Choose a page to list only its findings.</p>
  <table class="tbl"><thead><tr><th scope="col">Page</th><th scope="col">Status</th><th scope="col" class="num">Fix in your code</th><th scope="col" class="num">Needs review</th><th scope="col" class="num">Not your code</th><th scope="col">Note</th></tr></thead><tbody>${rows}</tbody></table>
  </div></section>`;
}

function linksSection(m) {
  if (!m.links.length) return '';
  const row = (l) => `<tr><th scope="row" data-l="Target">${code(l.u)}${/->|Redirect chain/.test(l.chain) ? `<details><summary>Redirect chain</summary><p class="src-how">${code(l.chain)}</p></details>` : ''}</th><td data-l="Status">${esc(l.st || 'n/a')}${l.rs ? `<br><small class="muted">${esc(l.rs)}</small>` : ''}</td><td data-l="Verdict"><span class="chip vd vd-${esc(l.v)}">${esc((VERDICT_TEXT[l.v] || [l.v])[0])}</span></td><td data-l="Pages"><span class="pg-list">${l.pages.map(route).join('')}</span></td><td data-l="Authored at">${l.where.length ? l.where.map((w) => pathHtml(w.replace(/:\d+$/, ''), (w.match(/:(\d+)$/) || [])[1])).join('<br>') : '<span class="muted">not traced</span>'}</td></tr>`;
  const head = '<thead><tr><th scope="col">Target</th><th scope="col">Status</th><th scope="col">Verdict</th><th scope="col">Pages</th><th scope="col">Authored at</th></tr></thead>';
  const first = m.links.slice(0, 60); const rest = m.links.slice(60);
  return `<section class="sec" id="links" aria-labelledby="h-links"><div class="wrap">
  <h2 id="h-links">Links</h2>
  <p class="lede">${plural(m.links.length, 'link target')} reported. Each row is one target with every page that links to it. Blocked or unverifiable responses stay needs review.</p>
  <table class="tbl">${head}<tbody>${first.map(row).join('')}</tbody></table>
  ${rest.length ? `<details class="guide"><summary>${plural(rest.length, 'more target')}</summary><table class="tbl" style="margin-top:0.5rem">${head}<tbody>${rest.map(row).join('')}</tbody></table></details>` : ''}
  </div></section>`;
}

const scoreWord = (n) => (n === null || n === undefined ? '' : n >= 90 ? 'good' : n >= 50 ? 'needs work' : 'poor');
const SCORES = [['performance', 'Performance'], ['accessibility', 'Accessibility'], ['bestPractices', 'Best practices'], ['seo', 'SEO']];
const VITALS = [['largest-contentful-paint', 'LCP'], ['cumulative-layout-shift', 'CLS'], ['total-blocking-time', 'TBT'], ['interaction-to-next-paint', 'INP'], ['first-contentful-paint', 'FCP'], ['speed-index', 'Speed Index']];
function perfSection(m) {
  const at = (k) => { const i = m.pages.findIndex((p) => p.name === k); return i < 0 ? 1e9 : i; };
  const entries = Object.entries(m.lighthouse).sort((a, b) => at(a[0]) - at(b[0]));
  if (!entries.length) return '';
  const table = (key, title) => {
    const rows = entries.filter(([, d]) => d[key]);
    if (!rows.length) return '';
    const vitals = VITALS.filter(([id]) => rows.some(([, d]) => d[key].metrics.some((x) => x.k === id)));
    const head = `<tr><th scope="col">Page</th>${SCORES.map(([, l]) => `<th scope="col" class="num">${l}</th>`).join('')}${vitals.map(([, l]) => `<th scope="col" class="num">${l}</th>`).join('')}</tr>`;
    const body = rows.map(([name, d]) => {
      const x = d[key]; const page = m.pages.find((p) => p.name === name);
      return `<tr><th scope="row" data-l="Page">${wbr(page?.route || name)}</th>${SCORES.map(([k, l]) => `<td class="num" data-l="${l}">${esc(x.scores[k] ?? 'n/a')} <span class="muted">${scoreWord(x.scores[k])}</span></td>`).join('')}${vitals.map(([id, l]) => { const v = x.metrics.find((y) => y.k === id); return `<td class="num" data-l="${l}">${v ? `${esc(v.v)} <span class="muted">${esc(v.rating)}</span>` : 'n/a'}</td>`; }).join('')}</tr>`;
    }).join('');
    const note = rows[0][1][key];
    return `<h3 class="sub">${title}${note.vp ? ` <span class="muted">${esc(note.vp)}</span>` : ''}</h3><div class="tbl-wrap" tabindex="0" role="group" aria-label="${title} scores, scrolls sideways"><table class="tbl tbl-perf"><thead>${head}</thead><tbody>${body}</tbody></table></div>`;
  };
  const sources = new Set(entries.map(([, d]) => (d.source === 'psi-api' ? 'PageSpeed Insights API: comparable to PSI baselines.' : d.fallback ? 'Local Lighthouse fallback: not comparable to PageSpeed Insights.' : 'Local Lighthouse lab runs: not comparable to PageSpeed Insights.')));
  const warns = [...new Set(entries.flatMap(([, d]) => [d.mobile, d.desktop].filter(Boolean).flatMap((x) => x.warn)))];
  return `<section class="sec" id="performance" aria-labelledby="h-perf"><div class="wrap">
  <h2 id="h-perf">Performance</h2>
  <p class="lede">Lighthouse scores and Core Web Vitals per page, mobile and desktop. ${esc([...sources].join(' '))} Lab data from one machine: compare between runs, do not read it as field data.</p>
  ${table('mobile', 'Mobile')}${table('desktop', 'Desktop')}
  ${warns.length ? `<ul class="facts">${warns.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
  </div></section>`;
}

/** Scanner warnings, one line per distinct message with a count (a validation note repeats for every finding). */
function warnings(list) {
  if (!list.length) return '';
  const by = new Map();
  for (const w of list) { const text = typeof w === 'string' ? w : `${w.message || w.type || 'warning'}`; by.set(text, (by.get(text) || 0) + 1); }
  return `<h3 class="sub">Warnings</h3><ul class="facts">${[...by].map(([t, n]) => `<li>${esc(t)}${n > 1 ? ` (${n} times)` : ''}</li>`).join('')}</ul>`;
}

function runSection(m) {
  const k = m.meta;
  const kv = [['Target', k.url], ['Mode', k.mode], ['Build revision', k.revision], ['Scanned', when(k.generatedAt)], ['Tool', k.tool], ['Node', k.node], ['Report id', k.reportId.replace(/^sha256:/, '').slice(0, 16)],
    ['Concurrency', k.concurrency || ''], ['Page work time', k.workMs ? `${dur(k.workMs)} summed over pages${k.wallMs ? '' : ''}` : ''], ['Run duration', dur(k.wallMs)], ['Profiles', (k.profiles || []).join(', ')],
    k.accessScan ? ['AccessScan profile', `${k.accessScan.profile}${k.accessScan.comparator ? `, comparator ${k.accessScan.comparator}` : ''}${k.accessScan.thirdParty ? ', third-party included' : ''}`] : null, ...k.kv].filter((r) => r && r[1] !== '' && r[1] !== undefined);
  const engines = m.engines.map((e) => `<tr><th scope="row" data-l="Engine">${esc(e.name)}</th><td data-l="Layer">${esc(e.layer)}</td><td data-l="Version">${esc(e.version)}</td><td data-l="Runs">${e.complete} complete${e.note ? ` ${esc(e.note)}` : ''}${Object.entries(e.other).map(([s, n]) => `, ${n} ${esc(s)}`).join('')}</td></tr>`).join('');
  const gate = m.gate && m.gate.pages.length ? `<details class="guide"><summary>Quality gate checks per page</summary>${m.w3cNote ? `<p class="src-how">w3c.* checks are fed by: ${esc(m.w3cNote)}</p>` : ''}<table class="tbl" style="margin-top:0.5rem"><thead><tr><th scope="col">Page</th><th scope="col">Check</th><th scope="col">Actual / target</th><th scope="col">Status</th></tr></thead><tbody>${m.gate.pages.flatMap((p) => (p.metrics || []).map((x) => `<tr><th scope="row" data-l="Page">${code(p.name || p.url)}</th><td data-l="Check">${esc(x.id)}</td><td data-l="Actual / target">${esc(x.actual ?? 'n/a')} / ${esc(x.target)}</td><td data-l="Status">${esc(x.status)}${x.reason ? `<br><small class="muted">${esc(x.reason)}</small>` : ''}</td></tr>`).concat(p.excluded ? [`<tr><th scope="row" data-l="Page">${code(p.name || p.url)}</th><td colspan="3">${esc(excludedNote(p.excluded))}</td></tr>`] : [])).join('')}</tbody></table></details>` : '';
  const parity = m.parity?.pages ? `<h3 class="sub">Supplementary: commercial-parity profile</h3><p class="lede">Extra information from a commercial-scanner-style profile. Not counted in the totals, the quality gate or the exit code.</p>${m.parity.pages.flatMap((p) => p.findings.map((f) => `<p>${code(p.url)} ${esc(f.ruleId)} (${esc(f.impact)}) ${code(f.selector)}</p>`)).join('') || '<p>No additional findings.</p>'}` : '';
  return `<section class="sec" id="run" aria-labelledby="h-run"><div class="wrap">
  <h2 id="h-run">Run details</h2>
  <dl class="kv" style="max-width:60rem">${kv.map(([a, b]) => `<dt>${esc(a)}</dt><dd>${/^(Target|Build revision|Report id)$/.test(a) ? code(b) : esc(b)}</dd>`).join('')}</dl>
  ${warnings(m.meta.warnings)}
  <h3 class="sub">Engines</h3>
  <table class="tbl"><thead><tr><th scope="col">Engine</th><th scope="col">Layer</th><th scope="col">Version</th><th scope="col">Runs</th></tr></thead><tbody>${engines}</tbody></table>
  ${gate}${parity}
  </div></section>`;
}

export function buildReportHtml(input) {
  const m = buildModel(input);
  const host = (() => { try { return new URL(m.meta.url).host; } catch { return m.meta.url || 'Scan report'; } })();
  const nav = [['overview', 'Overview', ''], ['findings', 'Findings', m.counts.findings], ['not-yours', 'Not your code', m.nyc.length ? m.counts.theirs : ''], ['coverage', 'Coverage', ''], ['pages', 'Pages', m.pages.length], ['links', 'Links', m.links.length || ''], ['performance', 'Performance', ''], ['run', 'Run details', '']]
    .filter(([id]) => (id !== 'not-yours' || m.nyc.length) && (id !== 'links' || m.links.length) && (id !== 'performance' || Object.keys(m.lighthouse).length));
  const data = pack({
    f: m.findings, p: m.pages.map((p) => ({ route: p.route, url: p.url })), m: { url: m.meta.url, tool: m.meta.tool }, sm: m.sourceMethods,
  });
  const body = `<a class="skip" href="#main">Skip to the report</a>
<header class="top"><div class="wrap">
  <div class="top-row"><h1>Accessibility scan <span>${wbr(host)}</span></h1>
  ${THEME_TOGGLE_HTML}</div>
  <p class="top-meta"><span>${esc(when(m.meta.generatedAt))}</span>${m.meta.tool ? `<span>${esc(m.meta.tool)}</span>` : ''}<span>${esc(plural(m.pages.length, 'page'))}</span>${m.meta.mode ? `<span>${esc(m.meta.mode)}</span>` : ''}${m.meta.revision ? `<span class="long">${wbr(m.meta.revision.slice(0, 24))}</span>` : ''}</p>
  <p class="verdict-line">${esc(verdictLine(m))}</p>
  <nav class="nav" aria-label="Report sections">${nav.map(([id, label, n]) => `<a href="#${id}">${esc(label)}${n !== '' ? `<small>${esc(n)}</small>` : ''}</a>`).join('')}</nav>
</div></header>
<main id="main" tabindex="-1">
${overview(m)}
${findingsSection(m)}
${notYourCode(m)}
${coverage(m)}
${pagesSection(m)}
${linksSection(m)}
${perfSection(m)}
${runSection(m)}
</main>
<footer class="foot"><div class="wrap"><p>Generated by ${esc(m.meta.tool || 'ada-scan')}. ${esc(wcagCoverageSentence())} Manual review is still required.</p></div></footer>`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
${cspMeta({ scriptSha256: [sha(THEME_INIT), sha(CLIENT)] })}
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Scan report: ${esc(host)} (${esc(when(m.meta.generatedAt))})</title>
<style>${CSS}</style>
</head>
<body>
<script>${THEME_INIT}</script>
${body}
<script type="application/json" id="report-data">${safeJson(data)}</script>
<script>${CLIENT}</script>
</body>
</html>
`;
}
