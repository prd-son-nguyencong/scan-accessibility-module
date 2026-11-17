import { loadVendors, matchVendor } from '../tracer/ownership.js';

// Controls that open and close something (WCAG 4.1.2: the expanded state is exposed with aria-expanded). A control is a candidate when it is visible, operable,
// has no aria-expanded and either declares what it controls (aria-controls, aria-haspopup) or looks like a disclosure by its id/class/name (hamburger, menu,
// accordion, toggle ...). The scanner activates it once in the live page and compares its target before and after, then restores the page.
export const DISCLOSURE_RULE = 'disclosure-missing-aria-expanded';
export const MENU_TRIGGER_RULE = 'menu-trigger-missing-aria-expanded';
const MAX_CANDIDATES = 12;
const SETTLE_MS = 450;

/** Pure judgement of one activation: { before, after } states of the target ({ shown, hidden, ariaHidden, height }) -> { toggled, fact }. */
export function judgeDisclosure({ before, after, targetLabel }) {
  if (!before || !after) return { toggled: false, fact: null };
  // flipped: the panel appeared or disappeared (shown, hidden attribute, aria-hidden). A height change alone also moves a load-more list or a play/pause control.
  const flipped = before.shown !== after.shown || before.hidden !== after.hidden || before.ariaHidden !== after.ariaHidden;
  const toggled = before.shown !== after.shown || before.hidden !== after.hidden || before.ariaHidden !== after.ariaHidden || Math.abs(before.height - after.height) > 1;
  const show = (s) => `${s.shown ? 'visible' : 'not visible'}, height ${Math.round(s.height)}px${s.hidden ? ', hidden' : ''}${s.ariaHidden ? `, aria-hidden=${s.ariaHidden}` : ''}`;
  return { toggled, flipped, fact: `activating the control changed ${targetLabel}: before ${show(before)}; after ${show(after)}; page state restored` };
}

/**
 * Pure: the verdict for a control without aria-expanded. Confirmed only when the panel was found through aria-controls or as an adjacent sibling, its
 * visibility flipped, it is not a dialog (APG: a dialog trigger needs no aria-expanded) and the control is not a toggle (aria-pressed, aria-checked, aria-selected or a switch/checkbox/radio role).
 * A control whose script sets aria-expanded when it is activated (`expandedAfter`, read after the click) does expose the state at runtime: only the initial collapsed state is missing,
 * which is not a clear A/AA failure, so it is needs-review, but only when the value is right. The value is compared with the real panel state measured right after the click (`panelAfter`)
 * and, when the control was activated a second time (`reactivated`), after it (`panelClosed`): a stuck or inverted value is a measured wrong state (4.1.2) and stays confirmed.
 * One whose attribute never appears stays confirmed.
 */
const isOpen = (s) => Boolean(s) && s.shown && !s.hidden && s.ariaHidden !== 'true';
export function disclosureVerdict({ judged, hasTarget, targetHow = 'fallback', isDialog = false, pressed = false, expandedAfter = null, expandedClosed = null, panelAfter = null, panelClosed = null, reactivated = false }) {
  if (!judged?.toggled) return { verdict: 'needs-review', reason: hasTarget ? 'activating the control did not change the visibility of the panel it controls' : 'no panel that toggles was found for this control' };
  const proof = { type: 'measured-fact', fact: judged.fact };
  if (isDialog) return { verdict: 'needs-review', proof, reason: 'the control opens a dialog, which needs no aria-expanded' };
  if (pressed) return { verdict: 'needs-review', proof, reason: 'the control exposes its state through aria-pressed/aria-checked/aria-selected (or is a switch/checkbox/radio): it is a toggle, not a disclosure' };
  if (expandedAfter === 'true' || expandedAfter === 'false') {
    const known = (v) => v === 'true' || v === 'false';
    const measuredPanel = (targetHow === 'controls' || targetHow === 'sibling') && judged.flipped; // a guessed or height-only panel cannot prove the value wrong
    const wrong = [];
    if (measuredPanel && panelAfter && expandedAfter !== String(isOpen(panelAfter))) wrong.push(`after the first activation the panel is ${isOpen(panelAfter) ? 'open' : 'closed'} but aria-expanded="${expandedAfter}"`);
    if (measuredPanel && reactivated && panelClosed && known(expandedClosed) && expandedClosed !== String(isOpen(panelClosed))) wrong.push(`after the second activation the panel is ${isOpen(panelClosed) ? 'open' : 'closed'} but aria-expanded="${expandedClosed}"`);
    if (wrong.length) return { verdict: 'confirmed', proof: { type: 'measured-fact', fact: `${judged.fact}; a script sets aria-expanded on activation, but the value does not match the panel: ${wrong.join('; ')}` } };
    return { verdict: 'needs-review', proof, reason: `the control has no aria-expanded in the initial DOM, but activating it makes a script set aria-expanded="${expandedAfter}"${reactivated && known(expandedClosed) ? ` (and "${expandedClosed}" when it is activated again)` : ''}: the state is exposed at runtime and only the initial collapsed state is missing` };
  }
  if (targetHow !== 'controls' && targetHow !== 'sibling') return { verdict: 'needs-review', proof, reason: 'the panel was guessed from the page (not aria-controls or an adjacent sibling), so it may not belong to this control' };
  if (!judged.flipped) return { verdict: 'needs-review', proof, reason: 'only the height of the target changed: a load-more list or a player control moves content without opening a disclosure' };
  return { verdict: 'confirmed', proof };
}

// Runs in the page. Serialised: self-contained.
export async function disclosureInPage({ max, settle, skipDesktop = false }) {
  const HINT = /hamburger|burger|menu|accordion|toggle|drawer|collapse|dropdown|disclosure|faq|expand|question/i;
  const SEL = 'button, [role="button"], [aria-haspopup]:not([aria-haspopup="false"]), [aria-controls]';
  const css = (el) => { const id = el.id ? `#${CSS.escape(el.id)}` : ''; if (id) return id; const parts = []; for (let n = el; n && n.nodeType === 1 && n !== document.documentElement; n = n.parentElement) { const i = [...n.parentElement.children].filter((c) => c.localName === n.localName).indexOf(n) + 1; parts.unshift(`${n.localName}:nth-of-type(${i})`); if (n.id) { parts[0] = `#${CSS.escape(n.id)}`; break; } } return parts.join('>'); };
  const shown = (el) => { const cs = getComputedStyle(el); const r = el.getBoundingClientRect(); return cs.display !== 'none' && cs.visibility !== 'hidden' && !el.hidden && r.width > 0 && r.height > 0; };
  const visible = (el) => el.checkVisibility({ checkVisibilityCSS: true }) && !el.closest('[inert], [aria-hidden="true"]') && shown(el) && !el.disabled;
  const state = (el) => ({ shown: shown(el), hidden: el.hidden || el.hasAttribute('hidden'), ariaHidden: el.getAttribute('aria-hidden') || '', height: Math.round(el.getBoundingClientRect().height * 10) / 10 });
  const attrsOf = (n) => ({ tag: n.localName, attrs: Object.fromEntries([...n.attributes].slice(0, 20).map((a) => [a.name, a.value.slice(0, 200)])) });
  const chainOf = (el) => { const out = []; for (let n = el; n && n.nodeType === 1 && out.length < 12; n = n.parentElement) out.push(attrsOf(n)); return out; };
  const nameOf = (el) => (el.getAttribute('aria-label') || el.textContent || el.getAttribute('title') || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  const hintOf = (el) => `${el.id} ${typeof el.className === 'string' ? el.className : ''} ${el.getAttribute('aria-label') || ''}`;
  // How the panel was found: 'controls' (aria-controls id), 'sibling' (next sibling of the control or of its parent), else 'fallback' (a guess from the page).
  const targetOf = (el) => {
    const ids = (el.getAttribute('aria-controls') || '').split(/\s+/).filter(Boolean);
    const byId = ids.map((i) => document.getElementById(i)).find(Boolean);
    if (byId) return { node: byId, how: 'controls' };
    const PANEL = '[class*="menu"],[class*="drawer"],[class*="panel"],[class*="content"],[class*="collapse"],[class*="dropdown"],[class*="nav"],[class*="answer"],[class*="body"],ul,nav,[hidden]';
    for (const s of [el.nextElementSibling, el.parentElement?.nextElementSibling]) if (s && (s.matches(PANEL) || s.querySelector(PANEL))) return { node: s.matches(PANEL) ? s : s.querySelector(PANEL), how: 'sibling' };
    const near = el.parentElement?.querySelector(`:scope > ${PANEL}`) || document.querySelector('[class*="drawer"],[class*="mobile-nav"],[class*="mobile-menu"],[class*="menu-panel"]');
    return near ? { node: near, how: 'fallback' } : null;
  };
  const isDialogNode = (n) => Boolean(n) && (n.localName === 'dialog' || /^(dialog|alertdialog)$/.test(n.getAttribute('role') || '') || n.getAttribute('aria-modal') === 'true');
  // Controls the desktop pass already measured (window.__adaDesktopControls, set by the mobile pass before it resizes): the same element object, or one with the same tag, id, name and href when a script replaced it. Markup is not compared: scripts rewrite classes and attributes.
  const desktop = skipDesktop ? window.__adaDesktopControls : null;
  const keyOf = (n) => [n.localName, n.id, n.getAttribute('aria-label') || '', (n.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80), n.getAttribute('href') || ''].join('|');
  const found = [];
  for (const el of document.querySelectorAll(SEL)) {
    if (found.length >= max) break;
    if (desktop && (desktop.refs.has(el) || desktop.keys.has(keyOf(el)))) continue;
    if (el.hasAttribute('aria-expanded') || el.closest('details') || el.localName === 'summary') continue;
    // Not disclosure widgets: ARIA tabs (aria-selected + aria-controls), menu items and options have their own state attributes; pagination and carousel dots select, they do not expand.
    if (/^(?:tab|menuitem|menuitemcheckbox|menuitemradio|option)$/.test(el.getAttribute('role') || '') || el.closest('[role="tablist"], [role="menu"], [role="menubar"], [role="listbox"], nav[aria-label*="pagination" i], [class*="pagination"], [class*="carousel-indicators"], [class*="slick-dots"], [class*="swiper-pagination"], [class*="carousel-dots"]')) continue;
    if (el.localName === 'a' && !(el.getAttribute('href') || '').startsWith('#')) continue;
    if (el.localName === 'button' && el.type === 'submit' && el.form) continue;
    const declared = el.hasAttribute('aria-controls') || (el.getAttribute('aria-haspopup') || 'false') !== 'false';
    if (!declared && !HINT.test(hintOf(el))) continue;
    if (!declared && el.getAttribute('role') === 'button' && el.localName !== 'button' && el.tabIndex < 0) continue; // not operable by keyboard: another rule
    if (!visible(el)) continue;
    found.push(el);
  }
  const results = [];
  for (const el of found) {
    const found_ = targetOf(el);
    const target = found_?.node;
    const res = { targetHow: found_?.how || 'none', isDialog: el.getAttribute('aria-haspopup') === 'dialog' || isDialogNode(target), pressed: ['aria-pressed', 'aria-checked', 'aria-selected'].some((a) => el.hasAttribute(a)) || ['switch', 'checkbox', 'radio'].includes(el.getAttribute('role')), selector: css(el), html: el.outerHTML.slice(0, 400), name: nameOf(el), haspopup: (el.getAttribute('aria-haspopup') || 'false') !== 'false', controls: el.getAttribute('aria-controls') || '', chain: chainOf(el), hasTarget: Boolean(target), targetLabel: target ? `${target.localName}${target.id ? `#${target.id}` : ''}` : '', before: null, after: null, closed: null, reactivated: false };
    if (target) {
      const saved = [[target, ['class', 'style', 'hidden', 'aria-hidden']], [el, ['class', 'style', 'aria-pressed', 'aria-expanded']]].map(([n, names]) => [n, names.map((a) => [a, n.getAttribute(a)])]);
      const stop = (e) => { const a = e.target.closest?.('a, button[type="submit"]'); if (a) e.preventDefault(); };
      document.addEventListener('click', stop, true);
      try {
        res.before = state(target);
        el.click();
        await new Promise((r) => setTimeout(r, settle));
        res.after = state(target);
        res.expandedAfter = el.getAttribute('aria-expanded'); // a script may set the state on activation: read it before the control is activated again
        res.reactivated = shown(el);
        if (res.reactivated) el.click(); // activate again to close what it opened; when skipped, expandedClosed would only repeat expandedAfter
        await new Promise((r) => setTimeout(r, settle / 2));
        res.closed = state(target);
        res.expandedClosed = res.reactivated ? el.getAttribute('aria-expanded') : null;
      } finally {
        document.removeEventListener('click', stop, true);
        for (const [n, list] of saved) for (const [a, v] of list) { if (v === null) n.removeAttribute(a); else n.setAttribute(a, v); }
      }
    }
    results.push(res);
  }
  return results;
}

/** Disclosure controls of the page without aria-expanded, measured: violation rows for dynamicContent (rule id by aria-haspopup). */
export async function scanDisclosures(page, { vendors = loadVendors(), skipDesktop = false } = {}) {
  const found = await page.evaluate(disclosureInPage, { max: MAX_CANDIDATES, settle: SETTLE_MS, skipDesktop });
  const rows = [];
  for (const c of found) {
    // A consent banner or other vendor control is not the site's to fix, whatever it looks like.
    if (matchVendor(c.chain, vendors)) continue;
    const judged = judgeDisclosure({ before: c.before, after: c.after, targetLabel: c.targetLabel || 'its panel' });
    const v = disclosureVerdict({ judged, hasTarget: c.hasTarget, targetHow: c.targetHow, isDialog: c.isDialog, pressed: c.pressed, expandedAfter: c.expandedAfter, expandedClosed: c.expandedClosed, panelAfter: c.after, panelClosed: c.closed, reactivated: c.reactivated });
    const rule = c.haspopup ? MENU_TRIGGER_RULE : DISCLOSURE_RULE;
    rows.push({
      rule,
      description: `Control "${c.name}" opens and closes content but has no aria-expanded attribute (WCAG 4.1.2)${v.proof ? `. ${v.proof.fact}` : ''}`,
      impact: 'serious',
      wcagCriteria: '4.1.2',
      verdict: v.verdict,
      element: { text: c.name, html: c.html, selector: c.selector },
      evidence: { measuredBy: 'ada-scan', ...(v.proof && v.verdict === 'confirmed' ? { proof: v.proof } : {}), ...(v.reason ? { reviewReason: v.reason } : {}), measured: { before: c.before, after: c.after, ...(c.expandedAfter != null ? { expandedAfter: c.expandedAfter, expandedClosed: c.expandedClosed, reactivated: c.reactivated } : {}) } },
    });
  }
  return rows;
}

export const NEW_TAB_NOTICE_RULE = 'link-new-tab-notice-without-target';
export const NEW_TAB_NOTICE = /\bopens?\s+in\s+(?:a\s+)?new\s+(?:tab|window)\b/i;

// Runs in the page: links whose name announces a new tab or window but that carry no target=_blank (the inverse, target=_blank without a notice, is LinkOpensNewWindow).
function newTabNoticeInPage({ source, max }) {
  const rx = new RegExp(source, 'i');
  const css = (el) => { if (el.id) return `#${CSS.escape(el.id)}`; const parts = []; for (let n = el; n && n.nodeType === 1 && n !== document.documentElement; n = n.parentElement) { const i = [...n.parentElement.children].filter((c) => c.localName === n.localName).indexOf(n) + 1; parts.unshift(`${n.localName}:nth-of-type(${i})`); if (n.id) { parts[0] = `#${CSS.escape(n.id)}`; break; } } return parts.join('>'); };
  return [...document.querySelectorAll('a[href]')]
    .filter((a) => (a.target || '').toLowerCase() !== '_blank' && rx.test(`${a.getAttribute('aria-label') || ''} ${a.getAttribute('title') || ''} ${a.textContent || ''}`) && a.checkVisibility())
    .slice(0, max).map((a) => ({ selector: css(a), html: a.outerHTML.slice(0, 400), name: (a.getAttribute('aria-label') || a.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80), target: a.getAttribute('target') || '' }));
}

/** needs-review rows: the name promises a new tab, the markup does not open one (a script may). Static markup fact, so never confirmed. */
export async function scanNewTabNotices(page) {
  const found = await page.evaluate(newTabNoticeInPage, { source: NEW_TAB_NOTICE.source, max: 20 });
  return found.map((c) => ({
    rule: NEW_TAB_NOTICE_RULE,
    description: `Link "${c.name}" says it opens in a new tab or window but has no target="_blank"${c.target ? ` (target="${c.target}")` : ''}; the notice is misleading unless a script opens the window (WCAG 3.2.5)`,
    impact: 'minor', wcagCriteria: '3.2.5', verdict: 'needs-review',
    element: { text: c.name, html: c.html, selector: c.selector },
    evidence: { measuredBy: 'ada-scan', reviewReason: 'a script may open the new window; the markup alone does not show it' },
  }));
}
