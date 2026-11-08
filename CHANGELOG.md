# Changelog

All notable changes to `ada-scan`. Versions are released as Git tags
(`git+https://…#vX.Y.Z`). Follows SemVer.

**accessScan `ruleId`s are a public contract** — a ruleId rename/removal is a
breaking change and must be documented here so baseline comparisons stay
comparable across upgrades.

## [Unreleased]

## [1.2.1] - 2026-11-08

### Added

- `docs/setup-with-local-career-site.md`: install, scan all pages, fix with the CIS chat, in simple English. `templates/list-pages.mjs` fills `pages` in `.scan-config.json` from `src/pages`.

## [1.2.0] - 2026-11-08

### Added (confirmed-tier accuracy measurement)

- `npm run eval:truth` serves every labelled fixture (truth-corpus and rule-seeds) from a loopback static server, scans each with the real `scanOnePage` (every offline layer) and the CLI's report builder, and measures the CONFIRMED tier: confirmed recall per success criterion and overall (violation fixtures with a confirmed finding for the labelled criterion) and confirmed false-positive rate (clean twins with any confirmed finding), with Wilson 95% intervals. No network, no LLM. It writes `docs/accuracy-measured.md` (deterministic, no timings) and exits 1 when a `validated` criterion in `docs/accuracy-commitments.json` falls below its `minRecall` or above its `maxFalsePositive`. A criterion is `validated` only with at least 3 violation fixtures, 3 clean twins and 60% confirmed recall; the rest start as `advisory` with the reason, and `maxFindingFalsePositives` gates the clean twins (of any criterion) that carry a confirmed finding for the criterion.
- A timed `<meta http-equiv="refresh">` (or `Refresh` header) with a positive delay no longer moves the scan: `resilientGoto` reads the refresh target from the loaded document and answers that navigation with 204, so a 3 to 10 second refresh used to redirect Chromium mid-scan, drop the MetaRefresh finding and attribute the next page's findings to the requested URL. Truth-corpus pairs for 3, 5 and 10 second refreshes (the 600 second one stays) measure it.
- Label in name (2.5.3) no longer confirms a one-character visible label (an icon glyph such as `x`) or the value text of a slider, spinbutton, progressbar, meter or scrollbar.
- Truth-corpus pairs so every validated criterion has 3 or more violation fixtures and 3 or more clean twins: 1.3.5, 1.4.1, 1.4.3, 1.4.4, 2.1.1, 2.2.2, 3.1.2, 2.4.2 and 2.4.4.
- Truth-corpus pairs for the weak spots: 2.5.3 reordered label, 2.5.7 drag-only sortable list, 3.2.1 focus that moves focus, 2.4.7 removed outline and a mobile-only menu toggle with no focus ring, 2.5.8 viewport-dependent icon spacing and a 20px versus 24px stacked pitch, and a duplicate id whose first copy is hidden. `labels.json` pairs may name an `oracle`.
- `scripts/lib/truth-oracle.js`: plain DOM geometry and computed-style oracles (target-size spacing, label in name, focus indicator contrast at 3:1) that share no code with `src/`; `test/truth-oracle.test.js` asserts the fixture truth agrees with them.
### Changed (fix harness speed and stability)

- Harness: a candidate that touches only templates is captured, scanned and perf-timed on the routes its edit changed (served HTML hash, task routes, report `routeDependencies`); other routes keep their accepted-state cells, rows and perf runs. A style, script, data file or a missing hash means every route. Snapshot cells run in parallel (`snapshotConcurrency`, 3) and so do per-route scans (`scanConcurrency`, 2); a rolled-back edit on the Vite adapter skips the rebuild (not covered by a test that counts builds). Both concurrency keys must be positive integers (`CONFIG_INVALID` otherwise). `harness-report.json` reports `timings` and `counts`.
- Harness: `shareNodeModules` links the packages entry by entry and never a dot entry other than `.bin` and `.pnpm` (`.vite`, `.vite-temp`, `.cache`), and the Vite shadow server uses a `cacheDir` inside the shadow, so the original `node_modules` is never written (Vite's `.vite-temp` config bundle included). A recapture after a sparse G4/G6 failure keeps the first capture's perf runs (it used to fail G7 as `PERF_MISSING`).
- Harness: queued edits are listed in `remaining.md` (the working-tree flow says the edit stays in the tree); "not seen by the rescan" is deduplicated by defect and sorted so identical runs agree; working-tree retargeting puts a multi-hunk task on the hunk that holds its element, else the first, not the last.
- Export: `scriptFiles` (and the script candidates in the task text) lead with `src/scripts/index.js`; the page-wide h1 candidate list is capped at 12 and ordered by dependency distance (page templates before the partials they render).
### Fixed (round 6 known confirmed-tier errors)

- `dead-link-404`, `dead-link-server-error`: a 404, 410 or 5xx is asked again twice with a browser user agent and a short backoff (0.3 s, 0.9 s) and the final status decides, so a bot-defence 502 that answers 200 on the retry is never confirmed: a same-origin link then drops to no finding; an external one stays `needs-review` "dead-link-unreachable" (reason "inconsistent-status", the HEAD and the final GET disagree). A persistent 404 stays confirmed.
- `disclosure-missing-aria-expanded`, `menu-trigger-missing-aria-expanded`: a control whose script sets `aria-expanded` when it is activated (read after the click) is `needs-review` (the state is exposed at runtime) when the value matches the panel, not confirmed. A value that does not match the measured panel state (stuck at "true", or inverted) is a wrong state and stays `confirmed` with that measurement as proof. A control whose attribute never appears stays confirmed. The same measurement now runs at 390 x 844 for controls that only render there (hamburger).
- `focus-not-visible` recall: a tabbable control rendered only below the desktop breakpoint (hamburger, mobile nav toggle) is Tab-focused at 390 x 844 and confirmed when its styles do not change and the pixels are identical focused and blurred. A control already rendered at the desktop width is recognised by its element (or tag, id, name and href), not its markup, so a resize handler, a focus handler or an autoplay class toggle does not make it "mobile-only" (the same identity is used for the mobile disclosure pass).
- Source attribution: `role-button-not-keyboard-operable` on a component that builds its class from a captured variable is attributed to the component through its render flag (`data-pdk-param-*`); `aria-expanded-not-updated` is attributed to the handler that shows the panel; an aria-label written by GSAP `SplitText` (and any value axe shortened with `...`) is attributed to the script that writes it.
- Target size: the finding text (and so the exported Cursor/markdown task) names the failing viewport, its size and circle clearance, and the viewports that pass.
### Release hygiene and developer guide

- `eval/corpus.json` is anonymised: site aliases `s01`..., route or selector stored as `h:<hash>` when it carried a customer term, no HTML or message text. `compare.mjs` matches both spellings; `metrics.mjs` prints aliases only; `recover-corpus.mjs` writes anonymised rows; new `eval/anonymise-corpus.mjs`. The real name map is `eval/site-map.local.json` (gitignored).
- `test/release-hygiene.test.js` fails when a hashed denylist term (`eval/release-denylist.json`, hashes only; add with `scripts/release-denylist.mjs`), a secret pattern, a personal path or a private working file is tracked.
- Real customer wording in a few tests and docs replaced by synthetic text; `eval/blind-scan.sh` needs `HOST_REPO` instead of a hard coded path. See `docs/release-data-audit.md`.
- New `docs/developer-guide.md`.
- New `docs/accuracy-commitments.md` and `npm run docs:accuracy` (`scripts/docs-accuracy.js`): writes it and the ACCURACY block of the developer guide from `docs/accuracy-measured.md` and `docs/accuracy-commitments.json`; `test/docs-accuracy.test.js` fails when they are stale.
- Fix: `eval/anonymise-corpus.mjs` and `eval/recover-corpus.mjs` number new sites above the highest alias already in `eval/corpus.json`, so a developer without the private site map no longer reuses `s01`.

### Fixed (WCAG 2.5.8 target size, round 5 false positives)

- A target-size row is measured on the element it names. A selector that matches several elements (Lighthouse reports one selector for a whole link list) is narrowed by the quoted opening tag, then by the engine DOM path; still ambiguous means `needs-review` instead of measuring the first match.
- A failure at a viewport other than the loaded one is re-measured on a fresh page load at that size (scripts that fix a layout at load make a resized page stale); the tool-owned scan of undersized targets does the same before it adds a finding.
- `needs-review` instead of `confirmed`: a target whose own display class (`inline-flex`, `flex`, ...) is not in effect (no author rule that sets a display matches it, in any media query, and no readable stylesheet hides one; a responsive `block md:inline` with its stylesheet loaded still confirms), and a circle overlap below 1px that involves an inline text box (font-metric rounding, `OVERLAP_NOISE_PX`; fixed px boxes confirm at any overlap). An overlap of 1px or more, and the circle of another undersized target, still fail exactly as WCAG 2.5.8 words it.
- Display rules are also read from `@import`ed and adopted stylesheets (a responsive `block md:inline` loaded through `@import` confirms). The fresh per-viewport re-measure of a `--no-hydrate-jobs` scan blocks the same jobs/chat requests and strips the same chrome as the scanned page. A rendered absolute href that only extends an authored one at a path, query or hash boundary no longer ties with a byte-equal authored href in source attribution (`/` vs `/careers` vs `/careers-fr`).
- Source attribution: a script-extended authored absolute href (a prefix of the live one) is the weakest href evidence (below an exact, an equivalent root-relative or a dynamic `{{ }}` href), so a bare `https://host/` Home link no longer takes the line of a looped or root-relative footer link; with no better candidate it is still found, at medium confidence.
- Merging: rows that quote complete markup with different visible text (the EN and FR links of one language switch) are never one element, so a confirmed FR row is no longer evidence of another link.
- Source attribution: a root-relative authored href no longer matches the same path on an external host, an authored absolute URL that a script extends (`href += path`) still matches. The language switch whose href a script extends with the route is traced to the footer partial instead of the header link with the same path, and own-text narrowing reads every tag of a candidate line (`EN | FR`), not only the first.
### Fixed (round 5 behaviour false positives and harness)
- `dropdown-not-dismissible-with-escape` is `needs-review` when measured after the mobile pass resized the viewport (a script that bound its focus handler by width at load keeps it) ; at the loaded viewport it still confirms. A CSS-only `:focus-within` menu whose toggle exists only at mobile width is measured after the resize, so it stays `needs-review` (policy: undecidable from the resized page).
- `menu-links-unreachable-by-keyboard`: a new tabbable link that precedes the trigger is reachable from the previous stop and is set aside, the remaining new links are judged on their own; a tabbable link within the ten-press walk (counted as tab stops after the trigger) that the walk never reached confirms (keyboard trap), one beyond the walk is `needs-review` only when every remaining new link is beyond it (a mega menu with near and far links where nothing was reached confirms, listing the near links); `tabindex="-1"` links confirm, and when any are present only they are judged, so an unrelated far-away new tabbable control (a Close button after many always-visible buttons) cannot demote them to `needs-review`. A CSS-only `:focus-within` menu that exists only at mobile width stays `needs-review` for `dropdown-not-dismissible-with-escape` after the resize (accepted policy).
- `dead-link-404` on a local page: another origin whose path repeats the local page path (a script appends `window.location.pathname`) is `needs-review` (`route-echoes-local-page`).
- Harness: a truncated baseline snapshot stops the run before any task (class `baseline_incomplete`, no rollback, no `gate_failed`) and the message names `snapshotBudgetMs`, now documented. Working-tree hunk ownership prefers the task whose own explicit range or top-level block holds the hunk over whole-file scopes of tasks traced elsewhere and no longer breaks ties by id string. `fix --verify` no longer resolves a legacy `scan-reports/latest.json`.

### Changed (focus rules, recall and precision)

- `focus-lost-after-escape`: focus on `<body>` alone is now `likely`; `confirmed` only when one more Tab restarts at the top of the page, lands before the trigger or more than 15 stops after it. One level of nested submenu triggers inside an opened panel is driven too, header/nav triggers are probed first, and an `a[href]` trigger with a real URL is never activated.
- `focus-indicator-removed` is `needs-review` unless a confirmed `focus-not-visible` pixel proof backs an element its selector matches.
- `focus-not-visible` always compares pixels (also when a wrapper or sibling style changes on focus); the Tab traversal cap is 400 presses (was 100), proof pairs 80 (was 40), and stops are told apart by element identity instead of `tag|text|x|y`.
- `focus-indicator-low-contrast` fill-only path is labelled 2.4.13 (AAA), impact `minor`.
- `reflow-horizontal-scroll`: wide fixed-position content is `needs-review` instead of skipped.

### Changed (confirmed means traced)
- A site-owned finding is `confirmed` only when a source `file:line` is attributed with confidence of at least medium (the anchor of an absence finding counts). One without it becomes `likely` with `untraced: true`, `source.traceReason` (`unresolved`, `multiple-candidates`, ...) and `verdictBeforeAgreement: confirmed`, so baseline comparison still sees it. It stays in the report, in the HTML report and in the fix export, where the task says "Untraced: locate manually" and lists its candidates. The harness gate still counts a new untraced finding as a regression (`untraced` rows are gated like confirmed). Applies to local scans with a source adapter (`runMetadata.sourceTracing.requireSource`); remote scans and scans without a source project are unchanged. Vendor and platform findings are untouched.
### Fixed (source attribution on real sites)
- A located defect is no longer demoted to `likely`/untraced: a template line with a medium or high trace and a unique data-sidecar hit count as traced, and an untraced row with a known line says `multiple-candidates`, not `unresolved`.
- Candidate narrowing: own-text keeps candidates whose text is dynamic Liquid; the selector chain reads the candidate's own tag (not the first tag on a shared line); a shared component is the owner of a role=button finding only when the traced line renders it (or is it) and shares a non-utility class.
- A root-relative authored `href`/`src` matches its absolute rendered form; a candidate with no `aria-label` cannot be an element that carries a literal one.
- Colour findings: white or black text over an undeclared background keeps the markup trace; a token also used for another role or property points at the rule that applies it (token stays in `tokenSource`).
- An element on the same template line as its `data-react-component` mount is the platform's snapshot (platform-owned); a focused control covered by a sticky bar whose own rule sets `z-index` is fixed in that rule.
- A local-URL scan whose instrumented build fails or is missing no longer drops every source: static tracing of the source tree needs no build and still attributes. `dist/` and the manifest are not consulted in that case (stale or partial output cannot name an owner); findings with no static source stay `unavailable`.
- Identical markup in several partials of one page (carousel buttons, slider dots) is told apart by the element's selector chain, level by level: tag, id, class (utility classes included, escapes decoded) and `[attr=value]` of the element and its ancestors. A class no template writes (set by a script) decides nothing; a candidate whose file ends before the chain does gains nothing from the levels it cannot check.
- A tag whose complete literal class list (`group`) equals the element's and is written by no other tag of the page's render tree is `medium`, so a weak class-hint search no longer overrides it with a look-alike tag in another partial.
### Fixed (editor trial tool bugs, round 2)
- Dev overlay sniff: `new ErrorOverlay(` counts only inside a `<script>` and only for a local target; a live-DOM overlay still fails any target. A page that quotes it in text (a Vite internals article) is scanned. Raw-Liquid contrast downgrade is now scoped: `leakNearSelectors` keeps the downgrade for rows whose element shares a section-level container with the leak; a footer leak no longer demotes a hero row.
- `remaining.json` / `remaining.md` are counted from the final shadow rescan (`source: final-rescan`, with `baselineRescan`, `finalRescan`, `notRescanned`); report findings the rescan never saw are listed under "Not seen by the rescan" and block the zero claim. Every rescan is kept as `<run dir>/scans/<label>.json` (listed in `harness-report.json` as `scans`).
- Editor-declined tasks carry `reasonClass` in `harness-report.json` (`needs_human_content` for name, label and h1 rules) and the remaining text says "the editor made no change for this task". A working-tree (editor) fixer is never asked to repair: one iteration per task (`noRepair`). A lighthouse-only finding is skipped with "layer not run in the harness". Hunks of skipped tasks are listed as "owned by task X, which was skipped".
- Working-tree flow: untracked files (a `.liquid.json` sidecar) are listed as new files instead of vanishing; the closing tag of an element whose opener a task rewrote follows that task; an insertion at the top of a file shows line 1, not 0.
- Export: element html keeps the whole opening tag (a long `<a data-pdk-param-*>` was cut at 300 characters and lost its tag); `parseElement` copes with a cut tag; the h1 task also names the partials the page renders (one level); behaviour tasks (`menu-links-unreachable-by-keyboard`, `focus-lost-after-escape`) name the `src/scripts` candidates and put them in scope. `fix --export --target cursor|claude` prints a `.git/info/exclude` suggestion for the agent rules it wrote when git does not already ignore them (nothing in git metadata is written); the rules file and the verify error name `--out-dir` when the export lives there.
- G1 evidence carries `rule` and `selector`; a new focus-behaviour finding says it may be unmasked by the edit. accessScan `VisibilityMisuse` no longer flags a visually hidden (`sr-only`) heading, the h1 fix the task itself recommends.
### Fixed (page validity and local render artefacts)
- Dev server overlay: a page whose live DOM holds `vite-error-overlay` (or another shadow-hosted dev overlay) is now `failed` with "dev server error overlay: fix the build error first" (exit 2) instead of skipped, also when the overlay appears during the scan. Findings whose element sits inside such an overlay are never reported. A local 5xx stays `unrenderable-locally`. The always-present `nextjs-portal` devtools host no longer fails a healthy Next dev page; it counts only when its shadow root holds an error dialog.
- Local render artefacts become needs-review "local render artefact: ...": pixel-measured contrast rows on a page where raw Liquid text leaked into the body, and an empty heading whose template is a `_translate("...")` token. Solid-backdrop contrast, a literal empty heading and pages without a leak are unchanged (`src/scanner/unresolved-text.js`).
- Scan hygiene: every scan prints the project root, branch and short commit it traces against, and warns loudly when the root is not a project, the working directory is outside it, or (local `--url`) the root never names the URL's port (`src/scanner/scan-hygiene.js`).
### Fixed (precision: duplicate ids, label in name)

- `duplicate-id-referenced` no longer fires for a repeated SVG `<symbol id>` referenced only by `<use href>`. It now also covers `aria-activedescendant`, `headers`, `list` and in-page anchor targets.
- Label in name (`VisibleTextPartOfAccessibleName`, `label-content-name-mismatch`) passes when the accessible name carries the control's title and only a separate caption is missing.
- Label in name: the title relaxation now needs a title of two or more words that is also visually first, with a caption no longer than the title. A one-word first block (`NEW`, `Apply` of `Apply Now`), a reordered layout or a longer second block stays a confirmed 2.5.3 mismatch.
### Changed (verdict tiering: confirmed means an A/AA failure)

- Export is unchanged by the tiering: `likely` findings are still exported as tasks by default; only `needs-review` findings need `--include-needs-review` (`src/fix/export/tasks.js`). `docs/verdict-matrix.md` said otherwise and is corrected.
- `skip-link-missing` is confirmed only when no bypass mechanism exists (3+ repeated header/nav stops, no main landmark, no headings); with a main landmark or headings it is `likely` (ARIA11, H69). axe/Lighthouse best-practice rules (`heading-order`, `page-has-heading-one`, `skip-link`, `tabindex`, any rule tagged `best-practice` without a WCAG A/AA tag) are `likely` at most (`isAdvisoryRule`, `settleFinding({ advisory })`). Dead links keep `category: reliability` outside the accessibility gate; `--fail-on-violations` behaviour is unchanged and documented in `docs/verdict-matrix.md`.
### Fixed (focus-not-visible on large elements)
- `focusPixelsUnchanged` returns needs-review when the capped screenshot clip (520x260) does not cover the whole padded element, so a card or hero link whose focus cue sits on a child outside the clip is no longer confirmed. Fixture `focus-reset-big`.

### Fixed (focus indicator removed by a CSS reset)
- `focus-not-visible` is now deterministic: confirmed only when a real Tab focus changes nothing in the computed styles of the element, its wrapper and siblings AND the pixels around it are identical focused and blurred (`focusPixelsUnchanged`); otherwise needs-review (custom checkbox/radio, wrapper or sibling cue, cue the pixels show elsewhere, proof budget spent).
- A background change as the only focus cue (no outline, ring, border or underline) used to count as an indicator and was never reported (`button{outline:0}` plus a 1.1:1 hover fill). It is now `focus-indicator-low-contrast` (needs-review) when the focused and unfocused opaque fills are under 3:1.
- Tests: `focus-reset` fixture in `test/fixtures/keyboard-contrast`, kind and verdict pins in `test/keyboard-contrast.test.js`; the heuristic-cap tests in `test/engine-agreement.test.js` and `test/rule-kinds.test.js` now use `focus-order-illogical`.
### Added (menu and dropdown keyboard behaviour, recall)
- `scanMenuKeyboard` (`src/scanner/behavior-checks.js`) drives menu triggers with real Tab, Enter, Escape and ArrowDown presses and records `document.activeElement` and the open state. New rules: `menu-links-unreachable-by-keyboard` (2.1.1), `dropdown-not-dismissible-with-escape` (1.4.13), `aria-expanded-not-updated` (4.1.2); `focus-lost-after-escape` now also tests focus inside the opened panel. Fixtures in `test/fixtures/menu-keyboard`, tests in `test/menu-keyboard.test.js`.

### Fixed (menu keyboard false positive)
- `scanMenuKeyboard` only counts newly visible links that belong to the trigger (its `aria-controls` panel or its nav, header, footer or parent). A scroll-triggered back-to-top link or late banner no longer makes a correct footer accordion fail `dropdown-not-dismissible-with-escape`. Reachability now tries ArrowDown plus ten Tabs and the proof says so instead of "never".
### Fixed (harness on real Paradox sites)
- The harness serves a real site's shadow copy with the Vite dev server by default when the project has a vite config (a Paradox `dist/` is only fragments: no head, layout or scripts, so a static server made baselines and rescans meaningless). `harness.site` in `.scan-config.json` chooses `auto` (default), `static` or `vite`; the fixture corpus keeps the static adapter.
- The static site adapter answers clean URLs (`/x` serves `x.html`, then `x/index.html`), so `/404` and `/500` no longer answer 404 when the build has them.
- html-validate failures in the harness are per route and non-fatal: a route that answers an error or makes the validator throw is skipped, listed in the incomplete reasons (baseline) or the G8 notes, and G8 compares only routes measured on both sides.
- `harness.shareNodeModules` defaults to true when the project has `node_modules` (set `false` to opt out); a baseline build that fails with `MODULE_NOT_FOUND` prints a hint that names the setting. Documented in `docs/fix-harness.md`.
- `remaining.md` no longer prints "Zero remaining claimed: yes" while findings remain: the claim needs an empty remaining list and a final scan of the final state that found nothing. New reason classes `not_traced` (no traced source line, so no task) and `needs_review_finding` replace the lumping into `fixer_could_not_produce_safe_change`.
- `ada-scan fix` reads `.scan-config.json` from `--source`, so the "not found" warning no longer appears when the project has one.
- Review fixes: `shareNodeModules` no longer links the project `node_modules` into the shadow when `verifyInstallCommand` is set (an install would write through the link into the real project); an explicit `true` still links. `fix --harness --source` now reads `thirdParty` from the `--source` config for the whole scan, not only the early config lookup, so the cwd "not found" warning is gone from the scan path too (`setThirdPartyConfigRoot`).

### Fixed (CIS fixer: round 12 live findings)
- `summarizeGateEvidence` threw "gateEvidence is not iterable" on the runner's `null` first-attempt value (every CIS attempt ended `CIS_FIXER_ERROR`) and skipped every entry because the runner's failed-gate entries carry no `pass` field, so no gate evidence ever reached CIS. It now accepts null and treats only `pass: true` as passed.
- The repair evidence now names the gate, the evidence kind, the moved box (before and after) or the design token that was added, plus a fixed one-line instruction per kind (no new colour or token, keep box geometry, keep a skip link hidden until focus). The CIS system prompt gained the same guidance and says that supplied blocks must be edited, not requested again. The strict allowlist parser and the untrusted-advisory rules are unchanged.
- `request_context` for blocks already supplied (`CONTEXT_ALREADY_SUPPLIED`, seen on `quarry-heading-order`) gets one nudge naming the supplied blocks before the advisory gives up.
- `scripts/fix-benchmark.js` builds the `cis` fixer through `createFixer`, which awaits `importTransport()` (one construction path with `fix --harness`).
### Added (fix harness runner)
- `ada-scan fix --harness [--fixer recipes|cis|external] [--max-repairs K] [--dry-run]` runs any Fixer through the gate harness: shadow copy, baseline snapshot, bottom-up task groups, pre-apply allowlist and design-lock check, atomic apply and rollback in the shadow, gates G1..G8, accept policy, at most K repairs with failed-gate evidence, cumulative acceptance, final rescan with the real scanner, squashed diff, per-task table and a remaining report. Fails closed without `verifyBuildCommand`/`buildCommand`; URL-only reports stay scan-only. See `docs/fix-harness.md` section 11.
- `src/fix/harness/`: `runner.js`, `perf.js` (Lighthouse perf runner), `build-checks.js` (G8 facts), `remaining.js` (reason classes, `remaining.json` and `remaining.md`), `policy.js` (accept policy and review queue), `change.js`. The review workbench shows a harness evidence block (gate table, screenshot paths, scan delta, diff) on queued candidates. `runLocalLighthouse` is now exported from `src/scanner/lighthouse.js`.
### Added (accessibility fix skill)
- `ada-scan fix --export --target cursor|claude` installs the fix skill bundle (`src/fix/export/skill/`: SKILL.md, workflow, Paradox and Liquid rules, no-break guardrails, design-locked rule, when to ask a human, 20 pattern files) as `.cursor/rules/ada-scan-fix-skill/*.mdc` or `.claude/skills/ada-scan-fix/`. Marked files only, foreign files and symlinked folders are never overwritten, stale files are removed; the generated rules file points to the skill.
- `ada-scan fix --verify [--baseline <report>]` checks the working tree diff against the export: only task named files (and sidecars), no `dist/` or generated changes, backend tag and `data-pdk-*` multiset unchanged, no colour declaration changes; prints a table and exits 1 on a violation.
- Static instruction coverage (`checkCoverage`) and a lint test for the skill (no em or en dashes, no forbidden advice); `scripts/skill-eval.md` manual evaluation protocol; `docs/fix-skill.md`.

### Fixed (working-tree harness flow on real exports)
- `fix --harness --from-working-tree`: tasks are normalised with the runner's `normalizeTask` (now exported) before the fixer scopes them, so real export tasks no longer all decline `NO_CHANGE_FOR_TASK`; hunk ownership matches the task's element (id, or tag plus attributes) in or around the hunk before line distance, so a trace a few lines off still works; untraced tasks get a whole-file scope over the files they list; unclaimed hunks are written to `harness-report.md` and `.json` with file and line; the run says it is always a dry run.
- A blank line above an edit no longer makes a valid candidate fail `STALE_PREIMAGE` (the joining newline mapped to the next line start in `candidate/bytes.js`).
- Export text: the rescan command is `ada-scan --url <site>` (compares with the saved baseline), not the nonexistent `--baseline-compare`; likely locations are per rule (the h1 task lists the page templates of its pages, not skip link advice); a loop is claimed only when the traced line holds the element, and a task says when the trace line does not contain it.
- `fix --verify`: a "locate manually" task accepts edits to the templates it lists, and only those (a deleted, created or unlisted template or sidecar stays a violation); adding a backend tag is a warning, removing or editing one stays a violation.

- Edits anchored next to an indented blank line or a line with trailing blanks no longer corrupt whitespace: such a line is not used as context (the line below is), and `fileToEdits` refuses (`WHITESPACE_MISMATCH`) any edit whose applied bytes would differ from the verified text.
- Working-tree flow: hunks are shifted by the line count of edits already in the shadow, so a task owning hunks above and below another task's hunk no longer makes that task decline `HUNK_DOES_NOT_APPLY`.

### Fixed (round 9: earlier fixes that did not take effect on real sites)
Rescans of seven sites showed four fixes missing their target. Root causes:
- Head metadata and the unbound-data cap: `PageTitleValid` on `<title>{{attribute:og_title}}</title>` stayed confirmed because the served-HTML comparison only runs when the navigation response body is available and unmodified. A finding on `<title>`, `<meta>`, `<link>` or `<html>` whose own source template line (the tracer's `file:line`, a multi-line tag read to its closing `>`) holds a backend tag (`{{attribute:..}}`, `{{data:..}}`, `{{component:..}}`) is now `unbound-data` needs-review, decided from the source (`unboundFromSource`, `src/tracer/ownership.js`), whatever the served HTML showed.
- Vacuous `measured-fact` proofs: an accessScan row whose proof was the rule's rationale plus an opening tag with no value (`<title />: the title element is present and non-empty or not`) counted as measured. The fallback proof is now `dom-structure` (needs-review) unless the tag holds an attribute value or a number, and a recorded accessScan `measured-fact` with no measured value is read as `dom-structure` (`hasMeasuredValue`, `proofFor`). Downgraded rows are listed in `docs/verdict-matrix.md`.
- Error pages: `FocusNotObscuredHeader` on `/404` and `/500` stayed confirmed because the scanner emits the header rule as `StickyHeaderObscuresFocus` and the page-structure list held only the report alias. Both ids (and the alias map) are matched now. A page is also a shell when its own template holds only layout/block/comment tags (a layout carrying `<main>` no longer hides that), or its live DOM has no main, no heading and under 80 characters of text outside header/footer/nav; the note says "empty template shell". The default `scan.errorPages` is `/404`, `/500`, `/job-details`.
- Consent banner covering a footer link (`FocusNotObscuredFooter`/header): anything inside a fixed/sticky container (not only classified overlays) is never the obscured element; the audit repeats the measurement with real Tab navigation (first 60 stops at the scan viewport). Confirmed only when real Tab leaves the control obscured; a control that Tab clears is no finding; one beyond the first 60 stops stays needs-review ("focus-only"). A third-party cover keeps the vendor owner but the finding carries `siteFix` (`note`, and `candidate`: the global stylesheet rule styling html/body, else the template loading the vendor script, never a null source when one exists; `src/tracer/site-fix.js`).
- `disclosure-missing-aria-expanded` skips `role=tab`, `menuitem*`, `option`, anything in a `tablist`/`menu`/`listbox`, pagination and carousel dots.
- `duplicate-id-referenced` on SVG sprites: copies with identical normalised inner markup and viewBox are needs-review, "identical duplicate definitions, hygiene only"; copies that differ stay deterministic.
- `target-size`: a neighbour whose centre is covered by another element, a node of the same control, and a label with its control are not neighbours (`docs/measured-checks.md`).
- Calibration: G9-* labels and fixtures (`/job-details`, `/sprite-identical`, `/sprite-differ`); `/no-main` now holds a paragraph of real text so it is a normal page, not a shell. Tests: `test/site-fix.test.js` and additions in `test/unbound-metadata-unrenderable.test.js`, `test/proof-families.test.js`, `test/obscured-focus-convention-precision.test.js`, `test/disclosure.test.js`, `test/svg-sprite-duplicate-id.test.js`, `test/measured-checks.test.js`.
### Fixed (round 9: colour tokens traced to their declaration)
- `color-contrast` findings pointed at markup while the failing colour is declared in CSS (a `var(--color-primary)` token, a rule on a component class, a colour inherited from an ancestor or a utility class). `src/tracer/color-origin.js` reads the winning `color` / `background-color` declaration from the live CSSOM (custom-property chain included), finds it in the authored CSS by selector and value, and makes that line the primary source (`source.method` `css-token` or `css-rule`; markup in `markupFile` / `markupLine`; the winning rule and the other colour as `sourceCandidates`; the chain appended to the proof, `evidence.colorOrigin`). Findings that share one declaration collapse into one with `evidence.occurrences`.
- Script-written labels: `aria-label`, `aria-labelledby`, `aria-describedby`, `title`, `alt` and text (`textContent`, `innerText`, `innerHTML`) writes are traced to the script line, including template strings and concatenations (`Show slide ${i}`) and `setAttribute` inside loops. The written literal must be able to produce the live value (a label it cannot produce is not blamed on the script); the template line stays as `templateSource` (`src/tracer/script-writes.js`).
- New measured rules (`src/scanner/behavior-checks.js`, details in `docs/measured-checks.md`): `reflow-horizontal-scroll` (WCAG 1.4.10, document scrollWidth at 320 x 568 with a visible non-exempt offender, top five listed), `focus-lost-after-escape` (WCAG 2.4.3, Enter opens a panel, Escape closes it, focus is on the body) and `role-button-not-keyboard-operable` (WCAG 2.1.1, a non-native `role=button` with a click listener that cannot take focus or gets no click from a real Enter or Space). `focus-invisible-stop` now names the containers and counts per container (`in ul#site-menu (17)`); a 17-link closed menu is one finding.
### Changed (fix export for AI tools)
- `ada-scan fix --export` tasks now say how to fix, not only where: `src/fix/export/recipes.js` holds per-rule recipes (intent, before/after pattern filled from the element, cautions, verification) for button-name, link-name, image-alt, meta-viewport, navs and landmarks, skip link, headings, target size, disclosure, duplicate ids, aria-hidden-focus, aria-allowed-role, label in name, new-tab notice, focus, tabpanel and more; a rule without one is marked "No recipe: use judgement". Task files have Where, Evidence, Fix, Do not, Verify and, when certain, a "Proposed change" diff suggestion. Acceptance criteria are compact (selector pattern, ids stay in the JSON). Page-wide findings (skip link) list likely files by role.
- `INDEX.md`: summary table, "By file" section (highest line first), updated prompt; new `--group-by-file` writes one combined task per source file. The rules file uses a project-relative path (absolute with a note when the export folder is outside the project) and carries the Liquid, sidecar and Tailwind guidance.
- Contrast findings (`DESIGN_LOCKED`) are design decisions: separate INDEX section, "For the design owner" (ratios, token chain, nearest passing colour as information only), no diff, never fixed by changing colours. JSON additions only: `evidence`, `selectorPattern`, `proposedChange`, `requiresDesignDecision`, `designOwner`, `fix.intent|before|after|cautions|verify|recipe`.
### Added (fix harness: fixer adapters, seeded-fault corpus and benchmark, Phase 5)
- `src/fix/harness/fixers/`: Fixer adapters with one call shape, `propose(task, context)` returning `{ files: [{ path, before, after }], rationale, confidence }` or `{ declined: reason }`. `createRecipesFixer` generates real edits for meta-viewport, button-name, link-name, image-alt, `aria-expanded`, nav labels, html lang, document title, `rel=noopener`, skip link, duplicate ids in loops (`forloop.index`) and autocomplete, keeps Liquid and Paradox tags byte-exact and declines on ambiguity, multi-line tags, dynamic attributes, labels without a safe source and design-locked rules. `createCisFixer` builds on the existing prompt, transport and strict parser, screens added text for script and URL injection, and sends path-free failed-gate evidence on repair. `createExternalFixer` converts a unified diff, a git working tree or two trees from Cursor, Claude Code or any agent and fails closed outside the allowlist.
- `test/fixtures/fix-corpus/`: six neutral Paradox-like sites with a manifest of seeded defects (rule, file:line, expected fix) and ten tempting wrong fixes (colour change, removed element, hard-coded loop ids, stripped `data-pdk-*`, `aria-hidden` on focusable content, `display:none` skip link, layout-shifting padding, heavy script, visible skip link, renamed script id).
- `scripts/fix-benchmark.js` (with `scripts/lib/fix-benchmark.js`, `scripts/lib/fix-corpus.js`, `scripts/lib/fix-foundation-runner.js`): runs fixers over the corpus through a harness runner, prints and writes fix rate, break rate, false-accept rate, rollback rate, mean repairs and perf delta, and evaluates the release criteria of `docs/fix-harness.md` section 9 (`--check`, `--repeat 2`). `docs/fix-benchmark.md` holds the runner contract and the real-site procedure on copies.
- Tests `test/fix/harness-fixers.test.js` (CIS against a mock server on 127.0.0.1), `test/fix/fix-corpus.test.js`, `test/fix/fix-benchmark.test.js`.
- `docs/fix-harness.md` section 9 refined: break rate counts accepted wrong fixes, false-accept covers `human_review` too, zero accepted is n/a, G1-only cases keep the release open without a scanner.
### Added (fix harness foundation, Phase 5)
- `docs/fix-harness.md`: architecture, gates G1..G8 with thresholds, accept policy, Fixer adapter interface, remaining-report classes, performance track, benchmark and release criteria, security, controller integration plan.
- `src/fix/harness/` (functions only, controller untouched): `snapshot.js` (baseline capture per route and viewport: screenshots, layout, computed styles, tab order, console, links, interaction smoke, perf runs), `compare.js` (G3 to G7, pure), `tokens.js` (backend tag, `data-pdk-*` and design-token multisets), `gates.js` (G1, G2, G8, `runGates`, `decideAcceptance`), `png.js` (dependency-free PNG decoder).
- Tests `test/fix/harness-units.test.js`, `test/fix/harness-gates.test.js` and the neutral fixture `test/fixtures/harness-site/`.

### Fixed (round 8: target size measured only on operable, visible targets)
Reviewers measured three live sites and found many confirmed `target-size` false positives. Root causes and fixes in `src/scanner/measured-checks.js` (details in `docs/measured-checks.md`):
- Closed menus counted as targets and neighbours (opacity 0, pointer-events none, collapsed or off-canvas): the target and neighbour sets now hold only operable, visible controls (computed opacity including ancestors, `pointer-events`, `aria-hidden`, `inert`, clip, zero area, overflow-clipped or offscreen).
- Phantom neighbours (sr-only skip link, hidden navigation, wrapper `li`, a `tabindex` region): wrappers and bare `tabindex` containers are no longer targets; a role needs `tabindex`.
- Vendor banners (OneTrust root has `tabindex=0`) counted as a neighbour box and hid the inline-link exception: a failure that depends on a vendor control is needs-review, "depends on a third-party control", never confirmed.
- Equivalent controls (same `href` or `aria-controls` in a 24px target) are exempt.
- Missing failures: the cap of 25 is gone; they are grouped by selector pattern and container (one finding with `evidence.occurrences`).
- Calibration: G8-* labels (closed menu, vendor-dependent link not confirmed; crowded list stays confirmed).
### Fixed (round 8: translated text, consent-banner controls, source attribution, recall)
Blind-review findings on three sites. Details in `docs/measured-checks.md`.
- Label in name on unresolved platform text: a `label-content-name-mismatch` / `VisibleTextPartOfAccessibleName` row whose text, name or attributes still hold `_translate(` or `{{` is needs-review, "text not resolved in local render" (`src/scanner/unresolved-text.js`). Punctuation, case and apostrophe variants never count as a mismatch.
- A merged finding describes one element: rows that share a source line but quote different tags or ids no longer merge, and a value-keyed merge (duplicate id) takes its element from the row that supplied the source (`distinctElements` in `src/reporter/engine-agreement.js`).
- `menu-trigger-missing-aria-expanded` no longer flags hidden or vendor controls (a consent banner's `#filter-btn-handler` inside a `display:none` preference center) and its rows carry the element markup and selector, so ownership and source tracing run on the real node.
- Source attribution: a generic `font-size` rule or an inherited rule is a low-confidence candidate, the markup line stays primary with the note "size comes from inherited font-size/line-height" (`source.note`, additive). `skip-link-missing` points at the header partial or layout every page shares, the page `<main>` stays a candidate.
### Added (recall)
- New rule `disclosure-missing-aria-expanded` (WCAG 4.1.2, dynamicContent): a visible, operable control that opens and closes a panel (header hamburger, `div[role=button][tabindex=0]` accordion trigger, `aria-controls`) without `aria-expanded`. Measured by activating it once in the live page and comparing the panel before and after; confirmed with that proof, else needs-review. `menu-trigger-missing-aria-expanded` uses the same measurement for `aria-haspopup` controls.
- New rule `link-new-tab-notice-without-target` (needs-review): the name says "opens in a new tab" but the link has no `target="_blank"`.
- `duplicate-id-referenced` covers `<use href="#id">` in SVG sprites; the proof lists every file and line that authors the id.
- Tests: `test/disclosure.test.js`, `test/unresolved-text.test.js`, `test/skip-link-home.test.js`, `test/svg-sprite-duplicate-id.test.js`, additions in `test/root-cause-merge.test.js` and `test/css-script-origin.test.js`.

### Fixed (confirmed tier: tool-owned measurements for target size, label in name and contrast)
Reviewers measured the live DOM of one site and found false confirmed rows in three classes. Details in `docs/measured-checks.md`.
- `target-size` (axe, Lighthouse) and `TargetSize` (accessScan): the tool measures every candidate on the live page at each scan viewport (box, nearest neighbour distance, clearance of the 24px circle to other targets, inline-in-sentence and user agent exceptions). Confirmed only when our numbers fail; the proof is `w x h, nearest neighbour distance d, circle clearance c at viewport WxH` (and says when it fails at one viewport only). When the engine flags a target whose geometry passes (axe approximates spacing in one dimension) the row is needs-review with the reason. Undersized targets with an intersecting circle that no engine reported become a confirmed `TargetSize` finding (layer `accessScan`, at most 25 per page).
- `label-content-name-mismatch` (Lighthouse) and `VisibleTextPartOfAccessibleName` (accessScan): a tool-owned WCAG 2.5.3 check reads the rendered text (not `textContent`: `font-size:0`, clipped, hidden and `aria-hidden` text is no label; a control with no rendered text uses its images' `alt`) and the computed accessible name. A logo link with hidden text and `alt=""` has no visible label: needs-review, reason "no visible label in rendered text". A visible label missing from the name is confirmed with a `name-vs-text` proof. The engine rows share the family `label-in-name` and merge into one finding with our verdict.
- Contrast is measured on a settled page: besides the injected `animation/transition: none` style, running Web Animations are finished before axe, before the pixel resolver for "incomplete" nodes and before the post-check. `color-contrast` rows (axe, Lighthouse) are sampled twice 300 ms apart: a ratio that moves is needs-review, an engine failure the settled page passes is needs-review.
- Links on an error page (`scan.errorPages` routes or a bare layout shell): `dead-link-404`, `dead-link-server-error`, `dead-link-unreachable` and `broken-link` are needs-review, reason "link on an error page mirrors the failed path".
- Calibration: pages `/measured` and `/404`, labels G7-* (spaced footer links, mid-animation text, a logo link without visible text and a mirrored error-page link are not confirmed; crowded dots, a visible label missing from the name and a digit label named by a word stay confirmed).
### Fixed (source attribution round 7: CSS, script and render-set causes)
Two more blind reviews (one with 133 of 275 rows pointing at the wrong source, one fully correct and kept as a regression target). Root causes and fixes (`src/tracer/css-origin.js`, `src/tracer/script-writes.js`, `src/index.js`, `src/reporter/report-v2.js`):
- A partial that no page renders won a manifest owner: the dist partial search matches the snippet in every emitted partial, and a manifest owner skipped the render-set check. On a page whose templates have no dynamic `{% render name %}`, a manifest owner outside the page's render set is dropped and the rendered look-alike (or the page template that holds the markup) is chosen. A page with a dynamic render name keeps a build-proven owner.
- The render set of a page already follows the layout it declares (`{% layout 'x' %}`); a paired test pins it. The `region` row mapped to the page anchor came from the report merge: a derived `region` row that located a real element in a partial lost to the missing-`<main>` page anchor. The merged finding now points at the partial that writes the element; the anchor stays in `sourceCandidates`. A derived row on a layout line, or on a skip link, keeps the old behaviour.
- Script-written attributes beyond `role`: when the live `href` / `src` / `class` / `style` / `aria-*` value is not what any template of the page writes and a project script (a `src/scripts` file or an inline `<script>` of the render tree) assigns, appends (`+=`) or `setAttribute`s that attribute, the script line is the primary source (`method: script-sets-attribute`, `source.scriptAttribute`) and the authored markup is `source.templateSource` (`href` rewrites: the template tag whose value is a prefix of the live one and whose text agrees). The script is matched to the element by the class/id tokens of its selector string; no tie, no claim (a class token added by `classList.add` is the exception).
- CSS-caused findings: a size finding takes the authored CSS rule that declares it; when the element has no rule of its own, the ancestor rule that sets an inherited `line-height` / `font-size` is a low-confidence lead (`method: css-rule-inherited`). A stylesheet whose header only says it was synced from the platform (`Synced from ... do not edit manually`) is the bundle the project keeps and pushes back, so it is no longer treated as generated (resets, vendor and synced-named paths, and `@generated` files still are). A contrast failure whose failing colour is declared by exactly one authored rule naming the element's own class (hover and focus rules never count) now points at that rule (`method: css-rule`, `source.cssSelector`), with the markup in `source.markupFile` / `markupLine`.
- Size and contrast findings always carry a line: a template file with no line is resolved to the element's tag in the page's render tree, else to its first matching tag in the file.
- `authoredCssCandidates(page, root, selector, props)` (exported from `src/tracer/css-origin.js`) returns the located authored rules for any producer of size findings (axe, Lighthouse, a tool-owned measurement); `collectCssRules` takes a property list.
### Added (keyboard: bypass blocks and invisible focus stops)
- `skip-link-missing` is now measured: when no in-page skip link is among the first 10 focusable stops, the description lists the first 5 stops, the number of header/nav stops before the content and whether a main landmark or heading exists. The finding is `confirmed` (WCAG 2.4.1) only with 3 or more header/nav stops and a main landmark or heading to skip to; otherwise `needs-review`.
- New rule `focus-invisible-stop` (WCAG 2.4.7, 2.4.11): tabbable elements that are not visible (opacity 0, clipped, offscreen or zero size) while not `display:none`, `visibility:hidden`, inert or `aria-hidden`. The proof gives the count and the first selectors. `confirmed` when the Tab simulation (first 40 presses) lands focus on an element that is still invisible at its focus state; a stop only found statically, past the Tab window, or a custom checkbox/radio/file input drawn on its label is `needs-review`. A skip link that appears on focus is not reported. See `docs/keyboard-bypass-and-invisible-stops.md`.

### Fixed (unbound platform data and pages that cannot render locally)
- Unbound-data detection no longer depends on the rule or on a complete finding snippet. A finding is `unbound-data` (needs-review, "platform data not bound in local render") when its head metadata is a backend tag in the served HTML (`<title>{{attribute:og_title}}</title>`, `<meta name=description content="{{..}}">`, canonical/og `<link>`/`<meta>`, `<html lang="{{..}}">`: the live DOM only holds the empty value), when its own text is a raw `{{component:..}}`/`{{data:..}}` placeholder (the live probe reads it, so a truncated axe/Lighthouse snippet no longer hides it), or when a list's subtree holds a runtime `{% if data:.. %}` block. A static empty `<title>`, a static list with bad children and static low-contrast text stay confirmed.
- A local dev server that answers HTTP 5xx or the Vite error overlay for a template that needs platform data (`/job-details`) makes the page `skipped-empty` with `skipped.reason: unrenderable-locally` (console, qa-report, HTML banner "Skipped pages") instead of `failed` / exit 2. `scan.strict: true` and remote targets (`--url`) keep the failure; a local 5xx is no longer retried.
- A bare layout shell (no `<main>`, empty page template: only layout/block/comment tags) gets the same `error/stub page` treatment as `scan.errorPages` routes, and `FocusNotObscuredHeader`/`FocusNotObscuredFooter` join the page-structure rules downgraded there (a stub page is shorter than the viewport, so the footer sits under the fixed header).
### Fixed (obscured-focus, convention rules and script-dependent behaviour: fewer false confirmed)
- `FocusNotObscuredFooter` / `StickyHeaderObscuresFocus` / `focus-obscured-by-sticky`: the focused element is never the overlay itself (a consent banner that takes focus) nor a fixed/sticky control (scrolling cannot move it); a page with no scrollable overflow (an empty `/404` or `/500` shell) is not measured; the proof records the viewport (`viewport WxHpx`) and the measurement is taken after focus scrolled the element into view (scroll-padding/-margin respected). Impact is capped at `serious` (2.4.11 allows partial cover).
- The owner of an obscured-focus finding is the owner of the covering element: a vendor overlay (consent banner, chat launcher) gives origin `third-party` / `vendor-script` labelled "... overlay (vendor-script: id)", outside the gate and capped like any foreign finding; a site-owned bar stays site-owned and confirmed.
- `BreadcrumbsNav`: a labelled breadcrumb `nav` that marks the current page (`aria-current`) but has no `<ol>` is needs-review, minor (recommended markup, not a WCAG failure). No `<ol>` and no current-page indication stays confirmed, now with a proof. Findings may carry their own `impact` and a weaker `manual-review` classification.
- Convention-only accessScan rules are no longer `deterministic`: `NoAutofocus`, `NoExtraInformationInTitle`, `NoRoleApplication`, `RegionMainContentSingle`, `TabAriaControls`, `TabpanelLabelledBy`, `TableNesting` are heuristic (needs-review), impact at most `minor`, and their autofix is `manual_only`. html-validate conventions were already warnings.
- `modal-focus-escapes` / `modal-focus-not-trapped`: confirmed only when the scanner opened a modal (`aria-modal="true"` or a native modal `<dialog>`) and every script of the page loaded; the proof records the dialog, the number of Tab/Shift+Tab presses that left it and the viewport. A non-modal popup, or a page whose focus-trap/behaviour script failed to load (CDN blocked offline, 4xx/5xx), is needs-review, moderate, reason "dialog not opened / behaviour script not loaded". Script-dependent carousel/accordion findings get the same downgrade.
- Scripts that failed to load are recorded per scan page and listed in the `focusTrap` / `dynamicContent` run metadata (`scanners[].evidence.blockedScripts: [{ url, reason }]`).
- Calibration: pages `/focus-obscured`, `/focus-obscured-site`, `/breadcrumbs` and labels G6-* (vendor overlay is not site-confirmed, site bar stays confirmed, breadcrumb convention vs missing current page).
### Fixed (source attribution: wrong file for structural, script and look-alike findings)
A blind review found 34% of confirmed rows pointing at the wrong source. Root causes and fixes (`src/tracer/structural-source.js`, `src/index.js`):
- Page-level anchor for an element that lives in a partial: `multiple-navs-missing-labels`, `multiple-main-landmarks` / `landmark-no-duplicate-main` / `landmark-unique` on `<main>`, `image-alt-missing-sr` and `modal-focus-escapes` (selector only) were put on `pages/<page>.liquid:2` or the layout. They now resolve through the page's render set: the unlabelled `<nav>` (first one `source`, the others `sourceCandidates`), the INNER `<main>` of a nested pair, the `<img>` without `alt`, the dialog the trigger's `aria-controls` names. With nothing to find (one `<main>`, all navs labelled) the page anchor is kept.
- Hint search chose look-alike markup: a bare class/text hint matched another partial (`Working at X` in two partials, a `p.body-l` that passes elsewhere, `alt=""` in a sibling). The structural tracer now runs first; survivors are narrowed by the live element (a tag that always renders `alt` cannot be an element without one; a colour utility the live element carries and the tag lacks), by DOM ancestry (selector ids/classes, landmark tags, `bg-<token>` of the failing background) and by render-call arguments (a call whose stamped argument differs did not render the element). Still tied: `confidence: low`, `traceReason: multiple-candidates`, all `sourceCandidates`; tasks say `locate among candidates`. Candidates in one file point at that file's first line (never a null line).
- Script-set attributes: `aria-allowed-role` / `aria-allowed-attr` where no template writes the role and a `src/scripts` file does (`setAttribute("role", "button")`, `.role =`) report the script line (`method: script-sets-attribute`) with the markup as `source.templateSource`.
- Colour tokens: a contrast failure whose foreground is a utility class backed by `--color-x: #hex` (or a literal `color:` in a rule naming the element's classes) lists the declaring CSS line as `source.tokenSource` and a `css-token` candidate next to the markup line; the background token is listed when the template names `bg-<token>`.
- Data values: the `.liquid.json` lookup now also matches `alt` and `aria-label`, and values followed by more properties on the same line.
- Measure: `scripts/trace-eval.js` (`npm run trace-eval`) traces hand-labelled rows and compares with the location a reviewer named: 26 neutral rows (`test/fixtures/trace-eval`) went from 1/26 to 26/26. Tests: `test/trace-source-errors.test.js`.
### Changed (scan-visual.html redesign)
- The visual report is rebuilt as a review tool (`src/reporter/ui/`; `buildHtml` delegates, writer functions unchanged). Overview first: gate state and why, verdict, a split into fix in your code / needs review / not your code, and the top root causes to fix first. Then a findings explorer with live search, filters (verdict, owner, impact, layer, rule, page, has source), sort, group by root cause / rule / page / source file, removable filter chips, view state in the URL hash, expand-in-place detail with proof, source (file:line, match quality, how found, "locate manually" when unresolved), element, owner and engines, copy buttons and a client-side "Copy as AI prompt", keyboard (`/`, `j`, `k`, Enter, `?`) and a live result count. Also: not-your-code per vendor, coverage with failed / partial / skipped reasons, per-page buckets, dead links grouped by target, Lighthouse and Core Web Vitals per form factor, run details and baseline comparison.
- Size: 1.2 to 1.9 MB reports are now 190 to 510 KB (586 findings: 481 KB) by embedding one compact record per finding with interned strings; screenshots stay separate lazily loaded files.
- Accessible and offline: dark-only design-system palette (#121212 page, #1E1E1E cards, cyan #00E5FF actions, red #FF453A alerts, amber for serious and moderate), Inter and JetBrains Mono named first with system fallbacks, a 12-column overview (three KPI cards, fix-first list, gate alert panel), inline SVG icons, AA text contrast,  skip link, landmarks, visible focus, reduced motion, print and forced-colors styles, no horizontal scroll at 320 px, one CSP-hashed inline script. `index.js` passes the V2 report to the writer (`{ ...enriched, v2 }`) so no V2 field is lost; legacy projections still render.
- `npm run report:audit` (`scripts/report-ui-audit.mjs`) checks overflow, split words, accessible names, contrast, focus order, shortcuts and axe-core in Chromium. Tests: `test/report-ui.test.js`.

### Fixed (CSS source choice for size findings)
- `target-size` was attributed to a reset (`src/styles/base/synced.css`, "do not edit") because it won on specificity, or left on the JS line that sets aria-labels. Every size-declaring rule that matches the element is now a candidate in cascade order; the finding goes to the first one in an authored file (path named reset/synced/vendor/normalize/generated, or a header saying generated/synced/do not edit, is not authored), the other authored rules are `sourceCandidates` (`method: css-rule-candidate`). If only generated CSS declares the size the finding stays on the markup. A size finding on a line inside `<script>` or in a `.js` file moves to the element's markup line (else the line is dropped). Tests: `test/css-origin-choice.test.js`.

### Fixed (locale routes)
- Route to template for nested page dirs: `src/pages/it/index.liquid` is the route `/it` (was the nonexistent `src/pages/it.liquid`, which also scoped the render tree to a file that does not exist and left shared-partial findings `unresolved`); `it/x.liquid` is `/it/x`. Applies to tracing, page-level fallback and `--changed-only`.
- A node whose live text is translated (`_translate("...")` in the template, another language at run time) is still traced: when no id, class or text hint matches, its tag plus absolute `href` is searched in the page's render tree (`source.method: source-href-search`; several lines with the same href name the file and leave the line empty). Fixture: `test/locale-routes.test.js`.

### Fixed (partial pages)
- A layer that hung to the 180 s deadline never got its retry (the deadline wrapped the layer and its retry); the deadline now bounds one attempt, so a timeout or lost target is retried once in a fresh context.
- A `partial` page says why: `pages[].partialReasons: [{ layer, reason, gating }]`, shown in the console, qa-report and the HTML banner. Exit code 2 now needs a gating incomplete layer: a page that is partial only because `lighthouse` or `w3c` did not complete is still `partial` but no longer exits 2 (`summary.pagesPartialGating`); `scan.strict: true` restores the old rule for every layer.

### Fixed (origin and verdict consistency across pages)
- The same injected vendor DOM got different origins on different pages: a node the live probe could no longer resolve (banner dismissed by a later layer, probe failed or timed out, 20 s bound) silently became `site` / `site-source` and, with a rule-name proof, `confirmed`. Now an unresolved node is classified from its markup: a vendor id/class token the served HTML never contains is `third-party` (as on every page); anything else is the new origin kind `unknown-probe-failed` (owner `site`), never confirmed. Findings with an empty selector go through the same path. Link findings are exempt. Calibration pages `/consent-a`, `/consent-b`, `/consent-slow` (slow blocking resource, banner dismissed mid-scan) pin it; `calibrate.js --pages /a,/b` scans a subset.
- `confirmed` needs a measured proof for any owner, not only third-party/platform. `validator-rule` (a rule name from lighthouse, html-validate, w3c), `dom-structure` (axe generic help) and `rule-fact` are no longer proofs. Measured now: axe's per-node failure summary, an html-validate/w3c message quoting the offending value, Lighthouse's per-node explanation (new `evidence.explanation`), accessScan's observed node markup plus the rule fact. Rows with only a rule name or generic wording are `needs-review`; the families and what each becomes are in docs/verdict-matrix.md (generated from `scripts/lib/proof-families.js`, `test/proof-families.test.js`).

### Fixed (links: false confirmed 404, wrong source)
- External dead links are judged on the final status after the redirect chain (5 hops, chain recorded in the message and `evidence.proof`). Confirmed only when HEAD and a browser-UA GET both end 404/410 or 5xx at the same final URL; 401/403/429/999, a bot challenge, or any disagreement (HEAD vs GET, final URLs, http vs https variant) is needs-review (`blocked-unverifiable` / `inconsistent-status`). Same-origin policy is unchanged.
- A link finding's primary source (`source.file`/`line`, fix tasks, SARIF) is the `.liquid.json` line where the href is authored; the template line moves to `source.templateSource`. The sidecar of the partial that renders the link wins; a value found in several other sidecars is not picked (`source.dataAmbiguous`).
### Fixed (review of real scans)
- One authoring line that a template loop renders N times (e.g. 4 tabpanels, same rule, same layers, same confident source line, same data line) is one finding with `count` N and every element in `evidence.observations`; different lines, routes and page states stay separate. `findingCount` drops accordingly; the merged finding's `stableId` differs from the former per-element ids (compare shows them as resolved + new once).
- html-validate impact follows a documented table (`HTML_VALIDATE_IMPACT`, docs/html-validate-rules.md): spec/hygiene errors (`no-deprecated-attr`, `deprecated`, `close-order`, ...) are minor, markup-validity errors moderate, rules that break assistive-technology semantics (`no-dup-id`, `valid-id`, `empty-title`, `element-required-attributes`, `multiple-labeled-controls`) stay serious. An unmapped error rule stays serious.
- A finding owned by a third party or the platform is `confirmed` only when its proof is a measured live-DOM fact (`computed-ratio`, `attribute-value`, `name-vs-text`, `measured-fact`, `element-from-point`, `http-status`); a validator rule id, axe failure summary or rule rationale gives `needs-review`. `summary.thirdPartyConfirmed` / `platformConfirmed` count only the proven ones; both stay outside the gate. Rules that capture `visibleText` and `accessibleName` (label-in-name) record them as a `name-vs-text` proof.

### Added (calibration)
- Calibration fixtures and labels for an empty `data-pdk-out` heading and the section it labels (needs-review), a fixed footer without focus-obscuration proof (not confirmed), and single findings for the cross-layer skip-link and heading-order duplicates.

### Fixed (error pages, skip-link source, empty scans)
- Skip-link findings on an error/stub page (`scan.errorPages`) are needs-review with the "error/stub page" note, like the other page-structure rules (the target `<main>` is absent by design).
- A page-level anchor always carries a line: the page's `<main>`, else its first element, else its layout include line (was `null` on pages without a `<main>`).
- A merged skip-link finding takes the source of the root-cause rows (the page's `<main>`), not the layout line of the derived axe `region` row.
- axe `aria-valid-attr-value` and accessScan `AriaLabelledByHasReference`/`AriaDescribedByHasReference` on one element are one finding (dangling aria reference).
- A scan whose pages are all `skipped-empty` writes a valid report with zero scanner runs (was `Invalid ScanReportV2: scanner metadata is required`); it exits 0 (skipped is not incomplete).

### Fixed (source hint search)
- The source hint search prefers live markup over a commented-out copy (`<!-- ... -->`, `{% comment %}`); a comment-only hit is still a fallback. A rendered `aria-label` div no longer points at its commented-out twin.

### Added (recall audit)
- `docs/recall-audit.md`: every ground-truth true positive of the two manual reviews with its status in the round-2 reports.

### Fixed (dedupe leftovers)
- One defect seen by several layers is one finding even when the engines quote it differently: markup truncated by one engine (`...">`, `…">`, cut mid-attribute) matches the full markup by prefix, and two layers that each report a family once on the same resolved source line are the same element. Fixes keyboard + Lighthouse skip link, axe + Lighthouse heading-order (Lighthouse quotes no heading text), axe + screen-reader empty-heading (new `empty-heading` family).
- Derived findings are listed in `DERIVED_PAIRS` (`engine-agreement.js`): axe `region` merges into the skip-link finding on its element, or into the main-landmark finding when the page has no main. Otherwise it stays its own finding.
- axe `aria-allowed-role` on `li[role=group]` items whose selector has no parent is one root cause per source line (occurrences counted), not one finding per item.
- Tag-head prefix matching applies only to cut markup (ellipsis or no closing `>`); a complete tag and the same tag with an extra attribute stay two elements, so they are no longer merged or counted as engine agreement.

### Added (calibration)
- `npm run calibrate` (`scripts/calibrate.js`): scans the neutral fixture site `test/fixtures/calibration/` (one page per known false-positive class N1-N15 and missed-true-positive class M1-M6 of the two manual reviews, loopback mock servers only) and scores the report against `labels.json`. Confirmed tier = verdict confirmed and owner site. Exits 1 when its precision is below 0.98 or a known false-positive class is confirmed; recall and missed true positives are reported. `--report <latest.json>` scores an existing report, `--save <file>` keeps the scan. Scoring logic has a unit test; the scan itself (about 2 minutes) is not part of `npm test`.

### Fixed (confirmed needs measured proof)
- Focus obscuration (`FocusNotObscuredFooter`, `StickyHeaderObscuresFocus`) ignores a fixed/sticky overlay whose effective opacity is below 0.05: `elementFromPoint` still returns an invisible overlay, but it hides nothing. Header and footer variants are now both covered by scanned-fixture tests.
- A rule that measures a rendered state (accessScan `automation: behavioral`: `FocusNotObscuredFooter`, `StickyHeaderObscuresFocus`) no longer inherits its documented rationale as proof, so it is never confirmed on a generic claim; its check records the measurement (`evidence.proof`, type `element-from-point`, with element/bar y-ranges and viewport height) or the finding stays `likely`. The audit now lets focus scroll the element into view like a real keyboard user, so only an element still fully covered is reported. Keyboard/focus-trap layer rules get the instance's own description as proof, not the rule's rationale. `docs/verdict-matrix.md` gains a proof column.

### Fixed (unbound PDK output)
- Unbound data is any PDK binding attribute (data-pdk-out, -render, -param-*, -if ...) on a node whose bound content is empty or a placeholder href in the live DOM; a node named through aria-labelledby/describedby by such an empty node (the section of an empty bound heading) is capped needs-review the same way. Static empties without a PDK attribute stay confirmed. Only output attributes (-out, -render, -bind, -param-*) count, only for rules that depend on bound content, never on void elements; a placeholder href counts only for `dead-link-empty-href`. Behaviour-only attributes (-click, -src, -lazy, -if ...) leave a missing alt, label or accessible name confirmed.

### Fixed (integration of origin, verdict and link grouping)
- A merged finding with any third-party/platform candidate takes that origin, has no site source and no source candidates; one with an unbound-data candidate is never confirmed. Link findings are grouped per origin as well as per target.
- Axe `region` on an error/stub page (`scan.errorPages`) is needs-review like the other page-structure rules (content outside landmarks follows from the missing main).

### Added (owner display)
- scan-visual.html and qa-report.html show an Owner badge on every finding (Site / Injected at runtime / Platform React widget / Platform component / Third-party: vendor / iframe) with the `origin` label, evidence and suggested action on expand. A "Not your code (N)" section groups vendor-script, platform and iframe findings by vendor or component with their pages and rules. scan-visual has owner filter chips (shown only when a non-site owner exists; no inline script beyond the report's own hashed one).
- Quality-gate rows (HTML, console, qa-report) state "third-party and platform findings excluded (N)"; `runMetadata.thresholds.pages[].excluded` carries N (confirmed occurrences, absent when 0).
- Console summary prints one `Owner <name>:` line per owner when any finding is not plain site code.
- JSON report v2: schema documents `origin`, `notYourCode` and `summary.platformConfirmed` / `thirdPartyConfirmed`; the V1 projection carries `origin`, `ownership` and `notYourCode`. SARIF results carry `properties.origin`; platform and third-party results are level `note`.
- The suggested action for vendor findings now also names the consent / tag-manager (GTM) configuration.

### Fixed (unbound platform data, noscript, error pages, stale heading evidence)
- Offline html-validate blanks `<noscript>` content (text when scripting is on), so a GTM noscript iframe is no longer flagged.
- New origin kind `unbound-data` (owner stays `site`): a node carrying or inside `data-pdk-for` / `data-pdk-var` or unresolved `{{data:}}` / `{{component:}}` / `{{attribute:}}` / `{{snippet:}}` tags. Its findings are capped `needs-review` ("platform data not bound in local render"). Decided by the markers, not the URL. Scoped: the node's own opening tag and own text always count; the `data-pdk-for`/`var` ancestor chain only for rules that depend on bound content (empty-heading, link-name, button-name, empty-table-header, color-contrast, list emptiness ...); a bound tag in a child only for list-structure rules. Static-markup defects (html-has-lang, image-alt on a literal `<img>`, landmark-unique ...) keep their verdict. A marker on a sibling is not detected. Findings are capped, not suppressed, even when purely emptiness.
- axe and screenReader scanner runs record `htmlSource: "live-dom"` like html-validate.
- `scan.errorPages` (default `["/404", "/500"]`, route globs): `missing-main-landmark`, `landmark-one-main`, `missing-h1`, `page-has-heading-one`, `no-headings` there are `needs-review` with the note "error/stub page"; real defects still confirmed.
- screenReader `empty-heading` now names the empty node (selector + markup) and is not reported when the live DOM heading has text; a new evidence guard drops `empty-heading` / `link-name` / `button-name` / `empty-table-header` findings whose evidence node is empty but has text in the live DOM.

### Added (origin model)
- Every finding carries `origin: { owner: site|platform|third-party, kind: site-source|react-widget|platform-component|vendor-script|injected-runtime|iframe, vendor?, label, evidence[] }` (schema, `.d.ts`, `ownership` unchanged). A live-page probe compares the DOM with the served HTML: injected DOM a vendor from the new `src/tracer/vendors.json` claims (consent banners, tag managers, chat, analytics, video; extend with config `tracing.vendors`) is `third-party`; what a `data-react-component` widget renders at run time is `platform`; injected DOM nobody claims is site-owned `injected-runtime` and never confirmed. `data-pdk-*`, `{{data:}}`, `{{component:}}`, `{{snippet:}}` and widget mount points authored in a template stay site-owned.
- Non-site findings have no source file (`traceReason` `third-party: <vendor>` or `platform-owned`), impact capped at moderate (`tracing.foreignImpactCap`, null lifts it), appear once per site in `report.notYourCode` (grouped across pages), and `fix --export` writes them to `not-your-code.md` with the owner and a suggested action instead of tasks.
- Origin model precision: the served-HTML comparison no longer treats one shared class (`btn`, `wrap`) as proof a node was served (an id absent from the served HTML, or a class no served element has, means injected); without a live probe no vendor is assigned from selector/markup classes or ids (`.cmp-hero`, `.ot-card`, `a.cc-btn` stay site-owned); an injected cross-origin `<a href>`/`<img src>` is no longer a vendor resource (only `<script>`/`<iframe>`).
- `gate.countPlatform` (default false), like `gate.countThirdParty`; `summary.platformConfirmed`.

### Changed (origin model)
- Platform-owned (widget, chat) findings no longer count in the gate or `--fail-on-violations` unless `gate.countPlatform`. `{{component:}}` / `{{snippet:}}` placeholders are no longer classified as platform-owned.

### Added (missed true positives)
- New `duplicate-id-referenced` (screenReader layer, confirmed, serious): an id carried by several elements that `aria-labelledby`/`-describedby`/`-controls`/`-owns`/`-details`/`-errormessage` or `label[for]` references, so every reference resolves to the first one (a hard-coded id inside a Liquid loop). The finding carries the occurrence count and the referrers that resolve to the wrong element (`evidence.referrers`), and its source is the template line that defines the id.
- One root cause is now ONE finding across engines and elements: `duplicate-id-referenced`, axe `duplicate-id-aria` and html-validate `no-dup-id` merge per id value (occurrences are counted once, not one row per group); a skipped heading level seen by axe, Lighthouse and the screen-reader layer merges per heading; `li[role=group]` in `ul[role=list]` (`aria-allowed-role` on each item plus `aria-required-children` on the list) merges per list; axe `bypass` and keyboard `skip-link-missing` merge.
- New `repeated-accessible-name-in-loop` (needs-review, moderate): sibling items (same parent, tag and role, visible) that all carry the same `aria-label`, such as every slide named "Slide 1 of 3: X".
- The keyboard layer looks for the skip link among the first 10 focusable stops, so a consent banner or other widget placed before the header no longer triggers a false `skip-link-missing`; a skip link whose `#target` does not exist is still reported (`skip-link-target-missing`) on pages with or without `<main>`.
- A slide named only by `aria-roledescription` is now reported as unlabelled (`carousel-slides-missing-labels`); the roledescription says "slide", not which one.
- The skip-link detector requires a skip/jump wording or a "main content" name and a real fragment, so a nav link such as `<a href="#">Main menu</a>` no longer hides a missing skip link.
- Two skipped headings with identical text on one page are two findings (a layer cannot report one heading at two places).
- Source tracing reads a class assembled by Liquid (`banner--{{ kind }}`) as a pattern instead of a literal class the element lacks, so a duplicated class on such an element resolves to its template line.
- html-validate `no-dup-class` and `no-dup-id` report the opening tag of the element that carries the attribute (not the whole serialized line), so the source trace names the right template line; a hard-coded `id="x"` is looked up by its defining attribute before any line that merely references it.

### Fixed (carousel labels)
- `carousel-slides-missing-labels` no longer fires when the slides are labelled: a slide is an element whose class token is `slide` (or `*-slide`), not any class containing the letters (`carousel-slides`, `slide-dots`), only the outermost slide counts, `aria-labelledby` names a slide, and one widget is one carousel instead of one per nested `carousel-*` part.

### Fixed (focus ring sampling)
- The focus ring is sampled around the element that was measured: a link that blurs or hands focus away before the screenshot no longer yields a false `focus-indicator-low-contrast` (the rect used to be re-read from whatever held focus).
- New `focus-indicator-unverified` (needs-review, minor): when no pixel of the ring colour is found in the ring's band, no ratio is reported. Fixtures cover a blurring link, a ring under an overlay and a fading header (animation freeze).

### Fixed (verdict invariants)
- One choke point (`settleFinding`) enforces the verdict rules for every layer: an axe `incomplete` result is needs-review at most moderate and its message says what axe could not decide; `confirmed` needs a deterministic rule plus a recorded `evidence.proof` (computed ratio, DOM structure, status, rule fact), else it is `likely`; a heuristic or manual rule is never confirmed and a heuristic is at most moderate.
- Impact ceilings: `duplicate-id-aria` serious, `dialog-missing-aria-modal` moderate.
- New `docs/verdict-matrix.md` (rule -> highest verdict and impact), generated by `pnpm docs:verdicts`.

### Added (zero-config source tracing)
- When the project's vite config does not register `ada-scan/vite`, the instrumented build runs the local `vite build` with a temporary wrapper config (`<root>/.ada-scan/tmp/vite-*/`, removed afterwards) that imports the project config (object, function, async or promise; `.ts`/`.js`/`.mjs`) and appends the instrumentation plugin once. The project is never modified. Opt out with `autoInstrument: false` in `.scan-config.json`; a custom `buildCommand` is left alone.
- html-validate rows carry the element's start tag (the live DOM is one long line), so they trace through the rendered partial/component/layout like axe rows instead of falling back to `src/pages/<page>.liquid` with no line; the same header defect on N pages then shares one `sharedSource` group.
- target-size findings whose size is declared in a project stylesheet point at that rule (`source.method: css-rule`, `file:line` in `src/**/*.css`; `source.markupFile/markupLine/cssSelector` keep the markup). Read from the live page's stylesheets (specificity then order; `!important` and layers ignored); utility classes, ambiguous selectors, source rules that declare no size property (e.g. a colour override next to a vendor padding) and winners from a cross-origin stylesheet stay on the markup.
- When wrapping is impossible (build script is not a plain `vite build`, no local vite, no config) the warning and `ada-scan doctor` (new check `tracing-ready`) state the reason and the remedy.

### Fixed (dead links)
- Crawl-found `broken-link` rows group per target like probed ones, carry the authored href (so the footer `.liquid.json` line resolves), and a same-origin route the project does not define is `needs-review` (`route-not-served-locally`) on a local scan. Source tracing also runs on a plain build without `scan-manifest.json` when `src/pages` exists (it returned early before, leaving every row `src=null`).
- A dead link is one finding per target URL and kind (rule, verdict, status, reason) across all pages: `finding.pages[]`, `count` (occurrences), `link.{url,status,reason,fragments,sources}`. The finding keeps the copy with the best source; `fix --export` units list every affected page.
- URL fragments are preserved (`link.fragments`) and never probed; hrefs that are still backend tags (`{{data:..}}`, `{% .. %}`) are not probed or reported.
- Report `source` carries `dataFile`/`dataLine` (the `.liquid.json` line where the href is authored). 401/403/429 and same-origin routes the project does not define stay needs-review (`blocked-unverifiable`, `route-not-served-locally`) and the reason is now in the report.

### Fixed (rule scoping)
- VisibilityMisuse no longer fires on text referenced by an ARIA relation (`aria-labelledby`/`aria-describedby` multi-id lists, `aria-details`, `aria-errormessage`, `aria-controls` of an active control) or on reveal-on-focus overlays (`:focus`, `:focus-visible` and `:focus-within` stylesheet rules). The exemption is scoped to the node that hides the text: only visibility properties count as a reveal (opacity, clip, clip-path, position, left, top, width, height; not transform/overflow), and `aria-controls` exempts only the controlled node, not text inside an ancestor wrapper.
- VisibleTextPartOfAccessibleName (2.5.3) only checks controls named from content or a visible label (link, button, form controls, tab, menuitem, checkbox, radio, switch...), not group/region/carousel containers.
- html-validate: `aria-label` on `h1`-`h6` is no longer reported (ARIA 1.2; resolved from the source tag, so headings with an `id` are covered too); `prefer-native-element` stays a convention warning (minor, needs-review). The error/warn mapping is documented in `docs/html-validate-rules.md`.

### Fixed (integration)
- Root-cause merge compares void-element opening tags with and without the self-closing slash, so a DOM-serialized and a source-serialized `<img>` merge.

### Fixed (report wording)
- Totals read "N occurrences in M distinct findings" in scan-visual.html, qa-report and the console.
- The Performance tile counts only Lighthouse performance findings; Lighthouse accessibility audits get their own "Accessibility (Lighthouse)" section.
- `w3c.*` gate rows name the engine that fed them ("HTML validity (html-validate, offline)", "W3C Nu") and say "Nu validator not run (external disabled)" when Nu was off.
- Health Score `n/a` is explained; the incomplete banner separates failed, partial, skipped-empty and dropped (not served) pages; a Lighthouse run with unevaluated audits reads "complete (N audits not evaluated)".
- Both reports state near the top that only confirmed findings fail the gate.

### Fixed (dead links, third-party iframes)
- Links layer: the route-not-served-locally downgrade applies only to extensionless paths (static assets such as .pdf/.css stay confirmed `dead-link-404`), a needs-review 404 keeps the `dead-link-404` ruleId, and a redirect loop stays a confirmed `dead-link-unreachable`.
- Links layer: on a local scan, a same-origin link answered 404 whose path no project page defines (pages dir, Paradox export page elements) is `needs-review` with "route-not-served-locally" instead of a confirmed 404; new config `links.platformRoutes` (globs, default empty) silences known platform routes. A remote scan still confirms same-origin 404s.
- External links answering 401, 403, 429, 999 or a Cloudflare challenge are `needs-review` ("blocked-unverifiable"). A timeout or network error is retried once as a browser-like GET and then reported as `needs-review` with the class `timeout`, `dns`, `tls` or `connection` and the real error text; only 404/410/5xx after the GET retry are confirmed. Any non-clean HEAD answer now gets one GET retry.
- Nodes inside a cross-origin iframe are `third-party`: no source file is guessed for them (`traceReason: third-party`, new value) and the gate (`evaluateGate`) and `--fail-on-violations` leave them out unless the new config `gate.countThirdParty` is true. They stay listed in the third-party section; `summary.thirdPartyConfirmed` records the confirmed count left out.

### Fixed (empty pages, unscorable Lighthouse)
- A page whose navigated document is empty (no text, landmarks or headings; body children only script, style or template; for example a 0-byte template the platform fills in) is no longer scanned as a full page. It gets status `skipped-empty` with the note "empty template, platform-managed?" (`pages[].skipped`, `summary.pagesSkipped`), no layer runs, so it yields no findings, is not counted as failed or partial (exit code unaffected), and is listed under "Skipped pages" in the QA and visual reports. New config `scan.emptyPagePolicy`: `skip` (default) or `scan`.
- A Lighthouse run that cannot score the page (no category scores, or every score 0 with at least half the audits incomplete) is `unscorable`: category scores are `null` instead of 0, the layer run is `skipped` (`errorCode: unscorable`, so the page is partial), and gate rows show `SKIPPED(unscorable)` instead of failing the 0/100 thresholds. Category scores of `null` are no longer reported as 0 in any run.

### Fixed (discovery)
- Page discovery no longer turns the build output's copy of the pages dir (for example `dist/pages/*.html` shells) into `/pages/*` routes; the dir name comes from `source.pagesRoot`. Against a local dev server the templates win over build output, and routes found only in the build output are probed: a 404/410 drops the route and records it in `discovery.droppedRoutes` instead of failing the scan as incomplete. `404` and `500` pages are discovered from both sources symmetrically and carry `allowStatus` for their own status. Empty directories yield no routes.
### Fixed (keyboard and contrast layers)
- `focus-indicator-low-contrast` compares the focus ring with the pixels next to it (outside the ring including `outline-offset`, and inside it when a negative offset overlaps the element) instead of the element's own background, and also measures new `box-shadow` rings; a UA `auto` ring is accepted. A ring cut off by an overflow ancestor is a separate minor `focus-indicator-clipped` note, not a contrast failure. A ring drawn wholly inside the border box (negative offset reaching at most the border) is judged against its inside neighbour alone, so an inset ring in the element's own fill colour is flagged even though it contrasts with the page outside.
- `focus-obscured-by-sticky` reads what is painted at the element's centre with `elementFromPoint` (stacking and z-index aware), re-checks after `scrollIntoView`, and no longer reports an element that sits above the sticky header.
- A cross-origin iframe without its own ring is reported as the needs-review `focus-in-cross-origin-frame` ("cannot verify in cross-origin frame", labelled with the frame's `title`) instead of `focus-not-visible`.
- New `skip-link-target-missing` (confirmed, serious): the first in-page skip link points to an id that no element has. Its `canonicalRuleId` is `skip-link` so it merges with the axe and Lighthouse findings, and its source is the page template (`<main>`), not the layout. An empty page gets no keyboard findings (no `skip-link-missing`).
- axe `color-contrast` nodes that axe leaves incomplete (text over an image or gradient) are measured from pixels: confirmed when 40% or more of the glyph pixels fail, needs-review from 10%, else passed; the message carries the lowest and median ratio (see `docs/pixel-contrast.md`). Transitions and animations are disabled during the axe run so mid-transition colours are not measured.
- Pixel contrast measures text with a `text-shadow` together with its shadow (the shadow counts as backdrop; the message also gives the share failing without it), so a dark shadow that rescues white text over a bright image no longer yields a confirmed failure. The focus ring check freezes `scroll-behavior`, waits two frames and re-reads the element rectangle before sampling: a ring captured mid smooth-scroll was sampled at the wrong place and gave wrong ratios or a missed failure.

### Fixed (heuristic false positives)
- `VisibilityMismatch` no longer flags decorative `aria-hidden` svg, icon-font or `role="presentation"` graphics without a name or text (a bare svg counted as informative); it is now a heuristic rule, so it is never `confirmed`. `VisibilityMisuse` skips focusable in-page skip links and visually hidden text that names a visible link, button or tab; inactive `role="tabpanel"` content hidden only by opacity is still flagged. `StrongMismatch` and `semantic-emphasis-missing` flag bold only inside running text (sibling text in the parent), not heading-like block labels or numeric badges. `IconDiscernible` accepts `role="presentation"`/`none` and icons inside a named link or button. Findings of heuristic rules are capped at `moderate` impact.

### Fixed (heuristic exemptions, follow-up)
- A heuristic rule's verdict is now `needs-review` (never `likely`), so heuristic findings no longer count in rescan comparison or the default `fix --export`; deterministic rules keep `confirmed`/`likely`. The `moderate` impact cap now applies to every heuristic finding in the report, including the screen-reader, keyboard and other behavioural layers, not only accessScan.
- `ButtonMismatch` also flags a `<button>` used for navigation (a navigation URL in `data-href`/`data-url`/`data-link`, an inline `location`/`window.open` handler, or a button inside a real link); submit and reset buttons are left alone.
- `VisibilityMisuse` treats a hidden fragment link as a skip link only when a `:focus`/`:focus-visible` stylesheet rule reveals it (new snapshot field `focusRevealed`); a hidden fragment link with no focus style is flagged.
- `StrongMismatch` compares the parent's full rendered text (not `visibleText`, which the snapshot fills only for controls), so bold emphasis among element-only siblings is flagged again.
### Fixed (root-cause merge)
- One defect seen by several layers is now ONE finding: the same canonical rule family on the same element, page and state merges across layers (`layers[]`, `enginesAgreeing`, `nativeRuleIds`), keeping the strongest verdict, the highest-confidence source and the stableId of the highest-priority candidate. New families: skip-link (axe, Lighthouse, keyboard `skip-link-target-missing`; an axe `region` on the skip link element is derived from it and merges in), html lang (`html-has-lang`, `HtmlLang`, `html-missing-lang`, html-validate required lang attribute), page title (`document-title`, `PageTitleValid`, `page-missing-title`, html-validate required title), main landmark, h1, and `aria-prohibited-attr`/html-validate `aria-label-misuse`/`AriaLabelMisuse`. Page-level families match by page, not element. `findingCount` counts merged findings; `occurrenceCount` counts each element once (distinct rules and layers on one element no longer add up). Golden: the merged findings replace `axe:document-title` and `accessScan:ButtonDiscernible`, and the `PageTitleValid` count is 1.
- Root-cause merge no longer swallows distinct elements: the opening-tag fallback applies only to a distinctive tag (id, class, real href/src) or when each layer reported a single element of that family on the page; otherwise a selector match is required.
- Findings from one source line and canonical rule (shared partial on many pages, or a line repeated on a page) stay per-page but share `sharedSource: { id, findings, pages }`; `summary.sharedSourceGroups` counts the groups and the QA report marks them. The id uses the same rule and source-line key as fix task grouping.

### Breaking (legacy fixer removed)
- The direct-write fixer (`src/fixer` rules and engine, the Claude, Codex, Cursor, Windsurf and VS Code `--fix-mode` writers, the AI/agent patching and its local UI) is gone. `--legacy-fix`, `--ai` and `--agent` and `--fix-mode claude|codex|cursor|windsurf|vscode` now stop with exit 2 and "removed in v2; use \"ada-scan fix --export\" or --fix-mode cis". `ada-scan fix` exports a task set by default (`--target cursor|claude` for IDE rules); `ada-scan fix --fix-mode cis` and `ada-scan --fix` run the trusted pipeline. `ada-scan init` now writes `scan:fix:cursor` and `scan:fix:claude` as `fix --export --target ...` and no longer writes `scan:fix:vscode|windsurf|codex`.

- `ada-scan fix --ui` or `--session` without `--fix-mode cis` now stops with "needs the trusted pipeline: add --fix-mode cis" instead of "--export cannot be combined with --ui"; the README review command now includes `--fix-mode cis`.

### Added (handoff)
- `ada-scan fix --export` (no AI, no CIS) writes one task per actionable finding (markdown plus JSON sidecar) and `tasks/INDEX.md` under the output directory, from the latest report or `--report`. A task has the rule, WCAG criterion and level, severity, verdict, pages, `file:line` with a five-line excerpt read from `--source`, the element, the fix hint (with an example for common rules) and acceptance criteria. Findings of the same rule and source line share one task; untraced ones say "locate manually"; platform- and third-party-owned findings are listed in the index as not actionable. Filters: `--severity` (that level or worse), `--rule`, `--page`, `--max`, `--include-needs-review`. Output has no timestamps, and the export only creates or replaces its own marked files.

- The scan, fix, rescan loop is covered end to end on the fixture site (`test/e2e-fix-loop.test.js`): the rescan comparison reports the findings of the fixed tasks as fixed and a wrong edit as remaining. README documents the developer loop.

### Fixed (handoff exporters)
- `fix --export --target cursor|claude` with a not-yet-existing `--out-dir` and an unmanaged rules file no longer crashes with ENOENT: tasks and the fallback rules file are written, then the refusal is reported.
- An export file counts as ada-scan-owned only when the marker is in its header, and a symlink (even dangling) at an export path is never followed or overwritten.

### Fixed (source attribution)
- A finding is only traced to a template its page renders (the page's layout and `{% render %}` tree): a legacy guess into another page's look-alike partial is discarded and re-resolved inside the page's own render.
- Page-structure findings (missing or duplicate main, h1, skip link, landmark structure) resolve to the page file (its `<main>` line when present) instead of the layout; elements that really live in the layout stay there.
- Link, image and text findings gain `source.dataFile` / `source.dataLine`: the `.liquid.json` sidecar line where the href, src or text is authored.
- html-validate records `htmlSource: live-dom` (the scanned page's serialized DOM); findings validated on any other HTML are `likely`, never `confirmed`.
- The `skip-link` rule (axe and Lighthouse) now resolves to the page's `<main>` like `bypass` and `skip-link-missing`, even though the reported skip link is written in the layout.
- A source proven by the build (manifest or marker) is no longer reset when the page renders its partial through a variable or computed name that the static render tree cannot see; only heuristic attributions outside the tree are dropped.
- Evidence HTML of access-scan findings (for example `LinkOpensNewWindow`) is read from the live DOM at detection time; a regression test pins it.

### Fixed

- `init --force` replaces a symlinked `.scan-config.json` instead of writing through the link.

### Changed (init, breaking)
- `ada-scan init` now only creates `.scan-config.json`, and only when it is absent (`--force` replaces it, `--dry-run` prints the file and writes nothing). It no longer edits `vite.config.*` or `package.json`, installs Playwright or asks questions; it prints those steps instead. `--yes` and `--no-browsers` are removed (unknown arguments exit 2). The seeded config adds `profile: "standards"`, the `htmlValidate` layer and a placeholder `/` page. `ada-scan init --help` prints the main help.

### Added (docs)
- `docs/README.md` (index) and `docs/host-sync-proposal.md` (changes the host repository owner must make for the stale embedded scanner, `scan:*` scripts, CI paths and lockfile drift; a proposal, nothing applied).
- `pnpm docs:readme` regenerates the usage, flags table, exit codes and the layer and rule counts in the README from the CLI help and the registry; `test/readme-docs.test.js` fails when they drift.

### Fixed (docs)
- README rewritten against the current CLI: install, quick start for a local and a preview URL, report files, the developer loop with Cursor and Claude Code, limits of automated testing; removed the "Ten layers" count, customer-style example hosts, deleted playbook link and old `scan-reports/` paths. `docs/cis-contract.md` no longer quotes point-in-time test counts (851 and 491) and `docs/fix-ada-cis-design-plan.md` marks the implemented milestones.

### Added (doctor)
- `ada-scan doctor [--url <url>] [--json]` checks Node against `engines`/`.nvmrc`, that Playwright Chromium launches (20 s bound), lockfile and package-manager drift (pnpm 11 implicit install before scripts, a module nested in another pnpm workspace), the local dev server, the build script used for tracing, CIS variable names (never values), that the output directory is writable, free disk space and, with `--url`, reachability, the redirect chain and a noindex hint. Each check reports PASS, WARN or FAIL with a fix hint; exit 1 when any check FAILs. It writes only a temporary probe that it removes, and contacts the network only with `--url` (plus a loopback probe of a local `baseUrl`).

### Added (truth corpus)
- `test/fixtures/truth-corpus`: 27 hand-written bad/good fixture pairs, each labeled with a WCAG success criterion and the reason the bad one violates it (`labels.json`), covering criteria that had no seeds (1.3.5, 1.4.1, 1.4.3, 2.2.2, 3.1.2 and more) and the axe and html-validate layers for 3.1.1, the only criterion the coverage matrix marks full. `npm run truth:metrics` runs axe, accessScan (deterministic and heuristic rules) and html-validate over these and the rule seeds and writes `docs/truth-metrics.md`: per layer recall on seeded violations, false-positive rate on clean fixtures, cross-layer agreement, recall per criterion and the misses. Truth is the fixture's authored label, never an engine result; the commercial-parity corpus stays a supplementary metric (parity is not truth). A test keeps the doc current. Six more pairs cover 1.4.4, 2.2.1, 2.4.11, 2.5.8, 3.2.1 and 3.2.2, which had only rule-seeds; the doc now has a "Seed coverage gaps" section and `labels.json` accepts `knownMiss` for a seeded violation no layer detects yet (3.2.1 focus-triggered submit; the test fails when a rule starts flagging it).
### Added (ground-truth labels)
- `ada-scan label <stableId|--from-report n> --tp|--fp --by <name> [--note ...]` records whether a finding is a real problem in `<reports dir>/labels.json` (stableId, ruleId, verdict, labeler, date, note, stableIdVersion). The file is tool-owned: written atomically, validated on load, and a file that is not a valid ada-scan store is reported and never overwritten. `ada-scan labels stats` prints true positives, false positives, label count and precision (tp / (tp + fp)) per rule, and warns about labels made under another stable-id version (they cannot be matched to current findings).
- The QA report has a "Rule precision" section and, under each finding, its ready-to-copy label command (no script in the report).
- `ada-scan labels apply` lists the rules with at least 10 labels and precision below 70%; with `--yes` it writes them to `<reports dir>/rule-demotions.json` (never automatic). Later scans move findings of those rules to `needs-review` (the earlier verdict stays in `verdictBeforeAgreement`, so baseline comparison is unaffected), record `runMetadata.ruleDemotions`, and the scan summary warns about demoted rules and about low-precision rules not yet applied.
### Added (manual verification)
- `ada-scan manual list|sign|status`: the standing manual checklist (keyboard-only use, visible focus, screen reader, zoom 200%/400% reflow, text spacing, captions and audio description, motion and auto-play, error identification, content and readability) mapped to WCAG criteria, with sign-offs (item, page or `*`, pass|fail|na, reviewer, date from `--date` or today, notes, optional content hash) stored in `<reports dir>/manual-checks.json`. The file is tool-owned: written atomically, validated on load, and a file that is not a valid ada-scan store is reported and never overwritten.
- The QA report shows per page "Automated passed; manual review N of M items signed off" (plus failed and stale counts) and an overall verdict line that never says "compliant". A sign-off older than 90 days, or whose recorded content hash differs from the page's, is stale and does not count.
- `ada-scan manual status --date YYYY-MM-DD` now checks staleness against that date (it was ignored). Scans record a per-page `contentHash` (rendered markup without scripts, styles, comments and whitespace) and `manual sign` stores the latest scan's hash for the page, so a sign-off goes stale when the page content changes.
### Added (WCAG coverage matrix)
- `docs/wcag-coverage.md` (`npm run docs:wcag`): every WCAG 2.2 A/AA criterion with the axe, accessScan and html-validate rules that cover it and a coverage level (full, partial, manual-only, none) from `src/utils/wcag-criteria.js`. A test keeps the doc current and fails on unknown criteria or coverage that contradicts the rules.
- The QA report and the visual report state how many WCAG 2.2 A/AA criteria automated checks cover (fully and partially counted separately) and how many need manual review.

### Added (engine agreement)
- Each finding now lists `enginesAgreeing` (the layers that report the same problem on the same element, matched through an equivalent-rule table and the element selector or opening tag) and an `agreement` level: `multi` (at least 2 independent engines), `single-deterministic` or `single-heuristic`. Lighthouse a11y audits run axe-core, so Lighthouse plus axe counts as one engine. Shown as an "Engines agreeing" column in the HTML report and QA report, and in `latest.json`.
### Changed (engine agreement)
- Verdicts: a finding that only one heuristic engine reports is now `needs-review` (it was `likely`; the pre-change verdict is kept in `verdictBeforeAgreement`) and cannot be `confirmed`. Gate math and `--fail-on-violations` still count confirmed findings only and do not move; baseline comparison uses the verdict a finding had before that adjustment (`verdictBeforeAgreement`), so these findings still show as fixed, remaining or new on rescan. Set `"verdict": { "agreementPolicy": "off" }` in `.scan-config.json` to keep the old verdicts (the agreement fields are still written).
### Fixed (review workbench)
- The review workbench now shows the unified diff table (loaded as a module under the page CSP), an insecure-TLS warning banner, a sandbox status card, and a confirmed, aria-busy-guarded sandbox rollback; the server already supported all of these.
- The review workbench no longer shows an empty sandbox card (with a dead rollback button) for sessions without a sandbox: the card's `display:flex` overrode the `hidden` attribute. Browser tests under the real CSP now cover the insecure-TLS banner, the sandbox card, and the rollback confirm / aria-busy / announcement flow.
### Changed (scan speed)
- Links layer: each distinct URL (fragment ignored) is probed once per scan, not once per page; up to 8 requests run at once (still 2 per host), and a network error or timeout is retried once before a link is reported unreachable. A re-verification run still probes again.
- Re-verification: an axe re-run checks only the rules of the findings it confirms (it ran every rule), layers that open their own contexts re-run beside the page-bound ones, and the fresh contexts it needs (default viewport and the other axe viewports) now load while the serial layers run, and only when the first pass has findings that need them. Findings are unchanged.
- `verify.maxPerPage` default is 100 (was 25): a re-run costs one pass per layer, not per finding, so the time budget (`verify.timeoutMs`) is the limit; findings it does not reach are reported as `unverified` and stay in the report.
### Changed (source tracing)
- Several equally good Liquid source tags (repeated cards, same-class links) are now told apart by the element's own text when every tie has authored text and exactly one equals it. The result is `medium`, never `high`; a tie member whose text is filled by Liquid keeps the tie `ambiguous`. In preview the twin's text only counts when the preview element shows the same text.
- `docs/trace-metrics.md` now covers a realistic Paradox fixture (header nav, footer lists, hero, card grid, form, icon buttons, layout head) in both local and preview mode (40 traceable preview cases, none dropped by a filter). Preview `high` versus `medium` is asserted from traced evidence (marker owner plus fingerprint score), not from case names.

### Fixed
- Re-verification no longer drops a real finding on an element whose id is generated per page load (for example `el-popover-3850`): the two loads are matched with generated ids and hashed classes removed.
- Report URL redaction no longer rewrites an absolute URL that has nothing to redact (for example it added a trailing slash to `target.deploymentUrl`, which made hybrid attestation fail with `DEPLOYMENT_URL_MISMATCH`).

### Fixed (scan hangs)
- A wedged Chromium can no longer stall a scan or a test file indefinitely: `newContext`, `newPage`, the runtime-hook install, `context.close()`, `page.title()` and `page.content()` carry a deadline (90 s / 10 s) and fail with a `TimeoutError`. Context close never blocks the scan.
- A layer now has a 180 s hard deadline including its retry (it was 15 minutes; `scanOnePage` option `layerDeadlineMs` overrides it). On the deadline the layer is reported as a `timeout` run and its work is cancelled, not abandoned: the contexts it opened are closed (a context it opens late is closed on arrival) and it cannot open new ones, so the next layer starts without interference and nothing leaks. A layer that only uses the shared page opens no context of its own, so the shared page is not closed for it.
- Work still running when `closeBrowser()` is called (for example a scan whose test already hit its `--test-timeout`) can no longer call `getBrowser()` and relaunch a Chromium nobody closes. Reproduced: such a late launch keeps the Node process alive until it is killed, after all tests have finished, where no test timeout applies. This is the one mechanism that explains a finished test file that never exits; the original 30+ minute stall itself was not reproduced (16 runs of `test/scan-session.test.js` under CPU stress, half beside another browser file, 22-54 s each), so it is not claimed as its proven cause.
- The `ps` call behind `browser-leak-guard` and `closeBrowser` has a 10 s limit (it is synchronous and would freeze every timer, including test timeouts).
- Testing: `npm test` runs with `--test-timeout=300000`; a `node:test` timeout fails a test but does not cancel its body, and an `after()` hook that never settles is dropped silently, so neither stops a process that a live child (Chromium) holds open. `test/helpers/browser-leak-guard.mjs` kills and fails any file that leaves a headless browser behind. Regression tests: `test/scan-scope.test.js`, `test/hang-bounds.test.js`.
- Content activation waits for two rendered frames after each scroll step (capped at 1 s) before its dwell time, so lazy-load observers fire on a loaded machine instead of depending on a fixed sleep. The `scan-loss` dynamic-content test now times only the interactions, not Chromium launch and navigation (that wall-clock assertion failed under load).

### Fixed (trace reasons and report consistency)
- A finding with no local source (a preview scan without `--source`, or an unresolved trace) now always has `source.file: null` (it was sometimes the string `unknown`) and a `source.traceReason` from the shared trace-reason list: `no-source-project`, `unresolved`, or `platform-owned` for any platform- or third-party-owned finding. `no-source-project` and `unresolved` are added to that list and to `docs/schema/scan-report-v2.schema.json`.
- `summary.ownershipCounts` sums occurrences (`finding.count`); the new `summary.ownershipFindingCounts` counts findings, so the two can differ (for example 32 vs 28 platform).
- `evidence.helpUrl` no longer carries axe's constant `?application=...` tracking query.
- QA report: rule headings under "Top issues by rule" are `h3` (they skipped from `h2` to `h4`), and the page has a footer with the generator and scan date.

### Fixed (stable ids on Studio previews)
- `stableId` collapses digit runs only in known generated ids (UUIDs, `el-<widget>-N`, 10+ digit timestamp suffixes); `#job-1001` and `#job-2002` are different findings again. Evidence screenshots are named from the stable id plus the raw selector, so two such elements can no longer share one picture.
- Markup the platform widget loader injects (the `<apply-widget>` host and its container, the widget runtime script, the recaptcha scripts) is classed `platform`, and the baseline comparison leaves platform and third-party findings out (with a note) because they load differently on each run.
- Re-verification also covers moderate axe / accessScan findings, so one-run-only findings such as `page-has-heading-one` or a second popover's `region` are marked flaky and excluded from the comparison.

### Changed
- `stableId` is now stable across runs on Studio previews (stable-id algorithm v2, recorded as `stableIdVersion` in the report). Before hashing, the selector drops generated ids (`el-popover-5950`, UUID-prefixed ids, `ours1793041973008`) and hashed classes (`ae8f46`, `css-1a2b3c`), `style`/`nonce`/`data-v-*` attributes, and the `:nth-child`/`:nth-of-type` positions of `<head>` elements and of script/link/meta/style/noscript; markup tells those elements apart instead. Names like `h1`, `col-6`, `grid-cols-3` are untouched. Identical findings that share an id are matched by order in the document. A baseline saved under another algorithm version is refused with a clear message (save a new one with `--baseline`) instead of printing wrong fixed/new counts, and findings the re-verifier saw flaky in either scan are left out of the comparison. On the same 3-page preview, two identical scans went from 78 differing ids to 11.
- Keyboard and screen-reader findings located by text or href fingerprint are never reported above `medium`: they carry no element markup, so the unified trace cannot confirm them.
- New `html` source adapter traces findings in plain `.html` folders (a static site served locally, or the folder passed as the source for a preview scan). Its own tokenizer records the line and column of every start tag (inline script bodies and comments are skipped); an element is located by unique id, then identical structure, then attribute + text + ancestry scoring. `high` needs a unique id or structure match, a clear scoring winner is `medium`, and same-looking repeats (the same footer on three pages, two identical cards) are `ambiguous` with every candidate listed, never a guessed line. Without a page file it searches every html file, so repeats across pages are ambiguous too.
- New `react` source adapter and scan-build transform. `reactSourceAttrPlugin()` (`ada-scan/vite/react`, active only with `SCAN_MODE=true`) adds `data-ada-src="file:line"` to every host element in `.jsx`/`.tsx` and emits `ada-react-src.json` with each file's sha256; the adapter traces a scanned element through that attribute: `high` needs the build hash to still match and the tag to start at that line, without a manifest it is `medium`, anything else (no attribute, edited file, wrong tag, platform widget) is `untraceable` with a reason, never a guessed path; a malformed hash in `ada-react-src.json` is `untraceable` (`manifest-invalid`), never verified. Next.js is detected but its adapter is documented, not implemented (SWC has no attribute plugin); the decision and steps are in `docs/trace-spike-E4.7.md`.
- `npm run trace:metrics` writes `docs/trace-metrics.md`: per adapter (paradox-liquid, html, react) and scan mode (local, preview), how many fixture elements were traced correctly, left ambiguous or untraceable, or traced wrong. `test/trace-regression.test.js` pins the exact counts, fails on any wrong `high`, requires at least 80% correct per adapter and checks the doc is up to date.
- Source tracing goes through a source adapter interface (`src/tracer/adapters`: `id`, `detect`, `index`, `locate`, `supports`). The framework is detected from `package.json` and `*.config.*` (`paradox-liquid`, `next`, `react`, `html`; Nuxt, Vue and Stencil are recognised and deferred) and can be forced with `tracer.adapter` in `.scan-config.json`. The existing Paradox Liquid tracing is the `paradox-liquid` adapter with unchanged results. A project with no adapter (unknown framework, or one not implemented yet) gets `untraceable` findings with reason `unknown-framework` / `unsupported-framework`, never a guessed path. The scan prints the detected framework and records it in `runMetadata.sourceTracing.framework`.
- One `traceElement` pipeline now attributes every finding to local source: it returns `high` only for a single candidate backed by a snippet marker or manifest owner, `medium`/`low` for weaker unique matches, `ambiguous` with every candidate listed when several tie (for example one snippet rendered twice), and `untraceable` with a reason (`no-marker`, `no-manifest`, `platform-owned`, `preview-without-reference`, `scope-mismatch`, `no-match`, ...). Ambiguous findings no longer get a guessed line. Reports keep `source.file/line/confidence` and add `source.traceConfidence` / `source.traceReason`; `sourceCandidates` lists the ambiguous places. Preview scans only trace after attestation; without a local reference build they never exceed `medium`, with one `high` needs a unique fingerprint match. Identical markup that also appears outside every snippet marker is never `high` (candidates are listed as ambiguous), `data-src` is not trusted as a source reference yet, and the partial-map and keyboard/screen-reader resolvers no longer pick the first matching snippet boundary or emit their own `high`.
- Preview findings are now traced through the local instrumented build: the preview element is matched against the build's page (tag, stable classes, attributes, leaf text, selector ancestry and position) and its local twin is traced to `src/**/*.liquid:line`. `high` needs a unique match with margin and a marker-proven owner, ties are `ambiguous` with all lines, and an element with no twin is `untraceable` (`no-match`); preview traces no longer return `low` or a bare tag-name `medium`, which previously guessed paths for platform-added markup. Spike numbers and the proposed Gate 3 threshold are in `docs/trace-spike-E4.2.md`.
- Real baseline comparison: each scan is compared by finding `stableId` (not counts) with the saved baseline, else the previous `latest.json`, and reports "fixed N, remaining M, new K" per page and overall in the console, `latest.json` (additive `comparison`), the HTML report and the summary document. Only confirmed and likely findings are compared; needs-review is shown as separate counts, findings that changed confidence are listed apart, and layers that did not complete in both scans are left out. Added or removed routes and failed pages are reported, never counted as fixed. A different profile or target warns that the comparison is not apples to apples; a missing or pre-`stableId` baseline prints a clear message and changes no exit code. The count-based "reduction vs baseline %" and bar chart are gone, and the executive summary is titled "Scan Summary" instead of "ROI Summary".
- The keyboard, focus-trap, aria-live, dynamic-content, screen-reader and links layers now have a kind per rule (`BEHAVIORAL_RULES` in `src/utils/verdict.js`, each with a one-line rationale) instead of one kind per layer. Machine-decidable rules (`page-missing-title`, `empty-heading`, `html-missing-lang`, `image-alt-missing-sr`, `focus-indicator-removed`, `modal-focus-escapes`, `dead-link-404`, ...) are deterministic and count as confirmed in the gate; guesses (`missing-h1`, `non-descriptive-link-text`, `focus-order-illogical`, `dead-link-unreachable`, class-name-detected widgets, ...) stay likely. A test fails when an emitted rule id has no entry.
- Lighthouse performance, best-practices, SEO and metric audits (FCP, LCP, TBT, CLS, speed index) no longer become findings or feed the a11y critical/serious gate rows; only Lighthouse accessibility audits do. Performance affects the `lighthouse.*` score thresholds only, and the report lists the metrics as informational with their good/poor targets and rating. A Lighthouse accessibility finding is dropped when axe reports the same rule on the same selector.
- **Breaking:** the profile is now chosen with `--profile standards|commercial-parity` (or `config.profile`), not by `--include-third-party`. The default is `standards` on every host, so remote scans no longer default to commercial parity and the gate and exit code always come from the standards profile. `--profile commercial-parity` adds a separate, labelled supplementary section (`runMetadata.parity`, HTML) that never affects totals, the gate or the exit code. `--include-third-party` now only controls third-party DOM filtering. Reports record the profiles in `runMetadata.profiles`. The golden file was re-approved because the fixture scan now runs the standards profile.
- Faster scans with the same findings: re-verification re-runs only what its findings need (links probe the reported links only, accessScan evaluates the reported rules only, axe revisits the viewports the findings were seen at), axe scans its viewports concurrently, and the focus-trap layer no longer reloads the page after its last trigger test. Cheaper re-runs also leave fewer findings unverified under `verify.timeoutMs`.

### Security
- Generated HTML reports (visual report, ROI summary and technical appendix) carry a strict `Content-Security-Policy` meta: `default-src 'none'`, the visual report's one inline script allowed by its sha256 only, no remote loads, no inline event handlers. A test parses the output and checks the hash.
- The page and route URLs the report records (not URLs inside captured element markup such as `outerHTML`, nor third-party script `src` values or other URLs quoted in evidence) no longer carry userinfo or fragments, and their query values are replaced by `r-` plus 8 hex of their sha256 (names kept; the same value gives the same route key and `stableId`, different values stay distinct pages). `--keep-query` keeps the query string (userinfo and fragments are always dropped). Routes with a query therefore look like `/jobs?page=r-1a2b3c4d`.
- Review workbench server: requests whose `Host` is not the literal `127.0.0.1:<port>` (DNS rebinding) or whose `Origin` is foreign are refused, non-object JSON bodies and unmapped state errors return 400 instead of 500, the first session write happens before the socket opens, and the duplicate `APPLY_STARTED` message key is gone. The workbench's "Open source owner in editor" link goes through the same `vscode://`/`cursor://` allow-list as the other editor links.
- Legacy `--fix --ui` server: foreign `Host` is refused and every mutating request needs the per-session token (printed in the dashboard URL fragment).

### Fixed
- Source attestation is now by content hash. The Vite scan plugin records the sha256 of every traced source file (`sourceHashes`) and of each instrumented page (`renderedHashes`) in `scan-attestation.json`, and the instrumentation digest commits to the source hashes (a sidecar without them keeps the old name-only digest). At report time the hashes are recomputed; a finding whose source file changed or disappeared since the build becomes `traceConfidence: stale`, `traceReason: source-changed-since-build`, confidence `low`, with no preimage so no fix can be applied against it. A sidecar whose persisted digest the manifest no longer reproduces is rejected as `ATTESTATION_SIDECAR_STALE` instead of being accepted as `recomputed`.
- **Breaking (reason names):** attestation/capability reasons are one enum (`ATTESTATION_REASONS`); `BUILD_REVISION_MISSING`, `INSTRUMENTATION_DIGEST_MISSING` and `DEPLOYMENT_URL_MISSING` are now `MISSING_BUILD_REVISION`, `MISSING_INSTRUMENTATION_DIGEST` and `MISSING_DEPLOYMENT_URL` (`LOCAL_ROOT_MISSING` joins the enum), and a test fails when code emits a reason that is not in it. Anything matching the old strings in `fix`/`scan` output must switch.
- A re-traced finding no longer keeps a legacy `high` or the preimage of its old line (the traced confidence and preimage replace them), page-level anchors are picked by exact rule id instead of substring, and the source preimage refuses symlinked paths that leave the project.
- A build revision is no longer `:dirty` because of untracked files (such as `dist/`), attestation meta tags are written to and read from the real document head only (a `</head>` in a comment or script, or a meta in the body, no longer breaks or duplicates them), and a scanned URL with a long query string stays inside the deployment scope (query and hash are ignored).

- A scan no longer leaves Chromium running when the browser does not close within 10 s (the browser children of the process are killed), and a context is no longer left open when its page cannot be created.

### Added
- `qa-report.html` and `qa-report.json` are written with every scan and with `--report-only` (in the reports dir): an overall PASS / FAIL / INCOMPLETE with reason, target, profile, engines and pages scanned vs requested; per-page actual / threshold tables for the accessibility gate, HTML validity, performance, best practices and SEO (advisory); confirmed findings by WCAG level from the rule metadata; top issues by rule with confirmed / likely / needs-review counts and traced `file:line`; platform-owned and third-party issues in their own group; the fixed / remaining / new baseline section when a comparison exists; and a "Limits of automated testing" block ("automated N of M passed, manual review K items", standing manual checks). The page has landmarks, table captions, no script (CSP `script-src 'none'`), print styles and never says "compliant". Missing gate, ownership or comparison data is skipped, not an error.
- Findings now carry `ownership` (`source` | `platform` | `third-party`): elements that are, or (found by the axe scan, which records `closest()` at scan time) sit under, a `data-react-component` / `component_data` widget or the chat widget, or are a bare `{{component:..}}` / `{{snippet:..}}` tag, are `platform`; axe nodes inside a cross-origin iframe are `third-party`. A source wrapper that merely contains a placeholder, and an iframe's own tag (for example a missing `title`), stay `source` and traceable. Descendants found by other layers are only classified when their selector names the widget. They trace as `untraceable` with reason `platform-owned`, are skipped by the fix engine and listed in their own HTML report section, and `summary.ownershipCounts` splits them out. **Decision:** they still count in the totals and the quality gate (a user hits those defects whoever owns the code); only the existing third-party scan flags remove them from a scan. Locked pages are not detected: neither the Paradox export nor the DOM carries a lock signal (callers can pass `platformOwned`).
- A scan of a preview URL with local source now compares the local build export (`dist/paradox-export.json`) with the pushed export (newest `JSON_for_pushed_data/*.json`) by sha256 of whitespace-normalized content, records it in `runMetadata.sourceDrift` and warns `local source differs from pushed version for <snippet>`. Reads `<outDir>/paradox-export.json`, falling back to `dist/` (where the export plugin writes). Never fatal; skipped when either file is missing.
- `--sarif [file]` also writes a SARIF 2.1.0 export (default `<out-dir>/scan.sarif`; works with `--report-only`): rules with WCAG tags and default level, one result per finding with level from severity and verdict (needs-review note, likely warning, confirmed serious/critical error), the traced source file and line (relative to the source root) or else the page URL plus the element selector, `stableId` as a partial fingerprint, and verdict/confidence/ownership as properties. `docs/schema/scan-report-v2.schema.json` publishes the ScanReportV2 shape; a test validates real reports against it.
- axe `incomplete` results (rules axe could not decide) are now reported as `needs-review` findings tagged `axe-incomplete` in the evidence tags, at most 10 per page, and never count toward the gate or `--fail-on-violations`.
- Every Lighthouse run's scores per form factor are recorded in `latest.json` (`lighthouseScores.<page>.runSummary`: `runs`, `median`, `spread`) and shown in the HTML report next to the median, with a variance note when the spread exceeds 5.
- A local-URL scan no longer fails when the instrumented build cannot run (no `package.json` with a build script, failing build, timeout): it warns `source tracing unavailable: <reason>`, scans the running URL untraced, marks findings' source `unavailable` and records `runMetadata.sourceTracing`. New `--require-trace` makes that case exit 2.
- A page found only by `--crawl` that answers 404/410 is no longer a failed page (which forced exit 2): it is dropped from the scan list and recorded as a confirmed `broken-link` finding (moderate, links layer) on each referring page, with the status and referrer. Discovery metadata lists them as `brokenLinks` (`route`, `status`, `referrers`). Explicit (`--page`, config) and sitemap-listed pages that 404 still fail the scan unless `allowStatus`; a crawled page failing for another reason (5xx, timeout) stays failed.
- Per-page phase timings: the console prints `[page] phases: navigate 12.3s, axe 18.0s, ...` (read-only layers overlap, so the phases do not sum to the page time), `runMetadata.scan.pages[].phases` records them in ms, and accessScan reports `accessScan.activate` / `.snapshot` / `.rules` separately. The console also says how many findings were left unverified (`verify.maxPerPage`, `verify.timeoutMs` unchanged).
- Evidence screenshots are captured only for findings that survive re-verification (flaky findings cost no screenshot), the per-page budget goes to the most severe first, and when the scan finishes any PNG in `evidence/` that the report does not reference is deleted (the count is logged).
- Calibrated offline HTML validity (`docs/html-validate-rules.md`): only what the W3C Nu validator reports as an error is a serious, confirmed `w3c.errors` finding. Conventions and Nu warnings (`script-type`, `prefer-native-element`, `void-style`...) are minor `likely` findings counted in `w3c.warnings` only; style rules and rules axe already covers (`no-implicit-button-type`, `unique-landmark`, `wcag/h37`...) are off. `valid-id` now follows the HTML standard (ids starting with a digit or containing punctuation are valid), so GUID-prefixed Paradox ids no longer fail.
- A layer that times out or fails transiently (closed target/context, `net::ERR_*`) is retried once in a fresh context before the page is marked partial; deterministic errors are not retried. Retries appear as `layerRetries` (`layer`, `attempts`, `reason`) per page in `runMetadata.scan.pages`. axe now has `axe.timeoutMs` (default 60000) and reports a timeout explicitly.
- `--crawl` groups URLs into route templates (`/:slug/job/:id`, `/page/:id`, ...) and keeps `--crawl-per-template` (default 2) sample pages each, preferring navigation links, so job and pagination routes no longer use up `--max-pages`. Discovery metadata records `templates`, `skippedDuplicates` and each page's `template`.
- Seeded-fault suite: every deterministic accessScan rule (40 of 40) has a minimal bad page it must flag and a clean twin it must stay silent on (`test/fixtures/rule-seeds/`, cited to the WCAG/ARIA text), run in one fast pass. `npm run seeds:report` writes per-rule TP/FP/FN to `docs/seeds-coverage.md` (a test fails when it is stale); failing seeds go in `KNOWN-GAPS.md`.
- Rule kinds and finding verdicts: every accessScan rule has a `kind` (`deterministic`, `heuristic`, `manual`) with a one-line rationale (see `docs/accessscan-rule-coverage.md`). Findings carry `kind` and `verdict` (`confirmed`, `likely`, `needs-review`; additive in the report) and `summary.verdictCounts`. The quality gate (`a11y.*`, `w3c.*`) and `--fail-on-violations` count only `confirmed` findings; `a11y.likely` / `a11y.needsReview` are shown as report-only metrics, the console prints "N confirmed, M likely, K need review", and the HTML report lists likely and needs-review findings under their own headings. The keyboard, focus-trap, aria-live, dynamic-content and screen-reader layers are classed heuristic, so they no longer fail the gate.
- `npm run docs:rules` generates `docs/accessscan-rule-coverage.md` from the accessScan registry; a test fails when it is stale or when rule counts in README/docs disagree with the registry. Stale layer/rule counts and layout references fixed.
- Re-verification against flaky findings: after the first pass, findings from timing/state-sensitive layers (keyboard, focusTrap, dynamicContent, ariaLive, links) and critical/serious axe / accessScan findings are re-checked in a fresh context (one extra context per page, at most `verify.maxPerPage` = 25 findings and `verify.timeoutMs` = 60000 per page). A finding that does not reproduce is flaky (stability 1/2): it is excluded from the report counts and the gate and listed in `runMetadata.scan.reverify` with the flake rate per rule. Opt out with `--no-reverify`. Adds roughly 5 s per page on the fixture site with every layer on.
- Offline HTML validity layer `htmlValidate` (on by default, nothing leaves the machine): html-validate over the rendered DOM, rule ids `html-validate:<rule>`, errors are serious and warnings minor, with the serialized-HTML line/column and the element selector. It feeds `thresholds.w3c.errors` / `warnings` and the scanner run names the engine (`html-validate`). Tune with `html.validate.rules` (`{ "void-style": "off" }`). With `--allow-external` both engines can run and duplicates are merged. New runtime dependency: `html-validate` 9.
- Evidence per finding: each confirmed or likely finding with a selector gets `evidence.capture` (in the finding's observations): the reason the rule fired, the WCAG Understanding link, a repro recipe (URL, viewport, selector, state), measured box, the computed styles the rule depends on, and role and accessible name from the AX tree. Confirmed critical/serious findings also get a screenshot crop (max 640x400, element outlined, form field values masked) at `<reports>/evidence/<stableId>.png`, limited by `evidence.screenshots {enabled, maxPerPage}` (default on, 20 per page; skipped shots record why; findings detected only at another viewport, such as mobile, record that viewport in the repro and skip measuring and screenshots with `viewport-mismatch`). The HTML report shows it under "Why flagged". Captured after the layers on the shared page, about 0.3 s per page on the fixture.
- Multi-page scans: bounded concurrency (`concurrency`, default 2) on one shared browser, one retry for transient navigation failures (timeout, 5xx, connection reset; never DNS or 4xx), `[3/13] /jobs ok (4.2s)` progress lines on stderr, per-page timing and retry counts in `runMetadata.scan`, and `--max-time <seconds>` which skips pages not started in time (incomplete, exit 2 unless `--allow-incomplete`).
- Quality gate: `thresholds.lighthouse.{mobile,desktop}.{performance,accessibility,bestPractices,seo}`, `thresholds.a11y`
  (counts per impact or `'report'`) and `thresholds.w3c` (`errors`, `warnings`). `--gate` exits 1 when a metric misses
  its target (exit 2 for an incomplete scan still wins; `--no-fail` silences it). The console, HTML and
  `runMetadata.thresholds` show `actual / target` per page and metric. Performance thresholds are advisory on a Vite dev
  server (detected by `/@vite/client`); `--perf-gate` enforces them anyway. The flat `thresholds.{wcag,performance,bestPractices}`
  keys still work (mapped, with a deprecation warning). Mobile performance default is now 80 (was 90).
- Noindex targets (robots meta or `X-Robots-Tag` noindex, e.g. preview sites): Lighthouse SEO thresholds are advisory with the
  reason `target is noindex (preview)`, their SEO findings are info only, and `--seo-gate` enforces them anyway.
- Local Lighthouse runs both form factors per page, one at a time across pages. `lighthouse.runs` / `--lighthouse-runs N`
  (default 1) reports the median score and keeps every run; `lighthouse.timeoutMs` (default 120000) bounds each run
  (layer status `timeout`). Each result carries provenance (source, version, form factor, runs, `comparableToPsi`).
  If one form factor fails the page is `partial`, not a crash. Lighthouse accessibility findings now carry mapped
  impact and WCAG criteria (unmapped audit ids stay `moderate`, flagged `unmapped`) and are tagged `layer: lighthouse`.

### Changed
- **Breaking:** calls to third-party services are now off by default. The W3C Nu validator and Google PageSpeed
  Insights run only with `--allow-external` or `external: { w3c: true, psi: true }` in `.scan-config.json`
  (`--psi` / `--no-psi` still toggle PSI; the old `usePSI` key is ignored). The first call prints which service
  receives what. Private/loopback hosts are never sent. Without opt-in the `w3c` layer is `skipped`
  (`external-disabled`), the report says no validity engine ran, and this does not make the scan incomplete (no exit 2).
  `external.w3cEndpoint` points at a self-hosted validator. Lighthouse uses the local package unless PSI is enabled.

### Fixed

- Remote scans without a source project no longer print a guessed `src/pages/<x>.liquid (page-level trace)`; the console says
  `Source: unavailable (no source project)` and findings carry method `no-source-project`.
- Scanner layers: focus-trap tests every detected trigger (clicking the right element) and its Escape check works for `position:fixed` dialogs; keyboard layer compares focus styles with the unfocused element (a static border is no indicator), judges focus order by DOM order, and reports focus-indicator contrast as WCAG 1.4.11 against the real background; screen-reader layer reads Chromium's accessibility tree (hidden headings are not counted) and no longer flags off-screen skip links, `display:none` SVGs, layout tables or `th` without `scope`; links layer caps requests per host, follows at most 5 redirects, skips same-page anchors and never lets a public page probe private/loopback addresses. The `table-th-no-scope` rule is removed.
- Each page is navigated once: read-only layers (axe, links, w3c, screen reader, aria-live) share it and run concurrently, a failing layer no longer loses its siblings, and only interacting layers (accessScan, keyboard, focus trap, dynamic content) run afterwards, the latter in fresh contexts. `--no-hydrate-jobs` route blocking and runtime hooks now apply to every layer context.
- accessScan scales linearly: per-snapshot label/heading indexes replace per-input rescans (36k elements: rules 29.6s with a 40s run before the geometry/link fixes, 2.0s after), a cooperative deadline in the evaluator and signal loops makes the rule timeout actually fire (status `timeout`, run continues; a cancelled scan starts no further evaluators), and iframes under different parents no longer share a `framePath` (frame index is document order within the owning frame).
- accessScan accessible names (standards profile) come from the browser's accessibility tree (CDP, accname 1.2) instead of the in-page approximation: `<button><img alt>` and svg `<title>` links are named, `display:none` text is excluded, button-type inputs use `value`, text inputs/plain divs do not. The commercial-parity profile keeps the legacy computation; if CDP is unavailable the legacy name is used and an `accname-cdp-unavailable` diagnostic is recorded.
- accessScan rule correctness: new `FormFieldDiscernible` (text input/select/textarea need an accessible name; placeholder is not a label, standards profile; 84 active rules); `LinkAnchorDiscernible` now covers every `<a href>` in the standards profile; `TargetSize` also checks undersized targets against full-size neighbours and drops dead logic; `DraggingAlternative` ignores the slider as its own container and matches whole words; `ListEmpty` counts `role=listitem` and skips `role=none`; `IframeDiscernible` accepts `aria-label(ledby)`; `MenuTriggerClickable` ignores `aria-haspopup="false"` and focusable hosts; `ImageDiscernible` accepts `aria-label` and `role=none`; `MetaRefresh` ignores immediate `0;url` redirects; viewport meta is matched case-insensitively.
- Report integrity: merged observations of one finding now add up per layer (three identical-locator `<img>` findings count 3, not the maximum) while the same element seen by several layers stays one issue; the finding fingerprint keeps the element selector (plus frame/shadow path) when file, line and preimage coincide, so distinct elements are no longer collapsed; `info` findings are excluded from occurrence totals (`summary.infoCount` reports them) and the v1 projection and legacy summary share one builder; v2 findings keep `sourceCandidates` (also in the v1 projection); the console file label uses the weakest source confidence. `latest.json`, the baseline and `fix --report` are validated on load: corrupt, tampered or unsupported files are rejected with a message naming the file (the baseline is ignored with a warning; `fix` and `--report-only` stop), never used silently. Reports written by earlier builds fail the fingerprint check; re-run the scan. The HTML report no longer imports Google Fonts.
- HTML reports (`scan-visual.html`, ROI documents) escape every interpolated value through one shared `escapeHtml` (now also `'` and backtick), no longer use inline `on*=` handlers carrying data, encode rule ids in links, and no longer double-escape scanner evidence; the unused `html-report.js` is removed.
- Reports no longer claim "Compliant" / "Great job" or hard-coded automation percentages: a clean result reads "No automated issues found" with a standing note that automated scans cover only part of WCAG and manual review is still required.
- Build and dev-server children run in their own process group and are killed as a group on timeout, SIGINT/SIGTERM
  and exit (no orphaned grandchildren); the instrumented build is async and enforces `buildTimeoutMs` with a group
  kill; `startDevServer` times out with a clear error (`devServerTimeoutMs`); a second signal force-kills.
- Tracing, the build manifest and the Vite plugin honor `outDir` and `source` through one `resolveProject()`
  instead of a hard-coded `dist/`; `/jobs/` now maps to `src/pages/jobs.liquid`.
- The Vite plugin reads `outDir` from the resolved Vite config, writes the manifest atomically in a
  post-order `closeBundle`, and writes nothing when the build failed.
- `ada-scan init` no longer inserts its import inside a multi-line import, targets the top-level
  `plugins` array (not `css.postcss.plugins`), and supports `--dry-run` (prints the diff, writes nothing).
- CIS telemetry NDJSON is now capped (256 KiB, one rotated `.1` generation) and a corrupt line no longer fails the call-budget gate.
- Removed dead code: `utils/logger.js`, `gitDiffFiles`, `hasUncommittedChanges`, `evaluateAdvisoryBudgets`, `effectiveUnitById`, tab-graph `getDirectChildren`.

### Added
- `ScanReportV2` schema 2.0.0 stays backward compatible (additive only): each finding has `stableId`, identical across runs for the same rule + route (query kept) + element locator and independent of source line, preimage, HTML text and generation time; optional `sourceCandidates` on findings and optional `summary.infoCount`. Reports without these fields still validate.

### Changed (breaking)
- Config and arguments fail closed. An unparsable or invalid `.scan-config.json` (wrong types, bad
  `thresholds`/`layers`/`pages`, duplicate page names) exits 2 instead of silently using defaults; the
  Vite plugin warns and fails the build. Argv is parsed strictly: `--help`/`-h` (no scan), `--flag=value`,
  and exit 2 for unknown flags, missing values, unknown `--layers` names and conflicting flags
  (`--include-third-party`/`--exclude-third-party`, `--psi`/`--no-psi`, `--url`/`--all` with `--page`).
- `--page` naming an unconfigured page is an error unless `--ad-hoc` is passed.
- `thirdParty: []`, `null`, `false` or `{ "preset": "none" }` now disable the Paradox preset; unset keeps
  today's Paradox defaults (`preset: "auto"`).
- Incomplete scans no longer look green. Each page has a `status` (`ok`/`partial`/`failed`) and the
  summary exposes `pagesFailed`, `pagesPartial`, `scannerErrors` and Lighthouse run statuses. A failed
  navigation (DNS/connect/timeout), an HTTP status >= 400 (unless the page lists it in `allowStatus`,
  e.g. `pages[].allowStatus: [404]`) or a bot/WAF challenge page makes the page `failed` and it is not
  scanned. Scanner runs can now be `timeout`. W3C `non-document-error` (or an unreadable validator
  answer) marks the w3c layer `error`, never "validation passed".
- Exit code `2` means an incomplete scan and wins over `1`. `--no-fail` no longer suppresses it; the new
  `--allow-incomplete` does (and the report records that). Console and HTML reports show an
  "incomplete scan" banner and drop the "Compliant" / "All clear" text for such runs.
- `--fix` now defaults to the trusted `cis` mode. The direct-write `claude` / `codex`
  fixers require `--legacy-fix` (prints a deprecation banner); unknown `--fix-mode`
  values are an error. Scaffolded `scan:fix:codex` / `scan:fix:claude` scripts pass it.
- `--dry-run` is refused with the legacy fixer (its rules write files).
- Removed the git-stash rollback of the legacy fixer; it stashed user work without restoring it.
- The legacy fixer UI server binds to 127.0.0.1 only and no longer sends CORS `*`.

### Fixed
- Scan loss: one failing test/trigger no longer drops a layer's other results (aria-live SVG `className`, dynamic-content and focus-trap interactions are isolated and click-bounded to 3s); `getBrowser()` is race-free and relaunches after a crash; w3c/page contexts are always closed; navigation waits for `load` plus a bounded 5s idle wait (no 60s+60s retry) and contexts default to a 5s action timeout and `ignoreHTTPSErrors`.
- Link checker retries HEAD 403/405/501 with a 1-byte GET before reporting a link dead.
- Invalid findings (bad impact, unsafe or unhashed source) are downgraded with a `validation` entry in `report.warnings` instead of aborting the whole report; keyboard/screen-reader source traces use the report source shape.
- `resolveFromElementText` no longer throws on long text with regex metacharacters; tracer reads are confined to the project root.
- `latest.json`/history/baseline are written atomically and history directories are unique per run (millisecond timestamp + counter).
- accessScan `bottomAnchoredFootersScanned` metric exists and headers/footers are counted separately; `redactSensitiveHtml` no longer corrupts snippets when the sensitive value is empty; HTML report no longer crashes on elements without `outerHTML`.

### Added
- Page discovery: without `--page`/config pages the scan now resolves pages from a sitemap
  (`--sitemap <url|file>`, or `/sitemap.xml` for `--url`), a bounded same-origin crawl (`--crawl`,
  `--max-pages`, default 50), the local build output, or `src/pages/*.liquid` (honouring `excludedPages`).
  Failed sitemap fetches are reported as warnings; each page's source is logged and recorded in `runMetadata.discovery`.
  `--url` stays a single-page scan unless `--sitemap`/`--crawl` is given; capped, sitemap and crawl
  runs count as partial so `--fix` does not prune patches of pages that were not scanned.
- Routes are normalized (hash dropped, trailing slash and `index.html` folded, locale prefixes untouched); the query is kept,
  so the same path with different queries is scanned as distinct pages instead of crashing with duplicate scanner run IDs.
  The deployment scope check now accepts scanned URLs with a query or hash (credentials and other origins are still rejected).
  Pages one source lists but another lacks (sitemap, build output, Liquid pages) are reported as discovery warnings in the console and `runMetadata.discovery.warnings`.

### Changed
- Corpus tooling: extra reviewed oracle/staging host suffixes now come from the gitignored `source-manifest.local.json` (`reviewedHostSuffixes`); customer names and hosts removed from tracked code, tests and docs. Loopback detection in evidence-URL neutralization uses the shared host classifier (whole 127.0.0.0/8 now maps to the neutral asset).
- PageSpeed Insights API key is sent in the `X-Goog-Api-Key` header instead of the `?key=` query string; PSI error text is redacted.
- Corpus: `pseudonymizeHumanText` is idempotent (re-seeding no longer re-hashes neutral placeholders);
  site-124/203/731 fixtures refreshed with `seed.js --reprocess-committed` (stale `checkId`/`violationType`), so `corpus:verify` is green again.
- Tests are hermetic: `ADA_SCAN_NO_DOTENV=1` skips `.env` loading, and `npm test`
  clears `ADA_SCAN_*`/`CIS_*`/`SCAN_MODE` and pins `ADA_SCAN_ROOT`.
- CI workflows now live in this repo (`test`, corpus verify, drift), non-blocking.
- Package marked `private`; removed the broken `scripts/review-smoke.mjs`.
- Reports, ROI docs, history, baseline and visual HTML now default to
  `<project>/.ada-scan/` instead of the tracked `scan-reports/`. Add `--out-dir`
  or config `reportsDir` to override. A legacy `scan-reports/baseline.json` or
  `latest.json` is still read when the new location has none (with a notice).
  Add `.ada-scan/` to your `.gitignore`.
- Corpus tooling: the committed `scripts/accessscan-corpus/source-manifest.json` now
  carries opaque ids and placeholder hosts (`site-NNN.preview.sites.stg.paradox.ai`)
  that do not resolve. Drift, seed and live capture need the real `label`/`sourceUrl`
  from the gitignored `scripts/accessscan-corpus/source-manifest.local.json`; extra
  redaction tokens come from the optional gitignored `redaction-tokens.local.json`
  (or `ADA_CORPUS_REDACTION_TOKENS`). Copy the `*.local.example.json` templates next
  to them to get started. Without the local files, offline tests still pass.

### Fixed (config/CLI)
- `--changed-only` maps changed `src/pages` files (tracked and untracked, relative to the project root) to
  pages; a shared template selects all pages instead of every `.liquid` change doing so.
- Page `name` defaults from the path (no more `[undefined]`); remote URL scans are named after the host.
- `createViolation` coerces an unknown `impact` to `moderate`. Config is read once per run.

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
