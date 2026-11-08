// svg-img-alt (axe and Lighthouse) fires on every <svg role="img"> without a name, including the decorative icon inside a button or link that already
// has its own accessible name. There the svg is child content of a named control (a button's children are presentational per ARIA) and adds nothing
// to announce, so the row is a question for a person, never a confirmed 1.1.1 failure. A control whose only content is the unnamed svg stays confirmed.

export const SVG_NAME_RULES = new Set(['svg-img-alt']);

/** Runs in the page. Per selector: null (not found / not an svg in a control) or the name that the enclosing control already has from something other than the svg. */
export function svgControlNameInPage({ selectors }) {
  const squash = (t) => String(t || '').replace(/\s+/g, ' ').trim();
  const nameOfControl = (ctl, svg) => {
    const byRef = (ctl.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean).map((id) => document.getElementById(id)).filter((e) => e && !svg.contains(e)).map((e) => squash(e.textContent)).join(' ').trim();
    if (byRef) return byRef;
    const al = squash(ctl.getAttribute('aria-label'));
    if (al) return al;
    let text = '';
    const walker = document.createTreeWalker(ctl, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const p = n.parentElement;
      if (!p || svg.contains(p) || !p.checkVisibility?.({ visibilityProperty: true }) || p.closest('[aria-hidden="true"]')) continue; // hidden and aria-hidden text is not part of the name
      text += ` ${n.nodeValue}`;
    }
    for (const img of ctl.querySelectorAll('img[alt]')) if (!svg.contains(img) && !img.closest('[aria-hidden="true"]')) text += ` ${img.getAttribute('alt')}`;
    return squash(text) || squash(ctl.getAttribute('title'));
  };
  const out = {};
  for (const s of selectors) {
    let el = null;
    try { el = document.querySelector(s); } catch { /* rejected selector */ }
    const svg = el && el.closest('svg');
    const ctl = svg && svg.parentElement && svg.parentElement.closest('button, a[href], [role="button"], [role="link"]');
    out[s] = ctl ? nameOfControl(ctl, svg) || null : null;
  }
  return out;
}

/** Caps svg-img-alt rows whose svg sits in a control that is named without it at needs-review. Returns the number capped. Never throws. */
export async function applySvgChildOfNamedControl(page, violations) {
  const rows = violations.filter((v) => SVG_NAME_RULES.has(v.ruleId || v.rule || v.id) && v.element?.selector && !v.element.framePath?.length && v.verdict !== 'needs-review');
  if (!rows.length) return 0;
  let names;
  try { names = await page.evaluate(svgControlNameInPage, { selectors: [...new Set(rows.map((v) => v.element.selector))] }); } catch { return 0; }
  let n = 0;
  for (const v of rows) {
    const name = names[v.element.selector];
    if (!name) continue;
    const reason = `the svg is child content of a button or link that is already named "${name.slice(0, 80)}": presentational, nothing to announce; judge whether the icon adds meaning`;
    v.verdict = 'needs-review';
    v.reason = reason;
    v.evidence = { ...(v.evidence || {}), reviewReason: reason };
    if (v.evidence.proof) delete v.evidence.proof;
    n++;
  }
  return n;
}
