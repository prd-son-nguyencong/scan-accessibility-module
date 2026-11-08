# headings: one h1, no skipped levels, size by classes

Intent: the heading outline reflects the content structure. Appearance is a CSS concern.

Before (page has no h1, hero title is an h2):

```liquid
<h2 class="text-4xl font-bold">{{data:hero.title}}</h2>
```

After (tag only, classes unchanged):

```liquid
<h1 class="text-4xl font-bold">{{data:hero.title}}</h1>
```

Skipped level: an `h4` after an `h2` becomes `h3` with the same classes. A heading used only for looks becomes a `<p>` with the same classes.

Cautions:
- Change the tag, not the classes; check the next heading still nests correctly.
- Exactly one `h1` per page; with several heroes, only the first is the h1. Edit the page template for that page.
- A shared partial used on pages at different levels: a fixed level may be right on one page and wrong on another; ask.
- Keep backend tags inside the heading untouched.

Verify: rescan; the rule is gone. List headings in order: levels rise by at most one.

Do not:
- Do not pick a level for its size.
- Do not add a second visible title to create an h1.
- Do not remove a heading to silence an order finding.
