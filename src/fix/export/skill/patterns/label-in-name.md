# label-in-name (WCAG 2.5.3): the name starts with the visible text

Intent: speech input users say what they see. The accessible name must contain the visible text, in order, at the start.

Before:

```liquid
<a href="/jobs" aria-label="Browse all vacancies">Search jobs</a>
```

After, option A (let the text be the name):

```liquid
<a href="/jobs">Search jobs</a>
```

After, option B (extend, starting with the visible text):

```liquid
<a href="/jobs" aria-label="Search jobs: browse all vacancies">Search jobs</a>
```

Cautions:
- Same words, same order, same language as the visible text.
- Context after the visible text is fine; context before it is not.
- Names that come from data change in the sidecar or by building them from the same variable as the visible text.
- Translated sites: use the project's string source for the visible text; never mix languages.

Verify: rescan; `label-content-name-mismatch` gone. The accessible name begins with the visible string.

Do not:
- Do not change the visible text to match the label.
- Do not use an `aria-label` that contradicts the visible text.
- Do not drop the label on an icon-only control (nothing visible to compare).
