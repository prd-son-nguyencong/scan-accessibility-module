# Phase 0 baseline (T-E0.2)

Measured on branch `ada/p0-a-tests` after the hermetic-test and CI/package commits (before the undici change), Node v24.13.0, macOS, `npm test` (which loads `test/helpers/hermetic-env.mjs`). Node 20.18.1 is not installed on this machine, so the Node 20 baseline could not be taken; Node 22.18.0 was used only for the undici spike.

## Full suite (Node 24.13.0, hermetic)

| tests | pass | fail | skipped | duration |
|---|---|---|---|---|
| 1399 | 1381 | 18 | 0 | 664 s |

Before this branch the same suite had 13 environment-caused failures (ambient `.env`, host files) on top of the ones below.

### The 18 failures

| Group | Count | Tests | Cause |
|---|---|---|---|
| Corpus replay (D5) | 9 | `access-scan-signal-policy-projection` "eight-site corpus replay exact gate"; `accessscan-corpus-cli` verify CLI; `accessscan-corpus-differential` x2; `accessscan-corpus-drift-all` x2; `accessscan-corpus-gaps` "passes replay equivalence"; `accessscan-corpus-manifest` "eight seeded committed cases"; `accessscan-corpus-tooling` "eight seeded cross-site fixtures" | AltMisuse identity hash mismatch on site-124/203/731 (see bisect below) |
| Review workbench (OPS-4) | 7 | `fix/review-workbench-csp` "loads diff-view module"; `fix/review-workbench` x6 (diff table, safe DOM, insecure-dev banner, sandbox card, rollback x2) | `src/fix/review/workbench.html` was never wired to diff-view/rollback UI |
| Flaky / network | 2 | `access-scan-cutover` "activates below-fold lazy content" (timing, passes alone); `accessscan-corpus-network-guard` "allows public CDN subresources" (real request to a CDN) | OPS-22 |

9 + 7 + 2 = 18.

## Corpus verify bisect (D5)

Command: `ADA_SCAN_ROOT=<wt> ADA_SCAN_NO_DOTENV=1 node scripts/accessscan-corpus/verify.js`, run in a temporary separate worktree (removed afterwards, no reseed).

Result: there is no culprit among the commits after the fixture commit.

- `308eb2e` ("fix: update access scan", the fixture commit) is the root commit of the module repo (1 commit of history before it, nothing older to test). `verify.js` already fails there, with the same three cases and the same fingerprints as on HEAD (`3b63588`):
  - site-124: 2 `AltMisuse` identities changed (`policy_mapping`, `policy_projection_delta`)
  - site-203: 1 changed, site-731: 3 changed
  - e.g. site-124 expected `sha256:3f79471b...` vs actual `sha256:df160b87...`, same value at 308eb2e, 9389afd, d77ffcc, 84d17f1 and HEAD.
- `git bisect` between `308eb2e` (assumed good) and HEAD therefore reported the first commit after it, `84d17f1` ("release: ada-scan v1.1.0"), as "first bad". That commit only changes `package.json` version, `README.md` and `CHANGELOG.md`; it is an artifact of the false "good" assumption, not a cause.
- The suspected commits `9389afd` (rule 83, NavigationWrapperMissingRole) and `c2cbd08` are not the cause: verify output at `9389afd` is already identical to `308eb2e`.
- Between `308eb2e` and HEAD the only corpus-related file touched is `test/fixtures/access-scan/catalog-rule-ids.json` (+2/-1); nothing under `scripts/accessscan-corpus` or `test/fixtures/accessscan-corpus`.

What the diff looks like: the committed fixtures (`expected.json` and `snapshot.json`) store the svg `role` as a pseudonym (`neutral-text-0-20401466`) while `page.html` has `role="image"` / `role="img"`; the AltMisuse element identity is computed from role and attributes, so the replayed identity differs from the seeded one. Not proven which side is stale. Whether the failure is environment dependent (shared `node_modules` at HEAD versions instead of what `308eb2e` was seeded with, Chromium build) could not be ruled out from here, because older install trees were not rebuilt.

Intent: nothing in the 8 later commits looks like an intentional change to AltMisuse identity. The fixtures were most likely sealed in a state the code at `308eb2e` could not reproduce here. Recommendation for D5: do not hunt a regression; decide between reseeding (`seed.js --reprocess-committed` for 124/203/731, then review the diff) and fixing pseudonymization of `role`, and keep the CI corpus job non-blocking until then.

### D5 resolution (root cause)

The role-pseudonym hypothesis above was wrong: replay builds the semantic descriptor from `snapshot.json` and sanitizes it, and that descriptor is identical to `expected.json` (`role` `neutral-text-0-20401466` = pseudonym of `image`). The fingerprint differs only in `evidence.checkId`: the fixtures stored `general:alt-misuse` (and `interactive:button-discernible`, `violationType` `confirmed`), while the code, unchanged since the root commit, emits `parity:alt-misuse`, `interactive:button-discernible-authored` and `commercial-parity` for the `commercial-parity` profile. So site-124/203/731 were stale seeds (cause 2); not environment dependent.

Fix: `seed.js --reprocess-committed --id site-124 --id site-203 --id site-731` (regenerates `expected.json`/`snapshot.json` from the committed `page.html` with the current code; needs no oracle payload). `pseudonymizeHumanText` was not idempotent, so that command re-hashed every placeholder in `page.html`; it now returns neutral placeholders unchanged (test added), leaving `page.html` byte-identical. `source-manifest.json` stableCaptureHashes updated by the same command. `corpus:verify` and the 9 failing tests now pass. Gate not weakened.

## Related spike results

- undici 7.30.1 on Node 22.18.0: `test/fix/cis-*.test.js` and `test/cis-*.test.js`, 261/261 pass. Applied as `undici ^7.30.1`. undici 7 `engines.node` is `>=20.18.1`; installed undici 8.10.0 requires `>=22.19.0`. Node 20.18.1 itself could not be tested.
