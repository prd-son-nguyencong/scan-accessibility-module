# landmarks-navs: named navs and exactly one main

Intent: landmarks let screen reader users jump around. Repeated landmarks need different names, content sits inside landmarks.

Before:

```liquid
<nav class="header-nav">...</nav>
<nav class="footer-nav">...</nav>
```

After:

```liquid
<nav class="header-nav" aria-label="Main">...</nav>
<nav class="footer-nav" aria-label="Footer">...</nav>
```

Page structure (shared layout, edit once):

```liquid
<body>
  {% render "layout/header" %}
  <main id="main-content" tabindex="-1">{% block content %}{% endblock %}</main>
  {% render "layout/footer" %}
</body>
```

Cautions:
- Names are unique per page and do not include the word "navigation".
- Label the navs in the shared header and footer partial once.
- Exactly one `<main>`. If the header partial already contains `<header>`, do not wrap it again.
- Prefer native elements over `role="navigation"` on a div.
- Content injected by vendor or platform widgets outside your markup cannot be fixed here.

Verify: rescan; the landmark rules are gone on the listed pages. Outline: one main, each nav distinct.

Do not:
- Do not add a landmark role to a div when a native element exists.
- Do not wrap everything in a second main.
- Do not move the header or footer in the DOM.
