# role-button-keyboard: real buttons, or full keyboard support

Intent: anything that acts like a button works with the keyboard and exposes a name and state.

Before:

```liquid
<div role="button" class="cta" onclick="openPanel()">Apply</div>
```

After (preferred, native element, same classes):

```liquid
<button type="button" class="cta" onclick="openPanel()">Apply</button>
```

If it cannot be a native element (platform markup), the minimum is `role="button"`, `tabindex="0"`, and a script that handles Enter on keydown and Space on keyup, plus a visible focus style.

Cautions:
- A native `<button>` may reset styles differently; keep the classes and check appearance at 375 and 1280 px.
- Navigation is a link, not a button: `<a href>` for a destination.
- Do not nest interactive elements inside a button.
- If the element is platform or vendor owned, report it (`when-to-ask-a-human.md`).

Verify: Tab reaches it, Enter and Space activate it, a focus ring is visible. Rescan: related rules gone.

Do not:
- Do not add `tabindex` above 0.
- Do not add `role="button"` to a link that navigates.
- Do not remove the click handler.
