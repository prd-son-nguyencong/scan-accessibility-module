# Pixel-measured contrast

Two checks measure colour from screenshots instead of trusting a declared colour.

## Text over images and gradients (axe layer)

axe reports `color-contrast` as *incomplete* (no ratio) when text sits on an image or gradient. For each such node
(at most 12 per page and viewport) the scanner:

1. disables CSS transitions and animations (the same style is also injected for the whole axe run and removed afterwards),
2. scrolls the element to the middle of the viewport and checks that nothing covers it,
3. takes a screenshot with the element's text made transparent (`color: transparent`, no layout change): the backdrop,
4. takes two more screenshots with the text forced to black and to white: a pixel is a glyph pixel when one of them covers at least half of the swing from the backdrop,
5. compares the real text colour (alpha and opacity blended) with the backdrop pixel under each glyph pixel, using the WCAG formula.

The threshold per text run is 3:1 for large text (24px, or 18.66px and bold) and 4.5:1 otherwise.

| Share of glyph pixels below the threshold | Result |
| --- | --- |
| 40% or more | `color-contrast` violation, `confirmed`, with the lowest and median ratio in the message |
| 10% to under 40% | stays an axe-incomplete `needs-review` finding, with the numbers |
| under 10% | passes, the incomplete node is dropped |

Text with a `text-shadow`: the shadow is part of the backdrop the glyph is read against, so the node is measured with the shadow
shown (only the glyph fill is hidden) and that result decides; the message also carries the share failing without it. `box-shadow`
and other backdrops are in the screenshot as painted. Only the resting state is measured: transitions, animations and
`scroll-behavior: smooth` are disabled first.

A node that cannot be measured (covered by another element, inside a frame, no visible text, over the cap) stays incomplete as axe reported it.

## Focus indicator (keyboard layer)

`focus-indicator-low-contrast` compares the focus ring with the pixels next to it in a screenshot of the focused element:
just outside the ring (outline-offset and ring width included), and also just inside it when a negative offset overlaps the element.
The element's own background or hover fill is never used. A ring passes when it reaches 3:1 against the outside neighbours, or, for an
overlapping ring, against either side. Outlines and new solid `box-shadow` rings are measured; a UA `outline: auto` ring is always accepted
(it is two-tone). A ring cut off by an `overflow` ancestor is reported separately as `focus-indicator-clipped` (minor, needs-review).
Before the screenshot the scanner waits two frames and re-reads the element's rectangle, and smooth scrolling is disabled: a ring
photographed while the page was still scrolling was measured at the wrong place and produced wrong ratios (the faint-ring case was missed).
The rectangle is re-read only from the element that was measured: if focus moved or blurred while waiting (blur handler, closing
menu, focus trap), the sample is skipped instead of being taken around another element's box. Before a ratio is reported the
scanner also checks that a pixel of the ring colour (within 40 per channel) exists inside the ring's band on at least one side; if not
(ring hidden, moved or still animating) the stop becomes `focus-indicator-unverified` (needs-review, minor) with no ratio, so a wrong
sample can never surface as a number such as 1.00:1. The exact round-1 values (2.92:1, 1.00:1) could not be reproduced from the scan
data; the causes reproduced with fixtures are a scroll still running and focus moving off the element (both measured the wrong place).
At most 60 stops per page are sampled.
