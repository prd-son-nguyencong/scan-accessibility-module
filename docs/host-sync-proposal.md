# Host repository sync proposal (T-E9.6, NEW-4)

**Status: proposal. Nothing here was applied.** ada-scan never edits the host repository; the host repo owner reviews
and applies these changes. Facts below were read from the host working tree on 2026-10-27 (read-only).

## What is wrong

1. **Stale embedded scanner.** `scripts/scan/` (65 tracked files: `fixer`, `reporter`, `scanner`, `tracer`, `utils`)
   is the old embedded scanner. The module now lives in `scan-accessibility-module/`, so two copies can drift and a
   developer can run the wrong one.
2. **`scan:*` scripts point at the old copy.** `package.json` runs `node scripts/scan/index.js ...` for `scan`,
   `scan:fix`, `scan:fix:ai`, `scan:fix:cursor|vscode|windsurf|codex|claude|cis`, `scan:url`, `scan:baseline`, `scan:report`.
3. **Tracked reports get overwritten (NEW-4).** `scan-reports/` has 60 tracked files, and the old scanner writes
   `latest.json`, `roi-comparison.html`, `roi-technical.html` there. The module writes to `.ada-scan/` by default (ignored),
   so only the old copy still dirties tracked files.
4. **CI paths are stale (OPS-1).** `.github/workflows/accessscan-corpus.yml` and `accessscan-drift.yml` use
   `working-directory: ada-scan`, `ada-scan/**` path filters and `cache-dependency-path: ada-scan/pnpm-lock.yaml`. The
   directory is `scan-accessibility-module/`, so those workflows run against a path that does not exist.
5. **Lockfile and `postinstall` drift.**
   - `scan-accessibility-module/` is untracked in the host and has its own `pnpm-lock.yaml`, while the host
     `pnpm-lock.yaml` also lists `playwright`, `@axe-core/playwright` and `lighthouse` as host dependencies
     (host `package.json` lines 16, 28, 34), so scanner versions can differ between the two installs.
   - The host `pnpm-workspace.yaml` has no `packages:` list (only `overrides`), but it makes the module a nested directory
     of a pnpm workspace root: a `pnpm` command in the module is handled by the host workspace, and pnpm 11 may run an
     implicit `pnpm install` before scripts. The host `postinstall` (`pnpm link ../web-component-poc`) can then re-enter pnpm.
     `ada-scan doctor` reports this as a `package-manager` WARN.
   - The host `pnpm-workspace.yaml` has an uncommitted edit (an added `web-component-poc: link:../web-component-poc` override);
     decide whether to commit it.

## Proposed changes (host repo owner)

Review each step; run from the host root. Steps 1 to 3 are independent of 4 to 6.

```bash
# 1. Track the module (or move it to its own repository and install it as a dependency instead).
git add scan-accessibility-module/ && git status --short | head   # check .gitignore keeps node_modules/, .ada-scan/, .env out

# 2. Point the scan scripts at the module (edit package.json "scripts"):
#    "scan":          "ada-scan",
#    "scan:url":      "ada-scan --url",
#    "scan:baseline": "ada-scan --baseline",
#    "scan:report":   "ada-scan --report-only",
#    "scan:export":   "ada-scan fix --export",
#    "scan:doctor":   "ada-scan doctor",
#    and remove scan:fix:ai, scan:fix:codex, scan:fix:claude, scan:fix:vscode, scan:fix:windsurf.
#    Keep scan:fix:cis as: "ada-scan --fix --fix-mode cis --ui"
#    "ada-scan" resolves once the module is installed as a dependency, for example
#    "ada-scan": "link:./scan-accessibility-module" under devDependencies (pnpm install --lockfile-only to refresh).

# 3. Retire the embedded copy once step 2 is merged and one scan has been compared against it.
git rm -r scripts/scan

# 4. Stop tracking generated reports (they now go to the ignored .ada-scan/). Keeps local copies.
git rm -r --cached scan-reports && echo "scan-reports/" >> .gitignore

# 5. Fix CI paths: replace ada-scan with scan-accessibility-module in the two workflows
sed -i.bak 's#ada-scan/#scan-accessibility-module/#g; s#working-directory: ada-scan#working-directory: scan-accessibility-module#' \
  .github/workflows/accessscan-corpus.yml .github/workflows/accessscan-drift.yml && rm .github/workflows/*.bak
git diff .github/workflows   # review: only path strings may change

# 6. Make the install deterministic.
#    Either list the module in pnpm-workspace.yaml:  packages: ['.', 'scan-accessibility-module']
#    (one lockfile at the host root, delete scan-accessibility-module/pnpm-lock.yaml), or keep it outside the workspace.
#    Remove duplicate scanner dependencies (playwright, @axe-core/playwright, lighthouse) from the host package.json
#    unless the host build uses them itself. Refresh the lockfile once: pnpm install --lockfile-only
#    Keep the postinstall tolerant (it already ends in "|| true").
```

## Verify after applying

```bash
pnpm_config_verify_deps_before_run=false npx ada-scan doctor     # no package-manager WARN about a nested workspace
npx ada-scan --url <preview-url> --out-dir /tmp/ada-check          # writes nothing under the host's tracked files
git status --short                                                 # clean apart from the intended changes
```

## Not covered

- Whether `scripts/scan/` still holds behavior the module lacks was not diffed; compare one scan of the same page with both before step 3.
- Removing `scan-reports/` history from git (history rewrite) is out of scope; step 4 only stops tracking.
