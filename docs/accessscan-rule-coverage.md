# accessScan Rule Coverage — Detailed Reference

**Date:** 2026-05-11
**Linked from:** [Scan Pipeline Design Spec](./2026-05-02-scan-autofix-pipeline-design.md) § Section 2
**Total rules:** 83 across 11 category files

---

## Summary

| File | Rules | WCAG Versions | Criteria Coverage |
|------|-------|---------------|-------------------|
| [01-general.js](#01-generaljs--14-rules) | 14 | WCAG 2.1, WCAG 2.0 | 1.1.1, 1.3.1, 2.4.4, 4.1.2 |
| [02-interactive.js](#02-interactivejs--18-rules) | 18 | WCAG 2.2, WCAG 2.0 | 1.3.1, 2.1.1, 2.4.4, 2.4.12, 2.5.8, 3.2.1, 3.2.5, 4.1.2 |
| [03-forms.js](#03-formsjs--6-rules) | 6 | WCAG 2.0 | 1.3.1, 3.2.2, 3.3.2 |
| [04-landmarks.js](#04-landmarksjs--10-rules) | 10 | WCAG 2.0 | 1.3.1 |
| [05-graphics.js](#05-graphicsjs--6-rules) | 6 | WCAG 2.0 | 1.1.1 |
| [06-dragging.js](#06-draggingjs--1-rule) | 1 | WCAG 2.2 | 2.5.7 |
| [07-aria.js](#07-ariajs--2-rules) | 2 | WCAG 2.1 | 2.5.3 |
| [08-lists.js](#08-listsjs--2-rules) | 2 | WCAG 2.2, WCAG 2.0 | 1.3.1, 2.4.11 |
| [09-metadata.js](#09-metadatajs--8-rules) | 8 | WCAG 2.0 | 1.4.4, 2.2.1, 2.4.2, 3.1.1 |
| [10-tabs.js](#10-tabsjs--9-rules) | 9 | WCAG 2.0 | 4.1.2 |
| [11-tables.js](#11-tablesjs--7-rules) | 7 | WCAG 2.0 | 1.3.1 |

**WCAG level breakdown:** 68 Level A · 6 Level AA · 1 Level AAA · 8 Best Practice

---

## 01-general.js — 14 rules

General content rules covering alt misuse, ARIA references, emphasis/strong semantics, visibility, and element labeling.

| # | Rule ID | WCAG | Level | Criterion | Impact | What it checks |
|---|---------|------|-------|-----------|--------|----------------|
| 1 | `AltMisuse` | 2.1 | A | 1.1.1 | moderate | Non-image elements (e.g. `<div>`, `<span>`) must not have `alt` attributes — use `aria-label` instead. |
| 2 | `AriaDescribedByHasReference` | 2.0 | A | 1.3.1 | serious | `aria-describedby` must reference IDs that exist in the DOM. Flags orphaned references. |
| 3 | `AriaLabelledByHasReference` | 2.0 | A | 1.3.1 | serious | `aria-labelledby` must reference IDs that exist in the DOM. Flags orphaned references. |
| 4 | `BreadcrumbsNav` | 2.0 | A | 1.3.1 | moderate | Breadcrumb navigation (`nav[aria-label*="breadcrumb"]`) should contain an ordered list (`<ol>`) for proper structure. |
| 5 | `EmphasisMismatch` | 2.0 | A | 1.3.1 | moderate | Visually italic text using CSS `font-style: italic` on `<span>` should use `<em>` so screen readers convey emphasis. |
| 6 | `FigureDiscernible` | 2.0 | A | 1.1.1 | moderate | `<figure>` elements need a `<figcaption>` or `aria-label` describing their content. |
| 7 | `IframeDiscernible` | 2.0 | A | 4.1.2 | serious | `<iframe>` elements must have a descriptive `title` attribute explaining their purpose to screen reader users. |
| 8 | `LinkAnchorAmbiguous` | 2.0 | A | 2.4.4 | moderate | Links with empty or `#`-only `href` should either have a valid URL or be converted to `<button>` for actions. |
| 9 | `NoExtraInformationInTitle` | 2.0 | A | 4.1.2 | minor | `title` attribute should not duplicate the element's visible text content (unreliable for labeling, adds noise). |
| 10 | `NoRoleApplication` | 2.0 | A | 4.1.2 | serious | `role="application"` must not be used — it overrides normal screen reader navigation and breaks usability. |
| 11 | `SalePriceDiscernible` | 2.0 | A | 1.3.1 | serious | Strikethrough/discounted pricing must use `aria-label` so screen readers can distinguish original vs sale prices. |
| 12 | `StrongMismatch` | 2.0 | A | 1.3.1 | serious | Visually bold text using CSS `font-weight: bold/700+` on `<span>` should use `<strong>` for semantic importance. |
| 13 | `VisibilityMismatch` | 2.0 | A | 4.1.2 | moderate | Visible, interactive elements must not have `aria-hidden="true"` — content is hidden from screen readers but remains interactive. |
| 14 | `VisibilityMisuse` | 2.0 | A | 4.1.2 | serious | Visually hidden containers with interactive children (buttons, links, inputs) need `aria-hidden="true"` to prevent ghost focus. |

---

## 02-interactive.js — 18 rules

Interactive content rules covering buttons, links, navigation, menus, focus management, and target sizing.

| # | Rule ID | WCAG | Level | Criterion | Impact | What it checks |
|---|---------|------|-------|-----------|--------|----------------|
| 1 | `AriaControlsHasReference` | 2.0 | A | 1.3.1 | serious | `aria-controls` must reference an ID that exists in the DOM. |
| 2 | `ButtonDiscernible` | 2.0 | A | 4.1.2 | serious | Buttons (`<button>`, `role="button"`) must have visible text, `aria-label`, or `title`. |
| 3 | `ButtonMismatch` | 2.0 | A | 4.1.2 | serious | Elements styled as buttons (e.g. `<a href="#">` with button styling) must have `role="button"` or use `<button>`. |
| 4 | `FocusNotObscuredFooter` | 2.2 | AA | 2.4.12 | critical | Sticky/fixed footers must not obscure focused elements — requires adequate `scroll-padding-bottom`. |
| 5 | `LinkAnchorDiscernible` | 2.0 | A | 2.4.4 | serious | In-page anchor links (`href="#..."`) must have descriptive text or `aria-label`. |
| 6 | `LinkCurrentPage` | 2.0 | A | 1.3.1 | moderate | Links to the current page should have `aria-current="page"` when visually distinguished as current. |
| 7 | `LinkImageWarning` | — | BP | — | minor | Best practice: warn when a link opens an image file directly (user may expect a page). |
| 8 | `LinkMailtoWarning` | — | BP | — | minor | Best practice: warn when a `mailto:` link opens a mail client (indicate in visible text). |
| 9 | `LinkNavigationAmbiguous` | 2.0 | A | 2.4.4 | serious | Multiple links with identical text pointing to different URLs need unique `aria-label` to distinguish purpose. |
| 10 | `LinkNavigationDiscernible` | 2.0 | A | 4.1.2 | serious | Navigation links inside `<nav>` must have descriptive accessible names (text or `aria-label`). |
| 11 | `LinkOpensNewWindow` | 2.0 | AAA | 3.2.5 | minor | Links with `target="_blank"` should indicate they open a new window in visible text or `aria-label`. |
| 12 | `LinkPDFWarning` | — | BP | — | minor | Best practice: warn when a link opens a PDF document (indicate file type to users). |
| 13 | `MenuAvoid` | — | BP | — | moderate | `role="menu"` should not be used for website navigation — it's for application-style menus only. |
| 14 | `MenuBarAvoid` | — | BP | — | moderate | `role="menubar"` should not be used for website navigation — it's for desktop-application menu bars only. |
| 15 | `MenuItemAvoid` | — | BP | — | moderate | `role="menuitem"` should not be used on ordinary navigation links. |
| 16 | `MenuTriggerClickable` | 2.0 | A | 2.1.1 | serious | Elements with `aria-haspopup` must be keyboard-operable (`<button>`, `<a>`, or have `tabindex` + `role="button"`). |
| 17 | `NoAutofocus` | 2.0 | A | 3.2.1 | moderate | `autofocus` attribute causes unexpected focus changes on page load — remove it. |
| 18 | `TargetSize` | 2.2 | AA | 2.5.8 | moderate | Interactive targets must be at least 24×24 CSS pixels for touch accessibility. |

---

## 03-forms.js — 6 rules

Form accessibility rules covering labels, required field indicators, submit buttons, and context changes.

| # | Rule ID | WCAG | Level | Criterion | Impact | What it checks |
|---|---------|------|-------|-----------|--------|----------------|
| 1 | `CheckboxDiscernible` | 2.0 | A | 1.3.1 | serious | Checkboxes must have an associated `<label>` or `aria-label` describing their purpose. |
| 2 | `FormContextChangeWarning` | 2.0 | A | 3.2.2 | serious | `<select>` elements must not rely on `onchange` to submit forms without an explicit submit control. |
| 3 | `FormSubmitButtonMismatch` | 2.0 | A | 3.2.2 | moderate | Forms with buttons should have at least one `type="submit"` button for proper form submission semantics. |
| 4 | `MainNavigationMismatch` | — | BP | — | moderate | Main navigation should be wrapped in `<nav>` or have `role="navigation"` for landmark identification. |
| 5 | `RadioDiscernible` | 2.0 | A | 1.3.1 | serious | Radio buttons must have an associated `<label>` or `aria-label` describing their purpose. |
| 6 | `RequiredFormFieldAriaRequired` | 2.0 | A | 3.3.2 | serious | Visually required fields (marked with `*`) must have `required` or `aria-required="true"` programmatically. |

---

## 04-landmarks.js — 10 rules

Landmark region rules covering navigation, main, footer, article, breadcrumbs, and search landmarks.

| # | Rule ID | WCAG | Level | Criterion | Impact | What it checks |
|---|---------|------|-------|-----------|--------|----------------|
| 1 | `ArticleMisuse` | 2.0 | A | 1.3.1 | moderate | `<article>` elements must be self-contained content with a heading — not used for trivial wrappers. |
| 2 | `BreadcrumbsMismatch` | 2.0 | A | 1.3.1 | moderate | Breadcrumb `<nav>` must have `aria-label` or `aria-labelledby` to distinguish it from other navigation landmarks. |
| 3 | `NavigationMisuse` | 2.0 | A | 1.3.1 | serious | `<nav>` must not be empty and should contain navigation links in a `<ul>` or `<ol>` structure. |
| 4 | `RegionFooterMismatch` | 2.0 | A | 1.3.1 | moderate | Footer/contentinfo landmark should contain typical global site information (copyright, privacy links, etc.). |
| 5 | `RegionFooterMisuse` | — | BP | — | moderate | `role="contentinfo"` should only be used on `<footer>` elements — not on arbitrary containers. |
| 6 | `RegionFooterSingle` | — | BP | — | moderate | Page should have at most one primary `<footer>`/`role="contentinfo"` landmark at page level. |
| 7 | `RegionMainContentMismatch` | 2.0 | A | 1.3.1 | moderate | Substantial page content sitting outside `<main>` should be moved into the main landmark. |
| 8 | `RegionMainContentMisuse` | 2.0 | A | 1.3.1 | moderate | `<main>` must contain meaningful content with a heading — not used for trivial or empty wrappers. |
| 9 | `RegionMainContentSingle` | 2.0 | A | 1.3.1 | moderate | Page must have at most one `<main>` or `role="main"` landmark. |
| 10 | `SearchFormMismatch` | 2.0 | A | 1.3.1 | serious | Search functionality must be wrapped in `role="search"` or `<search>` landmark for discoverability. |

---

## 05-graphics.js — 6 rules

Image and graphic rules covering alt text, decorative images, icons, and CSS background images.

| # | Rule ID | WCAG | Level | Criterion | Impact | What it checks |
|---|---------|------|-------|-----------|--------|----------------|
| 1 | `BackgroundImageDiscernibleImage` | 2.0 | A | 1.1.1 | moderate | Large elements with CSS `background-image` that convey meaning need `role="img"` + `aria-label`. |
| 2 | `DecorativeGraphicExposed` | 2.0 | A | 1.1.1 | minor | Small decorative icons inside links/buttons with visible text should have `aria-hidden="true"`. |
| 3 | `IconDiscernible` | 2.0 | A | 1.1.1 | serious | SVG/icon elements: meaningful icons need `aria-label`; decorative icons need `aria-hidden="true"`. |
| 4 | `ImageDiscernible` | 2.0 | A | 1.1.1 | serious | `<img>` elements must have an `alt` attribute (empty `alt=""` acceptable for decorative images). |
| 5 | `ImageDiscernibleCorrectly` | 2.0 | A | 1.1.1 | moderate | Alt text must be meaningful — rejects generic placeholders like "image", "photo", "img123", filename patterns. |
| 6 | `ImageMisuse` | 2.0 | A | 1.1.1 | minor | Tiny spacer/decorative images should use `alt=""` and `role="presentation"` to hide from screen readers. |

---

## 06-dragging.js — 1 rule

Dragging alternative for single-pointer operation of slider controls.

| # | Rule ID | WCAG | Level | Criterion | Impact | What it checks |
|---|---------|------|-------|-----------|--------|----------------|
| 1 | `DraggingAlternative` | 2.2 | AA | 2.5.7 | serious | Sliders and draggable controls must be operable with a single pointer (no drag-only interaction). Flags `<input type="range">` and `role="slider"` elements missing keyboard support. |

---

## 07-aria.js — 2 rules

ARIA label consistency rules ensuring accessible names match visible text content.

| # | Rule ID | WCAG | Level | Criterion | Impact | What it checks |
|---|---------|------|-------|-----------|--------|----------------|
| 1 | `AriaLabelledbyContentMismatch` | 2.1 | A | 2.5.3 | serious | Multi-ID `aria-labelledby` must not pull in text that doesn't match the element's visible label. |
| 2 | `VisibleTextPartOfAccessibleName` | 2.1 | A | 2.5.3 | serious | Accessible name (from `aria-label`) must contain the element's visible text — voice control users say what they see. |

---

## 08-lists.js — 2 rules

List structure and sticky header focus obscuring rules.

| # | Rule ID | WCAG | Level | Criterion | Impact | What it checks |
|---|---------|------|-------|-----------|--------|----------------|
| 1 | `ListEmpty` | 2.0 | A | 1.3.1 | moderate | `<ul>` and `<ol>` elements must contain at least one `<li>` child — empty lists are structural noise. |
| 2 | `StickyHeaderObscuresFocus` | 2.2 | AA | 2.4.11 | critical | Sticky/fixed headers must not obscure keyboard-focused elements — requires adequate `scroll-padding-top` matching the header height. |

---

## 09-metadata.js — 8 rules

Page-level metadata rules covering language, viewport, title, refresh, and description.

| # | Rule ID | WCAG | Level | Criterion | Impact | What it checks |
|---|---------|------|-------|-----------|--------|----------------|
| 1 | `HtmlLang` | 2.0 | A | 3.1.1 | serious | `<html>` element must have a `lang` attribute specifying the page language. |
| 2 | `HtmlLangValid` | — | BP | — | moderate | `lang` attribute must contain a valid ISO 639-1 language code (e.g. `en`, `fr`, `ja`). |
| 3 | `MetaDescription` | — | BP | — | minor | Page should have a `<meta name="description">` for SEO and link previews. |
| 4 | `MetaRefresh` | 2.0 | A | 2.2.1 | critical | `<meta http-equiv="refresh">` must not be used — causes unexpected timed page redirects. |
| 5 | `MetaViewportPresent` | — | BP | — | moderate | Page should declare a `<meta name="viewport">` tag for responsive behavior. |
| 6 | `MetaViewportScalable` | 2.0 | AA | 1.4.4 | critical | Viewport must not disable zoom: no `user-scalable=no`, no `maximum-scale` below 2. |
| 7 | `PageTitle` | 2.0 | A | 2.4.2 | serious | Page must have a `<title>` element. |
| 8 | `PageTitleDescriptive` | 2.0 | A | 2.4.2 | serious | `<title>` must be descriptive — rejects generic titles like "Home", "Page", "Untitled". |

---

## 10-tabs.js — 9 rules

Tab widget ARIA pattern rules ensuring correct `tablist` → `tab` → `tabpanel` relationships and attributes.

| # | Rule ID | WCAG | Level | Criterion | Impact | What it checks |
|---|---------|------|-------|-----------|--------|----------------|
| 1 | `TabAriaControls` | 2.0 | A | 4.1.2 | serious | Each `role="tab"` must have `aria-controls` pointing to its associated tabpanel. |
| 2 | `TabAriaSelected` | 2.0 | A | 4.1.2 | serious | Each `role="tab"` must have `aria-selected` (`true` for active, `false` for inactive). |
| 3 | `TabListMisuse` | 2.0 | A | 4.1.2 | serious | `role="tablist"` must only be used on containers that actually contain tab controls — not generic navigation. |
| 4 | `TabMismatch` | 2.0 | A | 4.1.2 | serious | Direct children of `role="tablist"` must have `role="tab"` — no unlabeled or role-less children. |
| 5 | `TabMisuse` | 2.0 | A | 4.1.2 | serious | `role="tab"` must only appear inside a `role="tablist"` — orphaned tabs break the ARIA pattern. |
| 6 | `TabPanelMismatch` | 2.0 | A | 4.1.2 | serious | Elements referenced by a tab's `aria-controls` must have `role="tabpanel"`. |
| 7 | `TabPanelMisuse` | 2.0 | A | 4.1.2 | moderate | `role="tabpanel"` must be linked to a tab via `aria-labelledby` — orphaned tabpanels are inaccessible. |
| 8 | `TablistRole` | 2.0 | A | 4.1.2 | serious | `role="tablist"` containers must have at least one `role="tab"` child. |
| 9 | `TabpanelLabelledBy` | 2.0 | A | 4.1.2 | moderate | `role="tabpanel"` must have `aria-labelledby` or `aria-label` identifying its associated tab. |

---

## 11-tables.js — 7 rules

Data table rules covering headers, nesting, captions, layout table identification, and row header scope.

| # | Rule ID | WCAG | Level | Criterion | Impact | What it checks |
|---|---------|------|-------|-----------|--------|----------------|
| 1 | `TableCaption` | 2.0 | A | 1.3.1 | moderate | Data tables (with `<th>`) must have a `<caption>`, `aria-label`, or `aria-labelledby` describing their purpose. |
| 2 | `TableHeaderEmpty` | 2.0 | A | 1.3.1 | serious | `<th>` elements must not be empty — must contain text, an image with alt, or `aria-label`. |
| 3 | `TableHeaders` | 2.0 | A | 1.3.1 | serious | Multi-row `<table>` elements must have at least one `<th>` for column identification by screen readers. |
| 4 | `TableMisuse` | 2.0 | A | 1.3.1 | moderate | Tables used for layout (few cells, no `<th>`, no `<caption>`) using `summary`, `role="table"`, or `role="grid"` should use `role="presentation"` instead. |
| 5 | `TableNesting` | 2.0 | A | 1.3.1 | serious | Tables must not be nested inside other tables — creates confusing screen reader navigation. |
| 6 | `TableRoles` | 2.0 | A | 1.3.1 | moderate | Layout tables (no `<th>`, no `<caption>`, trivial cell count) should have `role="presentation"` to remove table semantics. |
| 7 | `TableRowHeaderMismatch` | 2.0 | A | 1.3.1 | moderate | When a table has column headers, first-cell row headers should have `scope="row"` for proper screen reader association. |

---

## WCAG Criteria Index

Quick reference of all WCAG success criteria covered by accessScan rules.

| Criterion | Name | Level | Rules |
|-----------|------|-------|-------|
| 1.1.1 | Non-text Content | A | `AltMisuse`, `FigureDiscernible`, `BackgroundImageDiscernibleImage`, `DecorativeGraphicExposed`, `IconDiscernible`, `ImageDiscernible`, `ImageDiscernibleCorrectly`, `ImageMisuse` |
| 1.3.1 | Info and Relationships | A | `AriaDescribedByHasReference`, `AriaLabelledByHasReference`, `BreadcrumbsNav`, `EmphasisMismatch`, `SalePriceDiscernible`, `StrongMismatch`, `AriaControlsHasReference`, `LinkCurrentPage`, `CheckboxDiscernible`, `RadioDiscernible`, `ArticleMisuse`, `BreadcrumbsMismatch`, `NavigationMisuse`, `RegionFooterMismatch`, `RegionMainContentMismatch`, `RegionMainContentMisuse`, `RegionMainContentSingle`, `SearchFormMismatch`, `ListEmpty`, `TableCaption`, `TableHeaderEmpty`, `TableHeaders`, `TableMisuse`, `TableNesting`, `TableRoles`, `TableRowHeaderMismatch` |
| 1.4.4 | Resize Text | AA | `MetaViewportScalable` |
| 2.1.1 | Keyboard | A | `MenuTriggerClickable` |
| 2.2.1 | Timing Adjustable | A | `MetaRefresh` |
| 2.4.2 | Page Titled | A | `PageTitle`, `PageTitleDescriptive` |
| 2.4.4 | Link Purpose (In Context) | A | `LinkAnchorAmbiguous`, `LinkAnchorDiscernible`, `LinkNavigationAmbiguous` |
| 2.4.11 | Focus Not Obscured (Min) | AA | `StickyHeaderObscuresFocus` |
| 2.4.12 | Focus Not Obscured (Enhanced) | AA | `FocusNotObscuredFooter` |
| 2.5.3 | Label in Name | A | `AriaLabelledbyContentMismatch`, `VisibleTextPartOfAccessibleName` |
| 2.5.7 | Dragging Movements | AA | `DraggingAlternative` |
| 2.5.8 | Target Size (Minimum) | AA | `TargetSize` |
| 3.1.1 | Language of Page | A | `HtmlLang` |
| 3.2.1 | On Focus | A | `NoAutofocus` |
| 3.2.2 | On Input | A | `FormContextChangeWarning`, `FormSubmitButtonMismatch` |
| 3.2.5 | Change on Request | AAA | `LinkOpensNewWindow` |
| 3.3.2 | Labels or Instructions | A | `RequiredFormFieldAriaRequired` |
| 4.1.2 | Name, Role, Value | A | `IframeDiscernible`, `NoExtraInformationInTitle`, `NoRoleApplication`, `VisibilityMismatch`, `VisibilityMisuse`, `ButtonDiscernible`, `ButtonMismatch`, `LinkNavigationDiscernible`, `TablistRole`, `TabAriaControls`, `TabAriaSelected`, `TabListMisuse`, `TabMismatch`, `TabMisuse`, `TabPanelMismatch`, `TabPanelMisuse`, `TabpanelLabelledBy` |

### Best Practice Rules (no WCAG criterion)

| Rule | Category | What it checks |
|------|----------|----------------|
| `HtmlLangValid` | Metadata | Valid ISO 639-1 language code |
| `LinkImageWarning` | Interactive | Link opens image file directly |
| `LinkMailtoWarning` | Interactive | Link opens mail client |
| `LinkPDFWarning` | Interactive | Link opens PDF document |
| `MainNavigationMismatch` | Forms | Main nav not in `<nav>` landmark |
| `MenuAvoid` | Interactive | `role="menu"` misused on web nav |
| `MenuBarAvoid` | Interactive | `role="menubar"` misused on web nav |
| `MenuItemAvoid` | Interactive | `role="menuitem"` misused on nav links |
| `MetaDescription` | Metadata | Missing meta description tag |
| `MetaViewportPresent` | Metadata | Missing viewport meta tag |
| `RegionFooterMisuse` | Landmarks | `role="contentinfo"` on non-footer |
| `RegionFooterSingle` | Landmarks | Multiple footer landmarks |

---

## Impact Distribution

| Impact | Count | Percentage |
|--------|-------|------------|
| Critical | 4 | 5% |
| Serious | 38 | 46% |
| Moderate | 29 | 35% |
| Minor | 12 | 14% |
