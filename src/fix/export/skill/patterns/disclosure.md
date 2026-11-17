# disclosure: aria-expanded and aria-controls with real keyboard behaviour

Intent: a control that shows or hides a panel exposes its state and the panel it controls.

Before:

```liquid
<button type="button" class="accordion-trigger">{{data:item.title}}</button>
<div class="accordion-panel hidden">...</div>
```

After (markup):

```liquid
<button type="button" class="accordion-trigger" aria-expanded="false" aria-controls="panel-{{ forloop.index }}">{{data:item.title}}</button>
<div id="panel-{{ forloop.index }}" class="accordion-panel hidden">...</div>
```

After (script, in the existing module under `src/scripts/`):

```js
trigger.addEventListener('click', () => {
  const open = trigger.getAttribute('aria-expanded') === 'true';
  trigger.setAttribute('aria-expanded', String(!open));
  panel.hidden = open;
});
```

Keyboard:
- A native `<button>` already handles Enter and Space. Do not add key handlers for them.
- Escape closes an open menu or popup panel and returns focus to the trigger. Accordions need no Escape.
- Initial `aria-expanded` matches the real initial state.

Cautions:
- The script must flip the attribute; markup alone is not enough. Find the handler by class name in `src/scripts/`.
- Ids unique per item (`forloop.index`); the same expression in `aria-controls`.
- Do not apply `aria-expanded` to tabs, menuitems, options, pagination or carousel dots.

Verify: rescan; activate with Enter and Space; the attribute and the panel flip together; Escape closes and focus returns.

Do not:
- Do not use a `div` as the trigger; use a button.
- Do not leave `aria-expanded="false"` hard-coded while the panel is open.
- Do not change the open/close animation.
