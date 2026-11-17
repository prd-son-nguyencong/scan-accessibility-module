# Developer guide

For a developer who is new to `ada-scan`: what to install, how to scan, how to read the result, how to fix what it finds and how to measure the tool itself.
It stays short on purpose. Every section links to the document that holds the detail.

`ada-scan` is a scanner for career sites (Liquid and Vite projects, or any URL). It checks WCAG 2.2 AA, HTML validity and page speed, points each finding at the
source file and line that causes it, and writes one task per finding for an editor agent such as Cursor or Claude Code.
It helps a person do the work. It does not replace a manual accessibility audit, and it never says a site is "compliant".

## 1. Prerequisites

| Need | Detail |
|---|---|
| Node.js | 20.18.1 or newer (ESM). Check with `node --version` |
| Package manager | pnpm or npm. The lock file in the repo is `pnpm-lock.yaml`; npm works too |
| Playwright browsers | Chromium, installed once with `npx playwright install chromium` (stored in your user cache, not in the project) |
| git | Needed for `--changed-only` and for the fix flow (`git diff HEAD`) |
| Vite | Optional. Only needed for source tracing in a Vite project (peer dependency, version 5 or newer) |
| Network | Not needed for a local scan. Preview URL scans need access to the preview host. Third-party services (W3C validator, PageSpeed Insights) are off unless you pass `--allow-external` or `--psi` |

## 2. Install

In the project you want to scan (nothing is installed globally):

```bash
pnpm add -D git+https://<your-git-host>/ada-scan.git#v1.1.0     # or: npm install -D ...
npx playwright install chromium
npx ada-scan init          # writes .scan-config.json only; --dry-run prints it
npx ada-scan doctor        # PASS, WARN or FAIL per check, with a fix hint
```

To work on the tool itself, clone this repo, run `pnpm install` (or `npm install`) and `npx playwright install chromium`, then `npm test`.

Add `.ada-scan/` to the project `.gitignore`. Scan output contains page HTML and source snippets of the site you scanned. Do not commit it or share it outside your team without a look.

## 3. Scan a Liquid or Vite project

```bash
npx ada-scan                                    # all pages in .scan-config.json
npx ada-scan --page /jobs                       # one page
npx ada-scan --url http://localhost:1234/       # a URL you already serve
npx ada-scan --out-dir ../scan-output/site-a    # write reports somewhere else
```

For a local project the scan starts the dev server, builds an instrumented `dist`, runs the layers and traces findings to `file:line`.

Use `--out-dir` whenever you scan a repo you do not own or must keep clean, so the scan never writes inside it. The directory is created for you. The default is `<project>/.ada-scan`.

Useful flags (full list: [README, CLI reference](../README.md#cli-reference)):

| Flag | Use |
|---|---|
| `--sitemap <url or file>` and `--max-pages <n>` | discover and cap pages |
| `--baseline` | save this scan; later scans report fixed, remaining and new |
| `--layers axe,accessScan` | run fewer layers while you iterate |
| `--source <dir>` | trace a URL scan to a local project |
| `--no-fail` | exit 0 even with violations (useful for first looks) |
| `--max-time <seconds>` | wall clock budget; unfinished pages make the scan incomplete (exit 2) |

Exit codes: 0 ok, 1 violations or failure, 2 bad arguments or config, or an incomplete scan.

A local scan and a preview scan see different things. Platform widgets and bound data only exist on the preview, so use the preview scan for pass or fail and the local scan to trace
findings to files. Details: [README, Quick start](../README.md#quick-start) and [onboarding.md](onboarding.md).

## 4. Read the report

Open `<out-dir>/qa-report.html` for the verdict and top issues, and `<out-dir>/scan-visual.html` for every finding with filters. `latest.json` holds the same data for tools.

Each finding has a verdict, which says how sure the tool is:

| Tier | Meaning | Counts toward pass or fail |
|---|---|---|
| `confirmed` | The tool measured or proved the defect. A real, decidable defect stays here | Yes, only these |
| `likely` | Probably a defect, but something the tool cannot see could change the answer (a state it did not reach, script that runs later) | No |
| `needs-review` | A person must judge it (meaning, content, design intent) | No |

The rule of the tool: a fact it cannot decide is demoted to `likely` or `needs-review`. A defect it can decide stays `confirmed`. The per-rule ceiling is in [verdict-matrix.md](verdict-matrix.md).

Each finding also names an owner: `site` (you can fix it), `platform` (the career-site platform, listed apart) or `third-party` (a vendor widget). Do not try to fix the last two in your templates.

A scan that did not finish (skipped pages, layer timeouts) is marked incomplete in the report and exits 2. Do not read an incomplete scan as a clean one.

## 5. Fix flow

All of this works on files in your working tree. No AI and no network is used by steps 1 and 3.

```bash
# 1. Export one task per finding, plus an index and the agent rules
npx ada-scan fix --export --target cursor        # or --target claude

# 2. Let your editor agent do the tasks. Tell it not to commit, stash or reset.
#    Start from a clean tree so every changed line belongs to a task.

# 3. Check what changed, statically and fast
npx ada-scan fix --verify

# 4. Replay each change on a shadow copy and run the gates
npx ada-scan fix --harness --from-working-tree
```

- `fix --export` writes `tasks/INDEX.md` and one task per finding. Filters: `--severity`, `--rule`, `--page`, `--max`, `--include-needs-review`, `--group-by-file`. `--target cursor` or `--target claude` also installs the rules file and the fix skill. Use `--dry-run` to preview. See [fix-export.md](fix-export.md) and [fix-skill.md](fix-skill.md).
- `fix --verify` lists files no task names, changed data tags and any colour change. It exits 1 on a violation.
- `fix --harness --from-working-tree` copies the project to a shadow directory, builds it and gates each task (target gone, scope, layout, visual, style, behaviour, performance, build). It never writes to your project. A rolled back task keeps its edit in your tree until you undo it. See [fix-harness.md](fix-harness.md).
- Rescan afterwards. A finding counts as fixed only when it is gone from a complete scan of the same target.

Colour contrast is a design decision. The tool never changes colours to make a contrast finding go away, and neither should you or your agent. Raise it with design.

A reviewed fix with a model instead of an editor agent is `--fix --fix-mode cis --ui` (section 7).

## 6. Measuring the tool

Three separate checks exist. They answer different questions.

| Check | Command | Question it answers |
|---|---|---|
| Unit and fixture tests | `npm test` | Does the code still behave as specified? Chromium tests are slow; run single files as shown in the troubleshooting table |
| Truth corpus | `npm run truth:metrics` | On hand written pages with a known truth, how often is a seeded defect flagged and how often is a clean page flagged? The result is written to [truth-metrics.md](truth-metrics.md). This is the engine-layer check. The confirmed-tier check that feeds the accuracy statement in section 8 is `npm run eval:truth`, which writes [accuracy-measured.md](accuracy-measured.md) |
| Reviewed ground truth | files in `eval/` | On real pages, how many confirmed findings did reviewers judge true? |

The reviewed corpus flow in short (full text: `eval/README.md` in the repository, not shipped in the npm package):

1. Scan a site worktree with `HOST_REPO=<repo> eval/blind-scan.sh ...`. It asserts the scan stayed in the worktree and left the host repo untouched.
2. `node eval/compare.mjs <out-dir>/latest.json --site <alias>` prints matched TP, FP and UNV, confirmed findings nobody reviewed, and known true defects that were lost.
3. Two reviewers judge each unreviewed row without seeing the tool's verdict; a third decides ties with proof.
4. `node eval/metrics.mjs rows.json --by-site` gives precision and file:line accuracy with 95 percent Wilson intervals.
5. Add reviewed rows to `eval/corpus.json` after `node eval/anonymise-corpus.mjs`.

The committed corpus is anonymised: sites are `s01`, `s02` and so on, and no HTML or message text is stored. Never commit customer names, real page HTML or screenshots. `npm test` includes `test/release-hygiene.test.js`, which fails if a denylisted term, a secret or a personal path is tracked. See [release-data-audit.md](release-data-audit.md).

The commercial parity corpus (`npm run corpus:verify`, `corpus:seed`, `corpus:drift`) compares accessScan with another tool. It is supplementary: matching a tool is not the same as being right.

## 7. CIS review mode and the insecure-dev warnings

`--fix-mode cis` sends bounded edit requests to a model service (CIS). It can only propose edits to allowlisted source blocks. Nothing is written until you approve an exact diff in the review workbench and the shadow verification passes.

Configure it with `npm run cis:configure`. Credentials go in a gitignored `.env` and are never printed. `npx ada-scan doctor` shows which variable names are set, not their values.

**The default is `CIS_TLS_MODE=trusted`.** It checks the certificate chain and never sends the auth bypass parameter. Use it for anything real.

`CIS_TLS_MODE=insecure-dev` exists only for a development endpoint whose certificate chain you cannot yet verify. Read these warnings before you use it:

- It turns off certificate verification for the CIS connection. Anyone on the network path can read or change what is sent, including your feature key.
- It is refused when `CI` is set or `NODE_ENV=production`. Do not work around that.
- It needs every guard at once: `CIS_INSECURE_DEV_ACK=ALLOW_UNVERIFIED_CIS_TLS`, `CIS_TLS_MAX_VERSION=TLSv1.2`, `CIS_DEV_BYPASS_AUTH=true` and exactly one allowed host. A missing or wrong value fails closed.
- Never set `NODE_TLS_REJECT_UNAUTHORIZED=0`. It is not supported and weakens every connection in the process.
- Use only a throwaway key and a source tree with nothing sensitive in it. Remove the development keys from `.env` when you are done.
- The review workbench shows a permanent warning banner while this mode is on.

Full rules: [README, CIS security boundary](../README.md#cis-security-boundary) and [cis-contract.md](cis-contract.md).

## 8. Accuracy

What this tool gets right and wrong is measured, not promised. The statement below is generated by `npm run docs:accuracy` from the truth corpus measurement; do not edit it by hand.
The per-criterion numbers, the commitments and the method are in [accuracy-commitments.md](accuracy-commitments.md).

<!-- ACCURACY:START -->
- **Recall of the confirmed tier, measured on seeded fixtures:** 82 of 115 seeded violations (71.3%, 95% interval 62.5% to 78.8%). Counting only the validated criteria it is 55 of 56 seeded violations (98.2%, 95% interval 90.6% to 99.7%).
- **Confirmed false-positive rate:** 5 of 115 clean twins (4.3%, 95% interval 1.9% to 9.8%) had a confirmed finding. Of those, 1 were confirmed for the twin's own criterion.
- **Real-site recall is unmeasured.** The seeded fixtures are small and clear-cut, so real-site recall is lower than the seeded recall above, by an amount nobody has measured. The false-positive rate is also measured on minimal pages and understates what real pages produce. These numbers come from URL scans of the fixtures; a scan of local source also demotes findings it cannot trace to a file, so confirmed recall there is lower and not measured. A validated criterion may still have confirmed findings on a clean twin written for another criterion (counted in the measured page, column "Confirmed by this criterion on any twin"); read that page, not only the totals.
- A finding at `confirmed` is the only tier the numbers speak for. `likely` and `needs-review` are not counted as hits and carry no accuracy claim.
<!-- ACCURACY:END -->

How to read any number you see:

- The numbers cover the `confirmed` tier only. Recall is measured on seeded pages and overstates real pages; the false-positive rate is measured on minimal clean pages and understates real pages.
- A small sample gives a wide interval. Quote the interval, not just the percentage.
- Automation can fully check only part of WCAG. A clean scan is not a compliance statement.

## 9. Known limits

- Roughly a third of WCAG success criteria can be fully verified by software. Keyboard flows, reading order, content quality and assistive technology behaviour need a person.
- A local scan cannot see platform widgets, rendered metadata or bound data. A preview scan has no source to trace.
- Defects that exist only because platform data is unbound locally are not confirmed.
- Source tracing supports Liquid, plain HTML and React. Vue, Nuxt and Stencil are not traced yet.
- Findings in vendor code (consent banners, chat widgets, video players) are listed as `third-party` and are not fixable in your templates.
- Colour contrast is measured, but the fix is a design choice and is never automated.
- Timing, animation and state that needs a login or a multi step journey are only checked where the scan can reach them.
- The review workbench and the harness need a local source tree and a working build command.
- Reports embed `outerHTML` and source snippets. Review them before sharing.

## 10. Troubleshooting

Start with `npx ada-scan doctor`. It names the failing check and a fix.

| Symptom | Likely cause and fix |
|---|---|
| `doctor` fails on Chromium | Run `npx playwright install chromium`. On Linux add `npx playwright install-deps chromium` |
| Node version warning | Use Node 20.18.1 or newer (`nvm install 20` then `nvm use 20`) |
| Exit code 2 and "incomplete" | A page was skipped or a layer timed out. Rerun, raise `--max-time`, or pass `--allow-incomplete` if a partial result is acceptable |
| Dev server did not start or port busy | Free the port, or start your own server and use `--url <url> --no-server` |
| Findings have no `file:line` | Tracing is off. Check the `tracing-ready` line of `doctor`. A preview scan needs `--source <dir>` |
| Preview URL cannot be reached | Check the host from your network and that you are signed in to the preview if it needs it. Pages that cannot be loaded make the scan incomplete (exit 2) |
| Many findings marked `unbound-data` | The page needs platform data that is empty locally. Scan the preview instead |
| `fix --harness` says there is no source tree | The report came from a URL only. Scan with `--source .` or scan locally |
| `fix --verify` exits 1 | Read the listed file. Either the file is not part of a task, a data tag changed, or a colour changed. Undo that part |
| Harness result is `rolled_back` | Open `harness-report.md` in `<out-dir>/harness/<timestamp>/report/`, read the failed gate and its evidence, then shrink the edit and run it again |
| The agent committed its edits | The harness reads `git diff HEAD`. Reset the commit softly (`git reset --soft HEAD~1`) and unstage, so the change is back in the working tree |
| `insecure-dev` is refused | Working as designed in CI and production. Use `trusted` |
| A test fails only under load | Chromium tests are heavy. Run one file at a time: `nice -n 15 node --import ./test/helpers/hermetic-env.mjs --import ./test/helpers/browser-leak-guard.mjs --test <file>` |
| `release-hygiene` test fails | The message lists `file:line`. Replace the real content with a synthetic example, or anonymise the corpus row. Do not edit the denylist to make it pass |

Wrong or missed finding? Label it so the tool can learn its own precision: `npx ada-scan label <stableId> --fp --by <you> --note "why"`, then `npx ada-scan labels stats`.

## Where to go next

| Need | Read |
|---|---|
| First scan and first fix, step by step | [onboarding.md](onboarding.md) |
| All flags and config keys | [README](../README.md) |
| What each rule checks | [accessscan-rules-for-po.md](accessscan-rules-for-po.md) |
| How a verdict is decided | [verdict-matrix.md](verdict-matrix.md) |
| Fix export, skill and harness | [fix-export.md](fix-export.md), [fix-skill.md](fix-skill.md), [fix-harness.md](fix-harness.md) |
| Measuring the tool | `eval/README.md` (repository only), [truth-metrics.md](truth-metrics.md) |
| Data handling before release | [release-data-audit.md](release-data-audit.md) |
