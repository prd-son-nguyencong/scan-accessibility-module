# link-name: every link has a name that says where it goes

Intent: a link announces its destination or purpose from its text, or from an `aria-label` when it has only an icon.

Before:

```liquid
<a href="https://www.linkedin.com/company/example"><i class="fa-brands fa-linkedin"></i></a>
```

After:

```liquid
<a href="https://www.linkedin.com/company/example" aria-label="LinkedIn"><i class="fa-brands fa-linkedin" role="presentation"></i></a>
```

Cautions:
- If an image is the only content, give the image a meaningful `alt` instead (`patterns/image-alt.md`).
- Link text states the destination; no "click here", no raw URL.
- Adjacent links to different places need different names.
- Links to the same place in a loop need item-specific text from the sidecar or loop variable.

Verify: rescan; `link-name` gone. Tab to the link and read its name in dev tools.

Do not:
- Do not leave an icon without `role="presentation"` or `aria-hidden="true"`.
- Do not use `title` as the only name.
- Do not use an `aria-label` that differs from visible link text (`patterns/label-in-name.md`).
