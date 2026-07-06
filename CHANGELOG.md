# Changelog

All notable changes to `ada-scan`. Versions are released as Git tags
(`git+https://…#v1.0.0`). Follows SemVer.

**accessScan `ruleId`s are a public contract** — a ruleId rename/removal is a
breaking change and must be documented here so `scan:baseline` / ROI diffs stay
comparable across upgrades.

## [1.0.0] - 2026-07-06

### Added
- Initial extraction from `local-career-site` into a standalone,
  Git-installable package (Approach A: config-driven host resolver).
- `ada-scan init` — scaffolds `.scan-config.json`, registers the Vite plugin,
  adds host scripts, installs Playwright Chromium.
- Config-driven host integration: `devCommand`, `buildCommand`, `buildEnv`,
  `outDir`, `source`, `distMap`, `thirdParty`, `suppress`.
- Graceful degradation for optional deps (lighthouse/chrome-launcher, AI SDKs).
