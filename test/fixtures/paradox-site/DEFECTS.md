# Paradox fixture site: seeded defects

Static HTML mimicking a Paradox Site Studio export (`pages/`, served by `test/helpers/paradox-site-server.js`).
The `local` variant keeps `<!-- snippets/x.html -->` marker comments; `studio` strips them.
Routes: `/` (index), `/benefits`, `/jobs` (fake `data-react-component` widget), unknown routes serve `404.html` with status 404.
The golden (`test/golden/expected.json`, `npm run golden`) scans `/`, `/benefits`, `/jobs` with axe + accessScan.

## Seeded defects (all on `/`, page index.html)

| Defect | Selector | Expected rule | WCAG |
| --- | --- | --- | --- |
| Empty `<title>` | `title` | axe `document-title`; accessScan `PageTitleValid` | 2.4.2 |
| Viewport `user-scalable=no` | `meta[name="viewport"]` | axe `meta-viewport`; accessScan `PageMetaViewportValid` | 1.4.4 |
| Duplicate banner (`<header>` plus `<div role="banner">`) | `header`, `.promo-banner` | axe `landmark-no-duplicate-banner`, `landmark-unique` | best practice |
| Icon-only button without name | `.defect-icon-button` | axe `button-name`; accessScan `ButtonDiscernible` | 4.1.2 |
| Image without alt | `.defect-img` | axe `image-alt`; accessScan `ImageDiscernible` | 1.1.1 |
| Low-contrast text (#aaa on white) | `.defect-low-contrast` | axe `color-contrast` | 1.4.3 |
| Two adjacent 14px targets | `.defect-small-target` | axe `target-size` | 2.5.8 |

## Clean twins

| Twin | Where | Must stay silent |
| --- | --- | --- |
| Non-empty title, normal viewport, single banner | `/benefits`, `/jobs` | document-title, meta-viewport, landmark-no-duplicate-banner |
| Named icon button | `.clean-icon-button` (`/benefits`, and `the clean section` on `/`) | button-name |
| Image with alt | `.clean-img` | image-alt |
| #333 text on white | `.clean-contrast` | color-contrast |
| Two 44px targets | `.clean-target` | target-size |
| Widget links with padding | `/jobs` `.jobs-widget` | target-size |

## Known baseline noise (recorded in the golden, not seeded)

The golden scans with the default `standards` profile. accessScan reports heuristic findings on the shared
header and footer (for example `NavigationMisuse`, `LinkCurrentPage`, `MetaDescription`) on most pages, kept in the golden
so a change in them is visible. Review them when the golden diff touches those keys.
