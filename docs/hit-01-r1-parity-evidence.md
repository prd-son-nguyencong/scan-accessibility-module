# HIT-01 R1 Scanner Parity Evidence

**Recorded:** 15 July 2026  
**Target:** `https://hitachi728.preview.sites.stg.paradox.ai/`  
**State:** Initial page state  
**Machine-readable evidence:** `test/fixtures/hit-01-r1-parity.json`

## Decision

The eight resume conditions in `fix-ada-cis-design-plan.md` are satisfied, so
ScanReportV2 contract work may begin.

This closes the historical R1 design gate only. It does not convert R1 into official R2
benchmark evidence. Release-level parity still requires a paired manual and automated R2
run, raw tool exports, fixed page state, and matching timestamps and viewports.

## Captures

The automated evidence is intentionally split because the PSI request was quota-blocked:

- `2026-07-15T07:46:57.418Z`: axe, accessScan, and Nu Checker with third-party content
  included.
- `2026-07-15T07:57:53.433Z`: PSI requested; HTTP 429 caused a sanitized local
  Lighthouse fallback.

Every scanner run records its engine and version, page state, status, viewport where
applicable, and raw scanner totals. The visual report exposes the same data under
**Scan evidence**.

## Axe parity

The desktop/mobile matrix returned seven aggregate rule groups and seven affected nodes:

- Critical: `button-name`, `select-name`
- Moderate: `heading-order`, `landmark-main-is-top-level`,
  `landmark-no-duplicate-main`, `landmark-unique`, `meta-viewport`

This matches the R1 total and severity split of two Critical and five Moderate groups.
Desktop produced six groups; mobile produced seven. Three incomplete checks per viewport
remain explicit in scanner-run evidence.

## accessScan classification

Six R1 rule statements were reproduced or mapped to an equivalent native rule:

- `StrongMismatch`
- `StickyHeaderObscuresFocus`
- `VisibleTextPartOfAccessibleName`
- `RegionMainContentMisuse`
- `RegionMainContentSingle`
- `MetaViewportScalable`

Four statements could not be reproduced from the initial DOM and R1 contains no element
locator:

- `TablistRole`
- `TabMismatch`
- `TabPanelMismatch`
- `BreadcrumbsMismatch`

These are classified as state-dependent, not silently dropped. Browser fixtures prove
that roleless tab groups are detected while generic accordions and listboxes are
excluded. The known Paradox jobs-widget signature is included separately as
non-deterministic commercial-parity heuristics for the commercial 1
`TablistRole`, 8 `TabMismatch`, and 2 `TabPanelMismatch` findings. Reference
panel findings retained when those nodes are absent are marked
`domObserved: false`.

The compatibility layer now also reproduces the known Paradox desktop-submenu
`BreadcrumbsMismatch`, sticky-header `StickyHeaderObscuresFocus`, and one
`VisibleTextPartOfAccessibleName` finding per rendered jobs-filter checkbox.
Evidence preserves the actual semantic assessment and hit-test/Label-in-Name
result so parity findings are not mistaken for deterministic WCAG failures.

The historical complete automated accessScan run found 19 rule groups and 72 occurrences. Those
totals are broader than the ten R1 statements and are retained as scanner evidence rather
than presented as a one-to-one manual count.

## Nu Checker parity

The live Nu response matched the R1 raw totals exactly:

- 21 errors
- 14 warnings
- 35 raw messages

After supplemental deduplication, the report retained 30 actionable fix units. Native
families now distinguish nested interactive markup, duplicate IDs, main-landmark
structure, module/defer misuse, heading order, viewport zoom, sections without headings,
and unnecessary script types.

Raw API messages, supplemental candidates, added findings, suppressed duplicates, and
emitted fix-unit counts are recorded separately.

## Lighthouse and PSI

Lighthouse accessibility failures are now normalized into actionable node findings with
viewport evidence. The fallback run emitted:

- `button-name`
- `heading-order`
- `meta-viewport`
- `select-name`

Each viewport retained 76 accessibility audit references, failed group and node totals,
passes, ten manual checks, not-applicable totals, and incomplete totals.

The PSI API returned HTTP 429. The persisted provenance is:

- requested source: `psi-api`
- actual source: `local-fallback`
- comparable to PSI: `false`
- fallback code: `quota-exceeded`

The local scores are retained as local lab evidence only and are not compared with the R1
PSI Mobile scores.

## Resume-gate verification

All eight conditions are asserted by `test/parity-evidence.test.js`:

1. Scanner engine, version, viewport, state, status, and raw totals are retained.
2. Axe and Lighthouse accessibility failures become actionable findings.
3. Roleless tab semantics are detected with false-positive controls.
4. Nu raw and supplemental totals are separately counted and deduplicated.
5. Key Nu findings use stable native rule families.
6. PSI fallback provenance is explicit, sanitized, and non-comparable.
7. Manual and state-dependent evidence remains explicit.
8. Every R1 statement has an allowed classification.

The fixture is regression-tested so later scanner changes cannot silently reopen this
gate.
