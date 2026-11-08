# aria-misuse: roles and aria-hidden that do not belong

Intent: remove ARIA that the element may not carry, and stop hiding focusable content. Native HTML first.

Before:

```liquid
<ul role="menu"><li role="button">...</li></ul>
<div aria-hidden="true"><a href="/jobs">Jobs</a></div>
```

After:

```liquid
<ul><li>...</li></ul>
<div><a href="/jobs">Jobs</a></div>
```

A container hidden on purpose (closed menu) stays `aria-hidden="true"` and also becomes `inert` or `hidden`.

Cautions:
- If a script sets the role or aria-hidden (`setAttribute`), change the script as well as the markup.
- Keep ARIA the widget needs (`aria-controls`, `aria-selected`) only when the role stays.
- Prefer the native element over adding a role.
- Never remove `aria-hidden` from decorative icons.

Verify: rescan; `aria-allowed-role` and `aria-hidden-focus` gone. Tab never lands inside a hidden region.

Do not:
- Do not use `role="presentation"` on a real control.
- Do not add `aria-hidden` to anything focusable.
- Do not delete the element.
