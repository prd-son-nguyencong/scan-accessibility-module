# Paradox, Liquid and Tailwind rules

Paradox Site Studio projects are Liquid templates plus Tailwind, synced to a platform that owns some of the markup.

## Where to edit

- Edit the shared source once: a layout in `src/layouts/`, a partial in `src/partials/`, a component in `src/components/`.
  Every page that renders it changes together. Do not copy a fix into each page.
- A page template is `src/pages/<name>.liquid`. Its per-page values live in the paired `<name>.liquid.json` sidecar.
- Styles live in `src/styles/`. Prefer a Tailwind utility already used in the project over new CSS.

## Per-item values and ids

- Text, labels, alt text and ids that differ per item belong in the `.liquid.json` sidecar (or the loop variable), not
  hard-coded in the template.
- Inside `{% for %}`, build ids from `forloop.index` (`forloop.parentloop.index` for the outer loop):
  `id="panel-{{ forloop.index }}"` and the same expression in `aria-controls`, `aria-labelledby`, `for`, `href="#.."`.
- Do not use `{% assign %}` or `{% capture %}` to build values: the Paradox pull and push sync does not preserve them.
- Keep translations where the project keeps its strings (sidecar or locale source). Do not invent a second place.

## Never touch

- `{{data:..}}`, `{{component:..}}`, `{{snippet:..}}`, `{{attribute:..}}` tags, and `data-pdk-*` attributes. Add attributes
  around them, never inside them, and never reformat them.
- `dist/`, `paradox-export.json`, any exported or built JSON.
- Generated `+.css` aggregator files in `src/styles/` subfolders.
- Platform widgets: anything with `data-react-component`, vendor scripts and iframes. They are listed as not actionable.
- `{% render "folder/name" %}` targets are partials: edit the partial, not the call, unless the task names the call.

## Tailwind

- Use classes the project already uses; look at neighbouring elements first.
- This project may override `--spacing`: `p-4` can mean 4rem. Use arbitrary px or rem values (`min-h-[24px]`) when a size
  must be exact.
- Do not add utility colour classes, opacity classes or gradients. Colour is design-locked (`design-locked.md`).
- `sr-only` and `focus:not-sr-only` are the accepted way to hide text visually.

## Before and after

```liquid
{%- comment -%} wrong: id repeats in a loop, label text hard-coded {%- endcomment -%}
{% for item in items %}
  <button aria-controls="panel" aria-label="Open">{{data:item.title}}</button>
{% endfor %}
```

```liquid
{% for item in items %}
  <button aria-controls="panel-{{ forloop.index }}" aria-expanded="false">{{data:item.title}}</button>
  <div id="panel-{{ forloop.index }}" hidden>...</div>
{% endfor %}
```

## Do not

- Do not edit the generated or exported files above, even to "fix" a finding that points at them.
- Do not hard-code an id inside a loop.
- Do not move a backend tag into an attribute or out of its element.
- Do not add new global CSS when a utility does the job.
