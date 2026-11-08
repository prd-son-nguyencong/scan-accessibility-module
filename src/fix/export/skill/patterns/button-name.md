# button-name: every button has an accessible name

Intent: a screen reader announces the action. A button with only an icon or empty spans is announced as "button".

Before:

```liquid
<button type="button" class="menu-toggle">
  <span class="bar"></span><span class="bar"></span>
</button>
```

After (visible text preferred, `aria-label` when the control is icon-only):

```liquid
<button type="button" class="menu-toggle" aria-label="Menu">
  <span class="bar" aria-hidden="true"></span><span class="bar" aria-hidden="true"></span>
</button>
```

Cautions:
- The name states the action (Menu, Close, Search), never "button" or "icon".
- Two buttons with the same role in one view need different names (Close filters, Close dialog).
- If the name comes from data, bind it in the sidecar. If the site is translated, use the project's string source.
- A button already containing visible text needs no `aria-label`; do not add one.

Verify: rescan; `button-name` gone for the selector pattern. Inspect the accessibility name in dev tools.

Do not:
- Do not use `title` alone as the name.
- Do not label a decorative icon instead of the button.
- Do not change the element to a link or a div.
