// Tool-owned measurements on the live DOM (docs/measured-checks.md): WCAG 2.5.8 target size, WCAG 2.5.3 label in name and settled colour contrast.
// An engine row (axe, Lighthouse, accessScan) for the same rule is a candidate: our measurement decides its verdict and records the numbers as proof.
import { createViolation } from '../schema.js';
import { blend, contrastRatio, isLargeText, settleMotion } from './pixel-contrast.js';
import { DEFAULT_AXE_VIEWPORTS } from '../utils/config.js';
import { installNoHydrateJobsRoutes, prepareNoHydrateJobsPage } from './access-scan/runtime/no-hydrate.js';

export const TARGET_MIN_PX = 24;
const EPS = 0.05;
// Inline boxes take their height from font metrics, which differ by up to a pixel between platforms: a circle overlap smaller than this is not decidable from one measurement.
export const OVERLAP_NOISE_PX = 1;
const MAX_ADDED = 25; // label-in-name failures the engines skipped, per page
const SETTLE_GAP_MS = 300;
const CONTRAST_TOLERANCE = 0.05;

export const TARGET_RULES = new Set(['target-size', 'TargetSize']);
export const LABEL_RULES = new Set(['label-content-name-mismatch', 'VisibleTextPartOfAccessibleName']);
export const CONTRAST_RULES = new Set(['color-contrast']);

const r1 = (n) => Math.round(n * 10) / 10;

// ─── Pure judgements (unit-tested without a browser) ─────────────────────────

/**
 * WCAG 2.5.8 for one measured target: { w, h, inline, ua, nearest, clearance }. clearance = the smallest distance between the target's 24px circle and any
 * other target's box (or the circle of another undersized target); negative means they intersect. Touching (0) passes, as in the criterion's "does not intersect".
 */
export function judgeTarget(m) {
  if (!m || m.hidden) return { status: 'n/a', why: 'not rendered at this viewport' };
  if (m.ambiguous) return { status: 'n/a', why: `the selector matches ${m.ambiguous} elements and the row does not single one out` };
  if (m.w >= TARGET_MIN_PX - EPS && m.h >= TARGET_MIN_PX - EPS) return { status: 'pass', why: 'size is at least 24 x 24 CSS px' };
  if (m.inline) return { status: 'pass', why: 'inline exception: link inside a sentence' };
  if (m.ua && !m.uaResized) return { status: 'pass', why: 'user agent control, size not set by the author' };
  if (m.equivalent) return { status: 'pass', why: 'equivalent control: the same function is offered by a target of at least 24 x 24 CSS px' };
  if (m.clearance == null || m.clearance >= 0) return { status: 'pass', why: 'spacing exception: the 24px circle intersects no other target' };
  if (m.styleUnapplied) return { status: 'review', why: `the control's own display class (${m.styleUnapplied}) is not in effect, so the stylesheet that sizes it did not load or was overridden and the measured box is not the designed one` };
  if (m.fontBox && m.clearance > -OVERLAP_NOISE_PX) return { status: 'review', why: `circle overlap of ${r1(-m.clearance)}px is below the ${OVERLAP_NOISE_PX}px rounding of font metrics (an inline text box's height comes from the platform font)` };
  if (m.uaResized) return { status: 'review', why: 'author-resized native control: the user agent exception holds only at the default size' };
  if (m.vendor || m.vendorOnly) return { status: 'review', why: 'depends on a third-party control' };
  return { status: 'fail', why: 'undersized and its 24px circle intersects another target' };
}

const sizeText = (m) => `${r1(m.w)} x ${r1(m.h)}`;
const gapText = (m) => (m.nearest == null ? 'no neighbour' : `nearest neighbour distance ${r1(m.nearest)}px`);
const clearText = (m) => (m.clearance == null ? 'circle clearance n/a' : `circle clearance ${r1(m.clearance)}px`);
const at = (vp) => `${vp.width}x${vp.height}`;

/** perViewport: [{ viewport: {width,height}, m }]. Returns { verdict, proof?, reason?, measured }. */
export function aggregateTarget(perViewport) {
  const judged = perViewport.map((p) => ({ ...p, j: judgeTarget(p.m) }));
  const measured = judged.map((p) => ({ viewport: at(p.viewport), status: p.j.status, ...(p.m && !p.m.hidden ? { w: r1(p.m.w), h: r1(p.m.h), nearest: p.m.nearest == null ? null : r1(p.m.nearest), clearance: p.m.clearance == null ? null : r1(p.m.clearance) } : {}), why: p.j.why }));
  const fails = judged.filter((p) => p.j.status === 'fail');
  if (fails.length) {
    const others = judged.filter((p) => p.j.status !== 'fail');
    const lines = fails.map((p) => `${sizeText(p.m)}, ${gapText(p.m)}, ${clearText(p.m)} at viewport ${at(p.viewport)}`);
    const tail = others.length ? `; fails only at ${fails.map((p) => at(p.viewport)).join(', ')} (${others.map((p) => `${at(p.viewport)}: ${p.j.status === 'n/a' ? 'not rendered' : p.j.why}`).join('; ')})` : '';
    return { verdict: 'confirmed', proof: { type: 'measured-fact', fact: `${lines.join('; ')}${tail}` }, measured };
  }
  const review = judged.find((p) => p.j.status === 'review');
  if (review) return { verdict: 'needs-review', reason: `${review.j.why}: ${sizeText(review.m)}, ${gapText(review.m)}, ${clearText(review.m)} at viewport ${at(review.viewport)}${review.m.styleUnapplied ? '; reload with the site stylesheet before judging' : review.m.fontBox && review.m.clearance > -OVERLAP_NOISE_PX ? '; a sliver this small flips with the platform font, so measure it on the target device' : review.m.uaResized ? '; judge by eye whether the author size is what the browser would draw' : '; the undersized target or the neighbour it crowds is a vendor control (cookie banner, chat widget) the site does not own'}`, measured };
  const passed = judged.filter((p) => p.j.status === 'pass');
  if (passed.length) {
    const p = passed[0];
    return { verdict: 'needs-review', reason: `measured geometry passes WCAG 2.5.8 (${p.j.why}): ${sizeText(p.m)}, ${gapText(p.m)}, ${clearText(p.m)} at viewport ${at(p.viewport)}; the engine approximates spacing in one dimension`, measured };
  }
  const amb = perViewport.find((p) => p.m?.ambiguous);
  if (amb) return { verdict: 'needs-review', reason: `target not measurable: its selector matches ${amb.m.ambiguous} elements and neither the reported html nor the DOM path singles one out, so no element's size or spacing can be attributed to this row`, measured };
  return { verdict: 'needs-review', reason: 'target not measurable in the page document (not found, not rendered, not operable or inside a frame)', measured };
}

// Symbols a screen reader speaks as a word: "Terms & Conditions" and "Terms and Conditions" are the same words (WCAG 2.5.3 compares text, not glyphs).
const SPOKEN = { '&': ' and ', '+': ' plus ', '%': ' percent ', '@': ' at ', '#': ' number ' };
// Two readings of a symbol: spoken ("Job #5" -> "job number 5") or dropped ("Job 5"). Text holds when it holds in either reading on both sides, so a name
// that says the symbol's word or leaves the symbol out both keep the control addressable by voice.
const norm = (s, spoken = true) => { const t = String(s ?? '').normalize('NFKC').toLowerCase(); return (spoken ? t.replace(/[&+%@#]/g, (c) => SPOKEN[c]) : t).replace(/[^\p{L}\p{N}\s]+/gu, ' ').replace(/\s+/g, ' ').trim(); };
// The visible words are a contiguous run of the name's words; hyphen and space variants ("e-mail", "email") are the same word run once spaces are dropped.
const holdsIn = (name, label, spoken) => { const n = norm(name, spoken); const l = norm(label, spoken); return n.includes(l) || n.replace(/ /g, '').includes(l.replace(/ /g, '')); };
const holds = (name, label) => holdsIn(name, label, true) || holdsIn(name, label, false);
const same = (a, b) => norm(a) === norm(b) || norm(a, false) === norm(b, false);
export const hasLetters = (s) => /[\p{L}\p{N}]/u.test(String(s ?? ''));

/** WCAG 2.5.3: { label, name } -> 'na' (no visible label, or a symbol only), 'pass', 'review' (long text without a title) or 'fail'. Case-insensitive, whitespace and punctuation normalised. primary = the first block of visible text when the label spans several (title + caption), rest = the other blocks. */
export function judgeLabel({ label, name, primary, rest, title }) {
  if (!hasLetters(label)) return 'na';
  const one = [...norm(label).replace(/ /g, '')];
  if (one.length <= 1 && !/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]$/u.test(one[0] ?? '')) return /^\p{N}$/u.test(one[0] ?? '') && norm(name) ? (holds(name, label) ? 'pass' : 'review') : 'na'; // one letter ("x") is an icon glyph; one ideograph or kana is a whole word; a lone digit a voice user can say ("click 1") is a review item when the name lacks it
  if (!norm(name)) return 'na'; // an empty name is another rule's finding (link-name, button-name)
  if (holds(name, label)) return 'pass';
  // The name IS the control's visible title (a heading or the largest text) and the rest is supplementary description inside the same control: addressable by its title, a review item not a failure.
  if (title && norm(primary) && same(name, primary)) return 'pass';
  // A card or link with a title plus a shorter caption: the title is what a voice user says, so a name that carries it keeps the control addressable.
  // A one-word first block (a tag, "Apply" of "Apply Now") or a caption longer than the title is a split label, not a title: stays a mismatch.
  const words = (x) => norm(x).split(' ').filter(Boolean).length;
  if (words(primary) >= 2 && words(rest) <= words(primary) && holds(name, primary)) return 'pass';
  // Long card text with no title to say: 2.5.3 applies to the text that labels the control, which a script cannot tell from the description, so a person decides.
  return words(label) > 10 ? 'review' : 'fail';
}

export const labelFact = (label, name) => `visible text "${String(label).trim()}" is not part of accessible name "${String(name).trim()}"`;

export function aggregateLabel(perViewport) {
  const judged = perViewport.filter((p) => p.m && !p.m.hidden).map((p) => ({ ...p, j: judgeLabel(p.m) }));
  const fail = judged.find((p) => p.j === 'fail');
  const measured = judged.map((p) => ({ viewport: at(p.viewport), label: p.m.label, name: p.m.name, status: p.j }));
  if (fail) return { verdict: 'confirmed', proof: { type: 'name-vs-text', fact: `${labelFact(fail.m.label, fail.m.name)} at viewport ${at(fail.viewport)}` }, visibleText: fail.m.label, accessibleName: fail.m.name, measured };
  if (!judged.length) return { verdict: 'needs-review', reason: 'element not measurable in the page document (not found, not rendered or inside a frame)', measured };
  const long = judged.find((p) => p.j === 'review');
  if (long) return { verdict: 'needs-review', reason: `long visible text without a title ("${String(long.m.label).trim().slice(0, 80)}") is not part of the accessible name "${String(long.m.name).trim()}"; judge whether the control stays addressable by voice`, measured };
  const withLabel = judged.find((p) => p.j === 'pass');
  return { verdict: 'needs-review', reason: withLabel ? `visible label "${String(withLabel.m.label).trim()}" is contained in the accessible name "${String(withLabel.m.name).trim()}"` : 'no visible label in rendered text', measured };
}

/** Ratio of a sampled { fg:[r,g,b,a], bg:[r,g,b], opacity, fontPx, weight, image }. */
export function sampleRatio(s) {
  if (!s || s.image || s.unmeasured) return null;
  const fg = blend(s.fg.slice(0, 3), s.fg[3] * s.opacity, s.bg);
  return { ratio: contrastRatio(fg, s.bg), threshold: isLargeText(s.fontPx, s.weight) ? 3 : 4.5 };
}

/** Two samples 300 ms apart (a: first, b: second). Unstable when the colours or the ratio moved; passing/failing is judged on the second. */
export function judgeContrast(a, b) {
  const x = sampleRatio(a); const y = sampleRatio(b);
  const moved = Boolean(a && b && (JSON.stringify([a.fg, a.bg, a.opacity]) !== JSON.stringify([b.fg, b.bg, b.opacity])));
  if (moved && x && y && Math.abs(x.ratio - y.ratio) <= CONTRAST_TOLERANCE) return { state: 'stable', ...y };
  if (moved) return { state: 'unstable', ratio: y?.ratio ?? null, first: x?.ratio ?? null, threshold: y?.threshold ?? null };
  if (!y) return { state: 'unmeasured' };
  return { state: 'stable', ...y };
}

// ─── In-page measurement (self-contained: serialised into the page) ──────────

export function targetsInPage({ selectors, all }) {
  // Operable controls only: native controls, and an ARIA role only on a focusable element. Wrappers and bare tabindex containers (a cookie banner root, a scroll region) are not targets.
  const NATIVE = 'a[href], button, input:not([type=hidden]), select, textarea, summary';
  const ROLED = '[role=button], [role=link], [role=checkbox], [role=radio], [role=switch], [role=tab], [role=menuitem], [role=menuitemcheckbox], [role=menuitemradio], [role=option], [role=slider], [role=combobox], [role=treeitem]';
  const INTERACTIVE = `${NATIVE}, ${ROLED}`;
  const VENDOR = /onetrust|ot-sdk|optanon|cookiebot|cybot|truste|osano|usercentrics|didomi|cookie-?(banner|consent|notice)|intercom|drift-|zendesk|hubspot|livechat|chat-widget/i;
  const MIN = 24; const EPS_ = 0.05;
  scrollTo(0, 0);
  const styles = new Map();
  const cs = (el) => { let c = styles.get(el); if (!c) { c = getComputedStyle(el); styles.set(el, c); } return c; };
  const blockedMemo = new Map();
  // hidden, transparent, inert or aria-hidden here or in any ancestor (opacity composes, aria-hidden and inert inherit)
  const blocked = (el) => {
    if (!el || el.nodeType !== 1) return false;
    if (blockedMemo.has(el)) return blockedMemo.get(el);
    const c = cs(el);
    const own = c.display === 'none' || c.visibility === 'hidden' || c.visibility === 'collapse' || parseFloat(c.opacity) < 0.01 || el.getAttribute('aria-hidden') === 'true' || el.hasAttribute('inert');
    const v = own || blocked(el.parentElement);
    blockedMemo.set(el, v);
    return v;
  };
  // the part of the box that survives every clipping ancestor (overflow other than visible); an absolute child skips ancestors that are not its containing block
  const clippedAway = (el, r) => {
    let l = r.left; let t = r.top; let rt = r.right; let b = r.bottom;
    let mode = cs(el).position;
    for (let a = el.parentElement; a && a !== document.documentElement; a = a.parentElement) {
      if (mode === 'fixed') break;
      const c = cs(a);
      const skip = mode === 'absolute' && c.position === 'static';
      if (!skip && (c.overflowX !== 'visible' || c.overflowY !== 'visible')) {
        const ar = a.getBoundingClientRect();
        if (c.overflowX !== 'visible') { l = Math.max(l, ar.left); rt = Math.min(rt, ar.right); }
        if (c.overflowY !== 'visible') { t = Math.max(t, ar.top); b = Math.min(b, ar.bottom); }
        if (rt <= l || b <= t) return true;
      }
      if (c.position !== 'static') mode = c.position === 'absolute' ? 'absolute' : 'relative';
    }
    return false;
  };
  const operable = (el) => {
    if (el.disabled || blocked(el) || cs(el).pointerEvents === 'none' || el.closest('[inert]')) return false;
    const c = cs(el);
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1 || (r.width <= 1 && r.height <= 1)) return false; // empty or 1px (screen-reader-only)
    if (/^rect\(\s*[01](px)?[ ,]+[01](px)?[ ,]+[01](px)?[ ,]+[01](px)?\s*\)$/.test(c.clip) || /inset\((50|100)%\)/.test(c.clipPath)) return false;
    if (r.right <= 0 || r.bottom <= 0 || r.left >= document.documentElement.scrollWidth || r.top >= document.documentElement.scrollHeight) return false; // offscreen where no scrolling reaches it
    return !clippedAway(el, r);
  };
  // A pointer target needs no tab stop: a role control counts when it has one or holds no other control (a wrapper does not); the label of a visually hidden checkbox or radio is the target of the custom control.
  const isTarget = (el) => el.matches(NATIVE)
    || (el.matches(ROLED) && (el.hasAttribute('tabindex') || !el.querySelector(`${NATIVE}, ${ROLED}`)))
    || (el.tagName === 'LABEL' && Boolean(el.control) && el.control.tagName === 'INPUT' && ['checkbox', 'radio'].includes(el.control.type) && !operable(el.control));
  const OUTER = 'a[href], button, summary';
  // an inner role node of a native control is not the target: the outer control receives the click
  const outerOf = (el) => (el.matches(ROLED) && !el.matches(NATIVE) ? el.parentElement?.closest(OUTER) || el : el);
  // The hit area: the element and its in-flow descendants (an inline link around a block icon has a line-box fragment smaller than what the pointer reaches).
  const hitRect = (el) => {
    const r0 = el.getBoundingClientRect();
    let l = r0.left; let t = r0.top; let rt = r0.right; let b = r0.bottom;
    // a stretched link: an absolute ::before/::after that covers its containing block is what the pointer hits (Bootstrap .stretched-link, card title links)
    for (const pe of ['::before', '::after']) {
      const pc = getComputedStyle(el, pe);
      if (pc.content === 'none' || (pc.position !== 'absolute' && pc.position !== 'fixed') || pc.pointerEvents === 'none' || pc.display === 'none' || pc.visibility !== 'visible') continue;
      let cb = null;
      if (pc.position === 'absolute') for (let a = cs(el).position !== 'static' ? el : el.parentElement; a; a = a.parentElement) if (cs(a).position !== 'static' || a === document.body) { cb = a; break; }
      if (!cb) continue;
      const cr = cb.getBoundingClientRect();
      if (parseFloat(pc.width) >= cr.width * 0.9 && parseFloat(pc.height) >= cr.height * 0.9) { l = Math.min(l, cr.left); t = Math.min(t, cr.top); rt = Math.max(rt, cr.right); b = Math.max(b, cr.bottom); }
    }
    let n = 0;
    for (const d of el.querySelectorAll('*')) {
      if (++n > 60) break;
      if (d instanceof SVGElement && d.tagName.toLowerCase() !== 'svg') continue;
      const c = cs(d);
      if (c.display === 'none' || c.display === 'contents' || c.visibility !== 'visible' || c.pointerEvents === 'none' || c.position === 'absolute' || c.position === 'fixed') continue;
      let { left: x0, top: y0, right: x1, bottom: y1 } = d.getBoundingClientRect();
      // the pointer cannot hit what a clipping box between the descendant and the control hides
      for (let a = d.parentElement; a; a = a.parentElement) {
        const ca = cs(a);
        if (ca.overflowX !== 'visible' || ca.overflowY !== 'visible') {
          const ar = a.getBoundingClientRect();
          if (ca.overflowX !== 'visible') { x0 = Math.max(x0, ar.left); x1 = Math.min(x1, ar.right); }
          if (ca.overflowY !== 'visible') { y0 = Math.max(y0, ar.top); y1 = Math.min(y1, ar.bottom); }
        }
        if (a === el) break;
      }
      if (x1 - x0 <= 1 || y1 - y0 <= 1) continue;
      l = Math.min(l, x0); t = Math.min(t, y0); rt = Math.max(rt, x1); b = Math.max(b, y1);
    }
    return { left: l, top: t, right: rt, bottom: b, width: rt - l, height: b - t };
  };
  const vendorOf = (el) => { for (let e = el; e; e = e.parentElement) if (VENDOR.test(`${e.id} ${typeof e.className === 'string' ? e.className : ''}`)) return true; return false; };
  const box = (el) => { const r = hitRect(el); return { el, l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2, vendor: vendorOf(el) }; };
  const targets = [...document.querySelectorAll(`${INTERACTIVE}, label`)].filter((el) => isTarget(el) && operable(el) && outerOf(el) === el).map(box);
  const small = (o) => o.w < MIN - EPS_ || o.h < MIN - EPS_;
  const words = (s) => (s.match(/\p{L}[\p{L}\p{N}'’-]*/gu) || []).length;
  const inlineInText = (el) => {
    let p = el.parentElement;
    // only a link that flows in the text (display:inline); an author-sized inline-block box is not constrained by the line, so it is not the exception
    if (cs(el).display !== 'inline') return false;
    while (p && (cs(p).display.startsWith('inline') || cs(p).display === 'contents')) p = p.parentElement;
    if (!p) return false;
    let text = '';
    const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) if (!n.parentElement.closest(INTERACTIVE)) text += ` ${n.nodeValue}`;
    return words(text) >= 2;
  };
  const uaControl = (el) => el.tagName === 'INPUT' && ['checkbox', 'radio'].includes(el.type) && cs(el).appearance !== 'none';
  // the browser draws a checkbox or radio about 13px square; any other size was set by the author
  const uaResized = (e) => uaControl(e.el) && (Math.abs(e.w - 13) > 1.5 || Math.abs(e.h - 13) > 1.5);
  const sameFn = (a, b) => {
    const ha = a.getAttribute('href'); const ca = a.getAttribute('aria-controls');
    if (ha && !ha.startsWith('#') && !/^javascript:/i.test(ha) && a.href === b.href) return true;
    return Boolean(ca) && ca === b.getAttribute('aria-controls');
  };
  // A neighbour must be reachable by pointer: at some point of its box the pointer hits it or one of its descendants (a node behind a fixed header, or inside a hidden-by-overlay
  // widget snapshot, is not a neighbour). Nine points over the box, then the point nearest the target's centre; a point outside the viewport cannot be asked, so it counts.
  const hits = (o, x, y) => {
    if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return true;
    const top = document.elementFromPoint(x, y);
    return Boolean(top) && (top === o.el || o.el.contains(top));
  };
  const gridMemo = new Map();
  const occluded = (o, e) => {
    if (!gridMemo.has(o)) gridMemo.set(o, ![0.1, 0.5, 0.9].some((fx) => [0.1, 0.5, 0.9].some((fy) => hits(o, o.l + o.w * fx, o.t + o.h * fy))));
    return gridMemo.get(o) && !hits(o, Math.min(Math.max(e.cx, o.l), o.r), Math.min(Math.max(e.cy, o.t), o.b));
  };
  // Is any pointer-reachable part of o inside e's 24px circle? A box that meets the circle only where a fixed bar or overlay covers it is not a neighbour (WCAG 2.5.8 counts targets a pointer can hit).
  // Samples the box point nearest the circle centre plus a 2px grid over box and circle; a point outside the viewport cannot be asked, so it counts as reachable.
  const reachableInCircle = (e, o) => {
    const R = MIN / 2;
    const x0 = Math.max(o.l, e.cx - R); const x1 = Math.min(o.r, e.cx + R);
    const y0 = Math.max(o.t, e.cy - R); const y1 = Math.min(o.b, e.cy + R);
    const pts = [[Math.min(Math.max(e.cx, o.l), o.r), Math.min(Math.max(e.cy, o.t), o.b)]];
    for (let x = x0; x <= x1; x += 2) for (let y = y0; y <= y1; y += 2) if (Math.hypot(x - e.cx, y - e.cy) <= R) pts.push([x, y]);
    return pts.some(([x, y]) => {
      if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return true;
      return hits(o, x, y);
    });
  };
  // The same control: one control ancestor holds both (an svg/span role node inside a button), or a label and the control it names.
  const CONTROL = 'a[href], button, summary, label, [role=button], [role=link]';
  const sameControl = (a, b) => {
    const ca = a.closest(CONTROL);
    return (Boolean(ca) && ca === b.closest(CONTROL)) || (a.tagName === 'LABEL' && a.control === b) || (b.tagName === 'LABEL' && b.control === a);
  };
  // A larger link that wraps the target and is drawn behind it (a stretched card link, a header-wide link) is the surface the control sits on, not a neighbour: the pointer on the control reaches the control.
  const ownCentre = new Map();
  const pointerOnUs = (e) => {
    if (!ownCentre.has(e)) { const top = e.cx >= 0 && e.cy >= 0 && e.cx < innerWidth && e.cy < innerHeight ? document.elementFromPoint(e.cx, e.cy) : null; ownCentre.set(e, Boolean(top) && (top === e.el || e.el.contains(top))); }
    return ownCentre.get(e);
  };
  const backdropLink = (e, o) => o.w * o.h > e.w * e.h && o.l <= e.cx && e.cx <= o.r && o.t <= e.cy && e.cy <= o.b && pointerOnUs(e);
  // A utility class that sets the display (Tailwind inline-flex, flex, block...) on a link the browser still draws as plain inline: the stylesheet that sizes the control did not load (or was overridden), so the box is not the designed one.
  const DISPLAY_CLASS = { 'inline-flex': 'inline-flex', flex: 'flex', grid: 'grid', 'inline-grid': 'inline-grid', block: 'block', 'inline-block': 'inline-block' };
  // Provably absent only: some author rule that sets a display (inside any media query, so a responsive "block md:inline" counts) matches the element, or a stylesheet cannot be read.
  // Then the stylesheet is loaded and the inline box is the author's rendering. Every such link on the page must show the unstyled default, not just this one.
  let displayRules = null;
  const hasDisplayRule = (el) => {
    if (displayRules === null) {
      displayRules = []; let unreadable = false;
      const walk = (rules) => { for (const r of rules) { if (r.selectorText && r.style?.display) displayRules.push(r.selectorText); if (r.cssRules) walk(r.cssRules); else if (r.styleSheet) walk(r.styleSheet.cssRules); } }; // an @import rule keeps its rules on r.styleSheet; a cross-origin one throws and counts as unreadable
      for (const sh of [...document.styleSheets, ...(document.adoptedStyleSheets || [])]) { try { walk(sh.cssRules); } catch { unreadable = true; } }
      if (unreadable) displayRules.unreadable = true;
    }
    return displayRules.unreadable || displayRules.some((sel) => { try { return el.matches(sel); } catch { return false; } });
  };
  const displayClass = (el) => [...el.classList].find((k) => DISPLAY_CLASS[k]);
  const styleUnapplied = (el) => {
    const c = displayClass(el);
    if (!c || cs(el).display !== 'inline' || hasDisplayRule(el)) return null;
    for (const o of document.querySelectorAll('a[class], button[class]')) if (displayClass(o) && cs(o).display !== 'inline') return null;
    return c;
  };
  // an inline box takes its height from the platform font, so a sub-pixel overlap with it is not stable across machines; a fixed px box has no such noise
  const fontBox = (el) => cs(el).display === 'inline';
  const measure = (e) => {
    let nearest = Infinity; let clearance = Infinity; let own = Infinity; let equivalent = false; let limiter = null;
    for (const o of targets) {
      if (o.el === e.el || o.el.contains(e.el) || e.el.contains(o.el) || sameControl(e.el, o.el) || occluded(o, e) || backdropLink(e, o)) continue;
      const gx = Math.max(o.l - e.r, e.l - o.r, 0); const gy = Math.max(o.t - e.b, e.t - o.b, 0);
      nearest = Math.min(nearest, Math.hypot(gx, gy));
      const dx = Math.max(o.l - e.cx, 0, e.cx - o.r); const dy = Math.max(o.t - e.cy, 0, e.cy - o.b);
      let c = Math.hypot(dx, dy) - MIN / 2; // our circle against their box
      if (c < 0 && !reachableInCircle(e, o)) c = Infinity; // only meets the circle where something covers it
      if (small(o)) c = Math.min(c, Math.hypot(o.cx - e.cx, o.cy - e.cy) - MIN); // our circle against their circle
      if (c < clearance) limiter = o;
      clearance = Math.min(clearance, c);
      if (!o.vendor) own = Math.min(own, c);
      if (!small(o) && sameFn(e.el, o.el)) equivalent = true;
    }
    const vendorOnly = !e.vendor && clearance < 0 && own >= 0;
    return { styleUnapplied: styleUnapplied(e.el), fontBox: fontBox(e.el) || Boolean(limiter && fontBox(limiter.el)), w: e.w, h: e.h, inline: small(e) && inlineInText(e.el), ua: uaControl(e.el), uaResized: uaResized(e), equivalent: small(e) && equivalent, vendor: e.vendor, vendorOnly, nearest: Number.isFinite(nearest) ? nearest : null, clearance: Number.isFinite(clearance) ? clearance : null };
  };
  const pathOf = (el) => {
    if (el.id && document.querySelectorAll(`#${CSS.escape(el.id)}`).length === 1) return `#${CSS.escape(el.id)}`;
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && n !== document.documentElement; n = n.parentElement) {
      const i = [...n.parentElement.children].indexOf(n) + 1;
      parts.unshift(`${n.tagName.toLowerCase()}:nth-child(${i})`);
    }
    return `html > ${parts.join(' > ')}`;
  };
  // grouping keys: the tag chain without positions (selector pattern) and the nearest list, nav or landmark (container)
  const shapeOf = (el) => { const parts = []; for (let n = el; n && n.nodeType === 1 && n !== document.documentElement; n = n.parentElement) parts.unshift(n.tagName.toLowerCase()); return parts.join(' > '); };
  const containerOf = (el) => pathOf(el.parentElement?.closest('ul, ol, nav, footer, header, aside, form, section, main, table, [role=navigation]') || el.parentElement || el);
  // A selector that matches several elements (Lighthouse reports "div.col>ul>li>a" for every link of a list) names none of them: the first match is not the finding's element.
  // Narrow by the opening tag of the reported html, then by the engine's DOM path (childNodes indices, "1,HTML,1,BODY,..."); still several: ambiguous, never measured.
  const openTag = (h) => String(h || '').slice(0, String(h || '').indexOf('>') + 1).replace(/\s+/g, ' ').trim();
  const byDomPath = (p) => { let n = document; for (const [i, name] of (String(p).match(/\d+,[^,]+/g) || []).map((x) => x.split(','))) { n = n.childNodes[+i]; if (!n || n.nodeName !== name) return null; } return n.nodeType === 1 ? n : null; };
  const locate = (loc) => {
    let all = [];
    try { all = [...document.querySelectorAll(loc.selector)]; } catch { /* selector the DOM rejects */ }
    const tag = openTag(loc.html);
    // a path read on another load of the page (loc.same) must still be the element it was: same tag, id and href (a script may have changed the rest)
    const ident = (h) => ['^<([a-z][\\w-]*)', '\\sid="([^"]*)"', '\\shref="([^"]*)"'].map((r) => (String(h).match(new RegExp(r, 'i')) || [])[1] || '').join('|').toLowerCase();
    if (all.length === 1 && loc.same && tag && ident(all[0].outerHTML.slice(0, 400)) !== ident(loc.html)) return { el: null };
    if (all.length <= 1) return { el: all[0] || null };
    let c = all;
    if (tag) { const m = all.filter((e) => openTag(e.outerHTML) === tag); if (m.length) c = m; }
    if (c.length > 1 && loc.path) { const n = byDomPath(loc.path); if (n && c.includes(n)) c = [n]; }
    return c.length === 1 ? { el: c[0] } : { el: null, ambiguous: all.length };
  };
  const byFound = {};
  for (const raw of selectors) {
    const loc = typeof raw === 'string' ? { key: raw, selector: raw } : raw;
    const { el, ambiguous } = locate(loc);
    const t = el && outerOf(el) !== el && operable(outerOf(el)) ? outerOf(el) : el;
    byFound[loc.key ?? loc.selector] = ambiguous ? { ambiguous } : !el ? null : operable(t) ? { ...measure(box(t)), path: pathOf(t) } : { hidden: true, path: pathOf(el) };
  }
  const undersized = all ? targets.filter((e) => small(e) && !uaControl(e.el)).slice(0, 400).map((e) => ({ selector: pathOf(e.el), pattern: shapeOf(e.el), container: containerOf(e.el), html: e.el.outerHTML.slice(0, 300), tag: e.el.tagName.toLowerCase(), ...measure(e) })) : [];
  return { rows: byFound, undersized };
}

export function labelsInPage({ selectors, all }) {
  const CONTROLS = 'a[href], button, input[type=button], input[type=submit], input[type=reset], input[type=image], summary, [role=button], [role=link], [role=tab], [role=menuitem]';
  const hiddenStyle = (e, cs) => {
    if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.fontSize) === 0 || parseFloat(cs.opacity) === 0 || e.getAttribute('aria-hidden') === 'true') return true;
    if (parseFloat(cs.textIndent) <= -999) return true;
    const r = e.getBoundingClientRect();
    const clipped = /^rect\(\s*[01](px)?[ ,]+[01](px)?[ ,]+[01](px)?[ ,]+[01](px)?\s*\)$/.test(cs.clip) || /inset\((50|100)%\)/.test(cs.clipPath);
    return (cs.position === 'absolute' || cs.position === 'fixed') && (clipped || (r.width <= 1 && r.height <= 1 && cs.overflow !== 'visible'));
  };
  const hiddenWithin = (node, root) => { // any ancestor from node up to root that hides its text from the eye
    for (let e = node; e; e = e.parentElement) {
      if (hiddenStyle(e, getComputedStyle(e))) return true;
      if (e === root) break;
    }
    return false;
  };
  let primary = '', rest = '', title = false;
  const visibleLabel = (el) => {
    primary = ''; rest = ''; title = false;
    if (el.tagName === 'INPUT') return el.type === 'image' ? '' : el.value || ''; // the alt of an image input is not visible text
    const parts = [];
    const blocks = []; // text of each block-level run, in order: the first is the control's own title
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!/\S/.test(n.nodeValue) || hiddenWithin(n.parentElement, el)) continue;
      const range = document.createRange(); range.selectNodeContents(n);
      if (![...range.getClientRects()].some((r) => r.width > 0 && r.height > 0)) continue;
      parts.push(n.nodeValue);
      let b = n.parentElement;
      while (b !== el && getComputedStyle(b).display.startsWith('inline')) b = b.parentElement;
      const at = blocks.findIndex((x) => x.b === b);
      if (at < 0) blocks.push({ b, t: n.nodeValue }); else blocks[at].t += n.nodeValue;
    }
    // the title must also be the visually first block, so a reordered (column-reverse, order) layout never promotes the wrong run
    const pos = blocks.map((x) => x.b.getBoundingClientRect());
    const first = pos.reduce((m, r, i) => (r.top < pos[m].top - 1 || (Math.abs(r.top - pos[m].top) <= 1 && r.left < pos[m].left) ? i : m), 0);
    if (blocks.length > 1 && first === 0) {
      primary = blocks[0].t.replace(/\s+/g, ' ').trim();
      rest = blocks.slice(1).map((x) => x.t).join(' ').replace(/\s+/g, ' ').trim();
      const h = blocks[0].b.closest('h1,h2,h3,h4,h5,h6,[role=heading]');
      const px = (x) => parseFloat(getComputedStyle(x.b).fontSize);
      title = Boolean(h && el.contains(h)) || blocks.slice(1).every((x) => px(blocks[0]) > px(x));
    }
    // 2.5.3 applies to labels presented as text: an image-only control has none (an img alt is not visible text)
    return parts.join(' ').replace(/\s+/g, ' ').trim();
  };
  const content = (node, viaRef) => { // name from content (accname 2F): hidden by display/visibility/aria-hidden is skipped, font-size:0 and clipped text still count
    let out = '';
    for (const c of node.childNodes) {
      if (c.nodeType === 3) { out += c.nodeValue; continue; }
      if (c.nodeType !== 1) continue;
      const cs = getComputedStyle(c);
      if (!viaRef && (cs.display === 'none' || cs.visibility === 'hidden' || c.getAttribute('aria-hidden') === 'true')) continue;
      const al = c.getAttribute('aria-label');
      const block = !cs.display.startsWith('inline');
      let t;
      if (al && al.trim()) t = al;
      else if (c.tagName === 'IMG') t = c.getAttribute('alt') || '';
      else if (c.tagName === 'SVG' || c.tagName === 'svg') t = c.querySelector('title')?.textContent || '';
      else if (c.tagName === 'INPUT') t = c.value || '';
      else t = content(c, viaRef);
      out += block ? ` ${t} ` : t;
    }
    return out;
  };
  const nameOf = (el) => {
    const squash = (s) => s.replace(/\s+/g, ' ').trim();
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const t = squash(by.split(/\s+/).map((id) => document.getElementById(id)).filter(Boolean).map((n) => (n.getAttribute('aria-label') || content(n, true))).join(' '));
      if (t) return t;
    }
    const al = el.getAttribute('aria-label');
    if (al && al.trim()) return squash(al);
    if (el.tagName === 'INPUT') return squash(el.type === 'image' ? el.getAttribute('alt') || el.title || '' : el.value || el.title || '');
    return squash(content(el, false)) || squash(el.getAttribute('title') || '');
  };
  const visible = (el) => {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 1 && r.height > 1 && !el.closest('[inert]');
  };
  const pathOf = (el) => {
    if (el.id && document.querySelectorAll(`#${CSS.escape(el.id)}`).length === 1) return `#${CSS.escape(el.id)}`;
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && n !== document.documentElement; n = n.parentElement) parts.unshift(`${n.tagName.toLowerCase()}:nth-child(${[...n.parentElement.children].indexOf(n) + 1})`);
    return `html > ${parts.join(' > ')}`;
  };
  // Only a name set by aria-label/aria-labelledby (own or a descendant's) can drop visible text; a native name (content, value) holds it by construction.
  const ariaNamed = (el) => ['aria-label', 'aria-labelledby'].some((a) => (el.getAttribute(a) || '').trim()) || Boolean(el.querySelector('[aria-label], [aria-labelledby]')); // accname 2C: a descendant's aria-label replaces its text in the name
  const VALUE_ROLES = ['slider', 'spinbutton', 'progressbar', 'meter', 'scrollbar']; // their visible text is the current value, not a label
  const read = (el) => { const label = (el.tagName === 'INPUT' || ariaNamed(el)) && !VALUE_ROLES.includes(el.getAttribute('role')) ? visibleLabel(el) : ''; return { label, name: nameOf(el), ...(primary ? { primary, rest, title } : {}) }; };
  const rows = {};
  for (const s of selectors) {
    let el = null;
    try { el = document.querySelector(s); } catch { /* rejected selector */ }
    rows[s] = !el ? null : visible(el) ? { ...read(el), path: pathOf(el) } : { hidden: true, path: pathOf(el) };
  }
  const found = all ? [...document.querySelectorAll(CONTROLS)].filter(visible).slice(0, 1500).map((el) => ({ selector: pathOf(el), html: el.outerHTML.slice(0, 300), ...read(el) })).filter((x) => x.label && x.name) : [];
  return { rows, found };
}

export function contrastInPage({ selectors }) {
  // any computed colour (oklch, lab, color(srgb ...) from Tailwind v4 or color-mix) is read through a 1x1 canvas; a colour neither route reads sets `unparsed`
  let ctx = null; try { ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true }); } catch { /* no canvas */ }
  let unparsed = false;
  const parse = (css) => {
    const m = css.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)$/);
    if (m) return [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4])];
    if (ctx && css) {
      try {
        ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = '#010203'; ctx.fillStyle = css;
        const ok = ctx.fillStyle !== '#010203'; // an invalid colour leaves the sentinel
        ctx.fillRect(0, 0, 1, 1);
        const d = ctx.getImageData(0, 0, 1, 1).data;
        if (ok) return d[3] === 0 ? [0, 0, 0, 0] : [d[0], d[1], d[2], d[3] / 255];
      } catch { /* fall through */ }
    }
    if (css) unparsed = true;
    return null;
  };
  const out = {};
  for (const s of selectors) {
    let el = null;
    try { el = document.querySelector(s); } catch { /* rejected selector */ }
    if (!el) { out[s] = null; continue; }
    unparsed = false;
    const cs = getComputedStyle(el);
    let opacity = 1; let image = false; let translucent = false; let owner = false; const layers = [];
    for (let e = el; e; e = e.parentElement) {
      const c = getComputedStyle(e);
      const bg = parse(c.backgroundColor);
      const op = parseFloat(c.opacity);
      if (owner) { if (op < 0.99) translucent = true; continue; }
      if (c.backgroundImage !== 'none') image = true;
      if (bg && bg[3] > 0) layers.push(bg);
      // An ancestor's opacity fades its background and the text together, so only elements below the background owner change the ratio; at or above it the ratio is not decidable from colours.
      if (bg && bg[3] >= 1) { owner = true; if (op < 0.99) translucent = true; } else opacity *= op;
    }
    let bg = [255, 255, 255];
    for (const l of layers.reverse()) bg = bg.map((v, i) => Math.round(l[i] * l[3] + v * (1 - l[3])));
    // No opaque ancestor: the canvas is white unless another element (a positioned sibling, an overlay, an image) paints behind the text.
    let unmeasured = null;
    if (!owner) {
      let moved = false; const sx = scrollX; const sy = scrollY;
      let r = (el.getClientRects()[0]) || el.getBoundingClientRect();
      const cx = r.left + r.width / 2; const cy = r.top + r.height / 2;
      if (r.top < 0 || r.left < 0 || r.top >= innerHeight || r.left >= innerWidth || cx < 0 || cy < 0 || cx >= innerWidth || cy >= innerHeight) { moved = true; el.scrollIntoView({ block: 'center', inline: 'center' }); r = el.getClientRects()[0] || el.getBoundingClientRect(); }
      const stack = document.elementsFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      const at = stack.indexOf(el);
      for (const n of stack.slice(at < 0 ? 0 : at + 1)) {
        if (n === el || n.contains(el) || el.contains(n)) continue;
        const c = getComputedStyle(n);
        if (c.backgroundImage !== 'none' || (parse(c.backgroundColor)?.[3] ?? 0) > 0) { unmeasured = 'no opaque backdrop behind the text and another element paints there (a positioned sibling, an overlay or an image), so white cannot be assumed'; break; }
      }
      if (moved) scrollTo(sx, sy); // leave the page where later phases expect it
    }
    const LOGO = /(^|[^a-z])logo(type|mark)?([^a-z]|$)/i;
    // the name test applies to the text itself and its own link, button, image or svg, never to a wrapper that merely sits near the word logo
    const named = (e) => e && LOGO.test(`${e.id} ${typeof e.className === 'string' ? e.className : e.className?.baseVal || ''} ${e.getAttribute('aria-label') || ''}`);
    const logo = named(el) || named(el.closest('a, button, img, svg'));
    // a control is inactive when it or its disabled-control ancestor says so; a fieldset[disabled] only disables the controls inside it (not its legend or helper text)
    const disCtl = el.closest(':disabled');
    const dis = el.closest('[aria-disabled="true"]') || (disCtl && disCtl.localName !== 'fieldset') || el.closest('label')?.control?.matches(':disabled');
    const exempt = dis ? 'inactive component (disabled control): exempt from 1.4.3'
      : logo ? 'logotype (name or class says logo): exempt from 1.4.3' : null;
    const fg = parse(cs.color) || [0, 0, 0, 1];
    // Text painted by background-clip:text, or with a transparent fill, is not drawn in cs.color over the backdrop colours read here: not measurable from computed styles.
    let clip = false;
    for (let e = el; e; e = e.parentElement) { const c = getComputedStyle(e); if (c.backgroundClip === 'text' || c.webkitBackgroundClip === 'text') { clip = true; break; } }
    const fill = parse(cs.webkitTextFillColor);
    const unpaintable = clip ? 'text is painted through background-clip:text (a gradient or image clipped to the glyphs)' : fg[3] === 0 || (fill && fill[3] === 0) ? 'the text colour or -webkit-text-fill-color is transparent, so the glyphs are painted by another technique' : null;
    out[s] = { fg, bg, opacity: Math.round(opacity * 1000) / 1000, fontPx: parseFloat(cs.fontSize), weight: parseInt(cs.fontWeight, 10) || 400, image, unpaintable, translucent, unmeasured, exempt, unparsed };
  }
  return out;
}

// ─── Applying the measurements to findings ───────────────────────────────────

const ruleOf = (v) => v.ruleId || v.rule || v.id;

/** Which viewport a target-size failure was measured at, with its clearance, and which ones pass: a reviewer who measures at 1280 must learn that the failure is at 390. */
export function targetViewportNote(res) {
  const fails = (res.measured || []).filter((m) => m.status === 'fail');
  if (!fails.length) return null;
  const size = (m) => `${m.w} x ${m.h}${m.clearance == null ? '' : `, circle clearance ${m.clearance}px`}`;
  const others = res.measured.filter((m) => m.status !== 'fail');
  return `Fails at viewport ${fails.map((m) => `${m.viewport} (${size(m)})`).join(', ')}${others.length ? `; ${others.map((m) => `${m.viewport}: ${m.status === 'n/a' ? 'not rendered' : m.status}`).join(', ')}, so measure at the failing viewport` : ''}.`;
}

function decide(v, res) {
  // The finding's own text (what the report and the exported task print) names the failing viewport.
  const note = TARGET_RULES.has(ruleOf(v)) && res.verdict === 'confirmed' ? targetViewportNote(res) : null;
  if (note && v.fix) v.fix = { ...v.fix, hint: `${String(v.fix.hint || '').replace(/\s+$/, '')}${/[.!?]$/.test(String(v.fix.hint || '').trim()) ? '' : '.'} ${note}` };
  v.evidence = { ...(v.evidence || {}), measured: res.measured, ...(res.proof ? { proof: res.proof } : {}), ...(res.visibleText !== undefined ? { visibleText: res.visibleText, accessibleName: res.accessibleName } : {}), ...(res.reason ? { reviewReason: res.reason } : {}) };
  v.verdict = res.verdict;
  if (res.verdict === 'confirmed') v.kind = 'deterministic';
  else v.reason = res.reason;
}

function addedRow(ruleId, entry, res, { url, wcagRef, hint }) {
  const v = createViolation({
    ruleId, layer: 'accessScan', category: 'accessibility', wcagRef, impact: 'serious', priority: 2,
    element: { outerHTML: entry.html, selector: entry.selector }, source: { mode: 'url', url }, fix: { deterministic: false, hint },
  });
  v.evidence = { measuredBy: 'ada-scan', measured: res.measured, proof: res.proof, ...(res.visibleText !== undefined ? { visibleText: res.visibleText, accessibleName: res.accessibleName } : {}) };
  v.kind = 'deterministic';
  v.verdict = 'confirmed';
  return v;
}

/**
 * Measures target size, label in name and (settled) contrast on the live `page` for the findings of those rules and sets their verdict from our numbers;
 * returns { added } (failures the engines skipped, ready to push). Never throws: a page that cannot be measured leaves the findings untouched.
 * The shared page is resized for the duration and put back.
 */
export async function applyMeasuredChecks(page, violations, { viewports, url = null, noHydrateJobs = false } = {}) {
  const added = [];
  const vps = (viewports?.length ? viewports : DEFAULT_AXE_VIEWPORTS).map((v) => ({ width: v.width, height: v.height }));
  const targetRows = violations.filter((v) => TARGET_RULES.has(ruleOf(v)) && v.element?.selector);
  const labelRows = violations.filter((v) => LABEL_RULES.has(ruleOf(v)) && v.element?.selector);
  const contrastRows = violations.filter((v) => CONTRAST_RULES.has(ruleOf(v)) && v.element?.selector && !v.element.framePath?.length);
  const original = page.viewportSize();
  // One measurement per (selector, reported html, engine DOM path): a selector shared by several elements is told apart by the other two.
  const locOf = (v) => ({ selector: v.element.selector, html: v.element.outerHTML || v.element.snippet || '', path: v.evidence?.path || '' });
  const locKey = (l) => `${l.selector}\u0000${l.html.slice(0, 200)}\u0000${l.path}`;
  const tLoc = [...new Map(targetRows.map((v) => { const l = locOf(v); return [locKey(l), { ...l, key: locKey(l) }]; })).values()];
  const tSel = tLoc.map((l) => l.key);
  const lSel = [...new Set(labelRows.map((v) => v.element.selector))];
  const perT = new Map(); const perL = new Map(); const tFound = new Map(); const lFound = new Map();
  try {
    for (const vp of vps) {
      await page.setViewportSize(vp);
      await page.waitForTimeout(150);
      await settleMotion(page);
      const t = await page.evaluate(targetsInPage, { selectors: tLoc, all: true });
      const l = await page.evaluate(labelsInPage, { selectors: lSel, all: true });
      for (const s of tSel) perT.set(s, [...(perT.get(s) || []), { viewport: vp, m: t.rows[s] }]);
      for (const s of lSel) perL.set(s, [...(perL.get(s) || []), { viewport: vp, m: l.rows[s] }]);
      for (const e of t.undersized) tFound.set(e.selector, { ...(tFound.get(e.selector) || { entry: e, per: [] }), per: [...(tFound.get(e.selector)?.per || []), { viewport: vp, m: e }] });
      for (const e of l.found) lFound.set(e.selector, { ...(lFound.get(e.selector) || { entry: e, per: [] }), per: [...(lFound.get(e.selector)?.per || []), { viewport: vp, m: e }] });
    }
  } catch { return { added }; } finally { if (original) await page.setViewportSize(original).catch(() => {}); }

  // A size-dependent layout that a script fixed at load time (heights, offsets, carousels) is stale after a resize: a failure at a viewport other than the loaded one is re-measured on a fresh load at that size.
  await remeasureFresh(page, url, original, perT, tLoc, tFound, noHydrateJobs);

  for (const v of targetRows) decide(v, aggregateTarget(perT.get(locKey(locOf(v))) || []));
  for (const v of labelRows) decide(v, aggregateLabel(perL.get(v.element.selector) || []));

  // Failures no engine row covers (axe skips some links): reported with our proof. An engine row covers the element its selector resolves to.
  const coveredBy = (per) => { const paths = new Set([...per.values()].flat().map((p) => p.m?.path).filter(Boolean)); return (e) => paths.has(e.selector); };
  const tCovered = coveredBy(perT); const lCovered = coveredBy(perL);
  // Only failures that passed every operability filter reach here; a list of links with one defect is one finding with N occurrences (pattern + container).
  const groups = new Map();
  for (const { entry, per } of tFound.values()) {
    if (tCovered(entry)) continue;
    const res = aggregateTarget(per.concat(vps.filter((vp) => !per.some((p) => p.viewport === vp)).map((viewport) => ({ viewport, m: null }))));
    if (res.verdict !== 'confirmed') continue;
    const key = `${entry.pattern}\u0000${entry.container}`;
    if (groups.has(key)) groups.get(key).members.push(entry.selector);
    else groups.set(key, { entry, res, members: [entry.selector] });
  }
  for (const { entry, res, members } of groups.values()) {
    const v = addedRow('TargetSize', entry, res, { url, wcagRef: 'WCAG 2.5.8', hint: `Target is smaller than 24 x 24 CSS px and its 24px circle intersects another target. ${res.proof.fact}.${members.length > 1 ? ` ${members.length} occurrences in the same container.` : ''}` });
    if (members.length > 1) v.evidence.occurrences = { count: members.length, container: entry.container, pattern: entry.pattern, selectors: members.slice(0, 20) };
    added.push(v);
  }
  let labelsAdded = 0;
  for (const { entry, per } of lFound.values()) {
    if (labelsAdded >= MAX_ADDED || lCovered(entry)) continue;
    const res = aggregateLabel(per);
    if (res.verdict === 'confirmed') { labelsAdded++; added.push(addedRow('VisibleTextPartOfAccessibleName', entry, res, { url, wcagRef: 'WCAG 2.5.3', hint: `The accessible name does not contain the visible label. ${res.proof.fact}.` })); }
  }

  if (contrastRows.length) await settleContrast(page, contrastRows).catch(() => {});
  return { added };
}

const sameSize = (a, b) => Boolean(a && b && a.width === b.width && a.height === b.height);
const loadable = (u) => /^https?:/i.test(u || '');

/**
 * Failing target measurements at a viewport other than the loaded one are re-taken on a fresh page loaded at that size and replace the resized ones
 * (a failure that only exists after a resize is not what a visitor at that width sees). Nothing is replaced when the page cannot be reloaded or the target is not found there.
 * perT: key -> [{ viewport, m }]; loc: [{ key, selector, html, path }]; found: path -> { per } for failures no engine row covers.
 */
async function remeasureFresh(page, url, original, perT, loc, found, noHydrateJobs = false) {
  const target = url || page.url();
  if (!loadable(target)) return;
  const failing = (p) => p.m && !p.m.hidden && !p.m.ambiguous && judgeTarget(p.m).status === 'fail' && !sameSize(p.viewport, original);
  const byVp = new Map();
  const note = (list, key, make) => list.forEach((p) => { if (failing(p)) { const k = `${p.viewport.width}x${p.viewport.height}`; byVp.set(k, byVp.get(k) || { viewport: p.viewport, items: [] }); byVp.get(k).items.push({ key, loc: make, p }); } });
  for (const l of loc) note(perT.get(l.key) || [], l.key, l);
  for (const [path, { entry, per }] of found) note(per, path, { key: path, selector: path, html: entry.html || '', path: '', same: true });
  for (const { viewport, items } of byVp.values()) {
    let fresh = null;
    try {
      const fp = await page.context().newPage();
      try {
        await fp.setViewportSize(viewport);
        if (noHydrateJobs) await installNoHydrateJobsRoutes(fp); // the scanned page blocks the jobs/chat widgets: the fresh one measures the same page, not a hydrated one
        await fp.goto(target, { waitUntil: 'load', timeout: 30000 });
        if (new URL(fp.url()).pathname !== new URL(target).pathname) throw new Error('fresh load landed on another document'); // redirect or splash: not the page that was measured
        await fp.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
        await fp.evaluate(async () => { for (let y = 0; y < Math.min(document.documentElement.scrollHeight, 40 * innerHeight); y += innerHeight) { scrollTo(0, y); await new Promise((r) => setTimeout(r, 40)); } scrollTo(0, 0); });
        await fp.waitForTimeout(150);
        if (noHydrateJobs) await prepareNoHydrateJobsPage(fp);
        await settleMotion(fp);
        const uniq = [...new Map(items.map((i) => [i.key, i.loc])).values()];
        fresh = (await fp.evaluate(targetsInPage, { selectors: uniq, all: false })).rows;
      } finally { await fp.close().catch(() => {}); }
    } catch { fresh = null; }
    if (!fresh) continue;
    for (const { key, p } of items) if (fresh[key]) p.m = { ...fresh[key], fresh: true };
  }
}

/** Two samples 300 ms apart on the settled page; a ratio that moves is unstable (needs-review), a Lighthouse or axe failure that the settled colours pass is needs-review too. */
async function settleContrast(page, rows) {
  const sels = [...new Set(rows.map((v) => v.element.selector))];
  await settleMotion(page);
  const first = await page.evaluate(contrastInPage, { selectors: sels });
  await page.waitForTimeout(SETTLE_GAP_MS);
  const second = await page.evaluate(contrastInPage, { selectors: sels });
  for (const v of rows) {
    const s = v.element.selector;
    if (!first[s] || !second[s]) continue; // not on this page state: the engine's verdict stands
    const x = second[s];
    const sampled = Boolean(v.evidence?.pixelContrast); // glyph pixels of a solid fill were read, a real measurement
    const hold = x.unparsed ? ['unparsed', 'a text or background colour could not be read as a number (unparsed colour format), so the ratio cannot be computed; judge the rendered colours by eye']
      : x.unpaintable ? ['unpaintable', `contrast not decidable from pixels or computed colours: ${x.unpaintable}; judge the rendered colours by eye`]
      : x.exempt ? ['exempt', `${x.exempt}; a person decides whether the exemption applies`]
      : x.translucent ? ['translucent', 'an element at or above the background owner has opacity below 1, so the rendered colours are not the computed ones; judge by eye']
      : !sampled && x.unmeasured ? ['unmeasured', `${x.unmeasured}; judge the rendered colours by eye`]
      : !sampled && x.image ? ['image', 'text over a background image or gradient, measured only by sampling; judge the worst-case area by eye']
      : null;
    if (hold) {
      v.evidence = { ...(v.evidence || {}), measured: { ...(v.evidence?.measured || {}), contrast: { state: hold[0], ratio: null, threshold: null } }, reviewReason: hold[1] };
      v.verdict = 'needs-review'; v.reason = v.evidence.reviewReason;
      continue;
    }
    const j = judgeContrast(first[s], second[s]);
    const note = (extra) => ({ ...(v.evidence?.measured || {}), contrast: { state: j.state, ratio: j.ratio == null ? null : Math.round(j.ratio * 100) / 100, threshold: j.threshold ?? null, ...extra } });
    if (j.state === 'unstable') {
      v.evidence = { ...(v.evidence || {}), measured: note({ first: j.first == null ? null : Math.round(j.first * 100) / 100 }), reviewReason: `contrast changes between two samples ${SETTLE_GAP_MS}ms apart (animation or transition in progress)` };
      v.verdict = 'needs-review'; v.reason = v.evidence.reviewReason;
    } else if (j.state === 'stable' && j.ratio >= j.threshold) {
      v.evidence = { ...(v.evidence || {}), measured: note({}), reviewReason: `contrast measured on the settled page is ${(Math.round(j.ratio * 100) / 100)}:1, at least ${j.threshold}:1; the engine sampled a state that did not hold` };
      v.verdict = 'needs-review'; v.reason = v.evidence.reviewReason;
    } else if (j.state === 'stable') {
      v.evidence = { ...(v.evidence || {}), measured: note({}) };
      // our own measurement is the proof (a glyph-pixel row keeps its sampled one)
      if (!sampled) v.evidence.proof = { type: 'computed-ratio', fact: `${Math.round(j.ratio * 100) / 100}:1 against the required ${j.threshold}:1 (text rgb(${x.fg.slice(0, 3).join(', ')}) on rgb(${x.bg.join(', ')}), ${x.fontPx}px weight ${x.weight}, settled page)` };
    }
  }
}

