# ada-scan

On-demand **WCAG 2.2 AA** accessibility + performance scanner and interactive
auto-fixer for Liquid/Vite sites (local-career-site conventions) and live URLs.

Four scan layers — axe-core, an 83-rule accessScan engine, W3C Nu HTML Checker,
dead-link crawler, Lighthouse/PSI, plus behavioral checks (keyboard, focus
traps, ARIA live, dynamic content, screen-reader tree) — normalized into one
violation schema, traced back to source `.liquid` file + line, and fixable via
deterministic rules or six AI/IDE fix modes.

> Automated tooling can only fully verify roughly a third of WCAG success
> criteria. **ada-scan augments, it does not replace, manual accessibility
> audit.** AI-proposed fixes (alt text, ARIA) are drafts requiring human review.

## Install

```bash
pnpm add -D git+https://<your-git-host>/ada-scan.git#v1.0.1
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
pnpm scan                      # all pages (local instrumented build + tracing)
pnpm scan --page /jobs         # single page
pnpm scan --changed-only       # only pages with modified .liquid files
npx ada-scan --url https://…   # scan a live URL (no build/config needed)
pnpm scan:fix                  # scan + interactive terminal fix (claude default)
pnpm scan:fix:cursor           # write fix context for Cursor / VS Code / Windsurf
pnpm scan:baseline             # save ROI baseline
pnpm scan:report               # regenerate reports from last scan
```

Only `init` is a subcommand; everything else is flags passed straight through
(`--fix`, `--fix-mode`, `--ui`, `--layers`, `--psi/--no-psi`, `--dry-run`, …).

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

## Environment variables (`.env`)

```bash
ANTHROPIC_API_KEY=…    # claude fix mode
OPENAI_API_KEY=…       # codex fix mode
CIS_PROXY_URL=…        # cis fix mode
CIS_AUTH_TOKEN=…
CIS_MODEL=…
GOOGLE_API_KEY=…       # PageSpeed Insights — higher rate limits for remote URLs
ADA_SCAN_ROOT=…        # explicit host root override (useful in monorepos)
```

## Notes

- HTML reports embed source snippets + `outerHTML`; review before sharing
  externally.
- This package pins Playwright and `@axe-core/playwright` for stable scan
  results; benchmark and release evidence should record the effective versions
  externally when comparing baselines across upgrades.
- Requires Node ≥ 20.18.1, ESM host.
