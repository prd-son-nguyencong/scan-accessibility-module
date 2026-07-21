# Changelog

All notable changes to `ada-scan`. Versions are released as Git tags
(`git+https://…#vX.Y.Z`). Follows SemVer.

**accessScan `ruleId`s are a public contract** — a ruleId rename/removal is a
breaking change and must be documented here so `scan:baseline` / ROI diffs stay
comparable across upgrades.

## [Unreleased]

## [1.1.0] - 2026-07-21

### Added
- Publish `ScanReportV2` as `scan-reports/latest.json` with stable SHA-256 finding
  and report identities, scanner-run evidence, source tracing confidence and
  preimage hashes, and local build attestation.
- Export the V2 report contract from `ada-scan/report`.
- Add the trusted in-module CIS fix controller, canonical fix units, source-trace
  inbox, allowlisted context broker, bounded advisory loop, immutable candidates,
  shadow verification, exact-diff approval, transactional Apply, and byte-exact
  rollback.
- Add a token- and Origin-protected loopback review workbench with durable sessions.
  `ada-scan fix --report <file> --source <root> --session <id> --ui` resumes a
  report-bound session without writing source before Apply.
- Add strict deployed/local hybrid attestation using build revision,
  instrumentation digest, deployment URL, and source preimages. Unattested or
  mismatched runs fail closed to scan-only.
- Add executable safety, quality, and operational PoC gates backed by real source
  tracing, production scanner closure, shadow builds, persisted telemetry/audit,
  timeout cleanup, and HTTP workflow tests.
- Add accessScan commercial-parity corpus tooling (`corpus:capture` / `seed` /
  `verify` / `drift`) with fixture cases and `scripts/scrape-accessscan-dom.mjs`
  for live oracle scrapes.
- Add `--no-hydrate-jobs` to block jobs/chat bundles and strip mounts when
  comparing local shells to staging without third-party hydrate.
- Commercial parity now emits nested jobs-chrome `RegionMainContentMisuse` via
  additive `parity:region-main-misuse` (reuses landmark-graph `region-main-misuse`).
- Nu HTML Checker classifies the three distinct `main` landmark errors as
  `w3c-main-in-section`, `w3c-main-nested`, and `w3c-multiple-main` so
  scan-visual Serious counts match the Nu error total.

### Changed
- Legacy HTML, ROI, console, and fixer consumers now use a pure V1 compatibility
  projection while V2 remains the immutable source of truth.
- Instrumented local builds emit revision and instrumentation-digest markers in
  generated HTML for future hybrid attestation.
- Canonical report IDs now map `StickyHeaderObscuresFocus` to
  `FocusNotObscuredHeader` and `TablistRole` to `TabListMisMatch` while retaining
  the native rule IDs.
- `VisibleTextPartOfAccessibleName` now evaluates interactive controls using
  visible labels plus `aria-label`/`aria-labelledby`, and permits accessible
  names that add context while retaining the visible text.
- `StrongMismatch` remains an advisory best-practice finding.
  `SearchFormMismatch` also remains advisory in standards mode; commercial
  parity mode presents the commercial WCAG 2.0 A severity while retaining
  non-deterministic heuristic evidence.
- `StrongMismatch` excludes bold spans already contained by heading semantics,
  matching the commercial result-counter findings without reporting job badges.
- Remote URL scans now include third-party content by default for commercial
  parity; `--exclude-third-party` opts out, while local scans remain excluded
  unless `--include-third-party` is supplied.
- The Paradox jobs widget reproduces the commercial 1 `TablistRole`, 8
  `TabMismatch`, and 2 `TabPanelMismatch` findings. These findings carry
  `commercial-parity-heuristic` evidence and remain non-deterministic because
  the matched controls, pagination, and page-size label are not true tab UI.
  When the two panel nodes are absent from the current one-page result state,
  their reference findings record `domObserved: false` instead of claiming live
  DOM evidence.
- Commercial compatibility also reproduces the Paradox header
  `BreadcrumbsMismatch` finding and one `VisibleTextPartOfAccessibleName`
  finding per rendered jobs-filter checkbox. Both remain non-deterministic and
  expose evidence when the underlying semantic check actually passes.
- Forms and Landmarks parity now derives navigation, current-link, and search
  targets from rendered DOM structure. Hidden responsive copies are excluded,
  equivalent navigations are deduplicated by accessible name and destinations,
  and the smallest cohesive search controls-and-action group becomes the
  snapshot. The compatibility path uses no site hostname, brand string,
  generated selector, or fixed finding count.
- The commercial `RequiredFormFieldAriaRequired` observation on a current
  navigation anchor is retained as `commercial-parity-heuristic`, explicitly
  identified as a non-form-field anomaly, and cannot be auto-fixed.
- Main-landmark reports now retain the valid outer `<main>` as a successful
  snapshot for `RegionMainContentMisuse`, and attach the duplicate/nested
  `<main>` snapshot directly to `RegionMainContentSingle`.
- Standards-mode sticky-header focus findings now require a focused control to
  be fully covered in browser hit-testing; insufficient `scroll-padding-top`
  alone no longer fails. Commercial parity dynamically recognizes every
  rendered semantic header/banner with computed `fixed` or `sticky` top
  anchoring, reports the header under Interactive Content, and records whether
  hit-testing confirmed obscuration. The recognition path uses no site
  hostname, brand, selector, class, ID, or fixed count.
- `ButtonMismatch` findings now retain rendered native `<button>` controls as
  successful snapshots while excluding hidden responsive copies, and the HTML
  requirement matches the complete commercial wording.
- Credential-gate parity now derives `RegionMainContentMismatch`,
  `RegionMainContentMisuse`, `VisibilityMisuse`, and `PageTitleDescriptive`
  observations from rendered password-form, landmark-shell, hidden-content,
  and title-heading signals. These findings remain non-deterministic
  commercial heuristics, never synthesize absent iframe successes, and redact
  hidden credential values from snapshots. The recognition path uses no
  hostname, route, form action, brand, class, ID, selector, or fixed count.
- URL-only V2 reports preserve unresolved source files as `null` instead of the
  literal string `"null"`.
- CIS is advisory-only in the trusted path. Accept records a decision; source
  mutation requires separately verified candidate/diff hashes and explicit Apply.
- `scan-visual.html` Serious / Total / layer pills sum occurrence counts (including
  `count > 1`), matching Nu Html Checker and accessScan oracle totals.
- Nu dedupe keeps distinct validator messages on the same extract/line so multiple
  `main` errors are not collapsed into a single card.

### Deprecated
- `AriaLabelledbyContentMismatch` is no longer emitted. Its valid Label in Name
  cases are covered by `VisibleTextPartOfAccessibleName`; old reports remain
  readable through the compatibility projection.
- Legacy `src/fixer/` direct-write, wildcard-CORS, git-stash rollback, and CIS
  transport paths are deprecated for CIS fixes. Existing non-CIS/IDE modes remain
  temporarily available during migration.

## [1.0.1] - 2026-07-14

### Changed
- Align `@axe-core/playwright` to **4.12.1** (axe-core 4.12.1) to match axe DevTools
  engine parity for comparable rule results across manual and automated scans.

## [1.0.0] - 2026-07-06

### Added
- Initial extraction from `local-career-site` into a standalone,
  Git-installable package (Approach A: config-driven host resolver).
- `ada-scan init` — scaffolds `.scan-config.json`, registers the Vite plugin,
  adds host scripts, installs Playwright Chromium.
- Config-driven host integration: `devCommand`, `buildCommand`, `buildEnv`,
  `outDir`, `source`, `distMap`, `thirdParty`, `suppress`.
- Graceful degradation for optional deps (lighthouse/chrome-launcher, AI SDKs).
