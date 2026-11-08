# Recall audit (round 2 rescans against manual review)

Two production-like Paradox Site Studio sites were reviewed by hand: `site-001` (12 true positives) and `site-002` (classes M1-M6). Their round-2 rescans were checked finding by finding, and also re-run through the current report builder (merge rules included) to see what the next scan reports.

Status values: **present-confirmed** (reported, `confirmed`), **present-needs-review** (reported, `needs-review`), **missing** (not reported at all). "Fixed here" marks a change made with this audit.

## site-001

| Ground-truth true positive | Status | Where / why |
|---|---|---|
| Skip link `#main-content` has no target (axe + Lighthouse + keyboard + axe `region`) | present-confirmed on real pages; present-needs-review on `/404` and `/500` | One merged finding. Fixed here: the merged source is the page's `<main>` (the root-cause row), not the layout line the derived `region` row points at; on `/404` and `/500` skip-link rows are now needs-review (error-page policy) |
| `/404` and `/500` skip link source with `line: null` | fixed here | The page-level anchor falls back to the page's first element, then its layout include line, so a source line is always present |
| `NavigationMisuse` on `#desktop-navigation` (links outside a list) | present-needs-review | Best-practice convention, not a WCAG failure; layout-level, one row per page with the shared source `header.liquid:12` |
| `LinkCurrentPage` footer links without `aria-current` | present-needs-review | Convention (WCAG 2.4.8 is AAA); `footer.liquid:14` |
| `LinkOpensNewWindow` video link (aria-label hides the new-window notice) | present-needs-review | 3.2.5 is advisory; `video.liquid:7` |
| `LinkAnchorAmbiguous` for CTA `href="#"` | present-needs-review | Reported at the markup line (`events.liquid:17`); the `#` value comes from the JSON data file, which is named in the evidence only |
| `VisibilityMisuse` on inactive timeline tabpanels | present-needs-review (3 panels) | `journey.liquid:42`; opacity-hidden panels need a human look at the intended behaviour |
| `TabpanelLabelledBy` on the same panels | present-confirmed | One finding per panel, same source line |
| `aria-label` on `div.marquee` (axe + html-validate) | present-needs-review | One merged finding, `intro.liquid:23` |
| Contrast: `/benefits` h1 and intro, `/careers` h1, `/service-technicians` h1 | present-confirmed | Pixel-sampled, source in the partials |
| Contrast: `nav-link.current` 2.92:1 on the scrolled header | present-needs-review | Not fixed, by design: axe cannot decide (background overlapped by another element) and the pixel sampler does not cover the scrolled fixed header, so confirming 2.92:1 needs a scroll-state sampler. Source stays the markup line (`header.liquid`), not `header.css` |
| `html-validate` `no-deprecated-attr` (`frameborder`) | present-confirmed | `benefits/video.liquid:4`, `careers/testimonials.liquid:7` |
| Dead link to the terms page (remote 404) | present-confirmed | `footer.liquid:52` |

## site-002

| Ground-truth true positive | Status | Where / why |
|---|---|---|
| M1 hard-coded ids in loops, aria refs resolve to the first item | present-confirmed | `duplicate-id-referenced`, one finding per loop with the occurrence count (8, 4, 4, 3), source at the loop line |
| M2 carousel slide labels identical in a loop | present-needs-review | `repeated-accessible-name-in-loop` at `military.liquid:76`, `our-culture.liquid:98`; `carousel-slides-missing-labels` is no longer reported there. Needs a human: the label may be data-driven |
| M3 duplicate class from an unset slug | present-needs-review | `no-dup-class`, `career-area-page.liquid:25` |
| M4 `li[role=group]` in `ul[role=list]` | present-confirmed (one finding per list, counted) | `aria-allowed-role`; the `aria-required-children` rows on the same list merge into it |
| M5 `landmark-unique` | present-confirmed | five pages, one finding each |
| M5 dangling `aria-labelledby` (`job-details.liquid:76`) | present-confirmed | Fixed here: axe `aria-valid-attr-value` and accessScan `AriaLabelledByHasReference` on one element are now one finding |
| M5 heading skip h1 to h3 | present-confirmed | axe + Lighthouse are one finding |
| M5 `/benefits` has no h1 | present-needs-review | The h1 comes from unbound platform data, so it cannot be confirmed locally |
| M5 `aria-label` on a generic div | present-needs-review | `aria-prohibited-attr`. Fixed here: the line was a commented-out copy of the markup (`job-details.liquid:92`); the source search now skips comments and lands on the live element (the manual review's line) |
| M5 `<style>` inside `<section>` | present-confirmed | `card-carousel.liquid:24` |
| M5 dot targets under 24px | present-confirmed (axe), present-needs-review (Lighthouse part) | Source is the markup line (`internship.liquid:138`): no stylesheet rule declares the dot size (it comes from the gap), so the CSS re-pointing correctly declines |
| M6 footer links to routes the project does not define | present-needs-review | Grouped per target (count 19 pages); the route may be platform-hosted |
| M6 vendor-owned bugs | present-needs-review / third-party | Listed once in `notYourCode` |

## Error pages

The round-2 rescans predate the error-page policy for `region`/skip-link rows; the policy is covered by unit tests and the merged-report seed (`/404`, `/500` skip-link and `region` rows are needs-review with a source line). A rescan with `scan.errorPages` set and a source tree is needed to see it end to end.

## Not missing, but out of this audit's scope

- Third-party markup (injected scripts, consent banner) can still appear as `confirmed` with owner `third-party`. It is excluded from the gate and from the site-owned confirmed tier; whether it should also be capped to needs-review is a policy question for the origin model.
- Unbound platform data (`data-pdk-out` headings) still yields `empty-heading` confirmed on some site-002 pages in the round-2 scan.

## Result

No true positive is absent from the reports. Under-ranked or duplicated cases found and fixed: skip-link source, error-page skip links, dangling `aria-labelledby` duplicates, and `line: null` on page-level anchors.
