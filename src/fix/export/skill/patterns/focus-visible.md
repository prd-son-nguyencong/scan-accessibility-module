# focus-visible: keyboard focus is always visible

Intent: every focusable element shows an indicator when focused by keyboard.

Before:

```liquid
<button type="button" class="outline-none px-4">Search</button>
```

After (remove the suppression, keep the default or add a focus-visible style the project already uses):

```liquid
<button type="button" class="px-4 focus-visible:outline-2 focus-visible:outline-offset-2">Search</button>
```

Hidden focus stop: show it on focus (`sr-only focus:not-sr-only`) or make it unreachable while hidden (`hidden`, `inert`).

Cautions:
- Colour of the ring: reuse an existing utility or token already in the project, such as `outline-current`. Choosing a new
  colour is a design decision: ask. This pattern never edits an existing colour.
- Use `focus-visible:` (keyboard), not `focus:` for rings.
- Indicator at least 2px, not clipped by `overflow-hidden` on an ancestor.
- A closed menu or slide is `inert` while closed.

Verify: Tab to the control; a visible ring appears and is not clipped. Rescan: rule gone, no contrast finding appears.

Do not:
- Do not ship `outline-none` or `outline: 0` without a `:focus-visible` replacement.
- Do not make the element unfocusable to hide the problem.
- Do not use `opacity-0` on something that stays focusable.
