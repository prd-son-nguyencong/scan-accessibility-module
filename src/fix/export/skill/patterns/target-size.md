# target-size: 24 x 24 CSS px, or spaced (WCAG 2.5.8)

Intent: small controls are large enough to hit, or have a 24px circle around them clear of other targets.

Before:

```liquid
<a href="{{data:social.url}}" class="icon-link" aria-label="LinkedIn"><i class="fa-brands fa-linkedin"></i></a>
```

After (grow the hit area, not the icon):

```liquid
<a href="{{data:social.url}}" class="icon-link inline-flex min-h-[24px] min-w-[24px] items-center justify-center" aria-label="LinkedIn"><i class="fa-brands fa-linkedin"></i></a>
```

Cautions:
- Use arbitrary px values: numeric utilities such as `p-6` follow the project `--spacing` and can be far larger.
- Check neighbours: a bigger hit area must not overlap or push siblings. If the layout moves, stop and ask.
- Inline text links inside a sentence are exempt; do not pad them.
- Same control in several viewports: verify at each scanned viewport.
- If spacing is the cheaper fix, that is a design change: ask.

Verify: rescan at the scanned viewports; `target-size` gone. Compare the page before and after: no shifted neighbours.

Do not:
- Do not scale the icon or font to reach the size.
- Do not use negative margins to hide the growth.
- Do not set `width`/`height` on the visual so it changes the look.
