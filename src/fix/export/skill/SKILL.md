---
name: ada-scan-fix
description: Fix accessibility findings from an ada-scan export safely in Paradox Liquid and Tailwind projects. Use when asked to "fix accessibility findings from ada-scan", "apply ada-scan tasks", "work through tasks/INDEX.md", or to edit templates named in an ada-scan task file. Covers the per-task procedure, Paradox and Liquid rules, no-break guardrails, design-locked tasks (colour contrast is never fixed by changing colours) and when to stop and ask a person.
---

# ada-scan fix skill

You are applying findings exported by `ada-scan fix --export`. The export is a list of small, traced tasks. Your job is to make
the smallest correct edit for each one without changing how the page looks or behaves, and to report honestly what you did not do.

## Read in this order

1. `workflow.md`: the mandatory procedure for every task, stop conditions, how to report.
2. `paradox-liquid-rules.md`: what may and may not be edited in a Paradox (PDK, Liquid, Tailwind) project.
3. `no-break-guardrails.md`: what must stay identical and how to check it, with tempting wrong fixes.
4. `design-locked.md`: colour contrast and design tasks are reported, never fixed.
5. `when-to-ask-a-human.md`: the cases where you stop and ask.
6. The pattern file for the task's rule, from the table below. Read it before editing.

## Rule to pattern

| Task rule family | Pattern file |
| --- | --- |
| `button-name` | `patterns/button-name.md` |
| `link-name` | `patterns/link-name.md` |
| `link-new-tab-notice-without-target` | `patterns/link-new-tab.md` |
| `image-alt` | `patterns/image-alt.md` |
| `label` (form fields) | `patterns/form-labels.md` |
| `multiple-navs-missing-labels`, `landmark-unique`, `region`, `missing-main-landmark` | `patterns/landmarks-navs.md` |
| `skip-link-missing`, `skip-link-target-missing` | `patterns/skip-link.md` |
| `page-has-heading-one`, `missing-h1`, `heading-order`, `heading-level-skipped` | `patterns/headings.md` |
| `disclosure-missing-aria-expanded`, `menu-trigger-missing-aria-expanded` | `patterns/disclosure.md` |
| dialogs, off-canvas panels, `aria-hidden-focus` on a closed panel | `patterns/dialogs-focus.md` |
| `tabpanel-labelledby`, tab widgets | `patterns/tabs.md` |
| carousels and sliders | `patterns/carousels.md` |
| `target-size`, `targetsize` | `patterns/target-size.md` |
| `focus-visible`, `focus-indicator-removed`, `focus-not-visible`, `focus-invisible-stop` | `patterns/focus-visible.md` |
| `label-content-name-mismatch`, `visibletextpartofaccessiblename` | `patterns/label-in-name.md` |
| `document-title`, `html-has-lang` | `patterns/language.md` |
| `meta-viewport`, reflow at 320px | `patterns/reflow.md` |
| `role="button"` on a non-button | `patterns/role-button-keyboard.md` |
| `duplicate-id`, `duplicate-id-aria`, `duplicate-id-referenced` | `patterns/duplicate-ids.md` |
| `aria-allowed-role`, `aria-hidden-focus` | `patterns/aria-misuse.md` |
| `color-contrast`, `color-contrast-enhanced`, `focus-indicator-low-contrast`, `non-text-contrast` | `design-locked.md` (no edit) |

A rule with no row: no recipe exists. Use judgement, read `when-to-ask-a-human.md`, and prefer asking over guessing.

## Five rules that override everything

1. Never change colours, tokens, utility colour classes, opacity or background images. Contrast is for the design owner.
2. Never touch `{{data:..}}`, `{{component:..}}`, `{{snippet:..}}`, `{{attribute:..}}` or `data-pdk-*`.
3. Never edit `dist/`, exported JSON, generated `+.css` files or platform widgets (`data-react-component`).
4. One file at a time, bottom-up, minimal edit, then verify. A fix you cannot verify is reported as unverified.
5. If a fix would change layout, order, element count (beyond the documented addition) or a visible string, stop and ask.

## Check your work

Run `ada-scan fix --verify` after editing. It checks the working tree diff against the export (files, data tags, colour
declarations, `dist/`) and exits non-zero on a violation. Then rescan with `ada-scan --url <site>` (compares with the saved baseline).
