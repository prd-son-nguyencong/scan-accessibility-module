# Fix benchmark and real-site procedure

The benchmark measures the fixers (recipes, CIS, external tool) through the harness (`docs/fix-harness.md`) on a seeded-fault corpus and evaluates the
release criteria of section 9. It never writes to a site: every task runs on a private temp copy that is removed afterwards.

## 1. What is in the box

| Piece | Where |
| --- | --- |
| Fixer adapters | `src/fix/harness/fixers/` (`recipes.js`, `cis.js`, `external.js`, `common.js`) |
| Corpus (6 neutral sites, manifest) | `test/fixtures/fix-corpus/` (`manifest.json`, `sites/<id>/src/{pages,partials,styles,scripts,assets}`) |
| Corpus tooling (render, tasks, context) | `scripts/lib/fix-corpus.js` |
| Metrics and release criteria | `scripts/lib/fix-benchmark.js` (`runBenchmark`, `buildReport`, `evaluateRelease`) |
| CLI | `scripts/fix-benchmark.js` |
| Built-in runner on the harness foundation | `scripts/lib/fix-foundation-runner.js` (gates G2 to G7, no scanner) |

Each corpus site is Liquid pages and partials with `.liquid.json` sidecars, CSS and a script, rendered by the same static approach as `test/fixtures/harness-site`
(plus `for` loops over the sidecar). The manifest lists per defect: `rule`, `file`, `line`, an `anchor` on that line, the element and evidence (an export task shape),
the allowlist `scope`, the expected fix as exact `{ path, find, replace }` edits, whether the recipes fixer must reproduce it (`recipe`), and optional `targets` and
`documented` selectors. Per site `wrongFixes` lists the tempting wrong fixes with the gates expected to fire (`expect`); `needsScanner` marks those only G1 can catch and
`needsPerf` those only G7 can catch. `test/fix/fix-corpus.test.js` keeps lines, anchors and edits honest.

## 2. Running it

```bash
# Corpus self-check and gate check with the built-in runner (needs Chromium; about 2 to 3 minutes, one process, nice it on a loaded machine)
nice -n 15 node scripts/fix-benchmark.js --runner foundation --fixers recipes,oracle --out /tmp/fix-bench.json

# One site, determinism check (the whole run twice, decisions compared)
nice -n 15 node scripts/fix-benchmark.js --runner foundation --site harbor-doc --repeat 2

# With the controller runner (src/fix/harness/runner.js, used automatically when the file exists)
node scripts/fix-benchmark.js --fixers recipes,cis,external --external-dir ./external-diffs --repeat 2 --check
```

Options: `--runner <foundation|module>`, `--fixers recipes,cis,external,oracle`, `--external-dir <dir>` (diffs named `<defect-id>.diff`), `--site <ids>`, `--max-repairs <n>`,
`--perf`, `--repeat <n>`, `--out <file>`, `--check` (exit 1 when a release criterion fails; open criteria do not fail), and the manual real-site facts
`--real-sites <n> --broken-in-review <n> --perf-gain <yes|no>`. `oracle` applies the manifest's expected fix: it checks the corpus itself and gives the upper bound.
The `cis` fixer uses the normal trusted CIS configuration (`resolveCisConfig`, environment only, never printed); acceptance against the real endpoint is a separate step.
The unit tests use a mock server on 127.0.0.1 only.

## 3. Runner contract

`runner.runTask({ siteId, siteRoot, siteLang, routes, task, fixer, maxRepairs, perf })` resolves to

```
{ decision: 'auto_accept' | 'human_review' | 'rollback' | 'declined' | 'unverified',
  iterations,          // fixer calls that produced a candidate (repairs = iterations - 1)
  failedGates,         // gate ids of the last candidate, empty when accepted
  reason?, evidence?,  // decline reason or rollback summary; first failed-gate evidence (kept in the JSON report)
  resolved,            // target findings gone after apply, or null when the runner has no scanner
  regressions,         // anything the rescan or review found broken
  perfDelta? }         // { score, lcp, tbt, cls, transfer, regressed }
```

`siteRoot` is a copy owned by the benchmark; a runner may apply an accepted candidate to it and nowhere else. The runner builds the fixer context itself (see
`readTaskContext`; the benchmark's stub and foundation runner use `contextFor`) and drives the repair loop by passing `previous` and `gateEvidence` back into
`fixer.propose(task, context)`. A runner without the scanner gate G1 sets `scanner = false` on itself: nothing is then called resolved, tempting fixes that only G1 can catch
come back unverified, and `fix-rate-90` stays `open`. Tempting wrong fixes run with `maxRepairs` 0 and a scripted fixer: the harness, not the fixer, must reject them.

## 4. Metrics and release criteria

Printed and written as JSON: fix rate, break rate, false-accept rate, rollback rate, mean repairs, perf delta (median of accepted candidates), per fixer and combined, and
every tempting fix with the gates that fired (`gateMatch` says whether an expected gate fired; rejection by a different gate still counts as rejected). Definitions are in
`docs/fix-harness.md` section 9. `evaluateRelease` turns them into criteria: `break-rate-zero`, `false-accept-zero`, `all-tempting-verified`, `fix-rate-90`,
`no-unexplained-leftovers`, `no-perf-regression`, `deterministic-twice`, and the manual ones `real-site-copies-3`, `review-no-broken-auto-accepts`, `perf-gain-on-real-site`.
`pass: true` needs every criterion true; a criterion that cannot be decided is `open`, never silently true.

## 5. Real-site procedure (copies only)

Goal: run the harness on at least three real sites of different structure without ever writing to them.

1. Work from a clean checkout of the site repo. If it has uncommitted work, stop: copy only a committed state (`git worktree add <scratch>/site-copy <commit>` or `git clone --no-hardlinks <repo> <scratch>/site-copy`; never `cp` a dirty tree).
2. Keep the copy outside the original directory and remove its remote (`git remote remove origin`) so nothing can be pushed from it. Install only what the site already needs.
3. Scan the copy: `ada-scan` against the copy's dev server or build, writing the report into a scratch directory.
4. Run the harness on the copy with a recipe-only config, then with CIS. Use the controller (`ada-scan fix`) pointed at the copy; every candidate is applied only in the shadow tree, and only accepted candidates are applied to the copy.
5. Record per task: decision, gates, perf table, diff, the CIS telemetry (redacted). Keep these under the scratch directory.
6. Review: a person inspects every auto-accepted diff in full and a sample of the rest, checking the page visually and with the keyboard. Count candidates that are broken in `--broken-in-review`.
7. Check the performance track on at least one copy for a measured gain (`NO_MEASURED_IMPROVEMENT` rollbacks are expected where there is none).
8. Feed the totals to the benchmark: `--real-sites 3 --broken-in-review 0 --perf-gain yes` with the corpus run (`--check`).
9. Delete the scratch directory. The original checkout's `git status` must be unchanged from before.

Never run against a production URL for writes, never give the harness a path inside the original repo, and never commit the copies or the reports of customer sites; keep customer names out of any shared artifact.
