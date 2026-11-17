# language: page language and title

Intent: assistive tech picks the right voice from `<html lang>`, and every page has a descriptive `<title>`.

Before:

```liquid
<html>
<head><title></title>
```

After (shared layout, once):

```liquid
<html lang="en">
<head><title>{% block title %}Open jobs | Company{% endblock %}</title>
```

Cautions:
- Use the site language code; a translated site needs the code per locale from the project's locale source.
- Do not hard-code the title string in the layout for all pages; per-page titles come from the page template or its sidecar.
- A title bound to `{{attribute:..}}` or `{{data:..}}` is data: leave it, and ask when it is empty.
- Parts in another language get `lang` on the element, only where the text is truly another language.

Verify: rescan; `html-has-lang` and `document-title` gone on the listed pages.

Do not:
- Do not invent a title that is not true to the page.
- Do not guess the language code.
- Do not remove or edit backend tags in the head.
