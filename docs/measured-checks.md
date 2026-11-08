# Tool-owned measurements

Some checks are decided by ada-scan itself on the live DOM, not by the engine that raised the finding. The engine row (axe, Lighthouse or the accessScan rule) is a candidate: ada-scan measures the same element and the measurement sets the verdict. A finding is `confirmed` only when the tool's own numbers fail; the numbers are recorded as the proof.

The checks run once per page after the engines and re-verification, on the shared page. The page is resized to each scan viewport (`axe.viewports`, default desktop 1280x900 and mobile 390x844) for the length of the measurement and put back. A page that cannot be measured leaves the engine verdicts as they are.

## Target size (WCAG 2.5.8, Target Size Minimum)

Candidates: `target-size` (axe, Lighthouse) and `TargetSize` (accessScan). Frames are not entered.

**Where it failed.** The finding text (the `fix.hint` the report and the exported Cursor/markdown task print) and the proof name the failing viewport with its size and circle clearance, and the viewports that pass, so a reviewer who measures at 1280 learns that the failure is at 390.

**What is a target.** The target set and the neighbour set contain only elements that are operable and visible at measurement time: links with `href`, buttons, form controls (not `type=hidden`), `summary`, and an element with an interactive `role` (`button`, `link`, `checkbox`, `radio`, `switch`, `tab`, `menuitem`, `menuitemcheckbox`, `menuitemradio`, `option`, `slider`, `combobox`, `treeitem`) when it is focusable (`tabindex`) or holds no other control: 2.5.8 is about pointer targets, so a role control needs no tab stop. The `label` of a visually hidden (not operable) checkbox or radio is the target of that custom control. An inner role node inside a native `a[href]`, `button` or `summary` is not a target and is not measured: the outer control receives the click, and a row whose selector names the inner node is measured as the outer control. Wrappers (`li`, `div`, a region with `tabindex`, a banner root) are never targets, and neither are the ancestors or descendants of the candidate (a link around an image is one target).

**What is left out** (as target and as neighbour):

- `display:none`, `visibility:hidden`, computed `opacity` below 0.01 on the element or any ancestor (a closed menu or drawer fading in), `pointer-events:none`, `aria-hidden` or `inert` subtrees, disabled controls;
- zero-area, 1px (screen-reader-only) and `clip`/`clip-path` clipped-away elements;
- elements fully outside the document, or outside the box of an `overflow` clipping ancestor (collapsed `max-height`, off-canvas `transform`); elements below the fold are kept, the page is measured from scroll position 0.

A candidate row that is itself left out is `needs-review` ("target not measurable").

A target passes when any of these holds:

- it is at least 24 x 24 CSS px. The size is the hit area: the union of the element's box and the boxes of its in-flow descendants (an inline link around a block icon has a line-box fragment smaller than what the pointer reaches); absolutely positioned, fixed, hidden and 1px descendants are not part of it;
- the 24px circle centred on its bounding box intersects no other target's box and no circle of another undersized target (a circle that only touches passes);
- it is a link inside a sentence, or its size is constrained by the line height of the surrounding text: an `inline` element, or an inline-level box no taller than the parent line height, whose text block holds at least two other words of text outside controls (a focusable region around the text does not matter);
- it is a native checkbox or radio whose size the page does not set (user agent control). The browser draws about 13 x 13 px; a checkbox or radio of another size was resized by the author, loses the exception and becomes `needs-review` ("author-resized native control") instead of confirmed;
- an equivalent control gives the same function in a target of at least 24 x 24 px: another target with the same `href` (not a fragment or `javascript:`) or the same `aria-controls`. The reason says "equivalent control".

**Neighbours that are not neighbours.** A target is not measured against a node that no pointer can reach (nine points over its box and the point nearest the target's centre are all covered by another element, `document.elementFromPoint` returns something that is neither the node nor one of its descendants: a link behind a fixed header, a hidden widget snapshot; a node whose centre alone is covered still counts), against a larger node that contains the target's centre while the pointer there reaches the target (a stretched card link or header-wide link drawn behind the control is the surface it sits on), against a node of the same control (one control ancestor holds both, or a label and the control it names), or against its own descendant or ancestor. A centre outside the viewport cannot be asked and still counts.

**Reachable part of a neighbour's box.** A box that meets the 24px circle only where something covers it (a fixed header over a footer button that sits under it at scroll 0) is not a neighbour for that circle. When the circle meets a box, the tool asks `document.elementFromPoint` at the box point nearest the circle centre and on a 2px grid over box and circle; the box counts only if one of those points hits the box or a descendant (a point outside the viewport cannot be asked and counts). Two undersized targets are still judged circle against circle, exactly as WCAG 2.5.8 words it: dots 10px wide on a 20px pitch have circles (24px) that intersect, so a row of such dots fails even though no circle touches the neighbouring dot's box.

**Vendor controls.** A control inside a vendor-owned container (consent banners such as OneTrust, Cookiebot, Osano, Usercentrics, Didomi, TrustArc; chat widgets such as `#chat-widget`, Intercom, Zendesk, HubSpot; matched on id and class of the control and its ancestors) is a target and may be a neighbour. When the circle intersection exists only because of vendor controls (without them the target would pass), or the undersized target is itself a vendor control, the row is `needs-review` with the reason "depends on a third-party control" and is never confirmed or added as a new finding. A fixed banner container is not a target; only its buttons and links are.

**Which element a row names.** A row is measured on the element it names, never on the first element of a shared selector. Lighthouse reports one selector for a whole list of links (`div.col>ul>li>a`); when a selector matches several elements the tool narrows by the opening tag of the html the row quotes, then by the engine's DOM path (`evidence.path`, childNodes indices). Still several: the row is `needs-review` ("target not measurable: its selector matches N elements") and no element is measured for it. A failure the engine row hid is still reported by the tool's own scan of all undersized targets.

**Viewports other than the loaded one.** The shared page is resized to each viewport. A size-dependent layout a script fixed at load (heights, offsets, carousels) is stale after a resize, so a failure at a viewport other than the loaded one is re-measured on a fresh page loaded at that size (same browser context, scrolled once to wake lazy content) and the fresh numbers replace the resized ones. When the page cannot be reloaded or the target is not found there, the resized numbers stand.

**Rounding band.** Inline boxes take their height from font metrics, which differ by up to a pixel between platforms. For a target or the neighbour that limits it being an inline (`display:inline`) box, a circle overlap smaller than 1px (clearance between -1px and 0, `OVERLAP_NOISE_PX`) is not decidable from one measurement: the row is `needs-review` ("circle overlap of 0.5px is below the 1px rounding"). An overlap of 1px or more at any viewport is a measured failure, and so is any overlap between fixed-size (block, flex, px) boxes, which have no font noise; touching or clear still passes.

**Styles that did not apply.** A link whose own class sets the display (`inline-flex`, `flex`, `grid`, `block`, `inline-block`) while the browser draws it as plain `inline` has lost its stylesheet (a utility sheet that did not load, or an override): the box that was measured is not the designed one, so a failure is `needs-review` ("the control's own display class is not in effect").

Not modelled: the essential exception (a particular presentation that is essential or legally required). A script cannot tell it from a design choice, so it stays a manual judgement; a confirmed row is a measured fact that holds unless the site claims the exception.

Numbers per viewport: width x height, nearest neighbour distance (gap between the two boxes), circle clearance (distance between the 24px circle and the nearest other target's box or undersized target's circle; negative means they intersect).

Verdicts:

| Measurement | Verdict |
| --- | --- |
| undersized and the circle intersects a neighbour at any viewport | `confirmed`, kind `deterministic` |
| the engine flagged it but our geometry passes at every measured viewport | `needs-review`, reason names the exception that holds |
| element not found, not operable (hidden, closed menu, offscreen) or inside a frame | `needs-review`, reason "target not measurable in the page document" |
| the failure depends on a vendor control (neighbour or target) | `needs-review`, reason "depends on a third-party control" |
| the circle overlap is below 1px at every failing viewport and an inline text box is involved (font-metric rounding) | `needs-review`, reason "circle overlap of Npx is below the 1px rounding" |
| the row's selector matches several elements and neither its html nor its DOM path singles one out | `needs-review`, reason "selector matches N elements" |
| the target's own display class is not in effect (stylesheet missing) and its circle intersects a neighbour | `needs-review`, reason "display class is not in effect" |
| an undersized target with an intersecting circle that no engine reported, passing every filter above | new `TargetSize` finding (layer `accessScan`), `confirmed`; no cap, grouped by tag chain without positions and nearest list, nav or landmark: a footer link list is one finding, `evidence.occurrences` holds the count, container, pattern and up to 20 selectors |

Proof (`measured-fact`):

```
20 x 20, nearest neighbour distance 3px, circle clearance -1.2px at viewport 390x844; fails only at 390x844 (1280x900: spacing exception: the 24px circle intersects no other target)
```

The measured numbers of every viewport are kept in `evidence.measured`; the reason of a `needs-review` row is `evidence.reviewReason`.

## Label in name (WCAG 2.5.3)

Candidates: `label-content-name-mismatch` (Lighthouse) and `VisibleTextPartOfAccessibleName` (accessScan). Controls checked: links with `href`, buttons, `input` buttons, `summary` and elements with role `button`, `link`, `tab` or `menuitem`.

- Visible label: the rendered text of the control. Text is left out when it is `display:none`, `visibility:hidden`, `font-size:0`, fully transparent, `aria-hidden`, indented off screen, clipped to a pixel (the screen-reader-only pattern) or has no client rect. A control with no rendered text has no visible label (an image `alt` is not visible text, so an image-only link is never a 2.5.3 finding). Only a control named by `aria-label` or `aria-labelledby` is judged. An `input` button uses its value.
- Accessible name: `aria-labelledby`, then `aria-label`, then the native name (`input` value, image `alt`), then the name from content (hidden by display, visibility or `aria-hidden` is skipped; `font-size:0` and clipped text still count), then `title`. Pseudo-element content is not read.
- A label with no letter or digit (a symbol such as a cross) is not a label. A control with no accessible name is another rule's finding.
- The check fails only when a visible label exists and the accessible name does not contain it, compared after Unicode NFKC normalisation (composed and decomposed accents are equal), in lower case with whitespace and punctuation collapsed. Symbols are compared as the words a screen reader speaks (`&` = and, `+` = plus, `%` = percent, `@` = at, `#` = number): visible "Terms & Conditions" is contained in the name "View Terms and Conditions (opens in a new tab)". The visible words must be a contiguous run of the name's words; spelling variants that differ only by a hyphen or space ("e-mail", "email") count as the same run. The `alt` of an `input type=image` is not visible text: such a control has no visible label. A visible text of more than ten words with no title to address the control by (the card case) that the name does not contain is `needs-review` ("long visible text without a title"), not a failure.

Verdicts: fail at any viewport is `confirmed`; a pass is `needs-review` with the reason "no visible label in rendered text" or "visible label ... is contained in the accessible name ...". A failing control no engine reported becomes a new `VisibleTextPartOfAccessibleName` finding (layer `accessScan`, at most 25 per page). The engine rows and ours are one family (`label-in-name`) and merge into one finding that takes our verdict.

Symbols compare in two readings, spoken (`&` and, `+` plus, `%` percent, `@` at, `#` number) and dropped. The text holds when it holds in either reading, so "Job #5" passes against "Job 5" and "Job number 5", and "Save 50%" passes against "Save 50 dollars".

Duplicate ids: the name of each copy is the accessible text (aria-label, img alt, role=img label, svg title, child aria-label, skipping display:none and aria-hidden). Where flat markup ties on nesting depth, several rendered `label[for]` (labelable controls only), `aria-labelledby`, `aria-describedby`, `aria-errormessage`, `headers` or `aria-controls` referrers onto several candidate copies (rendered ones plus the first, which the browser resolves to even when hidden) cannot all reach their own copy, so the rule confirms (for everything but label[for] and aria-controls only when the copies read differently); `visibility:hidden` referrers count as hidden; the browser resolves every tie to the first copy.

Proof (`name-vs-text`): `visible text "Start your search" is not part of accessible name "Open chat" at viewport 1280x900`. `evidence.visibleText` and `evidence.accessibleName` hold both strings.

## Contrast on a settled page

Candidates: `color-contrast` rows from axe and Lighthouse. Before any contrast pass (axe, the pixel resolver for axe "incomplete" nodes, this check) the page is settled: CSS animations and transitions are switched off with an injected style, every running Web Animation is finished (`document.getAnimations()`; an infinite one is cancelled) and two animation frames are waited. Script-driven tweens (inline styles written by a timer) cannot be frozen, so the check samples twice.

Sample: text colour, the composited background colour up to the first opaque ancestor (the background owner), the product of the opacities of the elements below the owner, font size and weight. An ancestor's opacity fades its background and the text together, so opacity at or above the owner is not multiplied in: the row becomes `needs-review` ("an element at or above the background owner has opacity below 1"). When no ancestor is opaque the canvas is taken as white only if `elementsFromPoint` at the text finds no other element painting a colour or image behind it (a positioned sibling, a hero overlay); otherwise the sample is `unmeasured` and the row is `needs-review`, never white. Text over a background image or gradient (on the element or an ancestor up to the owner) that only sampling measured is `needs-review`; a row that carries glyph-pixel evidence of a solid fill (`evidence.pixelContrast`) keeps its verdict. Inactive components (`aria-disabled="true"`, a disabled control or `fieldset`, a label of a disabled control) and logotypes (id, class or `aria-label` with a `logo` token on the element or up to three ancestors, stopping at the link or button) are exempt from 1.4.3: `needs-review` for a person to confirm the exemption. A stable failure writes its own proof (`computed-ratio`, ratio, threshold, colours, size and weight) so a confirmed contrast row is traced to our number, for example a link `rgb(0,175,240)` at 18px weight 300 on a white footer (2.5:1, not large text) is confirmed. Text painted by `background-clip: text` (the element or any ancestor), or whose `color` or `-webkit-text-fill-color` is fully transparent, is not drawn in the colour read here over the backdrop read here: the row becomes `needs-review` ("contrast not decidable from pixels or computed colours"), never confirmed. The glyph-pixel resolver for axe "incomplete" nodes applies the same rule: such a node stays incomplete with the reason (no ratio), because hiding the text fill leaves the clipped gradient in the screenshot and reads it as the backdrop (1.00:1 artefacts). Text over a real image or gradient backdrop with an opaque fill is still measured and confirmed from pixels. Two samples are taken 300 ms apart.

| Result | Verdict |
| --- | --- |
| the colours or ratio change between the samples | `needs-review`, reason "contrast changes between two samples 300ms apart (animation or transition in progress)" |
| both samples agree and the ratio meets the threshold (4.5:1, 3:1 for large text) | `needs-review`, the engine sampled a state that did not hold |
| both samples agree and the ratio fails | the engine verdict stands; `evidence.measured.contrast` records the ratio and `evidence.proof` the measured ratio |
| background image or gradient, unmeasured backdrop, translucent ancestor at or above the owner, inactive component or logotype | `needs-review` with the reason, unless glyph-pixel evidence of a solid fill is present |

## Links on an error page

A link finding (`dead-link-404`, `dead-link-server-error`, `dead-link-unreachable`, `broken-link`) on a route that matches `scan.errorPages` (default `/404`, `/500`; never `/job-details` or a bare shell, where links are real) is `needs-review` with reason "link on an error page mirrors the failed path": a language switch there repeats the failed path on another host and is expected to lead to an error. A 404, 410 or 5xx is asked again twice with a browser user agent and a short backoff (0.3 s, 0.9 s): the final status decides, so a bot-defence 502 that answers 200 on the retry is never confirmed: a same-origin link then drops to no finding; an external one stays `needs-review` "dead-link-unreachable" (reason "inconsistent-status", the HEAD and the final GET disagree), and a 404 that persists stays confirmed. An empty `href` is a markup fact and keeps its verdict. On a local page, a 404 on another origin whose path repeats the local page path (a script that appends `window.location.pathname` to a host) is `needs-review` with reason `route-echoes-local-page`: the live page can redirect elsewhere, so the visitor's URL is not the one probed.

## Disclosure controls without aria-expanded

Rules: `disclosure-missing-aria-expanded` and, for controls that declare `aria-haspopup`, `menu-trigger-missing-aria-expanded` (dynamicContent layer, WCAG 4.1.2). Implementation: `src/scanner/disclosure.js`.

Candidates: a visible, operable control (button, `role="button"` with a tab stop, `aria-haspopup`, `aria-controls`) without `aria-expanded` that declares what it controls or looks like a disclosure by id, class or name (hamburger, menu, drawer, accordion, faq, toggle). Not candidates: anything inside a hidden container (`display:none`, `visibility:hidden`, `inert`, `aria-hidden`), controls inside `details`, submit buttons, links that leave the page, and controls that match a vendor entry in `vendors.json` (consent banners and similar). A vendor control that is hidden is never a site trigger.

Measurement: the scanner records the state of the target panel (the `aria-controls` element, else a sibling, else a drawer-like element): visibility, `hidden`, `aria-hidden`, height. It activates the control once in the live page, records the state again, activates it again to close, and restores the attributes it touched. Navigation from anchors and submit buttons is prevented during the activation.

| Result | Verdict |
| --- | --- |
| the panel was found through `aria-controls` or as an adjacent sibling, its visibility flipped (visibility, `hidden` or `aria-hidden`), it is not a dialog and the control has no `aria-pressed` | `confirmed`, proof `measured-fact` with the before and after state |
| only the height changed (a load-more list, a player control) | `needs-review`: moving content is not opening a disclosure |
| the target is the page-wide drawer fallback or a parent search, not aria-controls or an adjacent sibling | `needs-review`: the panel may not belong to the control |
| a dialog trigger (`aria-haspopup="dialog"`, or a target with role dialog, `aria-modal`, `<dialog>`) | `needs-review`: a dialog trigger needs no `aria-expanded` (APG) |
| the control has `aria-pressed` | `needs-review`: a toggle button, not a disclosure |
| the control has no `aria-expanded` at load but activating it makes a script set `aria-expanded` with the right value (compared with the panel state measured after the click, and after the second activation when there was one) | `needs-review`: the state is exposed at runtime, only the initial collapsed state is missing; the row keeps `measured.expandedAfter` |
| the script sets a value that does not match the measured panel (stuck at `true` after the panel closed, or inverted) and the panel was found through `aria-controls` or as an adjacent sibling | `confirmed`, proof `measured-fact` naming the panel state and the value |
| no panel found, or the panel did not change | `needs-review`, reason says which |

A hamburger that only renders below the desktop breakpoint has no desktop pass: the behaviour checks run the same measurement at 390 x 844 and skip the controls already rendered at the loaded width (recognised by element, or tag, id, name and href, never by markup) (their `evidence.viewports` says `mobile`).

The row carries the element markup and a selector from the same element, so ownership and source tracing run on that element.

## Link names that promise a new tab

Rule `link-new-tab-notice-without-target` (heuristic, needs-review): the accessible name says "opens in a new tab or window" but the link has no `target="_blank"`. A script may open the window, so the markup alone does not prove a defect. The inverse (`target="_blank"` without a notice) is the accessScan rule `LinkOpensNewWindow`.

## Unresolved translated text

A label-in-name row (`label-content-name-mismatch`, `VisibleTextPartOfAccessibleName`) whose visible text, accessible name or element attributes still contain a platform wrapper (`_translate(`, `{{`) is `needs-review`, reason "text not resolved in local render". The local render does not hold the text a user reads, so the comparison proves nothing. Comparison of resolved text ignores case, whitespace, punctuation and apostrophe variants (WCAG 2.5.3 practice).

## Duplicate ids and SVG sprites

`duplicate-id-referenced` fires only when an accessibility reference resolves to a duplicated id: `aria-labelledby`, `aria-describedby`, `aria-controls`, `aria-owns`, `aria-activedescendant`, `aria-details`, `aria-errormessage`, `aria-flowto`, `label for`, `headers`, `list` and an in-page anchor (skip target). `<use href="#id">` is not an accessibility reference (the icon is decorative and the id never reaches assistive technology), so a repeated `<symbol id>` in a sprite is not reported.

## Label in name with a title and captions

When the visible label spans several block-level runs (a card title plus a caption), the first run is the title only when it is two or more words, is also visually first, and the remaining runs are no longer than it. A name that contains the whole label, or such a title alone, passes. A name without the title, a one-word first run (a tag, `Apply` of `Apply Now`) or a longer second run fails as before.

## Skip link source

`skip-link-missing` (and the axe `bypass` absence row) names the header partial that every page layout renders as the primary source, or the layout body when one layout serves all pages and there is no header partial. The page `<main>` stays a secondary candidate. When pages use layouts that do not share a header, the page anchor stays the only answer. A skip link that exists but has no target remains a page defect.

## Size findings and generic CSS

A CSS rule is the primary source of a size finding only when it sets a box property of the element itself (line-height, padding, min-height, height, width, margin, gap). A rule that only sets font-size, or one inherited from an ancestor, is listed as a low-confidence candidate; the markup line stays primary with the note "size comes from inherited font-size/line-height".

## Reflow at 320px (WCAG 1.4.10)

Rule `reflow-horizontal-scroll`, layer `dynamicContent`. The shared page is resized to 320 x 568 CSS px (what 400% zoom of a 1280px window gives), settled for 350 ms, measured and put back. The document scrolls sideways when `document.scrollingElement.scrollWidth` exceeds `clientWidth` by more than 1px.

- Offenders: visible elements whose right edge is past the viewport, reduced to the innermost ones (a wrapper that only contains the cause is not listed), the widest five with selector, right edge and width.
- Left out: tables, `role=table` and `grid`, `pre`, images, SVG, canvas, video, iframes and map or carousel widgets (content that may need two-dimensional scrolling); anything inside an ancestor that scrolls or clips sideways and fits the viewport; hidden, `aria-hidden` and zero-size elements.
- `confirmed` (kind `deterministic`) when the document scrolls and at least one non-exempt offender is visible. Proof: `document scrollWidth 800 vs 320 (viewport 320 x 568); widest: div.wide (right edge 800px, width 800px)`.
- Fixed-position content does not widen the document but is clipped and unreachable when wider than the viewport. A visible fixed element that starts inside the viewport and is wider than it (an off-canvas drawer that starts at the right edge is not) is `needs-review` (the tool cannot tell whether the content can be reached another way), also when the document itself does not scroll.
- `needs-review` when `html` or `body` has `overflow-x: hidden` (content is cut off, not scrolled), or the document scrolls and no visible element sticks out. No finding when only exempt content sticks out.

## Focus return after Escape (WCAG 2.4.3)

Rule `focus-lost-after-escape`, layer `dynamicContent`. For up to 8 visible triggers that declare a panel (`aria-expanded`, `aria-haspopup` or `aria-controls`; triggers inside header or nav first, so a cap never drops the site navigation), the tool focuses the trigger, presses Enter, and requires the panel to open (the `aria-controls` target becomes visible, else `aria-expanded` becomes `true`). It then presses Escape.

- Focus back on the trigger (or inside it) passes; a panel Escape does not close, a trigger Enter does not open, or focus that moved to another control produce no finding. A panel that is open at load is not tested.
- Focus on `<body>` alone is not proof of a 2.4.3 failure: in Chromium and Firefox the sequential focus start point stays at the trigger, so the next Tab goes to the control after it. The tool presses Tab once more and records the stop it reaches among the page's tab stops. `confirmed` only when that Tab restarts at the first stop of the page (while the trigger is not the first), lands before the trigger, or lands more than 15 stops after it (F85 pattern); proof `Enter on the trigger opened its panel; Escape closed it and document.activeElement is <body> (focus lost), not the trigger; one Tab then moved focus to <a> "Home" (stop 1 of 12, the trigger is stop 4), not to the control after the trigger (focus order restarted)`. Focus on body with the next Tab landing near the trigger, or a landing that cannot be measured, is `likely` (users lose their place; best practice, not a measured failure).
- Nested submenus: while the trigger's panel is open, up to 6 visible triggers inside it (its `aria-controls` panel, else its `li` or parent; one level deep, never the page-level triggers already driven) get the same Enter, Escape and Tab probe. Focus returning to the nested trigger, to the outer trigger or staying inside passes. The outer panel is re-opened when Escape closed the whole menu.
- Navigation guard: a trigger that is an `a[href]` with a real URL (not a `#fragment`) is not activated, in both this check and the menu keyboard checks; Enter would unload the page and pollute every later check.
- Runtime bound: at most 8 + 6 per opened panel triggers, one Tab press and 60 ms per probe.

Menu keyboard checks (`scanMenuKeyboard`, layer `dynamicContent`). For up to 12 visible triggers the tool records the visible focusable controls and `document.activeElement` with real key presses, before and after each step. A trigger that is open at load, or an `<a>` with a real href when activation is needed, is not driven.
- `dropdown-not-dismissible-with-escape` (1.4.13): focusing the trigger alone (no activation) opened the panel; Escape on the trigger, and Escape on a link inside the panel when Tab or ArrowDown can reach one, leave it open. A hover-only menu, or one that Escape closes, produces no finding. Confirmed only at the viewport the page loaded at: the mobile pass resizes the viewport after load, and a script that bound its focus handler by `window.innerWidth` at load keeps it, so a focus-open measured there is `needs-review` (this includes a CSS-only `:focus-within` menu that only exists at mobile width).
- `menu-links-unreachable-by-keyboard` (2.1.1): after Enter, links of the menu (inside its aria-controls panel or its nav, header, footer or parent) that were not visible before appear; ArrowDown then ten Tab presses did not put focus on any of them. Page-wide links that appear for other reasons (a back-to-top link shown by scrolling) are not the menu. Links hidden while the menu is closed are not counted, and a roving-tabindex menu reached by ArrowDown passes. A new link that is in the tab order (`tabIndex` 0 or more) and precedes the trigger in the DOM is reached by Tab from the previous stop (the walk only goes forward from the trigger), so it is set aside and the other new links are judged on their own. A tabbable link after the trigger that is within ten tab stops of it and was still never reached (a key handler swallowing Tab) is confirmed; one more than ten stops away is `needs-review`, since the walk stopped short, but only when every remaining new link is beyond the walk: a mega menu with both near and far links that was not reached is confirmed, and the finding lists only the near ones. Links outside the tab order (`tabindex="-1"`) are confirmed, and when any exist only they are judged, so a far-away tabbable new control does not demote them.
- `focus-lost-after-escape` (2.4.3), panel level: focus is on a link inside the opened panel, Escape closes the panel and `document.activeElement` is `<body>`; the same one-Tab landing decides `confirmed` or `likely` as at trigger level. Same rule id and proof family as the trigger-level check; one row per trigger, the stronger verdict kept when both levels report it.
- `aria-expanded-not-updated` (4.1.2): the trigger has `aria-expanded`, Enter made the panel visible, the value is unchanged. A missing attribute stays `disclosure-missing-aria-expanded`.
When a trigger cannot be driven (focus fails, Enter does not open it) there is no finding.

## role=button operated by the keyboard (WCAG 2.1.1)

Rule `role-button-not-keyboard-operable`, layer `dynamicContent`. Candidates are `[role=button]` elements that are not `button`, `input`, `summary` or `a[href]` (for example `a[role=button]` without `href`). The DevTools protocol lists the element's `click` listener and the key listeners on it and its ancestors up to `body`. Only an element with its own click listener (or `onclick`) is measured. With a key listener on the element or an ancestor the answer is not known and nothing is reported.

The element is focused and a real Enter and a real Space key press are sent; click events targeting the element are counted in a capture listener that swallows them, so the page's own handler does not run. `confirmed` when the element cannot take focus (no `href`, no `tabindex`: "cannot take keyboard focus"), or Enter or Space produced 0 clicks (`Enter 0, Space 0`). A browser without the DevTools protocol only sees `onclick` attributes.

## Focus visible, keyboard traversal (WCAG 2.4.7)

Layer `keyboard`. The tool presses Tab through the page and, for each stop with no style change of its own, takes a screenshot pair (focused, then blurred) of the control.

- A tabbable control that is not rendered at the loaded (desktop) width but is at 390 x 844 (a hamburger; a desktop control is recognised by element, or tag, id, name and href, so a script rewriting its classes or attributes does not count) is Tab-focused there (`scanMobileOnlyFocus`): no style change on the control or its wrapper and identical pixels focused vs blurred is `confirmed`, otherwise `needs-review`; the description names the viewport it was measured at.
- `focus-not-visible` is `confirmed` only when the pixels are identical focused and blurred. The compared area covers the control and every wrapper, parent or sibling whose computed style changed on focus (`:focus-within` and similar): the pixel comparison always runs, because identical pixels prove no visible cue whatever the computed styles say. Different pixels, a clip area larger than the screenshot cap, or an exhausted sample budget (80 pairs per page) give `needs-review`.
- `focus-indicator-removed` (a stylesheet rule that sets `outline: none` on a `:focus` selector with no replacement in the same rule) is a guess about the cascade: a `:focus-visible { box-shadow }` rule or a utility class elsewhere replaces the ring. Its row is `needs-review`. It becomes `confirmed` only when a confirmed `focus-not-visible` pixel proof exists for an element that the rule's selector (pseudo-classes stripped) matches; the description then names the selector, the element and the pixel proof.
- `focus-indicator-low-contrast`, fill-only path: the focused fill compared with the same element's unfocused fill is the change-of-contrast test of 2.4.13 Focus Appearance (AAA), not 1.4.11. It is labelled 2.4.13, impact `minor`, and says it is not a failure of an A or AA criterion. The ring path (ring versus the pixels next to it) stays 1.4.11.
- Traversal bound: up to 400 Tab presses and 80 proof pairs per page (about 25 ms per press plus the screenshots), then a note in `passes` that later stops were not measured. Stops are told apart by element identity, not by `tag|text|x|y`, so stacked slides or mobile and desktop copies with the same text at the same spot are separate stops; a Tab that wraps to a stop already measured is skipped.

## Invisible tab stops (WCAG 2.4.7)

Rule `focus-invisible-stop` (keyboard layer) is one finding per page. A closed menu whose links have `opacity: 0` and `pointer-events: none` is covered: its 17 links are 17 stops, the description carries the count and the stops are grouped by container (`in ul#site-menu (17)`), so a single closed menu reads as one cause. `confirmed` when focus lands on an invisible stop within the first 40 Tab presses.

## Which behavioural rows can confirm (verdict gate)

A behavioural-layer row (keyboard, focusTrap, ariaLive, dynamicContent, screenReader) is `confirmed` only when its check wrote `evidence.proof`. The old fallback that turned the row's own description into a `measured-fact` is gone: a digit or a quoted id in the wording proved nothing, so `multiple-main-landmarks` or `focus-indicator-removed` were confirmed by their own text. A row with no recorded proof now carries a `dom-structure` proof and is `needs-review`.

Checks that write a proof of their own: `page-missing-title` (the measured title), `html-missing-lang` (the lang and xml:lang values read), `image-alt-missing-sr` (count of rendered `img` with no alt that are not hidden, decorative or named another way), `empty-heading` (the visible heading with no text or name), `aria-live-alert-not-assertive` (the role and aria-live value read), `tabs-missing-aria-selected` (0 of N tabs aria-selected="true" while one looks selected), the modal rules, the disclosure rows, reflow, focus return, role=button. Keyboard checks that measure but record no proof field (`focus-not-visible` with the focused-vs-blurred pixel comparison, `focus-invisible-stop` with a landed element, `skip-link-missing`, `skip-link-target-missing`) get the proof from `keyboardEvidence` in `src/index.js`, never for a row the check left `needs-review`. `focus-indicator-removed` is a stylesheet guess and records nothing: `needs-review`.

### Downgraded rules and why

| Rule | Verdict now | Why |
| --- | --- | --- |
| `missing-main-landmark`, `multiple-main-landmarks` | `needs-review` | cited as 1.3.6 (AAA); no A/AA criterion requires a main landmark, 2.4.1 can be met by headings or a skip link (axe: best-practice); the rows no longer cite a criterion |
| `empty-heading` | `likely` | axe `empty-heading` is best-practice; an empty heading is not an A/AA failure by itself |
| `dialog-no-label` | `needs-review` | axe `aria-dialog-name` is best-practice and a dialog is a container, not an operable 4.1.2 component; now only for an open dialog and `title` counts as a name |
| `tabs-missing-aria-controls` | `needs-review` | `aria-controls` on a tab is APG advice, not required by 4.1.2 |
| `tabs-missing-aria-selected` | `confirmed` with proof when one tab looks selected (active/selected class, `aria-current`) and none has `aria-selected="true"`; else `needs-review` | 4.1.2 fails when the selected state is not exposed |
| `modal-focus-escapes`, `modal-focus-not-trapped` | `likely`, impact at most serious, SC 2.4.3 | leaving a modal is the opposite of a 2.1.2 keyboard trap; the dialog pattern is APG advice. An escape does not count when focus lands on a control inside the dialog's own `position:fixed` overlay wrapper (nearest fixed ancestor within 3 levels), so a close button drawn beside the dialog is not an escape; a page control behind or beside the overlay is |
| `skip-link-target-missing` | `likely` | a broken skip link, but a main landmark or headings already bypass the blocks (2.4.1) and the keyboard check does not record whether they exist |
| `FocusNotObscuredFooter`, `FocusNotObscuredHeader`, `StickyHeaderObscuresFocus` | `needs-review` for a translucent bar | 2.4.11 fails only when the control is entirely hidden; with a background alpha below 1, a `backdrop-filter` or opacity below 1 (and no opaque element on top at the five sampled points) it may stay readable through the bar |
| `form-field-no-label` / `form-field-placeholder-only` | unchanged (heuristic, `needs-review`) | a placeholder gives an accessible name, so a field with one is placeholder-only whether or not it has an id; only a field with neither (and no `title`) is no-label |

Recall note: the rows kept `confirmed` are the ones whose check measured something. The rules above lose only the confirmed tier; they stay in the report as `likely` (exported as fix tasks) or `needs-review`.

## Names and ids that rows depend on (verdict gates)

- `duplicate-id-referenced` (screenReader): confirmed only when a rendered referrer measurably gets something different from the first copy of the id: `aria-labelledby` or `aria-describedby` text that differs from its own copy's, a `label for` that reaches the first control, or an `aria-controls` whose own target is rendered. Hidden or `aria-hidden` referrers, identical copies, hidden menu panels toggled by script and other IDREF attributes are `likely` (WCAG 2.2 removed 4.1.1, so the duplicate itself is not an A/AA failure).
- `svg-img-alt` (axe and Lighthouse): an unnamed `svg role="img"` inside a button or link that is already named by `aria-label`, `aria-labelledby`, its other visible text, an `img` alt or `title` is child content of a named control: `needs-review`, proof dropped. An svg alone, or the only content of an unnamed control, stays confirmed.
