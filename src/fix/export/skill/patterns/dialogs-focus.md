# dialogs-focus: modal dialogs, off-canvas panels and focus

Intent: when a dialog or panel opens, focus moves into it, stays inside while it is modal, Escape closes it, and focus returns to the opener. A closed panel is unreachable.

Before (closed panel still focusable):

```liquid
<div id="offcanvas" class="offcanvas" aria-hidden="true">
  <a href="/jobs">Jobs</a>
</div>
```

After (closed state):

```liquid
<div id="offcanvas" class="offcanvas" aria-hidden="true" inert>
  <a href="/jobs">Jobs</a>
</div>
```

The existing open handler removes `inert` and `aria-hidden` together, then moves focus to the first control or the panel heading.

Dialog markup when the project has no dialog yet and the task asks for one:

```liquid
<div role="dialog" aria-modal="true" aria-labelledby="dlg-title-{{ forloop.index }}">
  <h2 id="dlg-title-{{ forloop.index }}">...</h2>
</div>
```

Keyboard: Tab and Shift+Tab loop inside a modal (the project loads Focus Trap and Tabbable in the layout; use it, do not write a second trap); Escape closes; focus returns to the opener.

Cautions:
- Toggle `inert` and `aria-hidden` in the existing script, not only in markup.
- Never set `aria-hidden` on a container that holds focusable content unless it is also `inert` or `hidden`.
- Do not trap focus in a non-modal panel.

Verify: open with the keyboard, Tab around, Escape, check focus returns. Rescan: `aria-hidden-focus` gone.

Do not:
- Do not use `tabindex="-1"` on controls that stay visible.
- Do not hide a container that holds the only way to a feature.
- Do not change open and close transitions.
