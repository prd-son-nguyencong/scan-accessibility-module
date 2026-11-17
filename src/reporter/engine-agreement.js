// Cross-engine agreement (T-E11.4): which independent engines report the same problem on the same element.
import { canonicalizeRuleId } from './rule-aliases.js';

export const AGREEMENT_POLICIES = ['strict', 'off'];

// Equivalent checks under different engine rule ids. Ids are matched case-insensitively after canonicalizeRuleId.
const FAMILY_IDS = {
  'image-name': ['image-alt', 'ImageDiscernible', 'html-validate:wcag/h37'],
  'button-name': ['button-name', 'ButtonDiscernible'],
  'link-name': ['link-name', 'LinkAnchorDiscernible', 'LinkNavigationDiscernible', 'html-validate:wcag/h30'],
  'form-control-name': ['label', 'select-name', 'input-button-name', 'FormFieldDiscernible', 'CheckboxDiscernible', 'RadioDiscernible', 'html-validate:input-missing-label'],
  'frame-name': ['frame-title', 'IframeDiscernible'],
  'html-lang': ['html-has-lang', 'HtmlLang', 'html-missing-lang'],
  'html-lang-valid': ['html-lang-valid', 'HtmlLangValid'],
  'page-title': ['document-title', 'PageTitleValid', 'page-missing-title'],
  'skip-link': ['skip-link', 'skip-link-target-missing', 'skip-link-missing', 'bypass'],
  'landmark-main': ['landmark-one-main', 'missing-main-landmark'],
  'heading-one': ['page-has-heading-one', 'no-headings', 'missing-h1'],
  'aria-prohibited': ['aria-prohibited-attr', 'html-validate:aria-label-misuse', 'AriaLabelMisuse'],
  'meta-viewport': ['meta-viewport', 'PageMetaViewportValid'],
  'meta-refresh': ['meta-refresh', 'MetaRefresh'],
  'target-size': ['target-size', 'TargetSize'],
  'label-in-name': ['label-content-name-mismatch', 'VisibleTextPartOfAccessibleName'],
  'duplicate-id': ['duplicate-id', 'duplicate-id-aria', 'duplicate-id-referenced', 'html-validate:no-dup-id'],
  'focus-visible': ['focus-indicator-removed', 'focus-not-visible'],
  'heading-order': ['heading-order', 'heading-level-skipped'],
  'empty-heading': ['empty-heading'],
  'aria-idref': ['aria-valid-attr-value', 'AriaLabelledByHasReference', 'AriaDescribedByHasReference'], // aria-labelledby/-describedby naming an id that is not in the DOM
};
// Findings that are a symptom of another root cause, not a defect of their own: derived rule -> families of the root cause it merges into.
// axe 'region' (content outside landmarks) on the skip link element, or on any page that has no main landmark, is the skip-link / landmark-main defect.
export const DERIVED_PAIRS = Object.freeze({ region: ['skip-link', 'landmark-main'] });
// Checks about the document as a whole: engines anchor them on different elements (html, head, body), so the page is the element.
export const PAGE_LEVEL = new Set(['html-lang', 'page-title', 'landmark-main', 'heading-one']);
const FAMILY = new Map(Object.entries(FAMILY_IDS).flatMap(([family, ids]) => ids.map((id) => [id.toLowerCase(), family])));

// Lighthouse a11y audits are axe-core audits: they confirm nothing axe has not already said.
const LINEAGE = { lighthouse: 'axe' };

const messageOf = (f) => String(f.evidence?.message ?? f.fix?.hint ?? '');
// html-validate reports page title and html lang through generic rules; the element and message say which check it was.
function contextFamily(f) {
  const tag = (f.element?.outerHTML || '').match(/^<([a-z]+)/i)?.[1]?.toLowerCase();
  if (f.nativeRuleId === 'html-validate:element-required-attributes' && tag === 'html' && /\blang\b/i.test(messageOf(f))) return 'html-lang';
  if (f.nativeRuleId === 'html-validate:element-required-content' && (tag === 'head' || tag === 'title') && /\btitle\b/i.test(messageOf(f))) return 'page-title';
  return null;
}
export const familyOf = (f) => FAMILY.get(String(canonicalizeRuleId(f.nativeRuleId)).toLowerCase())
  ?? FAMILY.get(String(f.nativeRuleId).toLowerCase()) ?? contextFamily(f);
// Selectors differ between engines (Lighthouse paths vs axe targets); the opening tag is the common denominator.
// Engines serialize one tag differently: void elements as `<img ...>` or `<img ... />`, and src/href as written (`/a.svg`) or resolved (`http://host/a.svg`).
const openTag = (f) => (f.element?.outerHTML || '').match(/^<[^>]*>/)?.[0]?.replace(/\s*\/>$/, '>').replace(/(\s(?:src|href)=["'])https?:\/\/[^/"']+/gi, '$1') || null;
// Engines also truncate the markup they quote (axe `...">`, Lighthouse `…">`, a serializer cut mid-attribute): compare what both still show.
const tagHead = (f) => (f.element?.outerHTML || '').replace(/(?:…|\.\.\.)[\s\S]*$/, '').replace(/\s*\/?>$/, '');
// A complete tag (ends with `>`, no ellipsis) is never a prefix of another element; only a cut tag may match by head.
const isCut = (f) => { const h = f.element?.outerHTML || ''; return /(?:…|\.\.\.)/.test(h) || !/>\s*$/.test(h); };
const sameTagHead = (a, b) => {
  const x = tagHead(a); const y = tagHead(b);
  const [short, long, cut] = x.length <= y.length ? [x, y, a] : [y, x, b];
  return isCut(cut) && short.length >= 24 && long.startsWith(short);
};
export const sameElement = (a, b) => (a.element?.selector && a.element.selector === b.element?.selector)
  || (openTag(a) && openTag(a) === openTag(b)) || sameTagHead(a, b);

// The visible text of complete markup (an opening tag through its closing tag, nothing cut); null when the quote is partial or has no text.
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const wholeText = (f) => {
  const h = f.element?.outerHTML || '';
  if (/(?:…|\.\.\.)/.test(h) || !/<\/[a-z][\w-]*>\s*$/i.test(h)) return null;
  const t = h.replace(/<[^>]*>/g, ' ').replace(/&(#39|#x27|amp|lt|gt|quot|apos|nbsp);/gi, (_, e) => ENTITIES[e.toLowerCase()] ?? "'").replace(/\s+/g, ' ').trim().toLowerCase();
  return t || null;
};

/**
 * Two rows that cannot be one element: both quote an opening tag and the tag names differ, both carry an id and the ids differ, or both quote complete markup with different visible text
 * (the EN and FR links of one language switch sit on one authoring line and are two targets).
 * Selector, source line and markup of a merged finding must describe one element; this is the guard that keeps look-alike rows apart.
 */
export const distinctElements = (a, b) => {
  const x = openTag(a); const y = openTag(b);
  if (!x || !y) return false;
  if (x.match(/^<([\w-]+)/)?.[1]?.toLowerCase() !== y.match(/^<([\w-]+)/)?.[1]?.toLowerCase()) return true;
  const ia = attrId(x); const ib = attrId(y);
  if (ia && ib && ia !== ib) return true;
  const ta = wholeText(a); const tb = wholeText(b);
  return Boolean(ta && tb && ta !== tb);
};

/**
 * Adds enginesAgreeing (layers that report this problem here) and agreement (multi | single-deterministic |
 * single-heuristic) to each finding of one page, and under policy 'strict' moves a single-heuristic finding to
 * needs-review. Confirmed findings from a deterministic kind are never touched, so the gate math does not move.
 * shortcut: elements are matched by selector or opening tag only; upgrade to a DOM-path match if engines disagree on both.
 */
export function annotateAgreement(findings, policy = 'strict') {
  const families = findings.map(familyOf);
  findings.forEach((f, i) => {
    const engines = new Set(f.layers);
    if (families[i]) {
      findings.forEach((g, j) => {
        if (j !== i && families[j] === families[i] && g.pageState === f.pageState && sameElement(f, g)) g.layers.forEach((l) => engines.add(l));
      });
    }
    f.enginesAgreeing = [...engines].sort();
    const independent = new Set(f.enginesAgreeing.map((e) => LINEAGE[e] || e)).size;
    f.agreement = independent >= 2 ? 'multi' : f.kind === 'deterministic' ? 'single-deterministic' : 'single-heuristic';
    if (policy === 'strict' && f.agreement === 'single-heuristic' && f.verdict !== 'needs-review') {
      f.verdictBeforeAgreement = f.verdict;
      f.verdict = 'needs-review';
    }
  });
  return findings;
}

const attrId = (html) => (String(html || '').match(/^<[^>]*?\sid=["']([^"']+)["']/i) || [])[1] || null;
const textOf = (html) => String(html || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 60);
const parentSelector = (selector) => String(selector || '').replace(/\s*>\s*[^>\s]+$/, '');

/**
 * Root causes that are not one element: the problem is a value (an id, a heading's text, a list's role structure) that several engines and several
 * elements report differently. Findings of one family with the same key on one page state are ONE finding, whatever layer or element reported them.
 * Returns null when the finding is not of such a family or the key cannot be read (it then merges by element as before).
 * shortcut: the key is read from the message, markup and selector the engines give; upgrade to a DOM-path key if an engine stops quoting them.
 */
export function rootCauseKey(f) {
  const family = familyOf(f);
  const msg = messageOf(f);
  const html = f.element?.outerHTML || '';
  const rule = String(f.nativeRuleId).toLowerCase();
  if (family === 'duplicate-id') {
    const id = f.observation?.evidence?.id
      || (msg.match(/^Duplicate ID "([^"]+)"/) || [])[1] || (msg.match(/^id "([^"]+)" is on/) || [])[1]
      || attrId(html) || (String(f.element?.selector || '').match(/^#([\w-]+)$/) || [])[1];
    return id ? `duplicate-id:${id}` : null;
  }
  if (family === 'heading-order') {
    const text = ((msg.match(/\("([^"]*)"\)\s/) || [])[1] || textOf(html)).toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 60);
    return text ? `heading-order:${text}` : null;
  }
  // No skip link at all has no element to match on (axe bypass, keyboard skip-link-missing); a skip link that exists merges by its element.
  if (rule === 'skip-link-missing' || rule === 'bypass') return 'skip-link-absent';
  if (rule === 'aria-allowed-role' && /^<li\b[^>]*\srole=["']group["']/i.test(html) && f.element?.selector) {
    // axe names a list item by its own attributes (no parent in the selector): one authoring line is then one list.
    const parent = parentSelector(f.element.selector);
    return `list-group:${parent !== f.element.selector ? parent : f.source?.file && f.source.line ? `${f.source.file}:${f.source.line}` : parent}`;
  }
  if (rule === 'aria-required-children' && /^<(ul|ol)\b|^<[^>]*\srole=["']list["']/i.test(html) && f.element?.selector) return `list-group:${f.element.selector}`;
  return null;
}
