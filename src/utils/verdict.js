// Finding verdicts (T-E11.2): how sure a finding is. Only 'confirmed' findings fail a gate or --fail-on-violations.
export const VERDICTS = ['confirmed', 'likely', 'needs-review'];

// Layers with no rule registry: kind per layer. The behavioural layers fall back to heuristic here; their rules have explicit
// kinds in BEHAVIORAL_RULES below (a contract test fails when an emitted rule id has no entry).
const LAYER_KIND = {
  axe: 'deterministic', w3c: 'deterministic', htmlValidate: 'deterministic', lighthouse: 'deterministic', links: 'deterministic',
  keyboard: 'heuristic', focusTrap: 'heuristic', ariaLive: 'heuristic', dynamicContent: 'heuristic', screenReader: 'heuristic',
};

export const kindForLayer = (layer) => LAYER_KIND[layer] || 'heuristic';

const D = 'deterministic';
const H = 'heuristic';
// ruleId -> [kind, one-line rationale]. deterministic = a machine measures or reads the fact (an attribute, a style, a status,
// focus position); heuristic = the rule guesses intent, a widget from its class name, or a best practice that is not a WCAG failure.
export const BEHAVIORAL_RULES = {
  // keyboard
  'focus-indicator-removed': [D, 'a stylesheet rule sets outline:none with no replacement focus style'],
  'focus-not-visible': [D, 'focused by a real Tab press: no outline, ring, border, underline or fill change in the styles of the element, its wrapper and siblings, and the pixels around it are identical focused and blurred; the scanner marks an instance confirmed only with that pixel proof, else needs-review; a control rendered only below the desktop breakpoint (hamburger) is Tab-focused at 390x844 and judged the same way'],
  'focus-obscured-by-sticky': [H, 'what covers the focused element is read with elementFromPoint at one scroll position; partial cover is allowed by 2.4.11'],
  'focus-in-cross-origin-frame': [H, 'the focus ring inside a cross-origin frame cannot be inspected, so the result is always a question'],
  'focus-indicator-clipped': [H, 'ring clipping is judged from ancestor overflow boxes; a partly visible ring may still be enough'],
  'skip-link-target-missing': [D, 'the first focusable in-page link points to a fragment id that no element or a[name] in the DOM has; likely at most, because a main landmark or headings already bypass the blocks (2.4.1)'],
  'focus-order-illogical': [H, 'backward DOM jumps only hint at a bad order; visual order is a judgement'],
  'skip-link-missing': [D, 'no in-page skip link among the first focusable stops (measured, first 5 listed); confirmed only when 3+ header/nav stops repeat and the page has no main landmark and no headings (no other bypass mechanism, 2.4.1); with a main landmark or headings it is likely (a recommendation), with fewer repeated stops needs-review'],
  'focus-invisible-stop': [D, 'focus is measured landing on a tabbable element that is invisible at its focus state (opacity 0, clipped, offscreen, zero size); a stop only listed statically, or a custom checkbox/radio, is marked needs-review per instance'],
  'focus-indicator-unverified': [H, 'the ring was not found in the screenshot where its styles put it (moved, scrolled or animated), so no ratio is reported'],
  'focus-indicator-low-contrast': [H, 'ring contrast is measured against the pixels next to it, but the ring geometry is inferred from computed styles'],
  // focusTrap
  'dialog-no-label': [D, 'an open dialog element or role with no accessible name (aria-label, aria-labelledby or title); axe best-practice, not 4.1.2: needs-review'],
  'dialog-missing-aria-modal': [H, 'aria-modal is advisory; a trapped dialog without it is not a failure'],
  'modal-focus-not-trapped': [D, 'focus is measured: it did not move into the dialog after it opened (2.4.3 advice, not a 2.1.2 trap): likely at most'],
  'modal-focus-escapes': [D, 'focus is measured: it left the open dialog while tabbing, onto a control that is not part of the own fixed overlay wrapper of the dialog (2.4.3 advice, not a 2.1.2 trap): likely at most'],
  'modal-escape-key-not-working': [H, 'a dialog may be intentionally non-dismissable by Escape'],
  // ariaLive
  'aria-live-alert-not-assertive': [D, 'role=alert region carries a conflicting aria-live value'],
  'aria-live-log-assertive': [H, 'assertive on a log is unusual, not always wrong'],
  'dynamic-region-missing-aria-live': [H, 'which regions update dynamically is guessed from the markup'],
  'loading-state-missing-announcement': [H, 'loading indicators are recognised by class name and wording'],
  // dynamicContent
  'accordion-missing-aria-expanded': [H, 'accordions are recognised by class name'],
  'accordion-missing-aria-controls': [H, 'accordions are recognised by class name; aria-controls is recommended, not required'],
  'accordion-aria-expanded-not-updated': [H, 'accordions are recognised by class name and the click may not toggle'],
  'carousel-prev-button-no-label': [H, 'carousels and their buttons are recognised by class name'],
  'carousel-next-button-no-label': [H, 'carousels and their buttons are recognised by class name'],
  'carousel-missing-label': [H, 'carousels are recognised by class name'],
  'carousel-slides-missing-labels': [H, 'slides are recognised by class name'],
  'carousel-next-not-functional': [H, 'no slide movement after a click can be animation timing'],
  'carousel-dots-missing-active-state': [H, 'dots are recognised by class name'],
  'menu-trigger-missing-aria-expanded': [D, 'a visible, operable aria-haspopup control without aria-expanded; confirmed only when activating it changed its panel (measured before and after) and no script set aria-expanded on activation, else needs-review'],
  'disclosure-missing-aria-expanded': [D, 'a visible, operable control that opens and closes a panel (aria-controls, hamburger, accordion or toggle hints) without aria-expanded (also measured at 390x844 for a toggle that only renders there); confirmed only when activating it changed the panel (measured before and after) and the attribute never appears, else needs-review (a script that sets aria-expanded on activation exposes the state at runtime)'],
  'reflow-horizontal-scroll': [D, 'the document is measured scrolling sideways at 320 x 568 CSS px with visible, non-exempt content past the viewport edge (tables, images, maps, video and own-scroll containers are left out)'],
  'focus-lost-after-escape': [D, 'focus is measured: after Enter opened the panel and Escape closed it, document.activeElement is the body, not the trigger'],
  'menu-links-unreachable-by-keyboard': [D, 'links that became visible when Enter opened a menu are measured never receiving focus from ArrowDown or Tab presses, for tabindex -1 links or tabbable links within ten tab stops after the trigger; a tabbable link ahead of the trigger is reachable and set aside, one beyond ten stops is needs-review (the walk stopped short) unless tabindex -1 links are also present, which confirm on their own'],
  'dropdown-not-dismissible-with-escape': [D, 'a panel measured opening on keyboard focus alone and still open after Escape (on the trigger and, when reachable, inside the panel), at the viewport the page loaded at; after a viewport resize, needs-review'],
  'aria-expanded-not-updated': [D, 'the trigger has aria-expanded, Enter measurably opened its panel, and the attribute value did not change'],
  'role-button-not-keyboard-operable': [D, 'a non-native role=button with a click listener is measured not receiving a click from a real Enter or Space key press, or cannot take focus'],
  'link-new-tab-notice-without-target': [H, 'the name says a new tab opens but target=_blank is absent; a script may open the window'],
  'tabs-missing-aria-selected': [D, 'a tablist where one tab looks selected (active/selected class, aria-current) and no tab has aria-selected="true"'],
  'tabs-missing-aria-controls': [D, 'role=tab elements without aria-controls; APG advice, not required by 4.1.2: needs-review'],
  'form-field-no-label': [H, 'only label, for and aria-label are checked, other naming routes are not'],
  'form-field-placeholder-only': [H, 'a placeholder-only field may be named another way'],
  'form-validation-no-aria-invalid': [H, 'depends on a test submit and on how the form reports errors'],
  'form-error-missing-aria-describedby': [H, 'depends on a test submit; errors can be linked in other ways'],
  'form-error-no-live-region': [H, 'depends on a test submit; errors can be announced by moving focus'],
  // screenReader
  'page-missing-title': [D, 'document.title is empty'],
  'no-headings': [H, 'a short page can be fine without headings'],
  'missing-h1': [H, 'an h1 is a best practice, not a WCAG failure'],
  'multiple-h1': [H, 'several h1 elements are allowed by HTML'],
  'empty-heading': [D, 'a visible heading element with no text or accessible name; axe best-practice, likely at most'],
  'heading-level-skipped': [H, 'skipped levels are a best practice, not a WCAG failure'],
  'missing-main-landmark': [D, 'no main element or role=main in the DOM; 1.3.6 is AAA and 2.4.1 can be met by headings or a skip link: needs-review'],
  'multiple-main-landmarks': [D, 'more than one visible (not hidden, display:none or aria-hidden) main landmark; best practice, not an A/AA failure: needs-review'],
  'multiple-navs-missing-labels': [D, 'several visible nav landmarks and at least one has no aria-label or aria-labelledby'],
  'non-descriptive-link-text': [H, 'whether link text is ambiguous depends on its context'],
  'image-alt-missing-sr': [D, 'a rendered img with no alt attribute that is not aria-hidden, role=presentation/none or named by aria-label, aria-labelledby or title'],
  'image-alt-not-descriptive': [H, 'alt quality is a judgement'],
  'table-no-caption': [H, 'a caption is optional; layout tables are not told apart from data tables'],
  'table-no-headers': [H, 'layout tables are not told apart from data tables'],
  'html-missing-lang': [D, 'the html element has no lang attribute'],
  'reading-order-css-reordered': [H, 'CSS reordering may be harmless; reading order is a judgement'],
  'duplicate-id-referenced': [D, 'several elements carry one id and an ARIA attribute or label/for references it, so every reference resolves to the first element in the DOM; confirmed only when a rendered referrer gets a different name (labelledby/describedby text), control (label for) or visible aria-controls target than its own, else likely (WCAG 2.2 removed 4.1.1)'],
  'repeated-accessible-name-in-loop': [H, 'identical names on sibling items may be intended; which items should differ is a judgement'],
  'accessible-name-mismatch': [H, 'name versus visible text is compared with a text heuristic'],
  'semantic-emphasis-missing': [H, 'visual emphasis is guessed from styles'],
  'svg-sprite-not-hidden': [H, 'a sprite is guessed from its content'],
  'off-screen-content-exposed': [H, 'whether off-screen content is meant for assistive tech is a guess'],
  // links
  'dead-link-empty-href': [D, 'the href attribute is empty or #'],
  'dead-link-404': [D, 'the URL answered 404/410 on both attempts (HEAD, then a browser-like GET) at the same final URL, after redirects, and on two backed-off browser retries (the final status decides); on a local page, another origin whose path repeats the local page path (a script appends it) is needs-review'],
  'dead-link-server-error': [D, 'the URL answered 5xx on both attempts at the same final URL, after redirects and two backed-off browser retries (a 502 that recovers is no finding)'],
  'dead-link-unreachable': [H, 'no answer or a 4xx other than 404 (bot blocking, timeout, network) is not proof the link is dead'],
  'broken-link': [D, 'the crawl fetched the target and it answered 404 or 410'],
};

/** Per-rule kind for the behavioural layers; every other layer (and any unlisted rule) keeps its layer kind. */
const BEHAVIORAL_LAYERS = new Set(['keyboard', 'focusTrap', 'ariaLive', 'dynamicContent', 'screenReader', 'links']);
export const kindForRule = (layer, ruleId) => (BEHAVIORAL_LAYERS.has(layer) && BEHAVIORAL_RULES[ruleId]?.[0]) || kindForLayer(layer);

/**
 * deterministic + a confirmed check -> confirmed; manual or a manual-review check (or an engine 'incomplete') -> needs-review;
 * a heuristic rule guesses intent, so it is needs-review whatever its check says; a deterministic rule's potential or
 * commercial-parity check -> likely.
 */
export function verdictFor({ kind, violationType = 'confirmed', incomplete = false } = {}) {
  if (incomplete || kind === 'manual' || kind === 'heuristic' || violationType === 'manual-review') return 'needs-review';
  return kind === 'deterministic' && violationType === 'confirmed' ? 'confirmed' : 'likely';
}

const RANK = { confirmed: 0, likely: 1, 'needs-review': 2 };
export const strongerVerdict = (a, b) => (RANK[a] <= RANK[b] ? a : b);

/** A guess never outranks 'moderate': applied to every heuristic finding, whichever layer emits it. */
export const capImpactForKind = (kind, impact) => (kind === 'heuristic' && ['serious', 'critical'].includes(impact) ? 'moderate' : impact);

const IMPACT_ORDER = ['minor', 'moderate', 'serious', 'critical'];
export const capImpact = (impact, max) => (IMPACT_ORDER.indexOf(impact) > IMPACT_ORDER.indexOf(max) ? max : impact);

// ruleId -> highest impact the rule may carry, whatever the engine says. dialog-missing-aria-modal is advisory (a banner is not a modal).
// 2.4.11 is level AA and partial cover is allowed: a focus-obscured finding is at most serious.
export const RULE_MAX_IMPACT = {
  'duplicate-id-aria': 'serious', 'dialog-missing-aria-modal': 'moderate', 'modal-focus-escapes': 'serious', 'modal-focus-not-trapped': 'serious',
  // Convention-only rules (recommended markup, not a WCAG failure): needs-review, and never above minor.
  TabAriaControls: 'minor', TabpanelLabelledBy: 'minor', NoAutofocus: 'minor', TableNesting: 'minor', RegionMainContentSingle: 'minor', NoRoleApplication: 'minor', NoExtraInformationInTitle: 'minor',
  FocusNotObscuredFooter: 'serious', FocusNotObscuredHeader: 'serious', StickyHeaderObscuresFocus: 'serious',
};

/** A proof is a measured or structural fact: a type (computed-ratio, dom-structure, http-status, ...) and the fact itself. */
export const hasProof = (proof) => typeof proof?.type === 'string' && proof.type !== '' && ['string', 'number'].includes(typeof proof.fact) && String(proof.fact).trim() !== '';

export const isAxeIncomplete = (violation) => violation?.evidence?.tags?.includes?.('axe-incomplete') === true;

// Proof types that record a fact measured in this scan. A validator's rule id, an engine's generic help text and a rule's documented
// rationale ('validator-rule', 'dom-structure', 'rule-fact') are not measurements: no finding of any owner is confirmed on them.
export const MEASURED_PROOF_TYPES = new Set(['computed-ratio', 'attribute-value', 'name-vs-text', 'measured-fact', 'element-from-point', 'http-status']);
const QUOTED_VALUE = /["\u201c\u2018][^"\u201d\u2019\n]+["\u201d\u2019]/;
const nonEmpty = (t) => typeof t === 'string' && t.trim() !== '';

const VALIDATOR_LAYERS = new Set(['w3c', 'htmlValidate', 'lighthouse']);

// A 'measured-fact' proof must hold a value read in this scan: a number (ratio, size, count, status), a quoted value (attribute, id, text) or a CSS declaration.
// A rule's description, its rationale or the element's opening tag holds none of these (`<title />: the title element is present and non-empty`).
const MEASURED_VALUE = /\d|["\u201c\u2018'][^"\u201d\u2019'\n]+["\u201d\u2019']|[a-z-]+\s*:\s*[^\s;]+;/;
export const hasMeasuredValue = (fact) => MEASURED_VALUE.test(String(fact ?? ''));

/** The proof a deterministic violation carries: recorded by its layer, else the rule's documented measured fact. */
export function proofFor(violation) {
  const recorded = violation?.evidence?.proof;
  // An accessScan check that recorded only the rule's rationale (or the opening tag) measured nothing: a description, never a 'measured-fact'.
  if (hasProof(recorded)) return violation?.layer === 'accessScan' && recorded.type === 'measured-fact' && !hasMeasuredValue(recorded.fact) ? { ...recorded, type: 'dom-structure' } : recorded;
  const ev = violation?.evidence || {};
  // Label-in-name rules: both strings were captured from the DOM (visible text and accessible name), so the mismatch itself is the measurement.
  if (typeof ev.visibleText === 'string' && ev.visibleText.trim() && typeof ev.accessibleName === 'string') {
    return { type: 'name-vs-text', fact: `visible text "${ev.visibleText.trim()}" is not part of accessible name "${ev.accessibleName.trim()}"` };
  }
  if (violation?.layer === 'axe') {
    const ratio = ev.pixelContrast?.min;
    if (ratio != null) return { type: 'computed-ratio', fact: String(ratio) };
    // axe's per-node failure summary names the measured state ("Element has insufficient color contrast of 2.1"); its generic help does not.
    return nonEmpty(ev.failureSummary) ? { type: 'measured-fact', fact: ev.failureSummary.trim() } : { type: 'dom-structure', fact: ev.help || violation.ruleId || '' };
  }
  // A behavioural rule with no recorded proof measured nothing we can show: its description is wording, not a measurement (a quoted id or a digit in it
  // proves nothing), so it is a structural note and never confirms. Only a check that writes evidence.proof can be confirmed.
  if (BEHAVIORAL_RULES[violation?.ruleId]) {
    const fact = [violation.description, violation.fix?.hint, ev.snippet].find((t) => typeof t === 'string' && t.trim());
    if (fact) return { type: 'dom-structure', fact };
  }
  if (VALIDATOR_LAYERS.has(violation?.layer)) {
    // A validator's message is a measurement only when it records this instance's value (a quoted id, attribute or text, or Lighthouse's
    // per-node explanation); a bare rule name or the rule's generic wording is not.
    const message = violation.layer === 'lighthouse' ? ev.explanation : violation.description;
    if (nonEmpty(message) && (violation.layer === 'lighthouse' || QUOTED_VALUE.test(message))) return { type: 'measured-fact', fact: message.trim() };
    return { type: 'validator-rule', fact: `${violation.layer}:${violation.ruleId}` };
  }
  return null;
}

// Best-practice rules of the axe and Lighthouse layers are advice, not A/AA failures (a page with a main landmark passes 2.4.1 without a skip link;
// heading order and a missing h1 are not success criteria). They are likely at most, whatever the engine says.
const ADVISORY_AXE_IDS = new Set(['heading-order', 'page-has-heading-one', 'skip-link', 'tabindex']);
const WCAG_LEVEL_TAG = /^wcag2(1|2)?(a|aa)$/;
// Our own rules for best-practice advice (landmark labelling is ARIA11, an empty list is not exposed as anything): advisory on whatever layer emits them.
// A required main landmark is cited as 1.3.6 (AAA); 2.4.1 is met by headings or a skip link. A dialog's name is axe best-practice (aria-dialog-name), and
// aria-controls on tabs is APG advice: none of these is an A/AA failure.
const ADVISORY_OWN_IDS = new Set(['multiple-navs-missing-labels', 'landmark-unique', 'ListEmpty', 'missing-main-landmark', 'multiple-main-landmarks', 'dialog-no-label', 'tabs-missing-aria-controls']);
// Real but not provably an A/AA failure: likely at most (a recommendation, exported by default, never counted by the gate).
// empty-heading: best-practice in axe. modal-focus-*: leaving a modal is 2.4.3 advice (APG), not a 2.1.2 trap. skip-link-target-missing: a page with a main
// landmark or headings already has a bypass (2.4.1), and the check does not record that.
export const LIKELY_AT_MOST_IDS = new Set(['empty-heading', 'modal-focus-escapes', 'modal-focus-not-trapped', 'skip-link-target-missing']);
export const isAdvisoryRule = ({ layer, ruleId, tags = [] } = {}) => ADVISORY_OWN_IDS.has(ruleId)
  || ((layer === 'axe' || layer === 'lighthouse')
    && (ADVISORY_AXE_IDS.has(ruleId) || (tags.includes('best-practice') && !tags.some((t) => WCAG_LEVEL_TAG.test(t)))));

/**
 * The one choke point every finding passes through before it is reported (T-B1). Invariants:
 * an engine 'incomplete' is needs-review at most moderate; only a deterministic kind with a recorded proof is confirmed (no proof -> likely);
 * a finding of any owner is confirmed only when its proof type is a measurement (MEASURED_PROOF_TYPES: a rule name, generic help text or documented rationale is not), else needs-review;
 * an advisory (best-practice, not A/AA) rule is likely at most;
 * a heuristic or manual rule is never confirmed (a heuristic's impact is at most moderate); a rule's documented impact ceiling always applies.
 */
export function settleFinding({ kind, verdict, impact, ruleId, incomplete = false, proof = null, advisory = false }) {
  let v = verdict;
  let i = impact;
  if (incomplete || (kind !== 'deterministic' && v === 'confirmed')) v = 'needs-review';
  if (v === 'confirmed' && !hasProof(proof)) v = 'likely';
  // Any owner: confirmed only with a measured fact, else a question (for a vendor's code it is not ours to prove, for ours a rule name proves nothing).
  if (v === 'confirmed' && !MEASURED_PROOF_TYPES.has(proof.type)) v = 'needs-review';
  // An advisory (best-practice) rule is a recommendation: likely at most, never counted by the gate or --fail-on-violations.
  if (advisory && v === 'confirmed') v = 'likely';
  if (LIKELY_AT_MOST_IDS.has(ruleId) && v === 'confirmed') v = 'likely';
  // Our own best-practice rules are below likely: needs-review is not counted by the gate and not exported as a fix task unless asked for.
  if (advisory && ADVISORY_OWN_IDS.has(ruleId)) v = 'needs-review';
  if (incomplete || kind === 'heuristic') i = capImpact(i, 'moderate');
  if (RULE_MAX_IMPACT[ruleId]) i = capImpact(i, RULE_MAX_IMPACT[ruleId]);
  return { verdict: v, impact: i };
}
