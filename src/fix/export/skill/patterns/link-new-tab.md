# link-new-tab-notice-without-target: the link and its notice agree

Intent: if a link opens a new tab, say so for assistive tech; if it does not, do not claim it does.

Before (notice without behaviour):

```liquid
<a href="/privacy">Privacy <span class="sr-only">(opens in a new tab)</span></a>
```

After, option A (it should open a new tab):

```liquid
<a href="/privacy" target="_blank" rel="noopener noreferrer">Privacy <span class="sr-only">(opens in a new tab)</span></a>
```

After, option B (it should not): remove the notice span.

Cautions:
- Check `window.open` in `src/scripts/` first: a script may already open the tab.
- Every `target="_blank"` needs `rel="noopener noreferrer"` and a notice.
- Which option is right is a product decision when the page is a legal or apply flow: ask.

Verify: rescan; the rule is gone for the pattern. Keyboard-activate the link and confirm behaviour matches the notice.

Do not:
- Do not remove a notice just to silence the finding when the link opens a tab.
- Do not add `target="_blank"` to internal navigation links without approval.
