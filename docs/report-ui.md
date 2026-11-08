# Report UI (scan-visual.html)

The visual report is one self-contained, offline HTML file. It answers three questions in this order: did the scan pass the gate and why, what should be fixed first, and what in the list is not the site team's to fix.

## Code map

`buildHtml` in `src/reporter/html.js` delegates to `src/reporter/ui/`:

- `model.js` builds the view model from a ScanReportV2 (`report.v2`), or from the legacy projection when no V2 report is passed.
- `render.js` writes the static sections and one compact JSON record per finding.
- `client.js` is the explorer (search, filters, grouping, detail, shortcuts). It ships as one inline script covered by the CSP hash; the JSON block is never executed.
- `report.css` holds the tokens and layout.

Writer function signatures are unchanged. `src/index.js` passes `{ ...enriched, v2: report }` because the legacy projection drops `sharedSource`, `sourceCandidates`, `origin` and `link`.

## Information architecture

Overview, Findings, Coverage, Pages, Links, Performance, Run details, plus a "Not your code" section grouped once per vendor.

Buckets used by the overview bar and the explorer:

- Fix in your code: verdict confirmed or likely, owner site code or injected at runtime. Only confirmed findings fail the gate.
- Needs review: verdict needs-review, or an owner that is not established (`unbound-data`, `unknown-probe-failed`).
- Not your code: third-party, platform or iframe owners. Excluded from the gate.

A root cause is a shared source line, the same rule at the same file:line, or the same vendor and rule.

## Explorer

Toolbar: search, bucket control, filters (verdict, owner, impact, layer, rule, page, has source), sort, group by (root cause, rule, page, source file, none). Active filters are removable chips. The view is stored in the URL hash, for example `#findings?b=fix&i=serious&g=file&f=<id>`. Counts update live and a live region announces result counts.

Rows render 100 at a time; detail is built on first expand. Detail shows the proof, the source (file:line, match quality, how it was found, data file, template line, candidates, source lines) or an explicit "Not traced: locate manually", the owner and reason, engines agreeing, the selector and element HTML, and a lazily loaded screenshot.

Keyboard: `/` focus search, `j` / `k` move, `Enter` or `Space` toggle, `?` shortcuts. Copy buttons: path:line, selector, element HTML, link, and "Copy as AI prompt" (built client-side).

## Size

The old report rendered each finding once per tool section and once per observation as a full card, plus Lighthouse gauges. The new report embeds one record per finding and interns repeated strings. Screenshots stay as separate files next to the HTML (`evidence/`). A 586-finding report is about 490 KB.

## Typography and wrapping

System font stacks only; no external requests. Prose never breaks mid-word. Code, paths and selectors get `<wbr>` after `/ . - _ : ? & = # > + ~ , [ ] ( ) * "` and at camelCase boundaries. Wide `pre` blocks scroll inside their own container. Tables stack below 960 px and there is no horizontal page scroll at 320 px.

## Design system

The report copies the Notion design system (tokens, typography, radii, spacing and component styles) and leaves out its marketing content. Light is the default theme when the system preference is unknown; dark is derived from the navy family in the same system. A toggle in the navy band switches themes, the choice is stored in `localStorage` (guarded) and applied before first paint. Print uses a light, mono sheet. `forced-colors` and `prefers-reduced-motion` are supported. The shared look lives in `src/reporter/ui/theme.css` and `theme.js`; scan-visual, qa-report and the two ROI pages use it.

| Token | Light | Dark | Use |
|---|---|---|---|
| `--bg` | `#ffffff` | `#070f24` | page canvas |
| `--card` | `#ffffff` | `#0a1530` | cards, row lists |
| `--surface` / `--surface-2` | `#f6f5f4` / `#fafaf9` | `#1a2a52` / `#101c3d` | group headers, code, inputs, row hover |
| `--hair` / `--hair-soft` | `#e5e3df` / `#ede9e4` | `#2a3d70` / `#1f2f5c` | card borders, row separators |
| `--control` / `--btn-border` | `#8a8680` / `#c8c4be` | `#7d8bb0` / `#4a5d94` | input borders (3:1) and secondary button borders |
| `--ink` / `--text` / `--muted` | `#1a1a1a` / `#37352f` / `#5d5b54` | `#ffffff` / `#e6e8ef` / `#a4a097` | text levels |
| `--link` | `#005bab` | `#7eb6f5` | link text (`#0075de` is only about 4.2:1 on surfaces) |
| `--primary` / `--primary-hover` | `#5645d4` / `#4534b3` | `#4534b3` / `#5645d4` | primary button, confirmed badge |
| `--focus` | `#5645d4` | `#9a8ff0` | focus ring, 2 px |
| `--band`, `--band-deep`, `--band-mid` | `#0a1530`, `#070f24`, `#1a2a52` | same | header band |
| `--pill-bg` / `--pill-ink` | `#000000` / `#ffffff` | `#ffffff` / `#070f24` | active pill tab |
| Tints: peach, yellow, sky, mint, lavender, rose, gray | `#ffe8d4`, `#fef7d6`, `#dcecfa`, `#d9f3e1`, `#e6e0f5`, `#fde0ec`, `#f0eeec` | translucent hues over the card | KPI cards, chips, alerts |
| Tint inks | `#793400`, `#523410`, `#0b3f73`, `#0f5c25`, `#391c57`, `#7a1f4d`, `#5d5b54` | `#ffcfa0`, `#f7e08c`, `#b5d9fb`, `#9be8b1`, `#d2c8f7`, `#ffb3d3`, `#c9ccd8` | text on each tint |
| `--err` / `--err-ink` | `#e03131` / `#b42318` | `#ff6b61` / `#ff8a80` | borders and fills / text |
| `--ok` / `--ok-ink` | `#1aae39` / `#12722a` | `#3fcf5f` / `#7fe39a` | passing state |
| `--warn` / `--warn-ink` | `#dd5b00` / `#793400` | `#ff9a4d` / `#ffb27a` | warning, serious impact |

Contrast: every text pair reaches 4.5:1 and control borders and focus rings reach 3:1 in both themes (computed from the token pairs in `test/report-ui.test.js`). Colours adjusted from the source system for contrast: input borders (`#c8c4be` is 1.7:1), link text, small secondary text (slate instead of steel) and semantic text colours (ink variants).

Shape and type: radii chip 4, tag 6, button 8, card 12, badge and pill full. Spacing uses a 4 px base; sections are 64 px apart (48 px below 768 px). Fonts: `"Notion Sans", Inter, -apple-system, system-ui, ...` (nothing is loaded; families fall back to system fonts); mono only for code, paths and selectors. Verdict headline 36/600 with -0.5 px tracking (28 px on small screens).

Encoding without colour alone: impact is a word plus a four-step meter (critical 4 bars, serious 3, moderate 2, minor 1, info 0). Verdict chips: confirmed is a purple badge, likely a lavender tag, needs-review a peach tag with a dashed edge. Owner chips are grey, third-party chips sky.

Icons are inline SVG with one 1.5 stroke (chevron, check, alert, info, external link, copy, sun, moon). No emoji. No em or en dashes appear in rendered output (a test asserts it).

## Audit

`npm run report:audit [report.html]` opens a report in Chromium at 320, 390, 768 and 1440 px, light and dark, and asserts: no document or element overflow, no word split mid-word, every interactive element has an accessible name, text contrast of at least 4.5:1, logical focus order with visible focus, working shortcuts, no console errors, and no axe-core WCAG 2.2 AA or best-practice violations at 390 and 1440. It skips with exit 0 when Chromium is missing. With no argument it builds a small neutral fixture report. `test/report-ui.test.js` covers the structural assertions without a browser.
