// DOM-structure probes that need the live document: duplicate ids that ARIA references resolve through, and identical
// hard-coded names repeated across the items of a rendered loop. Both are facts read from the DOM (no guessing from class names).
// The element handed back is the first of the repeated markup, so source tracing lands on the template line that renders every copy.

const REFERENCE_ATTRS = ['aria-labelledby', 'aria-describedby', 'aria-controls', 'aria-owns', 'aria-details', 'aria-errormessage', 'aria-flowto', 'aria-activedescendant', 'headers', 'list'];
const MAX_IDS = 20;
const MAX_REFERRERS = 10;

/** Runs in the page. One entry per id that several elements carry AND something references. */
function readReferencedDuplicateIds({ attrs, maxIds, maxReferrers }) {
  const byId = new Map();
  for (const el of document.querySelectorAll('[id]')) {
    if (!el.id) continue;
    if (!byId.has(el.id)) byId.set(el.id, []);
    byId.get(el.id).push(el);
  }
  const depthOf = (el) => { let d = 0; for (let p = el; p; p = p.parentElement) d++; return d; };
  // Depth of the deepest ancestor two elements share: the closer, the more likely the author meant that pair.
  const sharedDepth = (a, b) => {
    const up = new Set();
    for (let p = a; p; p = p.parentElement) up.add(p);
    for (let p = b; p; p = p.parentElement) if (up.has(p)) return depthOf(p);
    return 0;
  };
  const rendered = (e) => e.checkVisibility({ visibilityProperty: true }) && !e.closest('[aria-hidden="true"], [inert]');
  // The text the accessibility tree exposes for an element used as a name: aria-label, else its content with img alt, svg title and a child's aria-label,
  // skipping display:none, visibility:hidden and aria-hidden children (the referenced root itself counts even when hidden, as in the accname algorithm).
  const textOf = (root) => {
    const own = (root.getAttribute('aria-label') || '').trim();
    if (own) return own.replace(/\s+/g, ' ');
    const walk = (n) => {
      if (n.nodeType === 3) return n.data;
      if (n.nodeType !== 1) return '';
      const cs = getComputedStyle(n);
      if (n.getAttribute('aria-hidden') === 'true' || cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') return '';
      const al = (n.getAttribute('aria-label') || '').trim();
      if (al) return ` ${al} `;
      const tag = n.localName;
      if (tag === 'img' || (tag === 'input' && n.type === 'image')) return ` ${n.getAttribute('alt') || ''} `;
      if (tag === 'svg') { const t = n.querySelector(':scope > title'); return t ? ` ${t.textContent} ` : ''; }
      return ` ${[...n.childNodes].map(walk).join('')} `;
    };
    return [...root.childNodes].map(walk).join('').replace(/\s+/g, ' ').trim()
      || (root.localName === 'svg' ? (root.querySelector(':scope > title')?.textContent || '').trim() : '')
      || (root.localName === 'img' ? (root.getAttribute('alt') || '').trim() : '');
  };
  // Whether resolving to the first copy changes what the accessibility tree exposes for this referrer. A duplicated id nothing resolves through
  // (hidden menu panels toggled by script) is only an HTML validity issue: WCAG 2.2 removed 4.1.1.
  const showsInTree = (el, attr, first, intended) => {
    if (!rendered(el)) return false; // a hidden or aria-hidden referrer exposes no name or relationship
    if (attr === 'aria-labelledby' || attr === 'aria-describedby' || attr === 'aria-errormessage' || attr === 'headers') { const a = textOf(first); const b = textOf(intended); return a !== b || (!a && !b); } // name, description, error text or header text differs (an unreadable pair is not demoted)
    if (attr === 'for') return true; // the label names the first control, not its own
    if (attr === 'aria-controls') return rendered(intended); // the control points at another panel than the one the user operates
    return false; // other IDREF attributes and in-page anchors: the resolution is ambiguous but the tree effect is not measured here
  };
  const refSelector = [...attrs.map((a) => `[${a}]`), 'label[for]', 'output[for]', 'a[href^="#"]'].join(',');
  const referrersOf = new Map();
  for (const el of document.querySelectorAll(refSelector)) {
    const pairs = attrs.filter((a) => el.hasAttribute(a)).map((a) => [a, el.getAttribute(a)]);
    if (/^(label|output)$/i.test(el.tagName) && el.hasAttribute('for')) pairs.push(['for', el.getAttribute('for')]);
    const href = el.localName === 'a' ? el.getAttribute('href') : null;
    if (href && href.length > 1 && href.startsWith('#')) pairs.push(['anchor href', (() => { try { return decodeURIComponent(href.slice(1)); } catch { return href.slice(1); } })()]); // in-page link or skip target
    for (const [attr, value] of pairs) {
      for (const token of String(value).split(/\s+/).filter(Boolean)) {
        if (!byId.has(token) || byId.get(token).length < 2) continue;
        if (!referrersOf.has(token)) referrersOf.set(token, []);
        referrersOf.get(token).push({ el, attr });
      }
    }
  }
  // <use href="#id"> is not an accessibility reference: a sprite's decorative icons never expose the id to AT, so repeated <symbol id> is not reported.
  const out = [];
  for (const [id, refs] of referrersOf) {
    const dups = byId.get(id);
    const first = dups[0]; // what getElementById, and so every ARIA reference, resolves to
    const labelable = (e) => /^(input|select|textarea|button|meter|output|progress)$/.test(e.localName) && !(e.localName === 'input' && e.type === 'hidden');
    // A label[for] whose id first resolves to a non-labelable element (hidden input, div) has no control, while a rendered labelable copy follows: the label's own input goes unnamed.
    const labelableCopy = labelable(first) && rendered(first) ? null : dups.find((d) => d !== first && labelable(d) && rendered(d));
    const detail = refs.map(({ el, attr }) => {
      let intended = first;
      for (const d of dups) if (sharedDepth(el, d) > sharedDepth(el, intended)) intended = d;
      if (attr === 'for' && el.localName === 'label' && labelableCopy) intended = labelableCopy;
      return { el, attr, intended, wrong: intended !== first, shows: false };
    });
    // Flat markup ties on depth, so the intended copy cannot be read from the tree. Pigeonhole decides it: several rendered referrers of one kind onto
    // several candidate copies cannot all reach their own copy (every one gets the first). Copies that read the same expose no different text, so those stay likely.
    // Candidates: rendered copies plus the first (it is what the browser resolves to even when hidden); for label[for] only labelable controls count.
    for (const kind of ['for', 'aria-labelledby', 'aria-describedby', 'aria-errormessage', 'headers', 'aria-controls']) {
      const group = detail.filter((d) => d.attr === kind && rendered(d.el));
      const copies = dups.filter((d) => (rendered(d) || d === first) && (kind !== 'for' || labelable(d)));
      if (group.length < 2 || copies.length < 2) continue;
      if (kind !== 'for' && kind !== 'aria-controls' && new Set(copies.map(textOf)).size < 2) continue;
      group.forEach((d, i) => { if (!d.wrong && i > 0) { d.intended = copies[Math.min(i, copies.length - 1)]; d.wrong = d.intended !== first; } });
    }
    for (const d of detail) d.shows = d.wrong && showsInTree(d.el, d.attr, first, d.intended);
    out.push({
      id,
      occurrences: dups.length,
      selector: `#${CSS.escape(id)}`,
      html: first.outerHTML.slice(0, 300),
      attrs: [...new Set(refs.map((r) => r.attr))].sort(),
      referrerCount: refs.length,
      misresolved: detail.filter((d) => d.wrong).length,
      shown: detail.filter((d) => d.shows).length,
      referrers: detail.slice(0, maxReferrers).map((d) => ({
        attr: d.attr,
        html: d.el.outerHTML.slice(0, 160),
        resolvesTo: `${first.tagName.toLowerCase()}#${id}[1]`,
        intendedIndex: dups.indexOf(d.intended) + 1,
        wrong: d.wrong,
        shows: d.shows,
      })),
    });
    if (out.length >= maxIds) break;
  }
  return out;
}

/** Runs in the page. Sibling items (same parent, tag and role) that carry the very same aria-label. */
function readRepeatedItemNames() {
  const ITEM_ROLES = new Set(['group', 'region', 'article', 'listitem', 'tabpanel', 'figure']);
  const ITEM_TAGS = new Set(['li', 'article', 'section', 'figure']);
  const visible = (el) => el.checkVisibility() && !el.closest('[aria-hidden="true"]');
  const buckets = new Map();
  for (const el of document.querySelectorAll('[aria-label]')) {
    const label = (el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
    const role = el.getAttribute('role');
    if (!label || !el.parentElement || !(role ? ITEM_ROLES.has(role) : ITEM_TAGS.has(el.tagName.toLowerCase()))) continue;
    if (!visible(el)) continue; // carousel clones are aria-hidden duplicates by design
    const parents = buckets.get(el.parentElement) || new Map();
    const key = `${el.tagName}|${role || ''}|${label.toLowerCase()}`;
    parents.set(key, [...(parents.get(key) || []), el]);
    buckets.set(el.parentElement, parents);
  }
  const out = [];
  for (const parents of buckets.values()) {
    for (const items of parents.values()) {
      if (items.length < 2) continue;
      out.push({ label: items[0].getAttribute('aria-label').replace(/\s+/g, ' ').trim(), count: items.length, html: items[0].outerHTML.slice(0, 300), tag: items[0].tagName.toLowerCase() });
    }
  }
  return out.slice(0, 20);
}

/** Duplicate ids that aria-labelledby/-describedby/-controls/headers/list/for and in-page anchors resolve through: the first element wins for every referrer. */
export async function checkReferencedDuplicateIds(page, violations, passes) {
  const found = await page.evaluate(readReferencedDuplicateIds, { attrs: REFERENCE_ATTRS, maxIds: MAX_IDS, maxReferrers: MAX_REFERRERS });
  for (const f of found) {
    // Confirmed only when a rendered referrer measurably gets the wrong name or relationship from the first copy; otherwise a duplicate id is advice (likely).
    const confirmed = f.shown > 0;
    violations.push({
      rule: 'duplicate-id-referenced',
      description: `id "${f.id}" is on ${f.occurrences} elements and is referenced by ${f.attrs.join('/')} on ${f.referrerCount} element${f.referrerCount === 1 ? '' : 's'}; `
        + `${f.misresolved} of them resolve to the first element instead of their own (typical cause: a hard-coded id inside a loop)`,
      impact: 'serious',
      wcagCriteria: '4.1.2',
      count: f.occurrences,
      element: { html: f.html, selector: f.selector },
      ...(confirmed ? {} : { verdict: 'likely' }),
      evidence: { id: f.id, occurrences: f.occurrences, referrerCount: f.referrerCount, misresolved: f.misresolved, shown: f.shown, referrers: f.referrers, proof: { type: 'measured-fact', fact: `id "${f.id}" is on ${f.occurrences} elements; ${f.misresolved} of ${f.referrerCount} referrer(s) via ${f.attrs.join('/')} resolve to the first element${confirmed ? `, ${f.shown} of them with a different name or target than their own` : ''}` }, ...(confirmed ? {} : { reviewReason: 'the duplicate id is not shown to change a name or relationship in the accessibility tree (referrers hidden, same text, or not a name or aria-controls reference); WCAG 2.2 removed 4.1.1' }) },
    });
  }
  if (found.length === 0) passes.push('No duplicate id is referenced by ARIA or label/for');
}

/** Items of one list or carousel that all announce the same hard-coded name. */
export async function checkRepeatedItemNames(page, violations, passes) {
  const found = await page.evaluate(readRepeatedItemNames);
  for (const f of found) {
    violations.push({
      rule: 'repeated-accessible-name-in-loop',
      description: `${f.count} sibling <${f.tag}> items share the accessible name "${f.label.slice(0, 80)}": a hard-coded label in a loop gives every item the same name`,
      impact: 'moderate',
      wcagCriteria: '4.1.2',
      count: f.count,
      element: { html: f.html },
      evidence: { label: f.label, items: f.count },
    });
  }
  if (found.length === 0) passes.push('No sibling items share an identical aria-label');
}
