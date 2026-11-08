# ada-scan

On-demand **WCAG 2.2 AA** accessibility, HTML validity and page-speed scanner for Paradox career
sites (Liquid/Vite projects and live preview URLs). It traces findings back to the local
source file and line, and hands fixes to a developer working in Cursor or Claude Code.

The scanner runs <!-- docs:counts -->11 scan layers (axe, accessScan, w3c, htmlValidate, links, lighthouse, keyboard, ariaLive, focusTrap, dynamicContent, screenReader) and 84 active accessScan rules<!-- /docs:counts -->. Findings are normalized into one report schema (`ScanReportV2`),
traced to the source `.liquid` file and line where a local build exists, compared against a baseline
(fixed, remaining, new) and exported as one task per finding.

> Automated tooling can only fully verify roughly a third of WCAG success criteria. **ada-scan
> augments, it does not replace, a manual accessibility audit.** AI-proposed fixes (alt text, ARIA) are
> drafts requiring human review. The generated QA report never says "compliant".

## Install

New to the tool? Start with the [developer guide](docs/developer-guide.md) (prerequisites, scanning, report tiers, fix flow, eval, troubleshooting) or [docs/onboarding.md](docs/onboarding.md).

Node 20.18.1 or newer, ESM host.

```bash
pnpm add -D git+https://<your-git-host>/ada-scan.git#v1.1.0
npx playwright install chromium
npx ada-scan init
npx ada-scan doctor
```

`init` creates `.scan-config.json` (thresholds, a placeholder `/` page, the `standards` profile) and
nothing else. It asks nothing, never overwrites an existing file (`--force` replaces it,
`--dry-run` prints the file and writes nothing) and does not edit `vite.config.*` or `package.json`;
it prints what to add yourself. For source tracing in a Vite project register the plugin:

```ts
import { scanInstrumentationPlugin } from 'ada-scan/vite';
export default defineConfig({
  plugins: [scanInstrumentationPlugin(), /* existing plugins */],
});
```

This is optional: when the vite config does not register the plugin and the build script is a plain
`vite build`, the scan adds it through a temporary config under `.ada-scan/tmp` (removed afterwards; your
files are untouched). `autoInstrument: false` in `.scan-config.json` turns that off; `ada-scan doctor`
(`tracing-ready`) says when it cannot be done and why.

`ada-scan doctor [--url <url>] [--json]` checks Node, the Chromium launch, lockfile and package-manager
drift, the dev server, the build script, CIS variable names, the output directory and, with `--url`,
reachability and a noindex hint. Each check is PASS, WARN or FAIL with a fix hint; exit 1 on any FAIL.

## Quick start

Local site (starts the dev server, builds an instrumented `dist`, traces findings to `file:line`):

```bash
npx ada-scan                       # all configured pages
npx ada-scan --page /jobs          # one page
npx ada-scan --url http://localhost:1234/
```

Preview (Studio) URL. This is the pass/fail source for QA, because it renders the platform widgets and
content that a local build does not. Add `--source .` to trace findings to the local project:

```bash
npx ada-scan --url https://<site>.preview.sites.stg.paradox.ai/ --psi --no-fail
npx ada-scan --url https://<site>.preview.sites.stg.paradox.ai/ --sitemap <sitemap-url> --max-pages 20
```

A preview scan cannot trace without local source, and a local scan cannot see platform-owned markup.
Findings carry an owner (`source`, `platform`, `third-party`) and platform-owned ones are listed apart,
not as something a developer can fix in Liquid. Use `--no-hydrate-jobs` to compare a local shell with a
preview without jobs/chat widgets.

### Reports

Everything is written to `<project>/.ada-scan/` (override with `--out-dir <dir>` or the `reportsDir`
config key; add `.ada-scan/` to `.gitignore`):

| File | Content |
|---|---|
| `latest.json` | `ScanReportV2` for the last scan |
| `qa-report.html`, `qa-report.json` | PASS / FAIL / INCOMPLETE against the thresholds, per-page tables, top issues, ownership, fixed/remaining/new |
| `scan-visual.html`, `roi-comparison.html`, `roi-technical.html` | HTML views of the same scan (file names kept for existing links) |

| `baseline.json` | written by `--baseline`; later scans compare by finding `stableId` |
| `history/` | one directory per scan |
| `scan.sarif` | with `--sarif` |
| `tasks/` | with `ada-scan fix --export` |

Report wording lives in `src/reporter/wording.js`: totals are "occurrences in distinct findings", Performance is Lighthouse performance only, `w3c.*` rows name their engine, and only confirmed findings fail the gate.

## Developer loop with Cursor or Claude Code

1. Scan the preview (QA verdict) and, when a local build exists, scan locally so findings trace to files.
   Save the result as the baseline: `npx ada-scan --baseline`.
2. Export the work: `npx ada-scan fix --export` writes one task per actionable finding (rule, WCAG
   criterion, `file:line`, snippet, confidence, suggested fix, platform-owned notes) plus `tasks/INDEX.md` to
   `<out-dir>/tasks`. It uses no AI and no network. Filters: `--severity`, `--rule`, `--page`, `--max`,
   `--include-needs-review`. `--target cursor` or `--target claude` also writes one agent rules file that ada-scan owns
   (`.cursor/rules/ada-scan.mdc` or `.claude/ada-scan.md`, marked, regenerated); it never edits a file without
   its marker, never `CLAUDE.md`. Each task has Where, Evidence, Fix (a recipe filled from the finding, with a
   suggested diff when certain), Do not and Verify; `INDEX.md` adds a summary table and a "By file" order (highest line
   first). `--group-by-file` writes one combined task per source file. Contrast findings are design decisions: listed
   apart, never auto-fixed, never edited by colour. See [docs/fix-export.md](docs/fix-export.md).
   With `--target`, the accessibility fix skill is installed too (`.cursor/rules/ada-scan-fix-skill/` or
   `.claude/skills/ada-scan-fix/`): the per-task workflow, Paradox and Liquid rules, no-break guardrails and one pattern per rule family.
   After editing, `npx ada-scan fix --verify` checks the working tree diff against the export (named files only, data tags and
   colour declarations unchanged, no `dist/`) and exits 1 on a violation. See [docs/fix-skill.md](docs/fix-skill.md).
3. In Cursor or Claude Code, point the agent at `tasks/INDEX.md` and work one task at a time. Review each diff.
4. Rescan. The comparison reports `fixed N, remaining M, new K` per page; a finding counts as fixed only when
   its `stableId` is gone from a complete scan of the same target and profile.
5. Leave the agent's edits uncommitted and check them: `npx ada-scan fix --harness --from-working-tree` replays each task's change on a shadow
   copy and gates it (targeted, scope, layout, visual, style, behaviour, performance, build). Nothing is written to the project; a rolled back
   task keeps its edit in your tree until you undo it. See [docs/onboarding.md](docs/onboarding.md) for the whole path and [docs/fix-harness.md](docs/fix-harness.md).
6. For a reviewed, CIS-assisted edit instead of an editor agent use `--fix --fix-mode cis --ui` (below).

## Limits of automated testing

- Automation verifies a subset of WCAG; the QA report lists how many checks ran and the manual review items.
- Verdicts: `confirmed` findings decide pass/fail; `likely` and `needs-review` are shown but do not gate.
- A clean scan is not a compliance statement. Keyboard flows, reading order, content quality and
  assistive-technology behavior need a person.
- Local and preview scans differ in content (widgets, rendered metadata); a preview scan has no source to trace.
- Reports embed `outerHTML` and source snippets; review before sharing outside the team.

## CLI reference

Generated from `ada-scan --help` by `pnpm docs:readme`; a test fails when it drifts.

<!-- docs:usage -->
```text
  ada-scan [flags]            scan the local site (starts dev server, builds instrumented dist)
  ada-scan --url <url>        scan a remote or local URL
  ada-scan init | fix | demo  subcommands (ada-scan fix --report <file> --source <dir>)
  ada-scan fix [--export]     write one task per finding + INDEX.md to <out-dir>/tasks (no AI); filters: --severity <level or worse>,
                              --rule <id,id>, --page <route>, --max <n>, --include-needs-review,
                              --target <generic|cursor|claude> (adds .cursor/rules/ada-scan.mdc or .claude/ada-scan.md and the fix skill), --dry-run,
                              --group-by-file (one combined task per source file)
  ada-scan fix --verify       check the working tree diff against the export (files, data tags, colours, dist/); --baseline <report>
  ada-scan fix --fix-mode cis trusted fix pipeline (advisory CIS, verified apply)
  ada-scan fix --harness      gated fix harness on a shadow copy: [--fixer recipes|cis|external] [--max-repairs K] [--dry-run];
                              add --from-working-tree to verify what an editor agent (Cursor chat, Claude Code) already changed (git diff HEAD) per task
                              (always a dry run: your edits stay in the working tree; unclaimed hunks are listed in the report);
                              needs a local source tree and verifyBuildCommand in .scan-config.json (URL-only reports stay scan-only)
  ada-scan doctor             check Node, Chromium, lockfile, CIS env, output dir (--url <url> --json)
  ada-scan manual list|sign|status   record manual WCAG checks (tool-owned manual-checks.json in the reports dir)
  ada-scan label <stableId> --tp|--fp   label a finding; labels stats|apply show rule precision and demote weak rules
```
<!-- /docs:usage -->

<!-- docs:flags -->
| Flag | Meaning |
|---|---|
| `-h, --help` | print this help and exit |
| `--url <url>` | scan this URL instead of the configured local site |
| `--page <name\|path>` | scan one configured page (--ad-hoc allows a path that is not configured) |
| `--ad-hoc` | with --page: allow a path that is not in config.pages |
| `--all` | scan all configured pages (default) |
| `--sitemap <url\|file>` | discover pages from a sitemap |
| `--crawl` | discover pages by a bounded same-origin crawl |
| `--max-pages <n>` | cap discovered pages (default 50) |
| `--crawl-per-template <n>` | with --crawl: sample pages kept per URL template, e.g. /:slug/job/:id (default 2) |
| `--changed-only` | scan only pages whose source files changed in git |
| `--layers <a,b>` | comma list of layers to run (axe, accessScan, w3c, links, lighthouse, ...) |
| `--lighthouse-runs <n>` | local Lighthouse runs per form factor; the median score is reported (default 1) |
| `--profile <name>` | standards (default; decides pass/fail) \| commercial-parity (adds a supplementary section that never affects the gate) |
| `--include-third-party` | keep third-party widget DOM in fixes and checks (does not select a profile) |
| `--exclude-third-party` | drop third-party widget findings |
| `--no-hydrate-jobs` | block jobs/chat bundles (implies --exclude-third-party) |
| `--no-reverify` | skip re-checking flaky-prone findings in a fresh context (on by default) |
| `--allow-external` | allow third-party services: W3C Nu validator, PageSpeed Insights (off by default) |
| `--psi / --no-psi` | enable / disable PageSpeed Insights (--psi implies the opt-in for PSI only) |
| `--fix` | run the trusted fix pipeline (--fix-mode cis, the default; --ui) |
| `--dry-run` | do not write files |
| `--baseline` | save results as the baseline later scans compare against (fixed, remaining, new) |
| `--sarif [file]` | also write a SARIF 2.1.0 export (default <out-dir>/scan.sarif) |
| `--keep-query` | keep URL query strings in reports (redacted by default; fragments and userinfo are always dropped) |
| `--report-only` | regenerate HTML reports from the last scan |
| `--fail-on-violations` | exit 1 when violations exist |
| `--gate` | exit 1 when a metric misses its threshold (config thresholds; performance only off a dev server) |
| `--perf-gate` | enforce performance thresholds even on a dev server |
| `--seo-gate` | enforce Lighthouse SEO thresholds even when the target is noindex (preview) |
| `--no-fail` | never exit 1 for violations |
| `--max-time <seconds>` | wall-clock budget; pages not started in time are skipped (incomplete, exit 2) |
| `--allow-incomplete` | do not exit 2 for an incomplete scan |
| `--require-trace` | fail (exit 2) when source tracing is unavailable for a local URL scan |
| `--force-build` | rebuild the instrumented dist |
| `--no-server` | do not start the dev server |
| `--source <dir>` | source root for fixes |
| `--session <id>` | resume a fix session |
| `--out-dir <dir>` | reports directory (default .ada-scan) |
| `--verbose` | print more detail |
<!-- /docs:flags -->

<!-- docs:exit -->
Exit codes: 0 ok, 1 violations/failure, 2 bad arguments/config or incomplete scan.
<!-- /docs:exit -->

Arguments are parsed strictly: `--flag=value` works, and an unknown flag, a missing value, a value that is
another flag, an unknown `--layers` name or conflicting flags exit 2 with a message. `--page` must name a configured
page unless `--ad-hoc` is given (or `config.pages` is empty). `--changed-only` selects pages whose `src/pages` file changed
(including untracked files); a changed layout, partial or component selects all pages. A scan that did not finish
(skipped pages, layer timeouts) exits 2 unless `--allow-incomplete`.
A layer that times out or loses its browser target is retried once in a fresh context (the 180 s deadline bounds one attempt). A page that is still incomplete is `partial`, and `pages[].partialReasons: [{ layer, reason, gating }]` says which layer and why (also in the console, `qa-report` and `scan-visual.html`). Only a **gating** layer makes the scan exit 2; a partial page whose only incomplete layers are supplementary (`lighthouse`, `w3c`) is reported but exits 0 (`summary.pagesPartialGating` counts the gating pages). Set `scan.strict: true` in `.scan-config.json` to make every incomplete layer gating.

`--profile commercial-parity` additionally runs the commercial-scanner-style profile; its extra findings are
listed in a separate supplementary section (`runMetadata.parity`) and never count toward totals, the gate or the exit code.
The default `standards` profile always decides the gate.

## Trusted CIS review workflow

`--fix-mode cis` uses the secured local controller under `src/fix/`. CIS only
proposes edits to allowlisted source blocks; it cannot select paths, read arbitrary
files, run commands, approve changes, or write source. Source is changed only by the
separate **Apply** action after shadow verification and exact-diff approval.

URL-only scans are always scan-only, even when fix flags are present:

```bash
npx ada-scan --url https://careers.example.com/
npx ada-scan --url https://careers.example.com/ --fix --fix-mode cis --ui
```

Run a local scan and open the review workbench:

```bash
npx ada-scan --fix --fix-mode cis --ui --session careers-review
```

Or review an existing V2 report without rescanning:

```bash
npx ada-scan fix \
  --report .ada-scan/latest.json \
  --source . \
  --fix-mode cis \
  --session careers-review \
  --ui
```

Rerun the same `fix --fix-mode cis` command with the same `--session` value to resume persisted
decisions from
`scan-reports/fix-sessions/<session-id>/session.json` (under the project root). Session IDs may contain
letters, numbers, `_`, and `-`. A session is bound to its report ID and fails
closed if the report, candidate, source preimage, or verification artifact changed.

For an attested hybrid review, set `deploymentUrl` in `.scan-config.json` (or
`ADA_SCAN_DEPLOYMENT_URL`), build and deploy with the scan instrumentation plugin,
then scan that deployment against the same local revision:

```json
{
  "deploymentUrl": "https://careers.example.com"
}
```

```bash
npx ada-scan \
  --url https://careers.example.com/ \
  --source . \
  --fix --fix-mode cis --ui \
  --session careers-hybrid-review
```

Hybrid fixing is enabled only when the deployed HTML, local
`dist/scan-attestation.json`, build revision, instrumentation digest, deployment
URL, and source preimages all match. Missing, dirty, stale, malformed, or
out-of-scope attestation downgrades the run to scan-only.

In the workbench, **Verify** builds and scans the candidate in a disposable shadow
workspace. **Accept** records a decision only. **Approve exact diff** binds approval
to the current candidate and diff hashes. **Apply** then performs compare-and-swap
preflight, atomic writes, and targeted post-apply verification. Transaction failures
and failed post-verification trigger byte-exact automatic rollback; concurrent edits
are preserved and reported as rollback conflicts. There is intentionally no
standalone unreviewed Apply or rollback command.

The legacy direct-write fixer was removed in v2. `ada-scan fix` exports a task set
for Cursor or Claude Code (`fix --export`, optionally `--target cursor|claude`);
`ada-scan fix --fix-mode cis` runs the trusted pipeline above.

## Report contract

`.ada-scan/latest.json` uses `ScanReportV2` (`schemaVersion: "2.0.0"`).
Finding and report IDs are canonical SHA-256 hashes, scanner runs retain engine,
viewport, state, and provenance evidence, and properly instrumented local reports
include build revision plus instrumentation digest attestation. Missing
instrumentation is represented explicitly rather than as a hash of an empty manifest.

Programmatic consumers can import the public contract:

```js
import {
  buildScanReportV2,
  projectReportV1,
  validateScanReportV2,
} from 'ada-scan/report';
```

The HTML reporter receives a V1 projection. New integrations should consume V2; the
compatibility projection is temporary.

### Who owns a finding (`origin`)

Every finding has `origin: { owner, kind, vendor?, label, evidence[] }` and the report has `notYourCode[]`
(findings in code the site cannot change, once per site; schema: `docs/schema/scan-report-v2.schema.json`,
types: `src/reporter/report-v2.d.ts`). The reports word it the same way everywhere:

| Owner badge | `origin` | Meaning |
|---|---|---|
| Site | `owner: site`, `kind: site-source` or `unbound-data` | the project's templates; fix in source |
| Injected at runtime | `owner: site`, `kind: injected-runtime` | a script added the DOM and no vendor claims it; never confirmed |
| Origin unknown (probe failed) | `owner: site`, `kind: unknown-probe-failed` | the live DOM probe could not resolve the node (page gone, probe timeout, node removed since) and no vendor token proves injection; never confirmed |
| Platform React widget / Platform component | `owner: platform`, `kind: react-widget` or `platform-component` | rendered by the Paradox platform; report to the platform team |
| Third-party: `<vendor>` | `owner: third-party`, `kind: vendor-script` | a vendor script (`vendors.json` id or the script host); contact the vendor or adjust the consent / GTM configuration |
| iframe | `owner: third-party`, `kind: iframe` | content inside a cross-origin iframe |

`scan-visual.html` shows the badge on every finding (expand "Origin" for the label and evidence), filter chips by owner,
and a "Not your code (N)" section grouped by vendor or component with pages, rules and a suggested action; `qa-report.html`
has an Owner column and the same section. Quality-gate rows say "third-party and platform findings excluded (N)" (N = confirmed
occurrences the gate did not count; `gate.countThirdParty` / `gate.countPlatform` count them). The console prints one `Owner <name>:` line per owner.
SARIF results carry `properties.origin`, and platform and third-party results are level `note`.

## Configuration (`.scan-config.json`)

Host-integration is fully config-driven so ada-scan is not hardcoded to any one
repo:

| Field | Purpose |
|-------|---------|
| `baseUrl` | Local dev URL (dev-server readiness port is derived from this) |
| `devCommand` / `buildCommand` / `buildEnv` / `outDir` | How to start dev + run the instrumented build |
| `source` / `distMap` | Source layout + built-HTML→source mapping for tracing |
| `thirdParty` | Third-party widgets to skip. Unset or `{ "preset": "auto" \| "paradox" }` applies the Paradox selector preset (selectors, template tokens, chatbot trigger; your keys override it). `[]`, `null`, `false` or `{ "preset": "none" }` disable it; an array is used as the selector list. |
| `pages` | `[{ path, name?, allowStatus? }]`; `name` defaults to the path (`/` = `homepage`, `/about/team` = `about-team`) and must be unique |
| `profile` | `standards` (default) or `commercial-parity`; same as `--profile` (see above) |
| `reportsDir` | Report output dir (default `.ada-scan`; `--out-dir` overrides) |
| `layers` | Toggle any scan layer |
| `links` | `{ "platformRoutes": [] }`: globs of same-origin paths the platform serves and the local dev server cannot (for example `["/jobs", "/job-details/*"]`); links to them are never probed or reported. Without it, on a local scan a same-origin link answered 404 whose path no project page (`source.pagesRoot`, the Paradox export's page elements) defines is `needs-review` ("route-not-served-locally"), not a confirmed 404. On a remote scan a same-origin 404 stays confirmed. External links answering 401/403/429/999 or a bot challenge are `needs-review` ("blocked-unverifiable"); timeouts and network errors are retried once as a browser-like GET and reported as `needs-review` with the class `timeout`, `dns`, `tls` or `connection`. An external link is confirmed dead only when two attempts (HEAD, then a browser-like GET) follow the redirect chain (max 5 hops, recorded in the finding) to the same final URL and both end 404/410 or 5xx; a 404, 410 or 5xx is asked again twice with a browser user agent and a short backoff and the final status decides (a transient 502 that recovers is never confirmed: a same-origin link then drops to no finding; an external one stays `needs-review` "dead-link-unreachable" (reason "inconsistent-status", the HEAD and the final GET disagree)); a block status or any disagreement between the attempts or the http and https variants is `needs-review` ("blocked-unverifiable" / "inconsistent-status"). A link finding is sourced to the `.liquid.json` line where its href is authored (the template line is kept as `templateSource`). |
| `gate` | `{ "countThirdParty": false, "countPlatform": false }`: findings owned by a third party (vendor-script DOM such as a consent banner, cross-origin iframes) or by the Paradox platform (React widget DOM, chat) are never traced to a source file, are listed once per site in `notYourCode` / `not-your-code.md`, and are left out of the `--gate` counts and `--fail-on-violations`. `true` counts them. |
| `tracing` | `{ "vendors": [], "foreignImpactCap": "moderate" }`: `vendors` extends `src/tracer/vendors.json` (`{ id, name, category, patterns: { src, id, class, attr, html } }`, regex strings; same `id` replaces a bundled entry) so injected vendor DOM is recognised as third-party; `foreignImpactCap` is the highest impact a non-site finding keeps (`null` lifts it). Every finding reports `origin` (owner, kind, vendor, label, evidence). |
| `thresholds` | Quality gate, checked with `--gate` (exit 1; exit 2 for an incomplete scan wins). `lighthouse.{mobile,desktop}.{performance,accessibility,bestPractices,seo}` are Lighthouse scores 0-100 (defaults: mobile performance 80, desktop performance 90, accessibility 100, bestPractices 90, seo 90). `a11y.{critical,serious,moderate,minor}` are max counts or `"report"` (defaults 0, 0, report, report). `w3c.{errors,warnings}` likewise (0, report); they count the offline `htmlValidate` layer and the W3C Nu layer. Performance is only enforced off a dev server (Vite dev client `/@vite/client` detected); there it is shown as advisory, `--perf-gate` enforces it anyway. Likewise Lighthouse SEO is advisory (with a reason) when the target blocks indexing (robots meta or `X-Robots-Tag` noindex, e.g. a preview site); `--seo-gate` enforces it anyway. The old flat `wcag` / `performance` / `bestPractices` keys still work (deprecated, warns). |
| `scan` | `{ "errorPages": ["/404", "/500", "/job-details"] }`: route globs of layout-only error/stub/platform pages (a page whose own template holds only layout/block/comment tags, or whose live DOM has no main, heading or body text, is treated the same: note "empty template shell"). There `missing-main-landmark`, `landmark-one-main`, `missing-h1`, `page-has-heading-one`, `no-headings` and the sticky header/footer focus-obscured rules are `needs-review` (note "error/stub page"); every other defect keeps its verdict. |
| `skipRules` / `suppress` | Global rule skips + targeted false-positive suppression (audited in reports) |

The file is validated (types, `thresholds`, `layers` names and booleans, `pages` items,
`concurrency`) and read once per run. A missing file warns and uses defaults; an
unparsable or invalid file exits 2 (CLI) and fails the Vite build with a warning (plugin).

### Privacy: external services

ada-scan sends nothing to third parties by default. Two optional services need an explicit opt-in with
`--allow-external` or `"external": { "w3c": true, "psi": true }`:

| Service | What is sent | Config |
|---------|--------------|--------|
| W3C Nu validator (`w3c` layer) | the rendered page HTML | `external.w3cEndpoint` (default `https://validator.w3.org/nu/`; point it at a self-hosted validator) |
| Google PageSpeed Insights (Lighthouse) | the page URL | `external.psi` / `--psi` |

The first call prints which service gets what. Private, loopback and link-local hosts are never sent, even when
enabled (the layer is reported `skipped: private-host`). Without opt-in the `w3c` layer is `skipped:
external-disabled` and the report shows that no HTML validity engine ran; this is not an incomplete scan. Lighthouse
runs locally unless PSI is enabled.

## Dependencies

- **Required:** `playwright`, `@axe-core/playwright`, `fast-glob`, `dotenv`, `html-validate`, `undici`
  (pinned Playwright/axe for stable browsers and rule results).
- **Optional (lazy):** `lighthouse` + `chrome-launcher` (Lighthouse layer), `@anthropic-ai/sdk`, `openai`.
  Missing optional dependencies degrade with an install hint; they never crash a scan. `--fix-mode cis` and
  `ada-scan fix --export` need no SDK.
- **Peer (optional):** `vite` (the plugin runs inside your host Vite).

## Live CIS operator workflow

**Trusted mode is the default.** Production, CI, and operator acceptance require a
Workday-approved PEM bundle and `sha256:<64hex>` fingerprint from Trust Star/PKI/JAMF —
never from an unverified endpoint. Keep `.env` and the CA bundle outside source control.

**Canonical reference:** [docs/cis-contract.md](docs/cis-contract.md) — security boundary,
trust prerequisites, config keys, sandbox demo, model scoring, activation checklist,
troubleshooting codes, implementation evidence, redaction policy, and legacy
characterization warnings.

### CIS security boundary

| Rule | Behavior |
| --- | --- |
| Default transport | `CIS_TLS_MODE=trusted` (or unset) — pinned CA, `rejectUnauthorized: true` |
| `insecure-dev` | Local development only; **refused** when `CI` is set or `NODE_ENV=production` |
| TLS scope | Unverified TLS applies only to the CIS Undici dispatcher — never a global Node setting |
| TLS version | Current development endpoint requires **TLS 1.2** (`CIS_TLS_MAX_VERSION=TLSv1.2`) |
| Auth bypass | `bypass_auth=true` query param is sent **only** in `insecure-dev` with `CIS_DEV_BYPASS_AUTH=true` |
| Forbidden | **`NODE_TLS_REJECT_UNAUTHORIZED` is not supported** — do not set it globally or in `.env` |
| Model claims | One sandbox demo does **not** prove the best model; use `cis:benchmark` for cross-model evidence |
| Trusted operation | Official CA bundle + fingerprint remain **required** for trusted/production use |

### Trusted operator commands

**Host root vs nested checkout:** When ada-scan is installed at the host project root
(`npx ada-scan init` creates `.scan-config.json` there), run `pnpm cis:*` from that root
and dotenv loads `./.env` automatically. In **this repository's nested checkout**
(`ada-scan/` inside the host tree, no host `.scan-config.json`), prefix commands with
`ADA_SCAN_ROOT=..` so dotenv loads the gitignored host `.env` at the repo root.

From `ada-scan/` (nested checkout — source tree layout):

```bash
pnpm cis:configure -- \
  --collection "$HOME/Documents/bruno/ml-https" \
  --env "../.env" \
  --ca-bundle "$APPROVED_CIS_CA_BUNDLE" \
  --ca-sha256 "$APPROVED_CIS_CA_SHA256"
ADA_SCAN_ROOT=.. pnpm cis:models
```

Benchmark only model IDs returned by `cis:models` (remove absent IDs; never guess aliases):

```bash
ADA_SCAN_ROOT=.. pnpm cis:benchmark -- \
  --report "../.ada-scan/latest.json" \
  --local-root ".." \
  --models "anthropic.claude-opus-4-8,anthropic.claude-sonnet-5,anthropic.claude-sonnet-4-20250514-v1:0" \
  --max-units 15
```

### Sandbox demo (one-file ADA, local only)

For guarded local development against the current CIS endpoint, set the development controls
in the gitignored root `.env` (see [cis-contract.md § Development mode](docs/cis-contract.md#development-mode-insecure-dev-local-only)).
Then from `ada-scan/` (nested checkout — use `ADA_SCAN_ROOT=..` as above):

```bash
ADA_SCAN_ROOT=.. pnpm cis:models
ADA_SCAN_ROOT=.. pnpm cis:demo -- \
  --source .. \
  --file src/partials/layout/header.liquid \
  --route / \
  --session demo-sonnet5-header \
  --ui
```

**Session layout** (under host project root):

```text
scan-reports/fix-sessions/<session-id>/
  demo-workspace/          # persistent sandbox copy (source edits apply here only)
  artifacts/
    candidate.patch
    fixed/<target-file>    # e.g. fixed/src/partials/layout/header.liquid
    evidence.json
  session.json             # review state (no credentials)
  transaction-<id>/        # apply journal + snapshots
```

**Workbench action order** (exact sequence):

```text
Generate proposal
→ acknowledge every manual check
→ Run isolated verification
→ Accept
→ Approve exact diff
→ Apply
→ Rollback sandbox
```

The workbench shows a persistent warning when `transportSecurity === 'insecure-dev'`.
Original host source is never modified; apply and rollback operate on `demo-workspace/` only.

**Evidence inspection** (after apply + rollback; from repo root):

```bash
node -e '
const fs = require("node:fs");
const p = "scan-reports/fix-sessions/demo-sonnet5-header/artifacts/evidence.json";
const evidence = JSON.parse(fs.readFileSync(p, "utf8"));
if (!evidence.originalUnchangedAfterApply ||
    !evidence.originalUnchangedAfterRollback ||
    !evidence.sandboxRestored) process.exit(1);
console.log(JSON.stringify({
  model: evidence.modelId,
  originalUnchangedAfterApply: evidence.originalUnchangedAfterApply,
  originalUnchangedAfterRollback: evidence.originalUnchangedAfterRollback,
  sandboxRestored: evidence.sandboxRestored,
  transactionId: evidence.transactionId,
}, null, 2));
'
```

Expected: all three booleans are `true`. Inspect `artifacts/candidate.patch` and
`artifacts/fixed/…` for the exported diff and post-apply file; delete
`scan-reports/fix-sessions/demo-*` when finished (gitignored).

No ADA-specialized model is proven; `CIS_MODEL` is candidate-hash input with no silent
runtime fallback. Activate only after inventory, minimal prediction, benchmark artifact,
and one-file review acceptance. Legacy `scripts/cis-characterize.js` uses unpinned
`bypass_auth` probing and is **not** a substitute for `cis:models`/benchmark validation.

## Environment variables (`.env`)

```bash
CIS_PROXY_URL=…        # cis fix mode — see Live CIS operator workflow
CIS_AUTH_TOKEN=…
CIS_ALLOWED_HOSTS=…    # comma-separated explicit allowlist
CIS_PROVIDER=aws
CIS_MODEL=…
CIS_CA_BUNDLE_PATH=…   # approved PEM bundle (outside repo; trusted mode only)
CIS_CA_SHA256=sha256:… # pinned bundle fingerprint (trusted mode only)
CIS_TLS_MODE=trusted   # or insecure-dev (local only — see cis-contract.md)
CIS_INSECURE_DEV_ACK=… # exact ALLOW_UNVERIFIED_CIS_TLS when using insecure-dev
CIS_TLS_MAX_VERSION=…  # TLSv1.2 required for insecure-dev
CIS_DEV_BYPASS_AUTH=…  # true for insecure-dev only
ADA_SCAN_DEPLOYMENT_URL=https://careers.example.com # attested hybrid scope
GOOGLE_API_KEY=…       # PageSpeed Insights — higher rate limits for remote URLs
ADA_SCAN_ROOT=…        # explicit host root override (required for a nested checkout)
```

## Notes

- HTML reports embed source snippets + `outerHTML`; review before sharing
  externally.
- This package pins Playwright and `@axe-core/playwright` for stable scan
  results; benchmark and release evidence should record the effective versions
  externally when comparing baselines across upgrades.
- Requires Node ≥ 20.18.1, ESM host.
- The trusted CIS transport requires its configured host allowlist and HTTPS
  (except explicit loopback development); it never sends `bypass_auth=true`.
  Guarded `insecure-dev` may send `bypass_auth=true` only with every required
  development guard — see [cis-contract.md](docs/cis-contract.md).
