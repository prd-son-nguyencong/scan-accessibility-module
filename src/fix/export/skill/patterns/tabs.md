# tabs: tablist, tab, tabpanel with arrow-key behaviour

Intent: a tab widget exposes roles and relationships and works from the keyboard.

Before:

```liquid
<div role="tabpanel" id="panel-{{ forloop.index }}">...</div>
```

After:

```liquid
<button role="tab" id="tab-{{ forloop.index }}" aria-controls="panel-{{ forloop.index }}" aria-selected="false" tabindex="-1">...</button>
<div role="tabpanel" id="panel-{{ forloop.index }}" aria-labelledby="tab-{{ forloop.index }}">...</div>
```

Keyboard (WAI-ARIA tabs pattern, in the existing script): Left and Right arrows move between tabs, Home and End jump to first and last, the selected tab has `tabindex="0"` and the others `-1`, Tab moves into the panel.

Cautions:
- Both ids exist exactly once; use `forloop.index`.
- Keep `aria-selected`, `aria-controls` and `tabindex` in sync with the script when selection changes.
- Do not add `aria-expanded` to tabs.
- If the widget is a list of links styled as tabs, it is navigation, not tabs: remove tab roles instead (ask).

Verify: rescan; `tabpanel-labelledby` gone. Arrow through the tabs, confirm the panel changes and the accessible name of the panel is the tab text.

Do not:
- Do not use `tabindex` above 0.
- Do not remove tab roles from a working widget to silence a finding.
- Do not change tab visuals.
