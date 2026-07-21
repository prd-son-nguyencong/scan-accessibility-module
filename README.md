# ada-scan

On-demand **WCAG 2.2 AA** accessibility + performance scanner and interactive
auto-fixer for Liquid/Vite sites (local-career-site conventions) and live URLs.

Four scan layers — axe-core, an accessScan-compatible rule engine, W3C Nu HTML Checker,
dead-link crawler, Lighthouse/PSI, plus behavioral checks (keyboard, focus
traps, ARIA live, dynamic content, screen-reader tree) — normalized into one
violation schema, traced back to source `.liquid` file + line, and fixable via
deterministic rules or six AI/IDE fix modes.

> Automated tooling can only fully verify roughly a third of WCAG success
> criteria. **ada-scan augments, it does not replace, manual accessibility
> audit.** AI-proposed fixes (alt text, ARIA) are drafts requiring human review.

## Install

```bash
pnpm add -D git+https://<your-git-host>/ada-scan.git#v1.1.0
npx ada-scan init
```

`init` (idempotent) scaffolds `.scan-config.json`, registers the Vite plugin in
`vite.config.*`, adds `scan*` scripts to your `package.json`, and installs the
Playwright Chromium browser. Flags: `--force`, `--yes`, `--no-browsers`.

If `init` cannot safely edit your `vite.config`, it prints the snippet to add:

```ts
import { scanInstrumentationPlugin } from 'ada-scan/vite';
export default defineConfig({
  plugins: [scanInstrumentationPlugin(), /* …existing plugins */],
});
```

## Usage

```bash
cd ada-scan

# toàn bộ pages (local instrumented build + tracing)
npx ada-scan --all --include-third-party --psi --verbose --no-fail

# 1 page
npx ada-scan --page / --include-third-party --psi --verbose --no-fail

# local URL (sau khi site chạy / tool tự build)
npx ada-scan --url "http://localhost:1234/" --include-third-party --psi --verbose --no-fail

# Staging shell-only (không hydrate jobs/chat) — so sánh crawl / local shell
npx ada-scan --url "https://hitachi728.preview.sites.stg.paradox.ai/" \
  --no-hydrate-jobs --psi --verbose --no-fail

# Local shell-only (không hydrate jobs/chat)
npx ada-scan --page / --no-hydrate-jobs --psi --verbose --no-fail

# Shortcuts / other modes
pnpm scan                      # all pages via host package scripts
pnpm scan --page /jobs
pnpm scan --changed-only
npx ada-scan --url https://… --exclude-third-party
pnpm scan:fix
pnpm scan:fix:cursor
pnpm scan:baseline
pnpm scan:report
```

`init` and `fix` are subcommands. Normal scans use flags passed straight through
(`--fix`, `--fix-mode`, `--ui`, `--layers`, `--psi/--no-psi`, `--dry-run`, …).
Remote URL scans include third-party content by default to match commercial
whole-page scanners. Local scans still require `--include-third-party`.
Use `--no-hydrate-jobs` when comparing local Vite shells to staging without
jobs/search/chat hydration (blocks widget bundles, strips leftover mounts, and
turns off accessScan scroll activation; also implies exclude-third-party).

## Oracle parity / crawl compare (copy-paste)

Run from `ada-scan/` when diffing against accessiBe accessScan or W3C Nu Html
Checker. Replace the URL with the staging page under test.

```bash
cd ada-scan

# 1) Crawl accessScan oracle (get-scan-details + DOM) — authoritative occurrence counts
node scripts/scrape-accessscan-dom.mjs \
  --url "https://hitachi728.preview.sites.stg.paradox.ai/" \
  --out docs/accessscan-hitachi-dom-scrape-demo.json

# 2) Commercial-parity accessScan (jobs/chat hydrate on)
npx ada-scan --url "https://hitachi728.preview.sites.stg.paradox.ai/" \
  --layers accessScan --include-third-party --psi --verbose --no-fail

# 3) Nu Html Checker (errors + warnings)
npx ada-scan --url "https://hitachi728.preview.sites.stg.paradox.ai/" \
  --layers w3c --include-third-party --psi --verbose --no-fail

# 4) Optional: accessScan + axe
npx ada-scan --url "https://hitachi728.preview.sites.stg.paradox.ai/" \
  --layers axe,accessScan --include-third-party --psi --verbose --no-fail

# 5) Staging shell-only (no jobs/chat hydrate) — khớp local --no-hydrate-jobs
npx ada-scan --url "https://hitachi728.preview.sites.stg.paradox.ai/" \
  --layers accessScan --no-hydrate-jobs --psi --verbose --no-fail
```

Reports: `scan-reports/latest.json`, `scan-reports/scan-visual.html`. Diff oracle
`api.byCategory.*.failures` against V2 finding `count` sums (aliases:
`FocusNotObscuredHeader` ↔ `StickyHeaderObscuresFocus`, `TabListMisMatch` ↔
`TablistRole`, `PageMetaViewportValid` ↔ `MetaViewportScalable`). Playbook:
[docs/accessscan-parity-playbook.md](./docs/accessscan-parity-playbook.md).

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
  --report scan-reports/latest.json \
  --source . \
  --session careers-review \
  --ui
```

Rerun the same `fix` command with the same `--session` value to resume persisted
decisions from
`scan-reports/fix-sessions/<session-id>/session.json`. Session IDs may contain
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

The older `src/fixer/` path and non-CIS modes remain temporarily available for
migration and IDE context generation. They are deprecated for CIS fixes: new
integrations must not reuse their direct-write, wildcard-CORS, git-stash rollback,
or legacy CIS transport paths.

## Report contract

`scan-reports/latest.json` uses `ScanReportV2` (`schemaVersion: "2.0.0"`).
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

The HTML reporter and legacy fixer currently receive a pure V1 projection. New
integrations should consume V2; the compatibility projection is temporary.

## Configuration (`.scan-config.json`)

Host-integration is fully config-driven so ada-scan is not hardcoded to any one
repo:

| Field | Purpose |
|-------|---------|
| `baseUrl` | Local dev URL (dev-server readiness port is derived from this) |
| `devCommand` / `buildCommand` / `buildEnv` / `outDir` | How to start dev + run the instrumented build |
| `source` / `distMap` | Source layout + built-HTML→source mapping for tracing |
| `thirdParty` | Selectors/tokens for third-party widgets to skip (Paradox defaults; set `[]` if none) |
| `layers` | Toggle any scan layer |
| `skipRules` / `suppress` | Global rule skips + targeted false-positive suppression (audited in reports) |

## Dependencies

- **Required:** `playwright`, `@axe-core/playwright`, `fast-glob`, `dotenv`
  (pinned Playwright/axe for stable browsers + rule results).
- **Optional (lazy):** `lighthouse` + `chrome-launcher` (Lighthouse layer),
  `@anthropic-ai/sdk` (claude mode), `openai` (codex mode). Missing optional
  deps degrade gracefully with an install hint — they never crash a scan. The
  `cis` mode and IDE modes need no SDK.
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
  --report "../scan-reports/latest.json" \
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

**Implementation verification (2026-07-16):** from `ada-scan/`, contract/redaction
25/25, trusted-fix 491/491, full `pnpm test` 851/851; repository build via
`cd .. && pnpm build` exit 0. Point-in-time baseline — counts may change; see
[cis-contract.md § Implementation verification](docs/cis-contract.md#implementation-verification-2026-07-16).

## Environment variables (`.env`)

```bash
ANTHROPIC_API_KEY=…    # claude fix mode
OPENAI_API_KEY=…       # codex fix mode
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
ADA_SCAN_ROOT=…        # explicit host root override (required for nested ada-scan/ checkout)
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
