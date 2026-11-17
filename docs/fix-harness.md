# Fix harness: fix after the scan, accept only what is proven

Phase 5 is "fix with CIS after the scan". The harness is the part that makes that safe. It is **fixer-agnostic**: a Fixer adapter
produces a candidate change set, and the harness alone decides accept or rollback, using hard gates and measured evidence.

Goal of a run: the site ends with no remaining fixable defects, performance is not worse (optionally better), and nothing else
breaks (layout, visuals, behaviour, data tags, build, Paradox export).

The foundation modules and the runner live in `src/fix/harness/`. `ada-scan fix --harness` runs the whole pipeline (section 11).
CIS output is untrusted advisory text (`docs/cis-contract.md`); it only ever enters through the strict allowlist parser.

## 1. Principles

1. **Fail closed.** Missing evidence, a truncated snapshot, a missing cell, an unreadable screenshot: the gate fails.
2. **Measure, never trust the fixer.** The fixer's own description of the change is not evidence.
3. **Compare to a baseline taken on the same shadow copy, before any change**, with the same tooling, so environment noise cancels.
4. **Everything is atomic.** A failed gate rolls the whole candidate back (`src/fix/apply` transaction and rollback). No partial accept.
5. **No silent loops.** At most K repair iterations; each iteration records the failed-gate evidence it was given.
6. **Design is locked** unless a human decides otherwise: colour, tokens, opacity and background images never change automatically.

## 2. Pipeline

```
scan (ada-scan report)
  -> tasks            one FixTask per root cause: target finding ids, routes, allowlist (files + line ranges), expected additions
  -> fixer            adapter returns a candidate (edits against the allowlist)
  -> candidate        validated by src/fix/candidate (hashes, preimages, size limits)
  -> shadow workspace copy of the project + candidate applied; build; static server on 127.0.0.1
  -> baseline         captured once on the untouched shadow copy (section 3); after each accepted task its own snapshot becomes the baseline
  -> gates G1..G8     evidence compared to the baseline (section 4)
  -> decision         auto_accept | human_review | rollback (+ repair iteration) (section 5)
  -> apply            accepted candidates stay in the shadow; at the end ONE transaction applies the squashed change to the real tree (not in dry run)
  -> rescan           rescan of the accepted shadow state with the real scanner; before/after scan delta
  -> report           remaining-report (section 7), gate tables, before/after screenshots, diffs, perf delta
```

Tasks run one at a time on a rolling baseline: the snapshot, scan and tree of an accepted candidate become the baseline of the next task (no re-capture
is needed, they were measured on exactly that state), so G1..G8 always compare one change against the state it was applied to. Batching several mechanically-safe candidates is allowed only after each passed alone.

## 3. Baseline capture (before any change, on the shadow copy)

`captureSnapshot({ baseUrl, routes, dir, viewports, perfRuns, ... })` in `snapshot.js` returns a versioned (`version: 1`),
JSON-serialisable object and writes full-page screenshots into `dir`. Routes are processed sorted; viewports in declared order; keys
inside a cell are in document order. A global `timeBudgetMs` (default 180 s; the harness passes it from the config key `snapshotBudgetMs`, see section 11) ends the capture with `truncated: true`; every gate then fails closed. A truncated baseline stops the run before any task: it is an environment problem (a loaded machine, a budget too small for routes x viewports), so no task is tried or rolled back and each is skipped with the class `baseline_incomplete`; raise `snapshotBudgetMs` and run again.
Each cell has a per-page timeout (30 s). A cell that cannot be captured is stored as `{ error }` and fails every gate that needs it.

Per route and per viewport (375x812, 768x1024, 1280x800, 1440x900) a cell holds:

| Field | Content |
| --- | --- |
| `screenshot` | full-page PNG (height capped at 16000 px), CSS scale, animations frozen (`FREEZE_MOTION_CSS`, `settleMotion`, reduced-motion emulation, light scheme), lazy content triggered by scrolling, images and `document.fonts.ready` awaited (2.5 s caps), caret hidden |
| `layout` | `{ key: { x, y, w, h, hid } }` for every visible element (document coordinates, 0.1 px). `hid` = visually hidden at rest (<= 1x1 px, off-screen to the left/top, opacity 0, `clip: rect(0,0,0,0)`, `clip-path: inset(50%)`) |
| `styles` | `{ key: { prop: value } }` for the tracked property set `STYLE_PROPS` (display, position, visibility, opacity, z-index, overflow, transform, margins, paddings, color, background colour/image, box and text shadow, border widths/style/colour/radii, font family/size/weight/style, line-height, letter-spacing, text-align/transform/decoration, flex and grid alignment). `width`/`height` are not tracked here (G3 covers geometry) |
| `domHash` | FNV-1a of tag names plus sorted attribute names of the whole document (evidence only; attribute VALUES are excluded so an `aria-label` value change is not a structure change) |
| `a11yTree` | Playwright `ariaSnapshot()` lines of `body` (evidence for the reviewer and for the a11y delta; not a gate input) |
| `tabOrder` | keys of the focus sequence from `Tab` presses (max 60 stops, stops at the first repeat) |
| `interactions` | smoke for up to 12 visible controls outside forms (`button`, `summary`, `[role=tab]`, `[role=button]`, `[aria-controls]`, not `type=submit`): click, count visible elements (`delta`), click again (`restored`), `nav` if the URL changed |
| `console`, `failedRequests` | sorted console errors, page errors, failed requests and HTTP >= 400, with the origin stripped |
| `links` | sorted normalised `href`s (same-document fragments stored as `#frag`; same-origin as path+query+hash) |
| `transfer` | sum of response header + body bytes |

Stable selector key: the path from `html` of `tag#id` (id unique and without a 4+ digit run) or `tag:nth(n)`, where `n` counts earlier siblings
with the **same tag and the same `class` attribute**. Inserting a differently classed sibling (a skip link) does not renumber the others.
Limitation: adding or removing a class re-keys that element; it then appears as removed plus added and must be covered by `targets`/`documented`.
`resolveKeys({ baseUrl, route, selectors })` maps a scan finding's CSS selector to snapshot keys.

Performance block `perf[route].runs[]` (`perfRuns` default 3 runs per route, fresh browser context each): `{ score, lcp, fcp, cls, tbt, si, transfer }`.
The built-in runner (`measurePerfOnce`) measures FCP, LCP, CLS, TBT (long tasks after FCP) and transfer without throttling; `score` and `si` are `null`.
The Lighthouse runner (median of 3: score, LCP, CLS, TBT, FCP, SI, transfer) is injected as `perfRunner(browser, url)`; it must return the same shape.
The scan findings (axe/ada-scan stable ids, with `rootCauseKey` and `tier`) come from the normal scan of the shadow site, not from the snapshot.

### Speed: where the time goes and what is shared

A run is dominated by three things, in this order: snapshot cells (route x viewport: scroll, screenshot, up to 60 Tab presses, up to 12 interaction probes),
perf runs (`perfRuns` per route, per capture; the built-in runner unless a Lighthouse `perfRunner` is injected) and the per-route `ada-scan` rescans (one process and one browser each). Builds are the fourth. The run reports
the split in `harness-report.json` as `timings` (`totalMs`, `buildMs`, `siteStartMs`, `snapshotCellsMs`, `perfMs`, `scanMs`, `htmlMs`, `factsMs`) and `counts`
(`snapshotCells`, `snapshotCellsReused`, `scanRoutes`, `scanRoutesReused`, `perfRoutes`, `candidates`, `candidatesAllRoutes`).

- **One dev server per run.** The site is started once and serves every gate; there is no restart per task. For the `vite` adapter the server reads the shadow sources on
  every request, so after a rollback the harness skips the rebuild and serves the restored sources (a static site serves `outDir`, so it still rebuilds after a rollback). This
  relies on the dev server re-reading templates on every request; no test runs the harness with the `vite` adapter and counts builds after a rollback, so treat it as unproven
  on a project whose own server caches templates. Each candidate still builds once, because G8 judges that build.
- **Incremental rescan** (`incremental.js`, `harness.incrementalRoutes`, default true). After a candidate is applied and built, the served HTML of every route is fetched
  (the same fetch html-validate needs) and hashed. A candidate that touched only templates (`.liquid`, `.html`) is captured, scanned and perf-timed on its **affected
  routes**: the routes whose served HTML changed, the routes of the task, and the routes the report's `source.routeDependencies` lists for a touched file. Every other route keeps
  the cells, PNGs, perf runs and scan rows of the accepted state, so those routes compare equal to themselves and no gate is skipped. A stylesheet, a script, a data file, a missing
  hash or `incrementalRoutes: false` means **every route**, exactly as before. The final rescan covers the union of the routes any accepted candidate changed; the rest keeps its baseline rows.
  `harness-report.json` records `routesChecked` and `routesReused` per iteration and the scan files record `reusedRoutes`.
- **Parallel capture** within a budget. `harness.snapshotConcurrency` (default 3) runs snapshot cells at the same time, each in its own browser context; the stored snapshot does not depend on it
  (cells are stored by route and viewport). Perf runs stay serial and run after the cells, because they measure timing. `harness.scanConcurrency` (default 2) runs per-route `ada-scan`
  processes at the same time; findings come back in route order. On a loaded machine lower both (1 is the old behaviour); `snapshotBudgetMs` still bounds one capture.
- **No write-through of tool caches.** `shareNodeModules` now creates a real `node_modules` folder in the shadow whose entries link to the project's packages, leaving out every
  dot entry except `.bin` and `.pnpm` (`.vite`, `.vite-temp`, `.cache`); the Vite dev server also gets `cacheDir` inside the shadow (`.ada-scan/vite-cache`), and Vite writes its bundled
  config temp file into the shadow's own `node_modules/.vite-temp`. None of them writes into the original project's `node_modules`. (A package folder is still shared, so an install
  that writes into an existing package still writes through; keep `verifyInstallCommand` for that.)
- A recapture after a sparse G4 or G6 failure keeps the perf runs of the first capture of that candidate (a capture without perf runs would fail G7 as `PERF_MISSING`).

## 4. Gates

`runGates({ before, after, beforeTree, afterTree, allowlist, designLock, targets, documented, findings, build, perf, only, compare })`.
Every gate returns `{ gate, pass, evidence[], regions[] }`; evidence is capped at 50 entries; `regions` are bounding boxes for the workbench overlay.
`targets` are snapshot keys of the elements the fix is meant to change; `documented` are keys the task says will change or be added
(for example an added skip link). Both include all descendants. Defaults live in `compare.js` `DEFAULTS`.

| Gate | Pass criteria (all must hold) | Thresholds |
| --- | --- | --- |
| **G1 targeted** | every target finding id is gone on the affected routes; no remaining finding shares a root-cause key with a target; no NEW finding of tier `confirmed` or `needs-review` (new = id absent AND root-cause key absent in the baseline). An empty target list never passes | tiers gated: confirmed, needs-review |
| **G2 scope** | every changed file is in the allowlist; every hunk lies inside an allowlisted line range (before-tree line numbers; no range = whole file; creating or deleting a file needs a whole-file entry); no change under `dist/` or `build/`, no `paradox-export*.json`, no `JSON_for_*/`; changed `.json` still parses; the multiset of `{{data:..}}`, `{{component:..}}`, `{{snippet:..}}`, `{{attribute:..}}` tags and `data-pdk-*` attributes is identical before and after (an edit counts as remove + add); with `designLock` (default on) the multiset of colour/background/border/opacity/shadow/custom-property declarations and Tailwind colour utilities is identical | line diff exact (LCS, prefix/suffix trimmed; middles over 2000x2000 lines become one hunk and fail closed) |
| **G3 layout** | for each baseline cell: every visible element keeps x, y, width, height within tolerance; none removed; every added element is visually hidden at rest; document height unchanged; exempt only `targets`/`documented` (and descendants) | tolerance 1 px |
| **G4 visual** | per viewport, pixels differing outside allowed regions stay under the limit. Allowed regions: the boxes of target/documented elements in the before and the after layout, grown 2 px. Added sr-only/focus-only elements are not visible at rest, so they need no region | channel delta > 8 counts as different; limit = max(25 px, 0.02 percent of the page area); area present in only one image counts as different |
| **G5 style** | for every non-target element present before and after, every tracked property is identical | exact string match |
| **G6 behaviour** | no new console error or failed request (multiset); no removed or changed link, no added link except `#fragment` or an explicitly allowed href; tab order: the baseline sequence is a subsequence of the new one and every added stop is a target/documented key; interaction smoke (`delta`, `restored`, `nav`) unchanged for every baseline control | multiset exact |
| **G7 performance** | per route, medians of the after runs vs medians of the baseline runs. Noise margin per metric = max(floor, max - min of the BASELINE runs). Fail if score drops by more than its margin, or LCP, FCP, SI, TBT, CLS grow by more than their margin, or transfer grows by more than 2 percent. Missing runs fail | floors: score 3, LCP 200 ms, FCP 150 ms, SI 300 ms, TBT 50 ms, CLS 0.01; transfer 2 percent |
| **G8 build and validity** | the project build succeeds (exit 0) on the candidate; html-validate error count not higher than the baseline; Paradox export plugin output (`dist/paradox-export.json` structure) validates; the formatter (prettier with the project config) is clean on the touched files. Each fact must be supplied; a missing fact fails | counts, no margin |

Notes:

- G4 and G3 treat a documented height change as a failure of G4 for everything below it. Such candidates cannot auto-accept and go to review with the evidence.
- G5 exists because a visual diff misses hover/focus/hidden-state styles. G3 + G4 + G5 together cover geometry, pixels and cascade.
- G6 interaction smoke is a smoke test, not a proof of behaviour. Candidates that touch scripts or add interactive roles also go to review (risk score, section 5).
- G7 is evaluated on the desktop viewport route list given to `perfRoutes`. Local measurement has no CPU throttling; the margin from the 3 baseline runs is the only noise model. A baseline spread above 3x the floor is a planned `noisy` flag (not implemented in the foundation): such a task should go to review, not auto-accept.

## 5. Accept policy

```
any gate failed                     -> rollback atomically, record reason + failed-gate evidence
                                       retry (repair) at most K times (default 2, `--max-repairs`), then final
all gates passed:
   mechanically-safe recipe         -> auto_accept
   changed lines < N (10) and risk <= 0.3 -> auto_accept
   otherwise                        -> human_review (workbench) with evidence
```

`decideAcceptance` implements this. `riskScore` = min(1, lines / 50) + 0.3 if a `.js` file is touched + 0.2 if a `.css` file is touched
+ 0.2 if more than one file + 0.2 if the file is under `partials/` or `layouts/`, capped at 1.

Repair iterations (at most `maxRepairs` after the first try, so 1 + K candidates per task): the fixer receives the task, the previous candidate and the failed-gate evidence (gate id, offending keys, before/after values,
pixel regions). Every iteration is written to the run log with its candidate hash and its gate table. After K iterations the task is closed as
`fixer_could_not_produce_safe_change` or `gate_failed` (section 7). Human review evidence: before/after screenshots per viewport with the diff overlay,
the unified diff, the scan delta, the gate table and the perf table. Approval applies through the same transaction; a human cannot waive G2
(scope and tags) or G8 (build).

## 6. Fixer adapters

```js
// Fixer: pure producer of a candidate. It never writes to the real tree or to the shadow.
fixer = {
  name: 'cis' | 'external-tool' | 'recipes',
  mechanicallySafe: boolean,   // true only for deterministic recipes with a proven transformation (decides auto_accept)
  async propose(task, context) -> { files: [{ path, before, after }], rationale? } | { declined: reason }
}
// context: { workspace, iteration, previous: { files, rationale } | null, gateEvidence: [{ gate, evidence }] | null, read(path) }
// task: { id, ids[], rule, routes[], occurrences[{route, selector, stableId}], source: { file, line }, allowlist: [{ file, startLine?, endLine? }],
//         documented: keys[], proposedChange?, fix?, ... }   (normalised from buildTaskSet tasks; allowlist defaults to source.line +- 3 lines)
```

`before` must be the exact current shadow text (`context.read(path)`); `after` is the whole new file. The harness turns each file into edit intents bound to preimage hashes
(`change.js`), so the existing candidate, transaction and rollback code is reused unchanged. Limits of that path: files must already exist (no new files), be LF text of at most
64 KB with an extension in `.css .html .js .liquid` (no `.liquid.json` sidecars), and lines in an edited block must not carry trailing whitespace. A fixer throwing, returning
`declined`, or returning no files closes the task as `declined` (no repair loop for those).

| Adapter | How it produces edits | What it may touch |
| --- | --- | --- |
| **CIS** | advisory text parsed by the strict allowlist parser (`src/fix/cis`) into edit intents bound to preimage hashes | only the allowlisted files and line ranges of the task; no new files; no `.js`/`.css` unless the task allows it |
| **External tool** (Cursor, Claude Code, any agent) | harness hands the tool a scratch worktree (a copy of the shadow tree) and the task prompt; after the tool exits the harness computes the working-tree diff and converts it into edit intents. Anything outside the allowlist is not rejected one by one: G2 fails the whole candidate | same as CIS, enforced by G2 on the diff, not by the tool's cooperation; the tool gets no network from the harness and no real tree |
| **Deterministic recipe** | code transformation (html-has-lang, document-title, `rel` on `_blank`, decorative `alt=""`, viewport, `aria-label` from visible text or title, `aria-expanded`, nav label, skip link, duplicate ids in loops, autocomplete; `width`/`height` on images with known size is planned) | exactly the lines of its finding; marked `mechanicallySafe` only after the recipe passes the benchmark corpus with zero break rate |

Implemented adapters live in `src/fix/harness/fixers/` and share one call shape: `fixer.propose(task, context)` returns `{ files: [{ path, before, after }], rationale, confidence }`
or `{ declined: reason }`; `task` is an export task (`src/fix/export/tasks.js`) plus the harness `allowlist`; `context` is `{ files, readonly, siteLang, previous, gateEvidence }`
(`readTaskContext(root, task)` fills `files` through the secure path resolver). `createRecipesFixer()`, `createCisFixer({ transport, model })` (mock-server tested; the repair prompt
carries path-free failed-gate evidence) and `createExternalFixer({ diff | diffFile | dir, baseDir })` (unified diff, git working tree, or two trees; fails closed on anything outside the allowlist).

All three produce the same candidate type, so shadow, gates, apply and rollback are shared. Prompt-injection text in a page or in a CIS response is
data: it can only appear as edit text, which is gated like any other edit.

## 7. "No defects left" and the remaining report

After the last rescan the harness writes `remaining.json` and `remaining.md` (`remaining.js`) listing **every unresolved finding** with one reason class:

| Class | Meaning |
| --- | --- |
| `needs_design_decision` | colour contrast and other design-locked items (the design lock forbids the change) |
| `platform_or_third_party` | owned by the Paradox platform, a vendor script, consent banner, widget or tag manager (origin not site-owned) |
| `data_not_bound_locally` | the value comes from a `{{data:..}}` binding that is not resolved in the local render; cannot be verified here |
| `needs_human_content` | the fix needs a label, alt text, heading or copy a human must write or approve |
| `fixer_could_not_produce_safe_change` | every adapter declined or no candidate within K iterations was safe |
| `gate_failed` | a candidate existed but failed a gate (the failing gate ids and evidence are attached) |
| `awaiting_review` | every gate passed but the policy queued the change for a human (review workbench; in the working-tree flow the edit stays in your tree). Each one is also listed under "Queued edits" in `remaining.md` with file and line |
| `not_reproduced_locally` | the local scan of the shadow build does not show the finding, so the harness cannot prove a fix |
| `not_traced` | the finding has no traced source line, so no task (or no allowlist) could be built; trace it by hand or rescan with the right `--source` |
| `needs_review_finding` | a needs-review finding with no task: a person must judge it, the harness never counts it as fixed |
| `baseline_incomplete` | environment, not the candidate: the baseline snapshot was truncated (see `snapshotBudgetMs`), so the run stopped before any task and nothing was rolled back |

**Zero remaining is claimed only when no finding remains and the final scan of the final state found none** (the rescan after accepted changes, or the baseline scan when nothing was accepted). A finding in an explained class still remains: the classes explain, they do not clear.
The report must state the counts per class and per tier, and it must never present "needs-review" findings as fixed or as clean.
A run with `truncated` snapshots, a failed rescan or a missing gate input reports `incomplete`, not `clean`, and claims nothing (`zeroRemainingClaim: false`).
Findings with no task are `not_traced` (no source line) or `needs_review_finding` (needs-review tier); a task skipped for the same reason keeps `not_traced`. A declined task is
`needs_human_content` for rules whose fix is words or a judgement (alt text, names, titles), else `fixer_could_not_produce_safe_change`.

## 8. Performance track

Separate task source: Lighthouse opportunities and measured checks (image `width`/`height`, `loading="lazy"` below the fold, `font-display`,
render-blocking scripts (`defer`), unused `preload`). Only **deterministic recipes** (no CIS, no free-form tool edits) produce candidates.
They pass the same G1..G8 gates (for the track G1 targets the performance finding id) plus one more rule:

**A measured improvement is required to accept**, not just non-regression: `comparePerf(..., { requireImprovement: { metric, minGain } })` passes only when the target
metric improves by more than its noise margin (and `minGain`). No measurable gain means rollback, class `gate_failed` with `NO_MEASURED_IMPROVEMENT`.

Realistic limits, stated in the report: third-party scripts (tag managers, consent banners, chat widgets, analytics) usually dominate TBT and LCP and are not
editable; Paradox platform bundles are not editable; a local run has no CDN or real network, so gains are relative, not absolute.
The track never promises a Lighthouse score target.

## 9. Benchmark and release criteria

**Seeded-fault corpus** (`test/fixtures/fix-corpus/`, six neutral Paradox-like sites, manifest in `manifest.json`; the tiny `test/fixtures/harness-site` is its seed):
each site has seeded defects with `rule`, `file:line` and the expected accepted fix (exact `find`/`replace` edits), plus "tempting but wrong" fixes that must be
rejected: contrast fixed by changing a colour (G2/G5), the element removed (G3), ids hard-coded inside a loop (G1), `data-pdk-*` stripped (G2), `aria-hidden` put on
focusable content (G1), `display:none` on the skip link (G6), padding widened so the layout shifts (G3), a heavy blocking script (G7), a skip link visible at rest (G3/G4),
an id renamed that the toggle script relies on (G6). Each wrong fix records the gate expected to fire. Coverage: button-name, meta-viewport, nav labels, skip link,
aria-expanded disclosure, duplicate ids in loops, label-in-name, image-alt (figcaption and decorative), form labels, autocomplete, heading order, target size by spacing,
focus-visible, html lang, document title, `rel=noopener`, and one design-locked contrast defect (class `needs_design_decision`, never fixed). The corpus is exercised by
`scripts/fix-benchmark.js` (`docs/fix-benchmark.md`); the controller runner and the built-in foundation runner both plug into it.

**Real-site procedure** (copies only, never the original): copy the site repo, run the scan, run the harness on the copy with CIS and with a recipe-only config,
record every decision, then have a reviewer inspect all auto-accepted diffs (full) and a sample of the rest. Never run against a site tree with uncommitted work.

Metrics:

| Metric | Definition |
| --- | --- |
| fix rate | confirmed site-owned findings fixed (accepted by the gates AND gone in the rescan, no regression) / confirmed site-owned findings with a fixable class. `human_review` is not counted as fixed |
| break rate | accepted candidates that break anything (post-apply rescan, independent review, or a tempting wrong fix that was accepted) / accepted candidates. A wrong fix that is accepted always counts as a break. Zero accepted candidates is reported as n/a, never as a pass |
| false-accept rate | candidates on the corpus that must be rejected (wrong fixes) but were accepted (`auto_accept` or `human_review`: every gate passed) / wrong-fix candidates the runner could verify |
| rollback rate | rolled-back candidates / candidates that reached the gates (informational; high is safe, but tracks fixer quality) |
| mean repairs | mean of (iterations - 1) over candidates; bounded by K |
| perf delta | median per-metric change of accepted candidates (score, LCP, TBT, CLS, transfer), plus the count of accepted candidates that regressed beyond margin |

**Phase 5 is done when**, on the full corpus and on at least 3 real-site copies of different structure:

- break rate = 0 and false-accept rate = 0 on the corpus (hard); every tempting wrong fix was actually evaluated (a runner without the scanner gate G1 leaves the G1-only cases open, which keeps the release open);
- 0 broken accepted candidates found by independent review of all auto-accepted real-site diffs;
- fix rate >= 90 percent of confirmed site-owned fixable findings on the corpus (any fixer or the configured chain), and every remaining finding is in a reason class (no unexplained leftovers);
- perf delta: no accepted candidate regressed beyond margin; the performance track shows a measured gain on at least one metric in at least one real-site copy;
- every gate has a failing test (the bad-change tests in `test/fix/harness-gates.test.js`) and a passing test for a good change;
- the corpus runs deterministically twice with identical decisions (`--repeat 2`).

`node scripts/fix-benchmark.js --check` evaluates these criteria (`evaluateRelease`): a failed criterion exits 1, a criterion that needs the scanner gate or a manual real-site fact stays `open` and the release is not claimed.

## 10. Security

- **Shadow isolation**: every candidate is applied only in a private temp copy (mode 0700, `copyProjectTreeIntoShadow`); the real tree changes only through the apply transaction after acceptance. External tools work on a further scratch copy.
- **Network**: the shadow site and mock servers bind 127.0.0.1 only; build/prepare commands run with the existing managed-command environment; the only outbound network is the CIS endpoint (through the CIS transport). Snapshots never fetch third-party hosts for the harness itself; pages that request them are recorded as failed requests, not allowed through.
- **Secrets**: never written to snapshots, logs, evidence or reports; console and request text is stored with the origin stripped and CIS telemetry stays redacted.
- **CIS responses** are parsed only by the strict allowlist parser; nothing else reads them. Edit text that reaches a candidate goes through the same gates as any edit.
- **Review workbench** stays loopback-only; evidence files are served from the session directory with path containment.
- Snapshot directories are session-private temp dirs, removed when the session ends unless the user keeps them.

## 11. Integration (implemented in `runner.js`; the controller and `verify/shadow.js` are unchanged)

`runHarness({ projectDir, tasks, fixer, config })` composes existing modules; all harness calls are plain functions.

| Step | Reused module | What the runner does |
| --- | --- | --- |
| Shadow copy | `verify/shadow.js` `copyProjectTreeIntoShadow`, `runManagedCommand`, `startCandidateSite`; `verify/site.js` static adapter | copy the project (node_modules, dist, .git, secrets excluded) into `<runDir>/shadow`, optional `prepare` command, build, serve `outDir` on a random loopback port |
| Baseline | `snapshot.js` `captureSnapshot`, the scanner adapter (`verify/scanner.js`, injectable), html-validate, export check | one baseline per run on the untouched shadow (`perfRuns` runs per route for the noise margin) |
| Tasks | `export/tasks.js` `buildTaskSet` tasks | skipped without a fixer call: design-locked (`needs_design_decision`), no traced source (`not_traced`), finding not reproduced locally. Order: file ascending, line descending (bottom-up) |
| Candidate | `candidate/*`, `change.js` | validated before anything is written: paths, extensions, `before` equals the shadow bytes, **G2 on in-memory trees** (allowlist files and line ranges, backend tags and `data-pdk`, design lock). A failure is fed back to the fixer like any gate failure (stage `pre_apply`) |
| Apply in shadow | `apply/transaction.js` `applyBatchTransaction` (journal, CAS, atomic writes) | the transaction API requires a verification artifact; the runner persists a staging artifact bound to the candidate and diff hash. It is not an acceptance proof: acceptance is decided only by the gates after the apply |
| Verify | build, `captureSnapshot`, scan, `runGates` G1..G8, `build-checks.js` | G1 compares the shadow scan before and after; targets (`resolveKeys` on the task selectors) exempt only the intended elements; `documented` keys come from the task, never from the fixer |
| Decide | `policy.js` `decide` (wraps `decideAcceptance`) | `auto_accept`: kept in the shadow, the after snapshot, findings and tree become the next baseline (cumulative). `human_review`: rolled back out of the shadow, queued. Gate failure: `rollbackTransaction`, bytes verified against the `before` text (sha256), repair or close |
| Final | scanner again, `apply/transaction.js` | rebuild if dirty, rescan the accepted state with the real scanner, scan delta, squashed unified diff, per-task table, `remaining.json` and `remaining.md`; unless `dryRun`, apply the squashed change to the project in ONE transaction (CAS: refused as `project_changed` if a touched file differs from the copy) |

Review queue (`policy.js` `queueForReview`): queued candidates are registered with the existing review state (`review/state.js`, `registerVerifiedCandidate`) in `<runDir>/review`.
The only workbench additions are a `harness` evidence block on the candidate record (gate table, before and after screenshot paths relative to the run directory, scan delta, capped
gate evidence, perf rows, diff; at most 48 KB, display only) and a collapsible "Harness evidence" section in `workbench.html`. A queued item that cannot be registered (an accepted task
changed the same file, so the preimage no longer matches) stays in `harness-report.json` with `review.registered: false` and the reason; it is not lost, but it must be re-run.

Config keys of `runHarness`: `build` (required, `{command,args}`, no shell; the harness fails closed without it), `outDir`, `prepare`, `routes`, `viewports`, `perfRuns` (default 3; 0 disables G7 and the report says so), `snapshotConcurrency` (3), `scanConcurrency` (2) (both must be positive integers, anything else is `CONFIG_INVALID`), `incrementalRoutes` (true), `snapshotBudgetMs` (default 180000: the time budget of one snapshot capture; a truncated baseline stops the run as `baseline-incomplete`, so raise it for many routes x viewports or a loaded machine),
`perfRunner`, `perf` (passed to `comparePerf`), `scanner` and `site` (an adapter object, or `auto` (default), `static`, `vite`: `auto` runs the Vite dev server of the shadow copy when the project has a vite config, else serves `outDir` statically), `maxRepairs` (2), `dryRun`, `designLock` (true), `allowRadius` (3 lines each side of the traced line), `policy`
(`autoAccept`, `maxAutoLines` 10, `maxAutoRisk` 0.3), `runDir`, `keepShadow`, `shareNodeModules` (symlinks the project's `node_modules` into the shadow; default true when the project has one and no `verifyInstallCommand` is set (an install must run in the shadow, not through the link), `false` opts out, an explicit `true` links even with an install command; dot entries other than `.bin` and `.pnpm`, such as `.vite`, `.vite-temp` and `.cache`, are never linked), `formatCheck`, `exportFile`, `report`.

CLI: `ada-scan fix --harness [--fixer recipes|cis|external] [--max-repairs K] [--dry-run] --report <latest.json> --source <dir>`. It reads `.scan-config.json` (`verifyBuildCommand` or `buildCommand`
is required, plus optional `outDir`, `verifyInstallCommand`, `verifyFormatCheckCommand`, `harness: { routes, viewports, perfRuns, snapshotBudgetMs, maxRepairs, lighthouse: false, site, shareNodeModules }`), runs the Lighthouse perf runner by
default, and writes everything under `<out-dir>/harness/<timestamp>/` (`report/harness-report.{json,md}`, `report/remaining.{json,md}`, `snapshots/`, `review/`). URL-only reports and projects without a local
tree stay scan-only. The shadow copy excludes `node_modules`, so a build that lives there (`node node_modules/vite/bin/vite.js build`) relies on `harness.shareNodeModules` (default true when `node_modules` exists and there is no `verifyInstallCommand`); a baseline build that fails with `MODULE_NOT_FOUND` prints a hint naming it. The config is read from `--source`, not from the working directory. A Paradox build only emits fragments, so on a project with a vite config the harness serves the shadow with the Vite dev server (`harness.site: "static"` forces the static server; routes that answer 404 on either server are skipped by html-validate and listed as incomplete reasons). Fixers are loaded from `src/fix/harness/fixers/index.js` (`createFixer(name, { localRoot, report })`); the CLI refuses with a clear message if that module is absent.

**`--from-working-tree`** verifies edits an editor agent (Cursor chat, Claude Code) already made. It is always a dry run: the edits stay in the working tree and nothing is written back or reverted.
Working-tree details: untracked files (a new `.liquid.json` sidecar) are listed as new files, never replayed and never verified. A task is replayed once (an editor owns the edit, so there is no repair loop). Hunks of tasks that were skipped (for example a lighthouse-only rule, "layer not run in the harness") are listed as unverified with their task. `remaining.json` is counted from the final shadow rescan (`source: final-rescan`); the rescan rows are kept in `<run dir>/scans/`.
The harness reads `git diff HEAD --unified=0`, builds the shadow from the HEAD text of every changed file, replays each task's hunks on it and runs the gates (G7 only with perf runs); the console and
`harness-report.md` say so. A hunk belongs to a task in this order: (1) the task's element (its id, or its tag plus attribute values, from the export task) appears in the hunk or in the lines around it,
among the tasks that name the file, so a reported source line a few lines off still works and the allowlist and the task's source line are moved onto the hunk; (2) otherwise the nearest task whose
allowlist covers the hunk; (3) a task without a source line ("locate manually") has a whole-file scope over the files it lists and claims a hunk only by (1) or when it is the only task in scope.
Hunks nobody claims are not verified: they are listed with file and line in `harness-report.md` and `harness-report.json` (`workingTree.unassigned`), not only on the console.

## 12. Module reference (`src/fix/harness/`)

| File | Exports |
| --- | --- |
| `incremental.js` | `affectedRoutes`, `routeIndexFromReport` |
| `snapshot.js` | `captureSnapshot`, `measurePerfOnce`, `resolveKeys`, `VIEWPORTS`, `STYLE_PROPS`, `SNAPSHOT_VERSION` |
| `compare.js` | `compareLayout` (G3), `compareVisual` (G4), `compareStyles` (G5), `compareBehaviour` (G6), `comparePerf` (G7), `noiseMargin`, `diffImages`, `DEFAULTS` |
| `tokens.js` | `extractBackendTokens`, `extractDesignTokens`, `compareTrees`, `readTree`, `diffMultisets` |
| `gates.js` | `runGates`, `evaluateTargeted` (G1), `evaluateScope` (G2), `evaluateBuildValidity` (G8), `decideAcceptance`, `riskScore`, `diffLines` |
| `png.js` | `decodePng` (8-bit RGB/RGBA PNG, no dependency; `pngjs` is not a dependency of this package) |
| `runner.js` | `runHarness`, `loadHarnessConfig`, `renderRunMarkdown`, `HarnessError` |
| `perf.js` | `createLighthousePerfRunner` (median of N Lighthouse runs with the scanner's device and throttling profile, injectable `runner`), `perfFromLhr`, `medianPerf` |
| `build-checks.js` | `runBuild`, `countHtmlValidateErrors`, `checkExport`, `checkFormatter`, `collectBuildFacts`, `dirSize` (G8 facts) |
| `remaining.js` | `buildRemainingReport`, `renderRemainingMarkdown`, `writeRemainingReport`, `REASON_CLASSES` |
| `policy.js` | `decide`, `buildEvidence`, `queueForReview`, `screenshotPaths`, `DEFAULT_POLICY` |
| `change.js` | `fileToEdits` (whole-file change to anchored edit intents), `unifiedDiff`, `changedLineCount` |
| `fixers/*.js` | `createRecipesFixer`, `createCisFixer`, `createExternalFixer`, `readTaskContext`, `parseUnifiedDiff`, `injectionIn` |

Tests: `test/fix/harness-units.test.js` (pure), `test/fix/harness-gates.test.js` and `test/fix/harness-runner.test.js` (live, need Chromium, scripted fake fixer and fake scanner), `test/fix/harness-modules.test.js` (pure), fixture `test/fixtures/harness-site/`, helper `test/helpers/harness-site.mjs`. Fixers and benchmark: `test/fix/harness-fixers.test.js`, `test/fix/fix-corpus.test.js`, `test/fix/fix-benchmark.test.js`.
Tests: `test/fix/harness-fixers.test.js`, `test/fix/fix-corpus.test.js`, `test/fix/fix-benchmark.test.js`, `test/fix/harness-units.test.js` (pure), `test/fix/harness-gates.test.js` (live, needs Chromium), fixture `test/fixtures/harness-site/`, helper `test/helpers/harness-site.mjs`.

Known limits of the foundation: keys re-key on class edits and when an id is added to or removed from an element (a skip link fix that has to add `id` to `<main>` re-keys the whole subtree, so G6 sees the tab order as changed; the corpus skip link site already has `<main id="main">`); the style set ignores pseudo-elements, hover and focus states (G4 at rest only; add state captures for interactive targets later);
Tailwind semantic colour utilities (for example `bg-primary`) are not seen by the design lock unless they resolve to a CSS declaration; the built-in perf runner has no throttling and no Lighthouse score.

Known limits of the runner (honest list):

- G8 formatter: the project's prettier runs only when it is installed in the shadow (`verifyInstallCommand`, or the default `shareNodeModules`); otherwise the check is skipped and the report notes it. Export validity is a structural check
  (parses, non-empty, keeps the baseline top-level keys), not a Paradox schema validation; a project with no export plugin reports "not applicable".
- G1 depends on the scanner adapter's finding ids; target findings are matched to the task by id, else by rule, route and selector. A task whose finding is not reproduced is skipped (`not_reproduced_locally`).
- G2 runs once on in-memory trees before the apply; the transaction then writes exactly those bytes. A change that survives G2 but needs a build step to show a design effect is caught by G4 and G5 only.
- Perf: the built-in runner has no throttling or score; the Lighthouse runner uses the scanner's local device profiles, runs serially, and its noise margin comes from the baseline runs only. G7 is skipped when `perfRuns` is 0 (reported).
- The edit model rejects CRLF files, files over 64 KB, new files, JSON sidecars and edited lines with trailing whitespace; such candidates are rejected before apply with a named reason.
- Queued review candidates are verified against the shadow at queue time and registered against the project; they are not rebased if a later accepted task touches the same file.
- Final apply refuses (`project_changed`) when a touched project file no longer matches the copy; it does not check for uncommitted work, so run it on a clean checkout.
- Each rejected or rolled-back candidate keeps its snapshots under `<runDir>/snapshots` as evidence; delete the run directory when done.
- Tolerances accumulate: each accepted task is compared with the previous accepted state, not with the original baseline, so many small in-margin changes can add up. Run `ada-scan` and a final visual review on the result.
- The "not seen by the rescan" list is deduplicated by defect and sorted, so identical runs give identical counts.
- Only the routes of the tasks (or `harness.routes`) are snapshotted and scanned; a change to a shared layout or partial is not checked on other routes unless they are configured. Set `harness.routes` for shared templates.
- An error thrown after a candidate was applied in the shadow (snapshot, scan) aborts the run without a report; earlier accepted changes are then not applied to the project. The shadow is private and removed.
- A skipped formatter check counts as clean in G8 (noted in the iteration `buildNotes`), so badly formatted Liquid can be accepted when prettier is not installed in the shadow.
