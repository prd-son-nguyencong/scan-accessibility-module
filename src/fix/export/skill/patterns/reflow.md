# reflow: 320 CSS px wide, zoom allowed

Intent: content works at 320px width (400 percent zoom) without two-dimensional scrolling, and the viewport allows zoom.

Before:

```liquid
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
```

After (shared layout, once):

```liquid
<meta name="viewport" content="width=device-width, initial-scale=1">
```

Cautions:
- Remove `user-scalable=no` and any `maximum-scale` below 5; keep `width=device-width, initial-scale=1`.
- Do not recreate a zoom lock with `touch-action: none` or script.
- A horizontal-scroll finding at 320px is a layout problem. Fixed widths in a template may be fixable with a responsive
  utility already used nearby; anything that changes the design at other widths is a question for the design owner.
- Data tables and code may scroll in their own container.

Verify: load at 320px width: no page-level horizontal scroll; pinch zoom works. Rescan: `meta-viewport` gone, no new layout findings.

Do not:
- Do not add `overflow-x: hidden` to the body to hide overflow.
- Do not shrink content with `scale` or `zoom`.
- Do not change breakpoints.
