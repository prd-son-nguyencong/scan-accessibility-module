/* Findings explorer for the scan report. Runs from the inline script the page's CSP hash allows; no network, no eval, no inline handlers.
   All text reaches the page as text nodes (createTextNode), never as parsed markup. */
(() => {
  'use strict';
  const raw = JSON.parse(document.getElementById('report-data').textContent);
  const table = raw.t;
  const unpack = (x) => {
    if (typeof x === 'string') return x.charCodeAt(0) === 126 ? (x.charCodeAt(1) === 126 ? x.slice(1) : table[+x.slice(1)]) : x;
    if (Array.isArray(x)) return x.map(unpack);
    if (x && typeof x === 'object') { const o = {}; for (const k in x) o[k] = unpack(x[k]); return o; }
    return x;
  };
  const D = unpack(raw.d);
  const F = D.f; const P = D.p;
  const NOT_YOURS = ['third-party', 'platform', 'iframe'];
  for (const f of F) f.b = NOT_YOURS.includes(f.o) ? 'theirs' : (f.v === 'needs-review' || (f.o !== 'site' && f.o !== 'injected') ? 'review' : 'fix');
  const IMP = ['critical', 'serious', 'moderate', 'minor', 'info'];
  const IMP_RANK = { critical: 5, serious: 4, moderate: 3, minor: 2, info: 1 };
  const IMP_LABEL = { critical: 'Critical', serious: 'Serious', moderate: 'Moderate', minor: 'Minor', info: 'Info' };
  const VERDICT = { confirmed: ['Confirmed', 'measured, a person does not need to decide'], likely: ['Likely', 'heuristic, probably a defect'], 'needs-review': ['Needs review', 'a person has to look'] };
  const OWNER = { site: 'Site code', injected: 'Injected at runtime', unbound: 'Platform data not bound', unknown: 'Origin unknown', 'third-party': 'Third party', platform: 'Platform', iframe: 'iframe' };
  const OWNER_WHY = {
    site: 'Rendered from this project\'s own templates.',
    injected: 'Added to the page by a script at run time; the served HTML does not contain it.',
    unbound: 'Platform data is not bound in the local render, so the element is a placeholder here. The live page may differ.',
    unknown: 'The origin probe failed, so ownership could not be established. Treated as needs review.',
    'third-party': 'Rendered by a third-party script. It cannot be fixed in the site source.',
    platform: 'Rendered by a platform widget. It cannot be fixed in the site source.',
    iframe: 'Lives inside an iframe, outside this document\'s source.',
  };
  const LAYER = { accessScan: 'AccessScan', axe: 'axe-core', htmlValidate: 'html-validate', w3c: 'W3C Nu', links: 'Links', keyboard: 'Keyboard', focusTrap: 'Focus trap', screenReader: 'Screen reader', lighthouse: 'Lighthouse', dynamicContent: 'Dynamic content', ariaLive: 'aria-live' };
  const CONF = { high: 'exact', medium: 'likely', low: 'possible', none: 'none' };
  const DEF = { q: '', b: '', v: '', o: '', i: '', L: '', r: '', p: '', src: '', s: 'impact', g: 'root', f: '' };
  const PAGE_STEP = 100;
  const $ = (s, r = document) => r.querySelector(s);

  const h = (tag, props, ...kids) => {
    const e = document.createElement(tag);
    for (const k in props || {}) {
      const v = props[k];
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') e.className = v; else if (k === 'text') e.textContent = v; else e.setAttribute(k, v === true ? '' : v);
    }
    for (const c of kids.flat()) if (c !== undefined && c !== null && c !== false) e.append(c.nodeType ? c : document.createTextNode(String(c)));
    return e;
  };
  // Break opportunities for code-like strings only (paths, selectors, URLs): after / . - _ : ? & = # > + ~ , [ ] ( ) * "
  const breakable = (s) => {
    const out = document.createDocumentFragment();
    String(s).replace(/([a-z0-9])(?=[A-Z][a-z])/g, '$1\u0001').split(/([/._\-:?&=#%>+~,[\]()*"]+|\u0001)/).forEach((part, i) => { if (part !== '\u0001') out.append(document.createTextNode(part)); if (i % 2) out.append(document.createElement('wbr')); });
    return out;
  };
  // Prose with a long token in it (a URL quoted in a scanner message): only that token gets break opportunities.
  const prose = (s) => {
    const out = document.createDocumentFragment();
    // `code` in scanner text becomes <code>; only a long token outside it gets break opportunities
    String(s ?? '').split(/(`[^`]+`)/).forEach((seg) => {
      if (seg.length > 2 && seg[0] === '`' && seg.endsWith('`')) { out.append(h('code', null, breakable(seg.slice(1, -1)))); return; }
      seg.split(/(\s+)/).forEach((t) => out.append(t.length >= 28 ? breakable(t) : document.createTextNode(t)));
    });
    return out;
  };
  const chevron = () => {
    const ns = 'http://www.w3.org/2000/svg'; const svg = document.createElementNS(ns, 'svg');
    for (const [k, v] of Object.entries({ width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' })) svg.setAttribute(k, v);
    const path = document.createElementNS(ns, 'path'); path.setAttribute('d', 'M5 8l7 7 7-7'); svg.append(path);
    return h('span', { class: 'chev' }, svg);
  };
  const code = (s, cls) => h('code', { class: cls }, breakable(s));
  const pathEl = (file, line) => {
    const i = file.lastIndexOf('/');
    return h('span', { class: 'path mono' }, h('span', { class: 'dir' }, breakable(file.slice(0, i + 1))), h('span', { class: 'base' }, breakable(file.slice(i + 1) + (line ? `:${line}` : ''))));
  };
  const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || `${one}s`)}`;
  const srcLabel = (f) => (f.s && f.s.f ? `${f.s.f}${f.s.l ? `:${f.s.l}` : ''}` : '');
  const pageRoute = (i) => (P[i] ? P[i].route : '');
  const impChip = (i) => h('span', { class: `chip imp imp-${i}` }, h('span', { class: 'meter', 'aria-hidden': 'true' }, [0, 1, 2, 3].map((n) => h('b', { class: n < (IMP_RANK[i] || 1) - 1 ? 'on' : null }))), IMP_LABEL[i] || i);

  // ---------- state ----------
  let st = { ...DEF };
  let limit = PAGE_STEP;
  const open = new Set();
  const els = { q: $('#q'), live: $('#live'), list: $('#list'), result: $('#result'), chips: $('#chips'), filters: $('#filters'), help: $('#help'), seg: $('#seg-v') };
  const BUCKET = { fix: 'Fix in your code', review: 'Needs review', theirs: 'Not your code' };
  const sel = { v: $('#f-v'), o: $('#f-o'), i: $('#f-i'), L: $('#f-L'), r: $('#f-r'), p: $('#f-p'), s: $('#f-s'), g: $('#f-g') };
  const srcBox = $('#f-src');

  const parseParams = (str) => {
    const p = new URLSearchParams(str); const o = { ...DEF };
    for (const k in DEF) if (p.has(k)) o[k] = p.get(k);
    return o;
  };
  const toParams = () => { const p = new URLSearchParams(); for (const k in DEF) if (st[k] !== DEF[k]) p.set(k, st[k]); return p.toString(); };
  const readHash = () => { const h0 = location.hash.slice(1); const i = h0.indexOf('?'); return i >= 0 ? parseParams(h0.slice(i + 1)) : null; };
  const writeHash = (section) => {
    const s = toParams(); const cur = location.hash.slice(1).split('?')[0];
    const id = section || (cur && !cur.includes('=') ? cur : 'findings');
    const next = s ? `#${id}?${s}` : (section ? `#${section}` : (location.hash.includes('?') ? '' : location.hash));
    try { history.replaceState(null, '', location.pathname + location.search + next); } catch (e) { /* file:// in some browsers */ }
  };

  // ---------- filtering ----------
  const hay = (f) => f._h || (f._h = [f.r, f.cr, f.y, f.h, f.m, f.sel, srcLabel(f), f.ol, pageRoute(f.p), f.w, f.wt, f.html, (f.pr || []).map((p) => p.fact).join(' ')].join('\n').toLowerCase());
  const matches = (f, skip) => {
    if (skip !== 'b' && st.b && f.b !== st.b) return false;
    if (skip !== 'v' && st.v && f.v !== st.v) return false;
    if (skip !== 'o' && st.o && f.o !== st.o) return false;
    if (skip !== 'i' && st.i && f.i !== st.i) return false;
    if (skip !== 'L' && st.L && f.L !== st.L && !(f.Ls && f.Ls.includes(st.L))) return false;
    if (skip !== 'r' && st.r && f.r !== st.r) return false;
    if (skip !== 'p' && st.p !== '' && !(String(f.p) === st.p || (f.pg && f.pg.includes(+st.p)))) return false;
    if (skip !== 'src' && st.src && !(f.s && f.s.f)) return false;
    if (skip !== 'q' && st.q) { const h0 = hay(f); for (const t of st.q.toLowerCase().split(/\s+/)) if (t && !h0.includes(t)) return false; }
    return true;
  };
  const tally = (key, skip, valueOf) => { const m = new Map(); for (const f of F) if (matches(f, skip)) { const v = valueOf(f); for (const x of Array.isArray(v) ? v : [v]) m.set(x, (m.get(x) || 0) + 1); } return m; };

  // ---------- grouping ----------
  const impRank = (f) => IMP_RANK[f.i] || 0;
  const itemCmp = () => {
    if (st.s === 'occ') return (a, b) => b.n - a.n || impRank(b) - impRank(a);
    if (st.s === 'page') return (a, b) => a.p - b.p || impRank(b) - impRank(a) || b.n - a.n;
    if (st.s === 'rule') return (a, b) => a.r.localeCompare(b.r) || impRank(b) - impRank(a);
    return (a, b) => impRank(b) - impRank(a) || b.n - a.n || a.r.localeCompare(b.r);
  };
  const groupKey = (f) => {
    if (st.g === 'none') return 'all';
    if (st.g === 'rule') return f.r;
    if (st.g === 'page') return String(f.p);
    if (st.g === 'file') return (f.s && f.s.f) || (f.o !== 'site' ? `~${f.ol}` : '~none');
    return f.rk;
  };
  function blocks(list) {
    const map = new Map();
    for (const f of list) { const k = groupKey(f); let g = map.get(k); if (!g) { g = { key: k, items: [], occ: 0, imp: 0, pages: new Set(), pmin: 1e9 }; map.set(k, g); } g.items.push(f); g.occ += f.n; g.imp = Math.max(g.imp, impRank(f)); g.pages.add(f.p); g.pmin = Math.min(g.pmin, f.p); }
    const cmp = itemCmp();
    const gs = [...map.values()];
    for (const g of gs) g.items.sort(cmp);
    const first = (g) => g.items[0];
    if (st.s === 'occ') gs.sort((a, b) => b.occ - a.occ || b.imp - a.imp);
    else if (st.s === 'page') gs.sort((a, b) => a.pmin - b.pmin || b.imp - a.imp);
    else if (st.s === 'rule') gs.sort((a, b) => first(a).r.localeCompare(first(b).r) || b.imp - a.imp);
    else gs.sort((a, b) => b.imp - a.imp || b.occ - a.occ || first(a).r.localeCompare(first(b).r));
    return gs;
  }

  // ---------- rendering ----------
  function rowEl(f, level) {
    const id = `d-${f.k}`;
    const where = f.s && f.s.f
      ? [pathEl(f.s.f, f.s.l), f.s.c === 'low' || f.s.c === 'medium' ? h('span', { class: 'pg' }, `source match: ${CONF[f.s.c]}`) : null]
      : [h('span', { class: 'none' }, f.o === 'site' || f.o === 'injected' || f.o === 'unbound' || f.o === 'unknown' ? 'Source not found: locate manually' : 'Not in your source')];
    const route = pageRoute(f.p) + (f.pg ? ` +${f.pg.length} more` : '');
    const btn = h('button', { type: 'button', class: 'row-btn', 'aria-expanded': open.has(f.k) ? 'true' : 'false', 'aria-controls': id, 'data-k': f.k },
      h('span', { class: 'c-imp' }, impChip(f.i)),
      h('span', { class: 'c-main' },
        h('span', { class: 'c-rule' }, code(f.r)),
        h('span', { class: 'c-why' }, prose(f.y || f.h || '')),
        h('span', { class: 'c-tags' },
          h('span', { class: `chip vd vd-${f.v}` }, (VERDICT[f.v] || [f.v])[0]),
          h('span', { class: `chip own${f.o === 'third-party' || f.o === 'platform' || f.o === 'iframe' ? ' own-theirs' : ''}` }, f.ol),
          f.w ? h('span', { class: 'chip tag' }, `WCAG ${f.w}`) : null,
          f.E && f.E.length > 1 ? h('span', { class: 'chip tag' }, `${f.E.length} engines agree`) : null)),
      h('span', { class: 'c-where' }, where, h('span', { class: 'pg' }, route)),
      h('span', { class: 'c-n' }, `×${f.n}`, h('small', null, f.n === 1 ? 'occurrence' : 'occurrences')),
      chevron());
    const li = h('li', { class: 'row', id: `f-${f.id}`, 'data-k': f.k }, h(level, { class: 'row-h' }, btn), h('div', { class: 'detail', id, hidden: !open.has(f.k) }));
    if (open.has(f.k)) fillDetail(li.lastChild, f);
    return li;
  }

  function groupHead(g) {
    const f0 = g.items[0]; const n = g.items.length; const meta = `${plural(n, 'finding')} · ${plural(g.occ, 'occurrence')} · ${plural(g.pages.size, 'page')}`;
    let title; let note = null;
    if (st.g === 'rule') { title = [code(f0.r), f0.y ? h('span', { class: 'gm' }, f0.y) : null]; }
    else if (st.g === 'page') { title = [h('span', null, pageRoute(f0.p) || '(page)')]; }
    else if (st.g === 'file') { title = g.key.charAt(0) === '~' ? [h('span', null, g.key === '~none' ? 'No source file found: locate manually' : `Not your source: ${g.key.slice(1)}`)] : [pathEl(g.key, 0)]; }
    else {
      const src = srcLabel(f0);
      title = src ? [pathEl(f0.s.f, f0.s.l)] : [code(f0.r)];
      const rules = [...new Set(g.items.map((x) => x.r))];
      note = src ? `One change at this location addresses all ${n} findings (${rules.length === 1 ? rules[0] : plural(rules.length, 'rule')}).` : `Same root cause: ${f0.ol}, rule ${f0.r}.`;
    }
    return [h('h3', { class: 'grp-h', id: `g-${Math.random().toString(36).slice(2, 8)}` }, h('span', { class: 'gt' }, title), h('span', { class: 'gm' }, meta)), note ? h('p', { class: 'grp-note' }, note) : null];
  }

  let rendered = 0; let remaining = 0; let current = [];
  function render(keepScroll) {
    const list = F.filter((f) => matches(f));
    current = list;
    const gs = blocks(list);
    const frag = document.createDocumentFragment();
    let budget = limit; rendered = 0;
    const grouped = !(st.g === 'none');
    for (const g of gs) {
      if (budget <= 0) break;
      const single = st.g === 'root' && g.items.length === 1;
      const level = grouped && !single ? 'h4' : 'h3';
      const items = g.items.slice(0, budget);
      const ul = h('ul', { class: 'rows', role: 'list' }, items.map((f) => rowEl(f, level)));
      budget -= items.length; rendered += items.length;
      if (single || !grouped) frag.append(h('div', { class: 'grp' }, ul));
      else {
        const [head, note] = groupHead(g);
        const sec = h('div', { class: 'grp' }, head, note, ul);
        if (items.length < g.items.length) sec.append(h('p', { class: 'grp-note' }, `${g.items.length - items.length} more in this group below the limit`));
        frag.append(sec);
      }
    }
    remaining = list.length - rendered;
    els.list.replaceChildren(frag);
    if (!list.length) {
      els.list.replaceChildren(h('div', { class: 'empty' }, h('h3', null, 'No findings match these filters'),
        h('p', null, F.length ? 'Remove a filter or change the search text. Every filter is shown as a chip above the list.' : 'This scan reported no findings. That is not a pass: see Coverage in the overview for pages that were not scanned.'),
        F.length ? h('button', { type: 'button', class: 'btn btn-primary', 'data-act': 'reset' }, 'Clear all filters') : null));
    } else if (remaining > 0) {
      els.list.append(h('div', { class: 'more' }, h('span', null, `${rendered} of ${list.length} findings shown`), h('button', { type: 'button', class: 'btn', 'data-act': 'more' }, `Show ${Math.min(PAGE_STEP, remaining)} more`), h('button', { type: 'button', class: 'btn', 'data-act': 'all' }, 'Show all')));
    }
    summary(list); facets(); chips();
    if (!keepScroll) writeHash();
  }

  const occOf = (l) => l.reduce((n, f) => n + f.n, 0);
  let liveTimer = 0;
  function summary(list) {
    const filtered = list.length !== F.length;
    const text = `${plural(list.length, 'finding')}${filtered ? ` of ${F.length}` : ''} · ${plural(occOf(list), 'occurrence')}`;
    els.result.replaceChildren(h('strong', null, text), h('span', null, `Sorted by ${$('#f-s').selectedOptions[0].textContent.toLowerCase()}, grouped by ${$('#f-g').selectedOptions[0].textContent.toLowerCase()}`));
    clearTimeout(liveTimer);
    liveTimer = setTimeout(() => { els.live.textContent = `${list.length} of ${F.length} findings shown`; }, 350);
  }

  const labelFor = { o: (v) => OWNER[v] || v, i: (v) => IMP_LABEL[v] || v, L: (v) => LAYER[v] || v, v: (v) => (VERDICT[v] ? VERDICT[v][0] : v), r: (v) => v, p: (v) => pageRoute(+v) };
  function facets() {
    const bc = tally('b', 'b', (f) => f.b);
    els.seg.querySelectorAll('button').forEach((b) => { const v = b.dataset.b; const n = v ? (bc.get(v) || 0) : [...bc.values()].reduce((a, c) => a + c, 0); b.setAttribute('aria-pressed', String((st.b || '') === v)); $('.n', b).textContent = n; });
    const upd = (key, vals, valueOf, label) => {
      const m = tally(key, key, valueOf); const s = sel[key];
      if (!s.dataset.built) { s.append(h('option', { value: '' }, 'All')); vals.forEach((v) => s.append(h('option', { value: v }, ''))); s.dataset.built = '1'; }
      [...s.options].forEach((o) => { if (o.value === '') { o.textContent = `All (${F.filter((f) => matches(f, key)).length})`; return; } o.textContent = `${label(o.value)} (${m.get(o.value) || 0})`; });
      s.value = st[key];
    };
    const uniq = (f) => [...new Set(F.map(f).flat().filter((x) => x !== undefined))];
    upd('v', Object.keys(VERDICT).filter((k) => F.some((f) => f.v === k)), (f) => f.v, labelFor.v);
    upd('o', Object.keys(OWNER).filter((k) => F.some((f) => f.o === k)), (f) => f.o, labelFor.o);
    upd('i', IMP.filter((k) => F.some((f) => f.i === k)), (f) => f.i, labelFor.i);
    upd('L', uniq((f) => [f.L, ...(f.Ls || [])]).sort(), (f) => [f.L, ...(f.Ls || [])], labelFor.L);
    upd('r', uniq((f) => f.r).sort(), (f) => f.r, labelFor.r);
    upd('p', P.map((_, i) => String(i)), (f) => [String(f.p), ...(f.pg || []).map(String)], labelFor.p);
    srcBox.checked = !!st.src;
    els.q.value = st.q; sel.s.value = st.s; sel.g.value = st.g;
  }

  function chips() {
    const out = [];
    const chip = (key, name, value) => out.push(h('button', { type: 'button', 'data-rm': key, 'aria-label': `Remove filter ${name}: ${value}` }, h('span', null, `${name}:`), h('b', null, value), h('i', { 'aria-hidden': 'true' }, '×')));
    if (st.q) chip('q', 'Search', st.q);
    if (st.b) chip('b', 'Show', BUCKET[st.b] || st.b);
    if (st.v) chip('v', 'Verdict', labelFor.v(st.v));
    if (st.o) chip('o', 'Owner', labelFor.o(st.o));
    if (st.i) chip('i', 'Impact', labelFor.i(st.i));
    if (st.L) chip('L', 'Layer', labelFor.L(st.L));
    if (st.r) chip('r', 'Rule', st.r);
    if (st.p !== '') chip('p', 'Page', labelFor.p(st.p));
    if (st.src) chip('src', 'Has source', 'yes');
    if (out.length > 1) out.push(h('button', { type: 'button', 'data-act': 'reset', 'aria-label': 'Clear all filters' }, h('b', null, 'Clear all')));
    els.chips.replaceChildren(...out);
  }

  // ---------- detail ----------
  const copyIcon = () => { const ns = 'http://www.w3.org/2000/svg'; const svg = document.createElementNS(ns, 'svg'); for (const [k, v] of Object.entries({ width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' })) svg.setAttribute(k, v); const r = document.createElementNS(ns, 'rect'); for (const [k, v] of Object.entries({ x: 9, y: 9, width: 11, height: 11, rx: 2 })) r.setAttribute(k, v); const p = document.createElementNS(ns, 'path'); p.setAttribute('d', 'M5 15V6a2 2 0 0 1 2-2h8'); svg.append(r, p); return svg; };
  const copyBtn = (label, text, what) => h('button', { type: 'button', class: 'btn btn-sm', 'data-copy': text, 'data-what': what || label }, copyIcon(), label);
  function codeBlock(text, opts = {}) { return h('pre', { class: `codebox${opts.wrap ? ' wrap-code' : ''}`, tabindex: '0', role: 'group', 'aria-label': opts.label || 'Code' }, h('code', { class: 'mono' }, opts.wrap ? breakable(text) : text)); }
  function snippet(sn) {
    const lines = sn.split('\n').map((ln) => { const hit = ln.startsWith('>'); return h('span', { class: hit ? 'hl' : null }, ln.replace(/^[> ]\s?/, '') || ' '); });
    return h('pre', { class: 'codebox lines', tabindex: '0', role: 'group', 'aria-label': 'Source lines around the finding; the flagged line is highlighted' }, h('code', { class: 'mono' }, lines));
  }
  function proofFact(p) {
    if (p.t === 'http-status' && / -> |; GET:|; HEAD:/.test(p.fact)) {
      const parts = p.fact.split(/;\s+(?=(?:HEAD|GET):)/);
      return h('div', null, h('p', null, prose(parts[0].split('. Redirect chain:')[0])), h('ul', null, parts.map((x, i) => h('li', null, code(i === 0 ? x.split('Redirect chain:')[1] || x : x)))));
    }
    return h('p', null, prose(p.fact));
  }
  function aiPrompt(f) {
    const pg = P[f.p] || {};
    const L = [];
    const own = f.o;
    L.push(`Fix this accessibility finding reported by ada-scan${D.m.tool ? ` (${D.m.tool})` : ''}.`, '');
    L.push(`Site: ${D.m.url || 'unknown'}`, `Page: ${pg.route || ''}${pg.url ? ` (${pg.url})` : ''}${f.pg ? `; also on ${f.pg.map(pageRoute).join(', ')}` : ''}`);
    L.push(`Rule: ${f.r}${f.cr && f.cr !== f.r ? ` (${f.cr})` : ''} | impact: ${f.i} | verdict: ${(VERDICT[f.v] || [f.v])[0]} | detected by: ${(f.E && f.E.length ? f.E : [f.L]).join(', ')}`);
    if (f.w) L.push(`WCAG: ${f.w}${f.wt ? ` ${f.wt}` : ''}`);
    L.push(`Owner: ${f.ol}${own === 'third-party' || own === 'platform' ? ' (not site code: propose a configuration or vendor-side mitigation, do not patch vendor files)' : ''}`, '');
    L.push(`Problem: ${f.m || f.h || f.y}`);
    if (f.h && f.h !== f.m) L.push(`Hint: ${f.h}`);
    if (f.pr && f.pr.length) L.push('Proof (measured by the scanner):', ...f.pr.map((p) => `- ${p.fact}`));
    if (f.sel) L.push('', `Element selector: ${f.sel}`);
    if (f.html) L.push('Element HTML:', '```html', f.html, '```');
    if (f.xs && f.xs.length) L.push(`Other affected elements (${f.xs.length}${f.xm ? '+' : ''}): ${f.xs.slice(0, 6).join(' | ')}`);
    L.push('');
    if (f.s && f.s.f) {
      L.push(`Source: ${srcLabel(f)} (${CONF[f.s.c] || f.s.c || 'unknown'} confidence, ${D.sm[f.s.m] || f.s.m || 'method unknown'})`);
      if (f.s.df) L.push(`Data file: ${f.s.df}${f.s.dl ? `:${f.s.dl}` : ''}`);
      if (f.s.ts) L.push(`Template: ${f.s.ts}`);
      if (f.sc && f.sc.length) L.push(`Other candidates: ${f.sc.map((c) => `${c.f}${c.l ? `:${c.l}` : ''}`).join(', ')}`);
      if (f.s.sn) L.push('Source context (">" marks the flagged line):', '```', f.s.sn, '```');
    } else L.push('Source: not located automatically. Search the repository for the element HTML above (text, classes, ids) and fix it where it is authored.');
    if (f.n > 1 || (f.ss && f.ss[0] > 1)) L.push(`This root cause has ${f.ss ? `${f.ss[0]} findings on ${f.ss[1]} pages` : `${f.n} occurrences`}: fix it once at the shared source.`);
    L.push('', `Expected result: "${f.r}" no longer reports this element on ${pg.route || 'the page'}${f.w ? ` and WCAG ${f.w} is met` : ''}. Keep the change minimal, do not change unrelated markup or visual design, do not edit generated or vendor files, and re-run ada-scan on the page to confirm.`);
    return L.join('\n');
  }
  const sec = (title, ...kids) => h('section', { class: 'd-sec' }, h('p', { class: 'd-title' }, title), ...kids);
  function fillDetail(box, f) {
    if (box.dataset.ready) return;
    box.dataset.ready = '1';
    const actions = h('div', { class: 'd-actions' },
      f.s && f.s.f ? copyBtn('Copy path:line', srcLabel(f), 'source path') : null,
      f.sel ? copyBtn('Copy selector', f.sel, 'selector') : null,
      f.html ? copyBtn('Copy element HTML', f.html, 'element HTML') : null,
      h('button', { type: 'button', class: 'btn btn-sm btn-primary', 'data-prompt': f.k }, copyIcon(), 'Copy as AI prompt'),
      copyBtn('Copy link', '', 'link'));
    actions.lastChild.dataset.link = f.id;
    // left column: what and why
    const left = h('div', { class: 'd-col' });
    left.append(sec('What is wrong', h('p', null, prose(f.m || f.h || f.y)), f.m && f.h && f.h !== f.m ? h('p', null, prose(f.h)) : null,
      f.det ? h('p', { class: 'src-how' }, 'The scanner can generate a deterministic fix for this rule.') : null));
    if (f.cp && f.cp.re || f.w) left.append(sec('Why it matters', f.cp && f.cp.re ? h('p', null, prose(f.cp.re)) : null,
      f.w ? h('p', null, f.wu ? h('a', { href: f.wu, target: '_blank', rel: 'noopener' }, `WCAG ${f.w} ${f.wt || ''} (Understanding)`) : `WCAG ${f.w} ${f.wt || ''}`) : null));
    if (f.pr && f.pr.length) left.append(sec('Proof', h('ul', null, f.pr.map((p) => h('li', null, proofFact(p))))));
    else left.append(sec('Proof', h('p', { class: 'src-how' }, f.v === 'confirmed' ? 'No measured value recorded.' : 'No measured proof: this is why the verdict is not confirmed.')));
    if (f.mc) left.append(sec('Manual checks', h('ul', null, f.mc.map((m) => h('li', null, m)))));
    if (f.dm) left.append(sec('Demoted', h('p', null, f.dm)));
    // right column: where
    const right = h('div', { class: 'd-col' });
    if (f.s && f.s.f) {
      const s = f.s;
      right.append(sec('Source', h('div', { class: 'src-main' }, pathEl(s.f, s.l), h('span', { class: `chip tag` }, `${CONF[s.c] || s.c || 'unverified'} match`)),
        h('p', { class: 'src-how' }, `Found by: ${D.sm[s.m] || s.m || 'unknown method'}${s.tr ? `. ${s.tr}` : ''}`),
        s.df ? h('p', { class: 'src-how' }, 'Data file: ', pathEl(s.df, s.dl), s.da ? ' (the same value is in several data files; this one is not certain)' : '') : null,
        s.ts ? h('p', { class: 'src-how' }, 'Template: ', pathEl(s.ts, 0)) : null,
        s.sn ? snippet(s.sn) : null,
        f.sc && f.sc.length ? h('div', null, h('p', { class: 'd-h' }, 'Other candidates'), h('ul', null, f.sc.map((c) => h('li', null, pathEl(c.f, c.l), ` (${CONF[c.c] || c.c || 'candidate'})`)))) : null));
    } else if (f.o === 'third-party' || f.o === 'platform' || f.o === 'iframe') {
      right.append(sec('Source', h('div', { class: 'locate' }, h('strong', null, 'Not in your source'), h('p', null, f.oa || OWNER_WHY[f.o]))));
    } else {
      right.append(sec('Source', h('div', { class: 'locate' }, h('strong', null, 'Not traced: locate manually'),
        h('p', null, `Open ${pageRoute(f.p) || 'the page'} and search the project for the element text, class or id shown below.${f.o === 'unbound' ? ' This node comes from platform data that is not bound in the local render.' : ''}`),
        f.sc && f.sc.length ? h('ul', null, f.sc.map((c) => h('li', null, pathEl(c.f, c.l), ` (${CONF[c.c] || c.c || 'candidate'})`))) : null)));
    }
    right.append(sec('Owner', h('p', null, h('strong', null, f.ol), ' ', OWNER_WHY[f.o] || ''), f.oe ? h('ul', null, f.oe.map((e) => h('li', null, e))) : null, f.o === 'third-party' || f.o === 'platform' ? h('p', null, f.oa) : null));
    const els2 = [];
    if (f.sel) els2.push(h('p', { class: 'd-h' }, 'Selector'), codeBlock(f.sel, { wrap: true, label: 'Selector' }));
    if (f.html) els2.push(h('p', { class: 'd-h' }, 'Element HTML'), codeBlock(f.html, { label: 'Element HTML' }));
    if (f.xs) els2.push(h('p', { class: 'd-h' }, `${f.n} occurrences. Other elements`), h('ul', null, f.xs.map((x) => h('li', null, code(x)))), f.xm ? h('p', { class: 'src-how' }, `and ${f.xm} more`) : null);
    if (els2.length) right.append(sec('Element', ...els2));
    if (f.cp && (f.cp.ax || f.cp.sz)) right.append(sec('Measured on the page', h('dl', { class: 'kv' }, f.cp.ax ? [h('dt', null, 'Accessible name'), h('dd', null, f.cp.ax)] : null, f.cp.sz ? [h('dt', null, 'Size'), h('dd', null, f.cp.sz)] : null, f.cp.vp ? [h('dt', null, 'Viewport'), h('dd', null, f.cp.vp)] : null)));
    if (f.cp && f.cp.shot) right.append(sec('Screenshot', h('img', { class: 'shot', src: f.cp.shot[0], loading: 'lazy', width: f.cp.shot[1], height: f.cp.shot[2], alt: `Screenshot of the flagged element for ${f.r}, outlined` })));
    const pages = [f.p, ...(f.pg || [])];
    right.append(sec('Detected by', h('p', null, (f.E && f.E.length ? f.E : [f.L]).map((e) => LAYER[e] || e).join(', '), f.ag ? ` (${f.ag})` : ''),
      h('p', { class: 'src-how' }, `Rule ${f.r}${f.cr && f.cr !== f.r ? `, canonical ${f.cr}` : ''}`)));
    right.append(sec(`On ${plural(pages.length, 'page')}`, h('p', { class: 'pg-list' }, pages.map((i) => code(pageRoute(i)))), f.ss ? h('p', { class: 'src-how' }, `The same source line is behind ${plural(f.ss[0], 'finding')} on ${plural(f.ss[1], 'page')}.`) : null));
    box.replaceChildren(actions, h('div', { class: 'd-grid' }, left, right));
  }

  function toggle(k, force) {
    const f = F[k]; const li = els.list.querySelector(`li.row[data-k="${k}"]`); if (!li) return;
    const btn = $('.row-btn', li); const box = $('.detail', li);
    const want = force === undefined ? !open.has(k) : force;
    if (want) { open.add(k); fillDetail(box, f); } else open.delete(k);
    btn.setAttribute('aria-expanded', String(want)); box.hidden = !want;
    st.f = want ? f.id : (st.f === f.id ? '' : st.f);
    writeHash();
  }

  // ---------- actions ----------
  let copyTimer = 0;
  function announce(msg) { els.live.textContent = ''; setTimeout(() => { els.live.textContent = msg; }, 30); clearTimeout(copyTimer); copyTimer = setTimeout(() => { els.live.textContent = ''; }, 3000); }
  function copyText(text, what, btn) {
    const done = () => { announce(`Copied ${what}`); if (btn) { const t = btn.lastChild; const old = t.textContent; t.textContent = 'Copied'; setTimeout(() => { t.textContent = old; }, 1400); } };
    const fallback = () => { const t = h('textarea', { 'aria-hidden': 'true', class: 'sr', tabindex: '-1' }); t.value = text; document.body.append(t); t.select(); try { document.execCommand('copy'); done(); } catch (e) { announce('Copy failed: select the text manually'); } t.remove(); };
    if (navigator.clipboard && window.isSecureContext !== false) navigator.clipboard.writeText(text).then(done, fallback); else fallback();
  }
  const setState = (next, section) => { st = { ...DEF, ...next }; limit = PAGE_STEP; render(); if (section) { const e = document.getElementById(section); if (e) e.scrollIntoView({ behavior: 'auto', block: 'start' }); } };
  function reveal(id, focus) {
    let f = F.find((x) => x.id === id); if (!f) return;
    if (!matches(f)) { st = { ...DEF, f: id }; }
    if (!current.includes(f)) render(true);
    let tries = 0;
    while (!els.list.querySelector(`#f-${CSS.escape(id)}`) && remaining > 0 && tries++ < 50) { limit += PAGE_STEP; render(true); }
    toggle(f.k, true);
    const row = document.getElementById(`f-${id}`);
    if (row) { row.scrollIntoView({ block: 'center' }); if (focus) $('.row-btn', row).focus(); }
  }

  document.addEventListener('click', (e) => {
    const t = e.target.closest('button, a'); if (!t) return;
    if (t.matches('.row-btn')) { toggle(+t.dataset.k); return; }
    if (t.dataset.copy !== undefined) {
      if (t.dataset.link) { copyText(`${location.href.split('#')[0]}#findings?f=${t.dataset.link}`, 'link', t); return; }
      copyText(t.dataset.copy, t.dataset.what, t); return;
    }
    if (t.dataset.prompt) { copyText(aiPrompt(F[+t.dataset.prompt]), 'AI prompt', t); return; }
    if (t.dataset.rm) { st[t.dataset.rm] = DEF[t.dataset.rm]; limit = PAGE_STEP; render(); return; }
    if (t.dataset.act === 'reset') { st = { ...DEF, s: st.s, g: st.g }; limit = PAGE_STEP; render(); els.q.focus(); return; }
    if (t.dataset.act === 'more') { limit += PAGE_STEP; render(true); return; }
    if (t.dataset.act === 'all') { limit = 1e9; render(true); return; }
    if (t.dataset.act === 'help') { els.help.showModal(); return; }
    if (t.dataset.act === 'close-help') { els.help.close(); return; }
    if (t.dataset.view !== undefined) { e.preventDefault(); setState(parseParams(t.dataset.view), 'findings'); return; }
    if (t.dataset.open) { e.preventDefault(); st = { ...DEF, f: t.dataset.open }; limit = PAGE_STEP; render(true); reveal(t.dataset.open, true); return; }
    if (t.closest('.nav') && t.getAttribute('href') && t.getAttribute('href').charAt(0) === '#') {
      e.preventDefault(); const id = t.getAttribute('href').slice(1); const target = document.getElementById(id);
      if (target) { target.scrollIntoView({ behavior: 'auto', block: 'start' }); writeHash(id === 'findings' ? 'findings' : id); target.focus && target.setAttribute('tabindex', '-1'); }
    }
  });
  els.seg.addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; st.b = b.dataset.b; limit = PAGE_STEP; render(); });
  let qTimer = 0;
  els.q.addEventListener('input', () => { clearTimeout(qTimer); qTimer = setTimeout(() => { st.q = els.q.value.trim(); limit = PAGE_STEP; render(); }, 160); });
  for (const k of ['v', 'o', 'i', 'L', 'r', 'p', 's', 'g']) sel[k].addEventListener('change', () => { st[k] = sel[k].value; limit = PAGE_STEP; render(); });
  srcBox.addEventListener('change', () => { st.src = srcBox.checked ? '1' : ''; limit = PAGE_STEP; render(); });
  window.addEventListener('hashchange', () => { const s = readHash(); if (s) { st = s; limit = PAGE_STEP; render(true); if (s.f) reveal(s.f); } });

  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || els.help.open) return;
    const tag = e.target.tagName; const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target.isContentEditable;
    if (e.key === 'Escape' && e.target === els.q) { if (els.q.value) { els.q.value = ''; st.q = ''; render(); } else els.q.blur(); return; }
    if (typing) return;
    if (e.key === '/') { e.preventDefault(); els.q.focus(); els.q.select(); }
    else if (e.key === '?') { e.preventDefault(); els.help.showModal(); }
    else if (e.key === 'j' || e.key === 'k') {
      const btns = [...els.list.querySelectorAll('.row-btn')]; if (!btns.length) return;
      let i = btns.indexOf(document.activeElement);
      if (e.key === 'j') { if (i === btns.length - 1 && remaining > 0) { limit += PAGE_STEP; render(true); i = btns.length - 1; } i = i < 0 ? 0 : i + 1; }
      else i = i < 0 ? 0 : Math.max(i - 1, 0);
      const now = [...els.list.querySelectorAll('.row-btn')]; const b = now[Math.min(i, now.length - 1)];
      if (b) { b.focus(); b.scrollIntoView({ block: 'nearest' }); }
      e.preventDefault();
    }
  });

  // filters panel is a disclosure on narrow screens only
  const mq = window.matchMedia('(min-width: 901px)');
  const syncFilters = () => { els.filters.open = mq.matches || !!(st.o || st.i || st.L || st.r || st.p !== '' || st.src); };
  mq.addEventListener('change', syncFilters);

  let printing = false; let savedLimit = limit;
  window.addEventListener('beforeprint', () => { printing = true; savedLimit = limit; limit = 1e9; render(true); });
  window.addEventListener('afterprint', () => { if (printing) { limit = savedLimit; render(true); printing = false; } });

  // section marker for the nav
  const links = [...document.querySelectorAll('.nav a')];
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver((ents) => { for (const en of ents) if (en.isIntersecting) links.forEach((a) => a.setAttribute('aria-current', String(a.getAttribute('href') === `#${en.target.id}`))); }, { rootMargin: '-20% 0px -70% 0px' });
    links.forEach((a) => { const t = document.getElementById(a.getAttribute('href').slice(1)); if (t) io.observe(t); });
  }

  // theme toggle: the head script already set data-theme; this flips it and remembers the choice if storage allows
  const tgl = $('#theme-toggle');
  const themeNow = () => (document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark');
  const themeLabel = () => { const t = themeNow(); tgl.setAttribute('aria-label', `Theme: ${t}, switch to ${t === 'dark' ? 'light' : 'dark'}`); };
  themeLabel();
  tgl.addEventListener('click', () => {
    const next = themeNow() === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem('ada-report-theme', next); } catch (e) { /* storage blocked: the choice lasts for this page view */ }
    themeLabel(); announce(`Theme: ${next}`);
  });

  document.documentElement.classList.add('js');
  const init = readHash();
  if (init) st = init;
  syncFilters();
  render(true);
  if (init && init.f) reveal(init.f);
  else if (init) { const e = document.getElementById('findings'); if (e) e.scrollIntoView({ block: 'start' }); }
  window.__report = { count: () => current.length, state: () => ({ ...st }) };
})();
