# Changelog

All notable changes to `ada-scan`. Versions are released as Git tags
(`git+https://…#vX.Y.Z`). Follows SemVer.

**accessScan `ruleId`s are a public contract** — a ruleId rename/removal is a
breaking change and must be documented here so `scan:baseline` / ROI diffs stay
comparable across upgrades.

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
