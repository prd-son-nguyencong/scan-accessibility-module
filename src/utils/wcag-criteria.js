// Maintained WCAG 2.2 criteria list with the declared automation coverage of this project (T-E11.8).
// coverage: full = the automated checks decide the criterion's testable requirement; partial = some failures are found, a person must still check;
// manual-only = needs human judgement, no automated check can decide it; none = automatable in principle, no rule runs yet.
// test/wcag-coverage.test.js fails when a coverage level contradicts the rule registry, axe tags or html-validate table.
// Keyboard, focus-trap, aria-live and screen-reader probes are not in a rule registry and are not counted here.
const ROWS = [
  ['1.1.1', 'A', 'Non-text Content', 'partial', 'Missing text alternatives are found; whether the text is accurate is manual'],
  ['1.2.1', 'A', 'Audio-only and Video-only (Prerecorded)', 'partial', 'axe checks audio elements for a caption track; the alternative for video-only media is manual'],
  ['1.2.2', 'A', 'Captions (Prerecorded)', 'partial', 'axe checks video elements for a caption track; caption accuracy is manual'],
  ['1.2.3', 'A', 'Audio Description or Media Alternative (Prerecorded)', 'manual-only', 'Needs a person to watch the media'],
  ['1.2.4', 'AA', 'Captions (Live)', 'manual-only', 'Live media cannot be checked from a page scan'],
  ['1.2.5', 'AA', 'Audio Description (Prerecorded)', 'manual-only', 'Needs a person to watch the media'],
  ['1.3.1', 'A', 'Info and Relationships', 'partial', 'Structural markup, references and tables are checked; whether markup matches the visual meaning is manual'],
  ['1.3.2', 'A', 'Meaningful Sequence', 'manual-only', 'Reading order versus visual order needs judgement'],
  ['1.3.3', 'A', 'Sensory Characteristics', 'manual-only', 'Instructions that rely on shape or position need a reader'],
  ['1.3.4', 'AA', 'Orientation', 'partial', 'axe detects CSS orientation locks only'],
  ['1.3.5', 'AA', 'Identify Input Purpose', 'partial', 'axe validates autocomplete values; whether a field needs one is manual'],
  ['1.4.1', 'A', 'Use of Color', 'partial', 'axe checks links inside text blocks; other colour-only cues are manual'],
  ['1.4.2', 'A', 'Audio Control', 'partial', 'axe finds autoplaying audio; page-specific controls are manual'],
  ['1.4.3', 'AA', 'Contrast (Minimum)', 'partial', 'axe measures text contrast; text over images and gradients is reported as incomplete'],
  ['1.4.4', 'AA', 'Resize Text', 'partial', 'Only the viewport meta tag is checked; real zoom to 200% is manual'],
  ['1.4.5', 'AA', 'Images of Text', 'none', 'Automatable in part, no rule runs yet'],
  ['1.4.10', 'AA', 'Reflow', 'none', 'The 320px reflow probe (reflow-horizontal-scroll) is not rule-registered, so it is not counted'],
  ['1.4.11', 'AA', 'Non-text Contrast', 'none', 'No rule runs yet'],
  ['1.4.12', 'AA', 'Text Spacing', 'partial', 'axe flags inline spacing styles; clipping after spacing changes is manual'],
  ['1.4.13', 'AA', 'Content on Hover or Focus', 'manual-only', 'Needs interaction and judgement'],
  ['2.1.1', 'A', 'Keyboard', 'partial', 'Focusability of scrollers, frames and image maps and click-only menus are checked; full keyboard operation is manual'],
  ['2.1.2', 'A', 'No Keyboard Trap', 'none', 'The focus-trap probe is not rule-registered, so it is not counted'],
  ['2.1.4', 'A', 'Character Key Shortcuts', 'none', 'No rule runs yet'],
  ['2.2.1', 'A', 'Timing Adjustable', 'partial', 'Meta refresh is checked; script timers are manual'],
  ['2.2.2', 'A', 'Pause, Stop, Hide', 'partial', 'axe finds blink and marquee; animated content is manual'],
  ['2.3.1', 'A', 'Three Flashes or Below Threshold', 'manual-only', 'Needs media analysis'],
  ['2.4.1', 'A', 'Bypass Blocks', 'partial', 'axe checks for a skip link or landmarks; whether it works is manual'],
  ['2.4.2', 'A', 'Page Titled', 'partial', 'Title presence and descriptiveness heuristics; real descriptiveness is manual'],
  ['2.4.3', 'A', 'Focus Order', 'manual-only', 'Needs a person to tab through the page'],
  ['2.4.4', 'A', 'Link Purpose (In Context)', 'partial', 'Empty and ambiguous link text is found; purpose in context is manual'],
  ['2.4.5', 'AA', 'Multiple Ways', 'manual-only', 'Needs site-level judgement'],
  ['2.4.6', 'AA', 'Headings and Labels', 'manual-only', 'Whether text describes its topic needs a reader'],
  ['2.4.7', 'AA', 'Focus Visible', 'none', 'The keyboard probe is not rule-registered, so it is not counted'],
  ['2.4.11', 'AA', 'Focus Not Obscured (Minimum)', 'partial', 'Only the sticky header and footer are measured'],
  ['2.5.1', 'A', 'Pointer Gestures', 'manual-only', 'Needs interaction testing'],
  ['2.5.2', 'A', 'Pointer Cancellation', 'manual-only', 'Needs interaction testing'],
  ['2.5.3', 'A', 'Label in Name', 'partial', 'Visible text versus accessible name is compared heuristically'],
  ['2.5.4', 'A', 'Motion Actuation', 'manual-only', 'Needs device testing'],
  ['2.5.7', 'AA', 'Dragging Movements', 'partial', 'Slider-like widgets are detected; whether a single-pointer alternative exists is manual'],
  ['2.5.8', 'AA', 'Target Size (Minimum)', 'partial', 'Measured size, but spacing exceptions need judgement'],
  ['3.1.1', 'A', 'Language of Page', 'full', 'The lang attribute is present and a valid tag; the testable requirement of the criterion'],
  ['3.1.2', 'AA', 'Language of Parts', 'partial', 'axe validates lang values; passages in another language are not detected'],
  ['3.2.1', 'A', 'On Focus', 'partial', 'Autofocus is checked; other context changes on focus are manual'],
  ['3.2.2', 'A', 'On Input', 'partial', 'Submit controls and likely unannounced context changes are checked'],
  ['3.2.3', 'AA', 'Consistent Navigation', 'none', 'Needs a cross-page comparison that is not built'],
  ['3.2.4', 'AA', 'Consistent Identification', 'manual-only', 'Needs judgement across pages'],
  ['3.2.6', 'A', 'Consistent Help', 'manual-only', 'Needs judgement across pages'],
  ['3.3.1', 'A', 'Error Identification', 'none', 'Needs form submission; no rule runs yet'],
  ['3.3.2', 'A', 'Labels or Instructions', 'partial', 'Multiple labels and required markers are checked; label quality is manual'],
  ['3.3.3', 'AA', 'Error Suggestion', 'manual-only', 'Needs a person to trigger and read errors'],
  ['3.3.4', 'AA', 'Error Prevention (Legal, Financial, Data)', 'manual-only', 'Needs a person to judge the flow'],
  ['3.3.7', 'A', 'Redundant Entry', 'manual-only', 'Needs multi-step flow testing'],
  ['3.3.8', 'AA', 'Accessible Authentication (Minimum)', 'manual-only', 'Needs a person to complete the login flow'],
  ['4.1.1', 'obsolete', 'Parsing', 'partial', 'Removed in WCAG 2.2; duplicate-id style checks remain useful but are not counted'],
  ['4.1.2', 'A', 'Name, Role, Value', 'partial', 'Names, roles and ARIA validity are checked; custom widget behaviour is manual'],
  ['4.1.3', 'AA', 'Status Messages', 'none', 'The aria-live probe is not rule-registered, so it is not counted'],
  ['1.4.6', 'AAA', 'Contrast (Enhanced)', 'none', 'Enhanced contrast rules are not run'],
  ['2.1.3', 'AAA', 'Keyboard (No Exception)', 'partial', 'Only scrollable-region focusability is checked'],
  ['2.4.12', 'AAA', 'Focus Not Obscured (Enhanced)', 'none', 'No rule runs yet'],
  ['2.4.13', 'AAA', 'Focus Appearance', 'manual-only', 'Needs visual judgement'],
  ['2.5.5', 'AAA', 'Target Size (Enhanced)', 'none', 'No rule runs yet'],
  ['3.2.5', 'AAA', 'Change on Request', 'partial', 'New-window links are flagged heuristically'],
];

export const WCAG_CRITERIA = Object.freeze(
  ROWS.map(([id, level, title, coverage, note]) => Object.freeze({ id, level, title, coverage, note })).sort((a, b) =>
    a.id.localeCompare(b.id, undefined, { numeric: true }),
  ),
);

export const COVERAGE_LEVELS = ['full', 'partial', 'manual-only', 'none'];

/** Counts over the WCAG 2.2 A and AA criteria. covered = full + partial; needManual = manual-only + none. */
export function wcagCoverageSummary() {
  const aa = WCAG_CRITERIA.filter((c) => c.level === 'A' || c.level === 'AA');
  const n = (level) => aa.filter((c) => c.coverage === level).length;
  const full = n('full');
  const partial = n('partial');
  const needManual = n('manual-only') + n('none');
  return { total: aa.length, full, partial, covered: full + partial, needManual };
}

export function wcagCoverageSentence(s = wcagCoverageSummary()) {
  return `Automated checks cover ${s.covered} of ${s.total} WCAG 2.2 A and AA criteria (${s.full} fully, ${s.partial} partially); ${s.needManual} need manual review. Partial coverage does not replace manual review.`;
}
