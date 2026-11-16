# Handover: ada-scan

This page is for the next owner of `ada-scan`. It says what the tool is, what is finished, what is not, how to run and measure it, and what to do next, in order. Read it first, then [setup-with-local-career-site.md](setup-with-local-career-site.md) and [developer-guide.md](developer-guide.md).

State at handover: version 1.2.1 (tag `v1.2.1`), branch `main` of the module repository. Test suite: about 2950 tests, all green when run on a quiet machine. Measured accuracy: see [accuracy-commitments.md](accuracy-commitments.md).

## 1. What the tool is for

A QA tool for Paradox career sites built with the PDK (Liquid + Vite). It does three jobs:

1. **Scan**: accessibility (WCAG 2.2 A and AA), HTML validity and page speed, on desktop (1280 px) and mobile (390 px).
2. **Trace**: each finding points to the source `file:line` that must change.
3. **Fix safely**: a developer lets an editor chat (the CIS chat in Cursor) change the code. The tool then checks the change did not break the page.

The product flow:

```
scan  ->  report + one task file per finding  ->  CIS chat edits the code  ->  tool verifies  ->  scan again
```

In this flow the tool does not edit the site. The CIS chat is a separate extension; we do not modify it.

## 2. What is finished

| Area | State |
|---|---|
| Scan layers: axe, accessScan rules, HTML validation, links, Lighthouse, keyboard, focus trap, dynamic content, screen reader, measured checks | Done |
| Verdict tiers: `confirmed` (proven, needs recorded proof), `likely`, `needs-review` | Done. Only `confirmed` fails a gate. |
| Source tracing (Liquid tag index, structural source, behaviour script) | Done. On reviewed real-site rows the cited line was right for about 91 to 100 percent of confirmed findings (reviewer judged, so a rough figure). |
| Fix export for Cursor and Claude Code (`fix --export --target ...`) | Done |
| Fix harness with 8 gates and `--from-working-tree` | Done. Speed work is in 1.2.x but only measured on one site. |
| `fix --verify` (quick static check of an edit) | Done |
| Deterministic accuracy measurement (`npm run eval:truth`) | Done. No network, no LLM. About 9 minutes. |
| Release hygiene (no customer data in tracked files, test enforces it) | Done |
| Developer guides | Done |

## 3. What is measured, and what is not

Measured, on 231 hand-written fixtures (115 with a seeded defect, 116 clean twins), through the real report pipeline, URL mode:

- Confirmed-tier recall about 71 percent, confirmed false-positive rate about 4 percent.
- 15 success criteria are `validated` (recall about 98 percent on 56 fixtures, 0 false alarms). 6 are `advisory`: 1.3.1, 2.4.7, 2.5.7, 3.2.1, 3.2.2, 4.1.2.

Not measured (do not claim these):

- **Recall on real sites.** Nobody has a ground truth. It is lower than the fixture number.
- **Local-source scans.** They also demote findings that cannot be traced to a file, so confirmed recall there is lower. Not measured.
- **Precision on new real sites.** The last measurement on 13 real sites gave about 95 to 97 percent, but the reviewers were LLM agents and their verdicts changed between runs (the same rows were marked wrong 46 times in one run and 8 times in another). Treat that number as a rough signal only. There is no unseen site left to measure blind.
- **The CIS fix quality.** The live benchmark needs the CIS token and was not run in this release.
- **Node 20.18.1.** `engines` says `>=20.18.1`. Only Node 22 and 24 were run.

## 4. How to run everything

```bash
pnpm install && npx playwright install chromium
npm test                          # full suite. Run on a quiet machine; see pitfalls
npm run eval:truth                # confirmed-tier accuracy on the fixtures, writes docs/accuracy-measured.md
npm run docs:accuracy             # regenerates docs/accuracy-commitments.md and the guide block
npm run truth:metrics             # engine-layer check, writes docs/truth-metrics.md
node bin/ada-scan.js doctor       # environment check
```

Generated documents (do not edit by hand): `docs/accuracy-measured.md`, `docs/accuracy-commitments.md`, `docs/truth-metrics.md`, `docs/verdict-matrix.md`, `docs/seeds-coverage.md`, and the README rule tables. Each has a test that fails when it is out of date.

The thresholds that `eval:truth` enforces are in `docs/accuracy-commitments.json`. Tighten them when a fix lands. Never loosen them to make a run pass.

## 5. Where things are

| Path | What it holds |
|---|---|
| `src/scanner/` | The scan layers and measured checks (`measured-checks.js`: contrast, target size, label in name) |
| `src/scanner/access-scan/` | The accessScan rule engine |
| `src/tracer/` | Finding to `file:line` |
| `src/reporter/` | Report v2, verdict gate, engine agreement |
| `src/fix/` | Export, harness, verify, CIS client (`src/fix/cis`), controller |
| `src/fix/harness/` | The shadow workspace, gates G1 to G8, incremental rescan |
| `test/` | Unit and browser tests. `test/fixtures/truth-corpus` and `rule-seeds` are the labelled fixtures |
| `eval/` | Ground truth rows from real-site reviews (`corpus.json`, anonymised), compare and metrics scripts |
| `scripts/` | Doc generators, `eval-truth.js`, benchmarks |
| `docs/` | All documents. `docs/fix-harness.md` and `docs/measured-checks.md` are the best technical references |
| `templates/` | Default config and `list-pages.mjs` |

Repository: `prd-son-nguyencong/scan-accessibility-module` on GitHub. Branch `main` is the line to work from. Tags `v1.2.0` and `v1.2.1` are releases. Branch `release/1.2.0` holds the same release commits.

## 6. Rules the previous owner worked under

Keep these unless you have a good reason and say so.

1. **Fix the tool, never the site source.** Never write scan output into a customer repo; use `--out-dir`.
2. **Never fix colour contrast by changing colours.** It is a design decision.
3. **`data-pdk-*` and `{{data:..}}` belong to the platform.** The tool and the chat must not change them.
4. **Third-party and platform findings are never `confirmed`.** Advisory rules are never `confirmed`.
5. **When a fact cannot be decided, demote the finding (`likely` or `needs-review`). When a real defect can be decided, keep it `confirmed`.** Both directions matter: false alarms cost trust, hidden defects cost users.
6. **House accessibility rules stricter than WCAG** (24 px on all controls, 2 px focus rings, placeholder ban) must never make a finding `confirmed`.
7. **Never commit `node_modules`.** Stage files by path, not with `git add -A`.
8. **CIS insecure-dev mode** (TLS checks off) is for local sandboxes and the synthetic fixtures only. It needs `CIS_INSECURE_DEV_ACK=ALLOW_UNVERIFIED_CIS_TLS`, refuses CI and `NODE_ENV=production`, and must never be used with a real site or real customer code. Never set `NODE_TLS_REJECT_UNAUTHORIZED`. Never print or commit the CIS token. Keep it in a local `.env` with mode 600.
9. **Publish only clean snapshots.** The working history of the original development branch contains customer names and page copy, so it was never pushed. Releases were made as a fresh single commit from a checked tree, then merged into `main` with the old `main` history kept. Do the same, and run `test/release-hygiene.test.js` before every push.

## 7. Known problems and gaps

Ordered by how much they matter.

**Accuracy**

1. Six advisory criteria (section 3). Specific causes:
   - 2.4.7: a removed focus outline is `needs-review` because the keyboard probe confirms only with identical-pixel proof. A hamburger that exists only on mobile is covered by the mobile pass added in 1.2.x (live tested on two sites), but a transition caught mid-way can still hide a missing ring.
   - 2.5.7 and 3.2.1: no confirming rule yet.
   - 1.3.1, 4.1.2: recall is about 50 percent on the fixtures.
2. A meta refresh that a script adds after the page loads is not seen by the redirect guard, so the 2.2.1 finding can be lost.
3. The mobile-only control key (`tag|id|aria-label|text|href`) can treat a mobile control as already seen when it matches a desktop one. Low risk, no test.
4. The mobile disclosure pass is capped at 12 candidates.
5. Duplicate-id checks are decided by real accessible text, but a label compare is case-sensitive in one path.
6. A one-character 2.5.3 label: a lone digit is a review item, other single letters are treated as icon glyphs.
7. Target size is viewport dependent. A control can pass at 1280 px and fail at 390 px. The finding text now names the failing viewport. Reviewers must check the failing viewport, not only desktop.

**Tool behaviour**

8. **Port reuse hazard**: if any server already answers on the dev port (1234), the tool uses it, even when it serves another project. The scan then fails with `HTTP 404` or, worse, scans the wrong site. A check that the server serves this project is a good first fix.
9. The harness is slow on large sites. One measured run on a real site went from about 690 s to about 330 s after the 1.2.x work, but the machine was heavily loaded and the numbers are noisy. The target of about 10 minutes for a medium site is not proven.
10. The harness needs a build command (`verifyBuildCommand` or `buildCommand`). Anything under the shared `.pnpm` store entry is still shared with the project by design.
11. In the working-tree flow a task can never be auto-accepted; edits stay in the tree and the user decides.
12. A dead-link finding now retries twice before it counts, but an external link that recovers is still a `needs-review` row, not silent.

**Process**

13. Four tests are load dependent (sticky header focus, seeds coverage, access-scan cutover, source attribution). They pass when run alone. `test/truth-corpus.test.js` has its own 20 minute timeout.
14. The CI workflow runs Node 22 and 24 only.
15. `eval/corpus.json` uses anonymised site ids (`s01` and so on). The private map from id to real site is not in the repository. A new owner can use the rows for regression checks but cannot map them back.
16. A site's own `postinstall` plus a `link:` override in `pnpm-workspace.yaml` can make `pnpm dev` start itself in a loop (seen on the local career site). Start the dev server yourself, or set `devCommand`. See the troubleshooting table in the setup guide.

## 8. Plan

Do the items in this order. Each has a way to know it is done. Do not start a later group before the earlier one is done, unless a person asks.

### Group 0: before wide rollout (about 1 to 2 days)

| Item | Done when |
|---|---|
| Run the suite on Node 20.18.1 (`nvm install 20.18.1`) and add 20 to the CI matrix | CI green on 20, 22 and 24 |
| Run `npm pack` and install the tarball in a scratch site | `ada-scan doctor` and one scan work from the installed copy; every link in the shipped docs resolves or is marked "repository only" |
| Fix the port reuse hazard (gap 8) | A test starts a foreign server on the port and the scan stops with a clear message |
| Run the whole flow once on a real site: `list-pages.mjs`, full scan, export, a real CIS chat edit, `fix --harness --from-working-tree` | The setup guide matches what you saw; fix the guide where it does not |
| Confirm the company policy on sharing this code outside the company (the code was written for Paradox work) | A written yes, or a decision to keep the repository private |

### Group 1: accuracy you can trust (about 2 to 3 weeks)

The old method (LLM reviewers judging real sites round after round) was noisy and costly (5 to 8 million tokens per round). Stop using it as the measurement. Use these instead:

1. **Grow the labelled fixtures** to at least 10 bad and 10 clean per criterion, with near-miss clean twins. Every real false alarm or miss found in the field becomes a fixture first, then a fix. Keep each pair small and write the reason it is a violation in `labels.json`.
2. **Turn advisory criteria into validated ones, one at a time**: 2.4.7, 2.5.7, 3.2.1, 1.3.1, 3.2.2, 4.1.2. A criterion becomes `validated` only with 3 or more fixtures on each side and confirmed recall at or above 60 percent (the rule in `scripts/lib/confirmed-eval.js`). Aim for 90 percent before you advertise it.
3. **Measure local-source mode**: run the same fixtures as a local Liquid project (with tracing) and record how many confirmed findings are demoted for lack of a source.
4. **Use human labels from the field** (`ada-scan label ... --tp|--fp`, then `labels stats`) as the real-site precision signal. Ask the first pilot developers to label what they fix or reject.
5. Add the script-injected meta refresh case (gap 2).

Done when: every criterion the tool claims in [wcag-coverage.md](wcag-coverage.md) is `validated`, fixture recall for them is 90 percent or more, and field labels from at least 3 sites give a precision number with its interval.

### Group 2: pilot (about 2 weeks)

- Give the tool to 3 developers on 3 different sites. Watch the first hour of each. Record where they stop or ask for help; fix the guide or the tool.
- Collect labels (above) and the harness reports for rolled back tasks.
- Decide with them what a "good run" means (time, noise, number of tasks).

Done when: each of the 3 developers finished scan, fix and verify without help, and the labels give a first field precision number.

### Group 3: CIS loop (needs the CIS token)

- Run the live CIS benchmark (`npm run cis:benchmark`) with a test token against the synthetic fixtures in `test/fixtures/fix-corpus`, under the insecure-dev rules in section 6. Never against real customer code.
- Measure: share of tasks fixed by the chat, share accepted by the harness on the first try, share that cause a regression (layout, behaviour, speed). The regression share is the number that matters most.
- Only after that, consider a closed loop where the tool feeds failed gate evidence back to the chat for one retry.

Done when: the three shares are written down with their sample sizes in `docs/fix-benchmark.md`.

### Group 4: harness speed and polish

- Measure a medium site before and after on a quiet machine and write the real numbers in `docs/fix-harness.md`. Target about 10 minutes.
- Cap and order the candidate file list for large tasks. Keep gates G1 to G8 intact.
- Make `fix --harness` print an estimate before it starts.

### What not to do

- Do not widen `confirmed` to raise recall. Move a rule up only with a fixture pair and a measured number.
- Do not weaken a gate to make a run pass.
- Do not claim compliance. The report never says "compliant".
- Do not run LLM-judged measurement rounds on real customer sites again as the main metric.

## 9. Pitfalls the previous owner hit

- **Quiet machine.** Run the suite and `eval:truth` with few other heavy jobs. Parallel agents and many browsers made tests time out and results differ.
- **Scratch files are temporary.** Anything under the system temp folder can disappear. Keep ground truth in `eval/` and the fixtures, not in scratch.
- **Do not run installers in a customer worktree.** Use a copy.
- **Generated docs.** If a docs test fails after you change a rule, run the matching `docs:*` script and commit the result.
- **`git add -A`** once swept in a symlinked `node_modules`. Stage by path.
- **Merge conflicts** in `CHANGELOG.md` are normal when several branches change it. Keep both sides.
- **Reviewers find edge cases forever.** Stop a branch when the reproduced problems are real defects, not when the review is silent.

## 10. How to release

1. Work on a branch, run `npm test` and `npm run eval:truth` on a quiet machine. Regenerate docs with `npm run docs:accuracy` and the other `docs:*` scripts.
2. Update `CHANGELOG.md` and the version in `package.json`.
3. Run `test/release-hygiene.test.js`. If you add a customer term to the denylist, use `scripts/release-denylist.mjs` so the file stays hashed.
4. Commit, tag `vX.Y.Z`, push the branch and the tag. Do not move a tag after it is published; ship a new patch version instead.
5. Merge into `main` without force. Developers install by tag: `pnpm add -D git+ssh://git@github.com/prd-son-nguyencong/scan-accessibility-module.git#vX.Y.Z`.

## 11. Access the next owner needs

- Read and write on the module repository.
- The CIS endpoint and a test token (only for group 3). The previous token is not in the repository and is gone; ask for a new one. Never commit it.
- A site checkout of a real PDK project to try the flow (the local career site is the reference).
- Chromium through Playwright (`npx playwright install chromium`).

## 12. First hour for the new owner

1. Clone, `pnpm install`, `npx playwright install chromium`, `node bin/ada-scan.js doctor`.
2. Read this page and [setup-with-local-career-site.md](setup-with-local-career-site.md).
3. Run `npm run eval:truth` and compare with [accuracy-measured.md](accuracy-measured.md). The numbers must match.
4. Scan one page of a real site and open `qa-report.html` and `scan-visual.html`.
5. Start group 0.
