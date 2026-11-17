# skip-link: first focusable, visible on focus, lands in main

Intent: keyboard users bypass repeated navigation (WCAG 2.4.1).

Before:

```liquid
<body>
  {% render "layout/header" %}
  <main>...</main>
```

After (shared layout, edit once):

```liquid
<body>
  <a href="#main-content" class="sr-only focus:not-sr-only focus:fixed focus:left-[1rem] focus:top-[1rem] focus:z-50 focus:bg-white focus:px-[1rem] focus:py-[0.5rem] focus:underline">Skip to main content</a>
  {% render "layout/header" %}
  <main id="main-content" tabindex="-1">...</main>
```

Cautions:
- The link comes first in DOM order, before header and nav.
- The `href` fragment equals the `id` on `<main>`; both unique on the page.
- It must be visible with a focus indicator when focused. The colours above are a minimal neutral default: if the project
  already has a skip link style or tokens, reuse those and do not invent a palette; a colour question goes to the design owner.
- Use arbitrary px/rem values for exact sizes.

Verify: press Tab once: the link appears; Enter moves focus into main. Rescan: both skip-link rules gone.

Do not:
- Do not hide it with `display: none` or `visibility: hidden`.
- Do not add a second `id="main-content"` or a second main.
- Do not point the link at an element rendered conditionally.
