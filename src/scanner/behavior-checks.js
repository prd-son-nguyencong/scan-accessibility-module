/**
 * Measured behaviour checks on the live page (docs/measured-checks.md): each finding is confirmed only from a number or an observed state
 * the tool recorded, with that measurement as the proof; anything it cannot settle is needs-review or no finding.
 *
 *  - reflow-horizontal-scroll (WCAG 1.4.10): at 320 x 568 CSS px (what 400% zoom of a 1280px window gives) the document scrolls sideways.
 *  - focus-lost-after-escape (WCAG 2.4.3): a disclosure/menu/dialog trigger (and one level of triggers inside its opened panel) opened with Enter, closed with
 *    Escape, and focus fell to <body>. Body alone is likely; confirmed only when one more Tab restarts at the top of the page or lands far from the trigger.
 *  - menu keyboard (scanMenuKeyboard): focus-lost-after-escape with focus inside the opened panel, menu-links-unreachable-by-keyboard (2.1.1),
 *    dropdown-not-dismissible-with-escape (1.4.13), aria-expanded-not-updated (4.1.2); each from real Tab / Enter / Escape / arrow presses.
 *  - role-button-not-keyboard-operable (WCAG 2.1.1): `role=button` on a non-native element that has a click listener but does not click on Enter / Space.
 */

import { scanDisclosures } from './disclosure.js';

export const REFLOW_RULE = 'reflow-horizontal-scroll';
export const FOCUS_RETURN_RULE = 'focus-lost-after-escape';
export const MENU_LINKS_RULE = 'menu-links-unreachable-by-keyboard';
export const ESCAPE_DISMISS_RULE = 'dropdown-not-dismissible-with-escape';
export const EXPANDED_STATIC_RULE = 'aria-expanded-not-updated';
export const ROLE_BUTTON_RULE = 'role-button-not-keyboard-operable';
export const REFLOW_WIDTH = 320;
export const REFLOW_HEIGHT = 568;
const SETTLE_MS = 350;
const MAX_TRIGGERS = 8;
const MAX_ROLE_BUTTONS = 12;

/** Runs in the page (serialised): is the document wider than the viewport, and which visible content sticks out. */
export function reflowInPage({ min }) {
  const root = document.scrollingElement || document.documentElement;
  const cw = root.clientWidth;
  const sw = root.scrollWidth;
  const clipped = ['html', 'body'].some((s) => /^(hidden|clip)$/.test(getComputedStyle(document.querySelector(s)).overflowX));
  const base = { scrollWidth: sw, clientWidth: cw, viewport: window.innerWidth, clippedByOverflowHidden: clipped, offenders: [], exempt: 0, fixedOffenders: [] };
  const scrolls = sw - cw > min;
  const EXEMPT = 'table, pre, canvas, svg, img, picture, video, iframe, object, embed, [role="table"], [role="grid"], [class*="map"], [class*="leaflet"], [class*="mapbox"], [class*="carousel"], [class*="slider"], [class*="swiper"], [class*="embla"]';
  const css = (el) => { if (el.id) return `${el.localName}#${CSS.escape(el.id)}`; const cls = [...el.classList].slice(0, 2).map((c) => `.${CSS.escape(c)}`).join(''); return `${el.localName}${cls}`; };
  const fixed = (el) => { for (let n = el; n && n.nodeType === 1; n = n.parentElement) if (getComputedStyle(n).position === 'fixed') return true; return false; };
  // An ancestor that scrolls or clips sideways and fits the viewport contains the overflow: it is that widget's own scrolling.
  const contained = (el) => { for (let n = el.parentElement; n && n !== document.body && n !== document.documentElement; n = n.parentElement) { if (/^(auto|scroll|hidden|clip)$/.test(getComputedStyle(n).overflowX) && n.getBoundingClientRect().right <= cw + min) return true; } return false; };
  const over = [];
  const overFixed = [];
  for (const el of document.body.querySelectorAll('*')) {
    const r = el.getBoundingClientRect();
    if (r.right <= cw + min || r.width === 0 || r.height === 0) continue;
    if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) || el.closest('[aria-hidden="true"], [inert]') || contained(el)) continue;
    if (fixed(el)) {
      if (el.closest(EXEMPT)) continue; // decorative full-bleed media is exempt here as it is elsewhere
      // Fixed content does not widen the document but is clipped and unreachable. An off-canvas drawer starts at or past the right edge: not wide fixed content on screen.
      if (r.left < cw && r.width > cw + min) overFixed.push({ el, right: Math.round(r.right), width: Math.round(r.width) });
      continue;
    }
    if (!scrolls) continue;
    if (el.closest(EXEMPT)) { base.exempt += 1; continue; }
    over.push({ el, right: Math.round(r.right), width: Math.round(r.width) });
  }
  const describe = (list) => list.filter((a) => !list.some((b) => b !== a && a.el.contains(b.el))).sort((a, b) => b.right - a.right).slice(0, 5)
    .map(({ el, right, width }) => ({ selector: css(el), right, width, text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60), html: el.outerHTML.slice(0, 300) }));
  base.fixedOffenders = describe(overFixed);
  if (!scrolls) return base;
  // The cause is the innermost element that sticks out, not the wrappers that merely contain it.
  const leaves = over.filter((a) => !over.some((b) => b !== a && a.el.contains(b.el)));
  base.offenders = leaves.sort((a, b) => b.right - a.right).slice(0, 5).map(({ el, right, width }) => ({ selector: css(el), right, width, text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60), html: el.outerHTML.slice(0, 300) }));
  base.offenderCount = leaves.length;
  return base;
}

/** Pure: the finding for a reflow measurement, or null when the document does not scroll sideways or only exempt content sticks out. */
export function judgeReflow(m) {
  if (!m) return null;
  const fixedText = (m.fixedOffenders || []).map((o) => `${o.selector} (right edge ${o.right}px, width ${o.width}px)`).join('; ');
  if (m.scrollWidth - m.clientWidth <= 1) {
    return m.fixedOffenders?.length ? { verdict: 'needs-review', reason: 'fixed-position content wider than the viewport does not make the document scroll but is clipped; check that it can be reached', fact: `fixed-position content wider than the ${REFLOW_WIDTH}px viewport: ${fixedText}` } : null;
  }
  const fact = `document scrollWidth ${m.scrollWidth} vs ${m.clientWidth} (viewport ${REFLOW_WIDTH} x ${REFLOW_HEIGHT})`;
  const widest = m.offenders.map((o) => `${o.selector} (right edge ${o.right}px, width ${o.width}px)`).join('; ');
  if (m.clippedByOverflowHidden) return { verdict: 'needs-review', reason: 'html or body has overflow-x hidden: content wider than the viewport is cut off, not scrolled; check that it is reachable', fact: `${fact}; widest: ${widest || 'none identified'}` };
  if (!m.offenders.length) return m.exempt ? null : { verdict: 'needs-review', reason: 'the document scrolls sideways but no visible element sticks out of the viewport', fact };
  return { verdict: 'confirmed', fact: `${fact}; widest: ${widest}` };
}

/** Measures reflow at 320 x 568 on the shared page, restores the viewport, returns violation rows. */
export async function scanReflow(page) {
  const original = page.viewportSize();
  let m;
  try {
    await page.setViewportSize({ width: REFLOW_WIDTH, height: REFLOW_HEIGHT });
    await page.waitForTimeout(SETTLE_MS);
    m = await page.evaluate(reflowInPage, { min: 1 });
  } finally { if (original) await page.setViewportSize(original).catch(() => {}); }
  const j = judgeReflow(m);
  if (!j) return [];
  const scrolls = m.scrollWidth - m.clientWidth > 1;
  const first = (scrolls ? m.offenders[0] : m.fixedOffenders[0]) || m.offenders[0];
  return [{
    rule: REFLOW_RULE,
    description: `At ${REFLOW_WIDTH} CSS px wide (400% zoom of a 1280px window) ${scrolls ? 'the page scrolls horizontally' : 'the document fits but fixed content is wider than the viewport'}: ${j.fact} (WCAG 1.4.10 Reflow)`,
    impact: 'serious', wcagCriteria: '1.4.10', verdict: j.verdict,
    element: first ? { text: first.text, html: first.html, selector: first.selector } : null,
    evidence: { measuredBy: 'ada-scan', measured: { scrollWidth: m.scrollWidth, clientWidth: m.clientWidth, offenders: m.offenders, fixedOffenders: m.fixedOffenders }, ...(j.verdict === 'confirmed' ? { proof: { type: 'measured-fact', fact: j.fact } } : { reviewReason: j.reason }) },
  }];
}

// ─── focus return after Escape ───────────────────────────────────────────────

const FAR_STOPS = 15; // a Tab that lands this many stops after the trigger is a jump, not "the next control"

/**
 * Pure: where one Tab went after focus was lost. `tab` = { idx, trigIdx, total, tag, label } (stop indexes in document tab order, -1 unknown) or null.
 * Restart = the first stop of the page while the trigger is not the first, a stop before the trigger, or one far after it (F85).
 */
export function judgeTabLanding(tab) {
  if (!tab || tab.idx < 0) return { restart: false, text: '' };
  const text = `<${String(tab.tag).toLowerCase()}> "${tab.label}" (stop ${tab.idx + 1} of ${tab.total}${tab.trigIdx >= 0 ? `, the trigger is stop ${tab.trigIdx + 1}` : ''})`;
  const restart = tab.trigIdx >= 0 && tab.idx !== tab.trigIdx && (tab.idx === 0 || tab.idx < tab.trigIdx || tab.idx - tab.trigIdx > FAR_STOPS);
  return { restart, text };
}

/** Pure: verdict for focus left on <body> after Escape. Body alone is not a failure (the sequential start point stays at the trigger in Chromium and Firefox); the next Tab decides. */
function judgeBodyFocus(lead, tab) {
  const t = judgeTabLanding(tab);
  if (t.restart) return { verdict: 'confirmed', fact: `${lead}; one Tab then moved focus to ${t.text}, not to the control after the trigger (focus order restarted)` };
  const where = t.text ? `one Tab then moved focus to ${t.text}, close to the trigger` : 'the next Tab position was not measurable';
  return { verdict: 'likely', fact: `${lead}; ${where}`, reason: 'focus is on <body> after Escape but the next Tab continues near the trigger: users lose their place, the focus order is not shown to be broken (best practice, not a measured 2.4.3 failure)' };
}

/** Pure: judges one trigger. `r` = { focused, opened, closed, activeIsTrigger, activeInsideTrigger, activeTag, tab }. */
export function judgeFocusReturn(r) {
  if (!r.focused || !r.opened || !r.closed) return null; // not opened by Enter, or Escape does not close it (another rule): nothing measured
  if (r.activeIsTrigger || r.activeInsideTrigger) return { verdict: 'pass' };
  if (r.activeTag === 'BODY' || r.activeTag === 'HTML') return judgeBodyFocus(`Enter on the trigger opened its panel; Escape closed it and document.activeElement is <${r.activeTag.toLowerCase()}> (focus lost), not the trigger`, r.tab);
  return null; // focus went to another control: a design choice, not measured as lost
}

/** Runs in the page (serialised): the visible triggers of an expandable panel, header/nav first. With `within` (a trigger selector): the triggers inside its opened panel, minus `exclude`. */
function triggersInPage({ max, within = null, exclude = [] }) {
  const css = (el) => { if (el.id) return `#${CSS.escape(el.id)}`; const parts = []; for (let n = el; n && n.nodeType === 1 && n !== document.documentElement; n = n.parentElement) { const i = [...n.parentElement.children].filter((c) => c.localName === n.localName).indexOf(n) + 1; parts.unshift(`${n.localName}:nth-of-type(${i})`); if (n.id) { parts[0] = `#${CSS.escape(n.id)}`; break; } } return parts.join('>'); };
  // aria-hidden on a visible, focusable control is its own defect (aria-hidden-focus), not a reason to skip the keyboard measurement; inert truly blocks focus.
  const vis = (el) => el.checkVisibility({ checkVisibilityCSS: true }) && !el.closest('[inert]') && !el.disabled;
  let root = document;
  const parent = within ? document.querySelector(within) : null;
  if (within) {
    const ids = (parent?.getAttribute('aria-controls') || '').split(/\s+/).filter(Boolean);
    root = ids.map((i) => document.getElementById(i)).find(Boolean) || parent?.closest('li') || parent?.parentElement;
    if (!root) return [];
  }
  const out = [];
  for (const el of root.querySelectorAll('button, [role="button"], a[href], summary')) {
    if (el === parent) continue;
    const open = el.getAttribute('aria-expanded');
    const declared = open !== null || (el.getAttribute('aria-haspopup') || 'false') !== 'false' || el.hasAttribute('aria-controls');
    if (!declared || el.localName === 'summary' || !vis(el) || el.tabIndex < 0) continue;
    const selector = css(el);
    if (exclude.includes(selector)) continue;
    out.push({ inNav: Boolean(el.closest('header, nav, [role="navigation"], [role="banner"]')), selector, name: (el.getAttribute('aria-label') || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60), href: el.getAttribute('href'), html: el.outerHTML.slice(0, 300) });
  }
  // a cap must not push the site navigation out behind page content
  return out.sort((a, b) => Number(b.inNav) - Number(a.inNav)).slice(0, max);
}

/** Enter on a link that leaves the page would unload it and pollute every later check: only same-page (#fragment) links are activated. */
const navigates = (href) => href !== null && href !== undefined && !/^\s*(#|javascript:)/i.test(href);

/** Runs in the page (serialised): where focus is now among the document's tab stops, and where the trigger (first of `selectors` still present) sits. */
function tabLandingInPage({ selectors }) {
  const stops = [...document.querySelectorAll('a[href], button:not([disabled]), input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex^="-"])')]
    .filter((el) => el.tabIndex >= 0 && !el.matches(':disabled') && el.checkVisibility({ visibilityProperty: true }) && !el.closest('[inert]')); // tabindex=-1 and disabled (incl. fieldset[disabled]) controls are never reached by Tab
  // a radio group is one stop (the checked radio, else the first), like the browser's own Tab order
  const radioGroup = (el) => (el.name ? `${el.form ? [...document.forms].indexOf(el.form) : ''}|${el.name}` : null);
  const checkedIn = new Set(stops.filter((el) => el.type === 'radio' && el.checked && radioGroup(el)).map(radioGroup));
  const seen = new Set();
  const tabStops = stops.filter((el) => { const g = el.type === 'radio' ? radioGroup(el) : null; return !g || (checkedIn.has(g) ? el.checked : !seen.has(g) && Boolean(seen.add(g))); });
  const a = document.activeElement;
  let trigIdx = -1;
  for (const s of selectors) { const i = tabStops.indexOf(document.querySelector(s)); if (i >= 0) { trigIdx = i; break; } }
  const onBody = !a || a === document.body || a === document.documentElement;
  return { tag: onBody ? 'BODY' : a.tagName, label: onBody ? '' : (a.getAttribute('aria-label') || a.textContent || a.localName).replace(/\s+/g, ' ').trim().slice(0, 40), idx: onBody ? -1 : tabStops.indexOf(a), trigIdx, total: tabStops.length };
}

/** One Tab from where Escape left focus: the stop it reaches, as a position among the page's tab stops. */
async function tabLanding(page, selectors) {
  await page.keyboard.press('Tab');
  await page.waitForTimeout(60);
  return page.evaluate(tabLandingInPage, { selectors });
}

const panelState = (selector) => {
  const el = document.querySelector(selector);
  const ids = (el?.getAttribute('aria-controls') || '').split(/\s+/).filter(Boolean);
  const panel = ids.map((i) => document.getElementById(i)).find(Boolean);
  const shown = (n) => { const r = n.getBoundingClientRect(); return n.checkVisibility({ checkVisibilityCSS: true }) && !n.hidden && r.width > 0 && r.height > 0; };
  return { expanded: el?.getAttribute('aria-expanded') ?? null, panel: panel ? shown(panel) : null, active: document.activeElement === el };
};
const isOpen = (s) => (s.panel !== null ? s.panel : s.expanded === 'true');

/** Closes a panel the check left open: a real click, else a scripted one (a click that waits for actionability times out on a loaded machine and would leave the page changed for the next check). */
async function toggleBack(page, selector) {
  const loc = page.locator(selector).first();
  await loc.click({ timeout: 1500 }).catch(() => loc.evaluate((el) => el.click()).catch(() => {}));
}

const MAX_NESTED = 6; // triggers driven inside one opened panel (one level deep: bounds runtime)

/** The row for a lost-focus judgement (confirmed carries the measured proof, likely carries the reason it is not proof). */
function focusLostRow(t, j, description, measured) {
  return {
    rule: FOCUS_RETURN_RULE,
    description: `${description} ${j.fact}`,
    impact: 'moderate', wcagCriteria: '2.4.3', verdict: j.verdict,
    element: { text: t.name, html: t.html, selector: t.selector },
    evidence: { measuredBy: 'ada-scan', ...(j.verdict === 'confirmed' ? { proof: { type: 'measured-fact', fact: j.fact } } : { reviewReason: j.reason }), measured },
  };
}

/** Focuses a trigger, presses Enter and reports whether its panel opened (a trigger that does not open is escaped and left). */
async function openWithEnter(page, t) {
  await page.locator(t.selector).first().focus({ timeout: 1500 });
  if (!(await page.evaluate(panelState, t.selector)).active) return false;
  await page.keyboard.press('Enter');
  await page.waitForTimeout(SETTLE_MS);
  if (isOpen(await page.evaluate(panelState, t.selector))) return true;
  await page.keyboard.press('Escape');
  return false;
}

/** Escape on an opened trigger: where focus went and, when it is on body, where one Tab goes. `parents` = selectors where focus may also legitimately return (an outer trigger). */
async function escapeAndJudge(page, t, parents = []) {
  await page.keyboard.press('Escape');
  await page.waitForTimeout(SETTLE_MS);
  const sels = [t.selector, ...parents];
  const after = await page.evaluate((s) => ({ tag: document.activeElement?.tagName || 'BODY', inside: s.some((x) => Boolean(document.querySelector(x)?.contains(document.activeElement))), isTrigger: s.some((x) => document.activeElement === document.querySelector(x)) }), sels);
  const closed = !isOpen(await page.evaluate(panelState, t.selector));
  if (!closed) await toggleBack(page, t.selector);
  const lost = closed && !after.isTrigger && !after.inside && (after.tag === 'BODY' || after.tag === 'HTML');
  const tab = lost ? await tabLanding(page, sels) : null;
  const j = judgeFocusReturn({ focused: true, opened: true, closed, activeIsTrigger: after.isTrigger, activeInsideTrigger: after.inside, activeTag: after.tag, tab });
  return j && j.verdict !== 'pass' ? focusLostRow(t, j, `After Escape closes the panel of "${t.name}", keyboard focus is on <${after.tag.toLowerCase()}>; it should return to the trigger (WCAG 2.4.3).`, { activeElement: after.tag, tabLanding: tab }) : null;
}

/** Activates each trigger with the keyboard, closes with Escape, reports where focus went; then the same for one level of triggers inside the opened panel. Page state is restored best-effort (second Enter or click). */
export async function scanFocusReturn(page) {
  const triggers = await page.evaluate(triggersInPage, { max: MAX_TRIGGERS });
  const top = triggers.map((t) => t.selector);
  const rows = [];
  for (const t of triggers) {
    if (navigates(t.href)) continue; // Enter on a real link would navigate away mid-scan
    try {
      if (isOpen(await page.evaluate(panelState, t.selector))) continue; // opens at load: closing it first would test a different state
      if (!(await openWithEnter(page, t))) continue;
      // Submenus only exist once the parent is open ("Our Brands", "Career Areas"): drive them while it is.
      let drove = false;
      for (const n of await page.evaluate(triggersInPage, { max: MAX_NESTED, within: t.selector, exclude: top })) {
        if (navigates(n.href)) continue;
        try {
          if (!isOpen(await page.evaluate(panelState, t.selector)) && !(await openWithEnter(page, t))) break; // a previous Escape closed the whole menu
          if (isOpen(await page.evaluate(panelState, n.selector)) || !(await openWithEnter(page, n))) continue;
          drove = true;
          const row = await escapeAndJudge(page, n, [t.selector]);
          if (row) rows.push(row);
        } catch { /* this submenu trigger could not be driven: no finding */ }
      }
      if (drove) { // the outer Escape probe starts from the state Enter on the trigger leaves (focus may be inside the panel), not from where the submenu probes ended
        if (isOpen(await page.evaluate(panelState, t.selector))) await toggleBack(page, t.selector);
        if (!(await openWithEnter(page, t))) continue;
      }
      const row = await escapeAndJudge(page, t);
      if (row) rows.push(row);
    } catch { /* this trigger could not be driven: no finding */ }
  }
  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
  return rows;
}

// ─── menu keyboard behaviour: reachability, Escape inside the panel, Escape on hover/focus content, aria-expanded updates ───

const REACH_TABS = 10; // Tab presses tried after ArrowDown; a panel later in the DOM order than this is not measured as reachable

/**
 * Pure: links that appeared when the menu opened were never focused by Tab or ArrowDown. Needs links to have been measured.
 * A tabbable link that precedes the trigger is reached by Tab from the previous stop (the forward walk from the trigger cannot get there): it is set aside and
 * the other new links are judged on their own. A tabbable link after the trigger sits `stops` tab stops away: within REACH_TABS the walk covers it, so a miss is
 * a real defect (confirmed); beyond it (or with the distance unknown) the walk stopped short, so needs-review. A link outside the tab order (tabindex -1) confirms, and when any exist only they are judged (a far tabbable sibling cannot make them undecidable); likewise a tabbable link within the walk confirms and a farther link beside it cannot demote it. Only when every remaining link is beyond the walk (or its distance is unknown) is it needs-review.
 */
export function judgeLinksReachable({ newLinks, reached }) {
  let links = newLinks.filter((l) => !(l.tabbable && l.before));
  if (!links.length || reached) return null;
  // Links outside the tab order are unreachable whatever a far-away tabbable control does: judge and report only those.
  if (links.some((l) => !l.tabbable)) links = links.filter((l) => !l.tabbable);
  // A tabbable link within the walk that was not reached is a real miss whatever a farther link does: judge and report only those.
  else if (links.some((l) => l.stops <= REACH_TABS)) links = links.filter((l) => l.stops <= REACH_TABS);
  const fact = `Enter opened the menu and ${links.length} link(s) became visible (first: ${links[0].label}); ArrowDown and the next ${REACH_TABS} Tab presses did not put focus on any of them (tabindex ${[...new Set(links.map((l) => l.tabindex ?? 'none'))].join('/')})`;
  const beyond = links.filter((l) => l.tabbable && !(l.stops <= REACH_TABS));
  if (beyond.length) return { verdict: 'needs-review', fact, reason: `${beyond.length} of the new link(s) are in the page's tab order but follow the trigger by more than the ${REACH_TABS} Tab presses tried: the walk may have stopped short, so keyboard reachability is not shown to be broken` };
  return { verdict: 'confirmed', fact };
}

/** Pure: focus moved inside the opened panel, then Escape closed it; focus on the trigger (or still in the panel) is fine, focus on body is likely and confirmed only by the Tab landing (see judgeFocusReturn). */
export function judgeEscapeInsidePanel({ focusedInside, closed, activeIsTrigger, activeTag, tab }) {
  if (!focusedInside || !closed || activeIsTrigger) return null;
  if (activeTag === 'BODY' || activeTag === 'HTML') return judgeBodyFocus(`focus was on a link inside the opened panel; Escape closed it and document.activeElement is <${activeTag.toLowerCase()}> (focus lost), not the trigger`, tab);
  return null;
}

/**
 * Pure: content that appeared on keyboard focus alone and stayed after Escape (with focus on the trigger, and inside the panel when it could be reached).
 * Confirmed only at the viewport the page was loaded at: after a viewport change the page's own scripts keep the handlers they bound for the load width
 * (a width test at load), so what opens on focus there is not what a visitor at that width gets: needs-review. (The focused trigger is rendered by construction.)
 */
export function judgeEscapeDismiss({ openedOnFocus, openAfterEscape, openAfterEscapeInside, resized = false }) {
  if (!openedOnFocus || !openAfterEscape || openAfterEscapeInside === false) return null;
  const fact = `the panel opened when the trigger received keyboard focus (no activation); after Escape it is still open${openAfterEscapeInside ? ' (also with focus on a link inside it)' : ''}`;
  if (resized) return { verdict: 'needs-review', fact, reason: 'measured after the viewport was resized from the one the page loaded at: handlers a script bound by window width at load stay in place, so a visitor who loads the page at this width may never get a panel that opens on focus' };
  return { verdict: 'confirmed', fact };
}

/** Pure: the trigger declares aria-expanded, the panel measurably opened, the value did not change. */
export function judgeExpandedUpdated({ hadAttr, before, after, opened }) {
  if (!hadAttr || !opened || before !== after) return null;
  return { verdict: 'confirmed', fact: `Enter opened the panel (visible after, not before) but aria-expanded stayed "${after}"` };
}

/** Runs in the page (serialised): visible focusable controls as paths, the focused path, and the trigger state. */
function menuSnapshot(selector) {
  const css = (el) => { if (el.id) return `#${CSS.escape(el.id)}`; const parts = []; for (let n = el; n && n.nodeType === 1 && n !== document.documentElement; n = n.parentElement) { const i = [...n.parentElement.children].filter((c) => c.localName === n.localName).indexOf(n) + 1; parts.unshift(`${n.localName}:nth-of-type(${i})`); if (n.id) { parts[0] = `#${CSS.escape(n.id)}`; break; } } return parts.join('>'); };
  const trig = document.querySelector(selector);
  const links = [];
  const ids = (trig?.getAttribute('aria-controls') || '').split(/\s+/).filter(Boolean);
  const panel = ids.map((i) => document.getElementById(i)).find(Boolean);
  const scope = trig?.closest('nav, [role="navigation"], header, footer') || trig?.parentElement;
  for (const el of document.querySelectorAll('a[href], button, [tabindex], input, select, textarea')) {
    if (el === trig || el.disabled || !el.checkVisibility({ checkVisibilityCSS: true }) || el.closest('[inert]')) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    // related: inside the controlled panel or the trigger's own nav/header/footer/parent, so a page-wide link (back to top, banner) is not read as the menu
    links.push({ related: Boolean(panel?.contains(el) || scope?.contains(el)), path: css(el), tabindex: el.getAttribute('tabindex'), tabbable: el.tabIndex >= 0, before: Boolean(trig && trig.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_PRECEDING), label: (el.getAttribute('aria-label') || el.textContent || el.localName).replace(/\s+/g, ' ').trim().slice(0, 40) });
  }
  // tab stops after the trigger, counted over the same visible focusable set; shortcut: controls outside that selector (summary, contenteditable) are not counted
  let stops = 0;
  for (const l of links) if (l.tabbable && !l.before) l.stops = ++stops;
  const a = document.activeElement;
  return { links, active: a && a !== document.body && a !== document.documentElement ? css(a) : null, tag: a?.tagName || 'BODY', isTrigger: a === trig, insideTrigger: Boolean(trig?.contains(a)), expanded: trig?.getAttribute('aria-expanded') ?? null, panel: panel ? panel.checkVisibility({ checkVisibilityCSS: true }) && !panel.hidden && panel.getBoundingClientRect().height > 0 : null };
}

/** Drives each menu trigger with real key presses and records document.activeElement and the open state before and after. Page state restored best-effort. */
export async function scanMenuKeyboard(page, { resized = false } = {}) {
  const triggers = await page.evaluate(triggersInPage, { max: 12 });
  const rows = [];
  const snap = (sel) => page.evaluate(menuSnapshot, sel);
  const press = async (k) => { await page.keyboard.press(k); await page.waitForTimeout(k === 'Tab' ? 60 : SETTLE_MS); };
  const row = (t, rule, wcag, impact, j, description, measured) => rows.push({ rule, description: `${description} ${j.fact}`, impact, wcagCriteria: wcag, verdict: j.verdict ?? 'confirmed', element: { text: t.name, html: t.html, selector: t.selector }, evidence: { measuredBy: 'ada-scan', ...(j.verdict === 'confirmed' ? { proof: { type: 'measured-fact', fact: j.fact } } : { reviewReason: j.reason }), measured } });
  for (const t of triggers) {
    try {
      await page.evaluate(() => document.activeElement?.blur?.());
      const base = await snap(t.selector);
      if (isOpen(base)) continue; // open at load: closing it first would test a different state
      await page.locator(t.selector).first().focus({ timeout: 1500 });
      const onFocus = await snap(t.selector);
      if (!onFocus.isTrigger) continue;
      const newLinks = (s) => s.links.filter((l) => l.related && !base.links.some((b) => b.path === l.path));
      const openNow = (s) => isOpen(s) || newLinks(s).length > 0;
      const reachInside = async () => { // ArrowDown then Tab until focus is on a link that appeared with the panel
        const fresh = new Set(newLinks(await snap(t.selector)).map((l) => l.path));
        for (const k of ['ArrowDown', ...Array(REACH_TABS).fill('Tab')]) {
          await press(k);
          const s = await snap(t.selector);
          if (s.active && fresh.has(s.active)) return true;
        }
        return false;
      };
      // Opened by focus alone (focus/hover menu): Escape must dismiss it (WCAG 1.4.13).
      if (openNow(onFocus)) {
        await press('Escape');
        const openAfter = openNow(await snap(t.selector));
        let openInside;
        if (openAfter) {
          if (await reachInside()) { await press('Escape'); openInside = openNow(await snap(t.selector)); }
        }
        const j = judgeEscapeDismiss({ openedOnFocus: true, openAfterEscape: openAfter, openAfterEscapeInside: openInside, resized });
        if (j) row(t, ESCAPE_DISMISS_RULE, '1.4.13', 'serious', j, `Content shown on focus of "${t.name}" cannot be dismissed with Escape (WCAG 1.4.13).`, { openOnFocus: true, openAfterEscape: openAfter, openAfterEscapeInside: openInside ?? null });
        await page.evaluate(() => document.activeElement?.blur?.()).catch(() => {});
        continue;
      }
      // Real navigation would unload the page: only same-page triggers are activated.
      if (navigates(t.href)) continue;
      await press('Enter');
      const opened = await snap(t.selector);
      const fresh = newLinks(opened);
      if (!openNow(opened)) { await press('Escape'); continue; }
      const panelOpened = isOpen(opened) && opened.panel !== null ? true : fresh.length > 0;
      const upd = judgeExpandedUpdated({ hadAttr: base.expanded !== null, before: base.expanded, after: opened.expanded, opened: panelOpened });
      if (upd) row(t, EXPANDED_STATIC_RULE, '4.1.2', 'serious', upd, `The expanded state of "${t.name}" is not updated (WCAG 4.1.2).`, { before: base.expanded, after: opened.expanded });
      const inPanel = opened.active && fresh.some((l) => l.path === opened.active);
      const reached = inPanel || await reachInside();
      const un = judgeLinksReachable({ newLinks: fresh, reached });
      if (un) row(t, MENU_LINKS_RULE, '2.1.1', 'serious', un, `The links of the menu opened by "${t.name}" cannot be reached with the keyboard (WCAG 2.1.1).`, { links: fresh.slice(0, 6) });
      if (reached) {
        await press('Escape');
        const after = await snap(t.selector);
        const closed = !openNow(after);
        const lost = closed && !(after.isTrigger || after.insideTrigger) && ['BODY', 'HTML'].includes(after.tag);
        const tab = lost ? await tabLanding(page, [t.selector]) : null;
        const j = judgeEscapeInsidePanel({ focusedInside: true, closed, activeIsTrigger: after.isTrigger || after.insideTrigger, activeTag: after.tag, tab });
        if (j) row(t, FOCUS_RETURN_RULE, '2.4.3', 'moderate', j, `After Escape closes the menu of "${t.name}" focus is on <${after.tag.toLowerCase()}> (WCAG 2.4.3).`, { activeElement: after.tag, tabLanding: tab });
      }
      // restore: close by Escape, else by activating the trigger again
      await page.locator(t.selector).first().focus({ timeout: 1500 }).catch(() => {});
      if (openNow(await snap(t.selector))) { await press('Escape'); if (openNow(await snap(t.selector))) await press('Enter'); }
    } catch { /* this trigger could not be driven: no finding */ }
  }
  await page.evaluate(() => { document.activeElement?.blur?.(); window.scrollTo(0, 0); }).catch(() => {});
  return rows;
}

// ─── role=button without keyboard operation ──────────────────────────────────

/** Pure: judges one role=button element. */
export function judgeRoleButton(r) {
  if (!r.hasClickListener) return null; // nothing the element is supposed to do is known
  if (r.hasKeyListener) return { verdict: 'needs-review', reason: 'the element or an ancestor has a key listener that may act on Enter or Space without a click' };
  if (!r.focusable) return { verdict: 'confirmed', fact: `has a click listener but cannot take keyboard focus (${r.tag} with role=button and no href or tabindex); Enter and Space cannot reach it` };
  if (r.enterClicks === 0 || r.spaceClicks === 0) {
    const missing = [r.enterClicks === 0 && 'Enter', r.spaceClicks === 0 && 'Space'].filter(Boolean).join(' and ');
    return { verdict: 'confirmed', fact: `has a click listener; with focus on it ${missing} produced 0 click events (Enter ${r.enterClicks}, Space ${r.spaceClicks})` };
  }
  return null;
}

/** Runs in the page (serialised): non-native role=button elements, without the listener facts (those come from the debugger protocol). */
function roleButtonsInPage({ max }) {
  const css = (el) => { if (el.id) return `#${CSS.escape(el.id)}`; const parts = []; for (let n = el; n && n.nodeType === 1 && n !== document.documentElement; n = n.parentElement) { const i = [...n.parentElement.children].filter((c) => c.localName === n.localName).indexOf(n) + 1; parts.unshift(`${n.localName}:nth-of-type(${i})`); if (n.id) { parts[0] = `#${CSS.escape(n.id)}`; break; } } return parts.join('>'); };
  return [...document.querySelectorAll('[role="button"]')]
    .filter((el) => !['button', 'input', 'summary'].includes(el.localName) && !(el.localName === 'a' && el.hasAttribute('href')) && el.checkVisibility({ checkVisibilityCSS: true }) && !el.closest('[inert], [aria-hidden="true"]') && el.getAttribute('aria-disabled') !== 'true')
    .slice(0, max).map((el) => ({ selector: css(el), tag: el.localName, name: (el.getAttribute('aria-label') || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60), html: el.outerHTML.slice(0, 300), onclick: el.hasAttribute('onclick') || typeof el.onclick === 'function', hasKeyAttr: ['onkeydown', 'onkeyup', 'onkeypress'].some((a) => el.hasAttribute(a)) }));
}

/** Listener facts via DevTools: click on the element, key listeners on the element and its ancestors up to body. Null when the protocol is unavailable. */
async function listenerFacts(page, cdp, selector) {
  const out = { click: false, key: false };
  for (let depth = 0; depth < 12; depth += 1) {
    const { result } = await cdp.send('Runtime.evaluate', { expression: `(() => { let n = document.querySelector(${JSON.stringify(selector)}); for (let i = 0; i < ${depth} && n; i += 1) n = n.parentElement; return n && n !== document.body && n !== document.documentElement ? n : null; })()` });
    if (!result.objectId) break;
    const { listeners } = await cdp.send('DOMDebugger.getEventListeners', { objectId: result.objectId });
    for (const l of listeners) {
      if (depth === 0 && l.type === 'click') out.click = true;
      if (/^key(down|up|press)$/.test(l.type)) out.key = true;
    }
  }
  return out;
}

export async function scanRoleButtons(page) {
  const found = await page.evaluate(roleButtonsInPage, { max: MAX_ROLE_BUTTONS });
  if (!found.length) return [];
  let cdp = null;
  try { cdp = await page.context().newCDPSession(page); } catch { /* not chromium: only onclick attributes are known */ }
  const rows = [];
  try {
    for (const c of found) {
      try {
        const facts = cdp ? await listenerFacts(page, cdp, c.selector) : { click: false, key: false };
        const r = { tag: c.tag, hasClickListener: facts.click || c.onclick, hasKeyListener: facts.key || c.hasKeyAttr, focusable: false, enterClicks: 0, spaceClicks: 0 };
        if (r.hasClickListener && !r.hasKeyListener) {
          // Count the clicks a real key press produces and swallow them, so the page's own handler does not run.
          await page.evaluate((selector) => { window.__adaClicks = 0; window.__adaOnClick = (e) => { const t = document.querySelector(selector); if (t && (e.target === t || t.contains(e.target))) { window.__adaClicks += 1; e.stopImmediatePropagation(); e.preventDefault(); } }; window.addEventListener('click', window.__adaOnClick, true); }, c.selector);
          try {
            r.focusable = await page.evaluate((selector) => { const t = document.querySelector(selector); t.focus({ preventScroll: true }); return document.activeElement === t; }, c.selector);
            if (r.focusable) {
              await page.keyboard.press('Enter');
              await page.waitForTimeout(80);
              r.enterClicks = await page.evaluate(() => { const n = window.__adaClicks; window.__adaClicks = 0; return n; });
              await page.keyboard.press('Space');
              await page.waitForTimeout(80);
              r.spaceClicks = await page.evaluate(() => window.__adaClicks);
            }
          } finally { await page.evaluate(() => { window.removeEventListener('click', window.__adaOnClick, true); }).catch(() => {}); }
        }
        const j = judgeRoleButton(r);
        if (!j || j.verdict !== 'confirmed') continue;
        rows.push({
          rule: ROLE_BUTTON_RULE,
          description: `"${c.name || c.tag}" has role=button but is not keyboard operable: ${j.fact} (WCAG 2.1.1)`,
          impact: 'serious', wcagCriteria: '2.1.1', verdict: 'confirmed',
          element: { text: c.name, html: c.html, selector: c.selector },
          evidence: { measuredBy: 'ada-scan', proof: { type: 'measured-fact', fact: j.fact }, measured: { focusable: r.focusable, enterClicks: r.enterClicks, spaceClicks: r.spaceClicks } },
        });
      } catch { /* element gone or not drivable: no finding */ }
    }
  } finally { await cdp?.detach().catch(() => {}); await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {}); }
  return rows;
}

export const MOBILE_VIEWPORT = { width: 390, height: 844 };

/** Menus that only exist below the desktop breakpoint (hamburger drawers) are driven at the mobile width, then the viewport is restored. */
async function scanMobileMenus(page) {
  const original = page.viewportSize();
  if (!original || original.width <= MOBILE_VIEWPORT.width) return [];
  const rows = [];
  // Controls already rendered at the loaded width are measured by the desktop pass: the mobile pass adds only what is not there.
  // Identity is the element object (kept in the page) or tag + id + name + href, never its markup: a resize handler or an autoplay script rewrites classes and attributes.
  await page.evaluate(() => {
    const keyOf = (n) => [n.localName, n.id, n.getAttribute('aria-label') || '', (n.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80), n.getAttribute('href') || ''].join('|');
    const els = [...document.querySelectorAll('button, [role="button"], [aria-controls], [aria-haspopup]')].filter((el) => el.checkVisibility());
    window.__adaDesktopControls = { refs: new WeakSet(els), keys: new Set(els.map(keyOf)) };
  }).catch(() => {});
  try {
    await page.setViewportSize(MOBILE_VIEWPORT);
    await page.waitForTimeout(SETTLE_MS);
    for (const run of [scanFocusReturn, (p) => scanMenuKeyboard(p, { resized: true })]) { try { rows.push(...await run(page)); } catch { /* skip this check */ } }
    // A hamburger that only renders here is not on the desktop page: its missing aria-expanded is measured at this width (rows say where they were measured, so no desktop evidence is taken for them).
    try { rows.push(...(await scanDisclosures(page, { skipDesktop: true })).map((r) => ({ ...r, evidence: { ...r.evidence, viewports: [{ name: 'mobile', ...MOBILE_VIEWPORT }] } }))); } catch { /* skip this check */ }
  } finally { await page.setViewportSize(original).catch(() => {}); await page.evaluate(() => { delete window.__adaDesktopControls; }).catch(() => {}); }
  return rows;
}

/** All checks on the shared page; each is isolated so one failure keeps the others. */
export async function scanBehaviorChecks(page) {
  const rows = [];
  for (const run of [scanRoleButtons, scanFocusReturn, scanMenuKeyboard, scanMobileMenus, scanReflow]) {
    try { rows.push(...await run(page)); } catch { /* skip this check */ }
  }
  // the trigger-level and the panel-level focus checks can both hit the same trigger: keep the stronger verdict
  const rank = (r) => ['confirmed', 'likely', 'needs-review'].indexOf(r.verdict);
  const best = (r) => rows.filter((x) => x.rule === r.rule && x.element?.selector === r.element?.selector).sort((a, b) => rank(a) - rank(b))[0];
  return rows.filter((r, i) => rows.findIndex((x) => x.rule === r.rule && x.element?.selector === r.element?.selector) === i).map(best);
}
