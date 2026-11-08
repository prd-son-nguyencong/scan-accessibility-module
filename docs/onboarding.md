# Onboarding: your first scan and your first fix

For a developer who has never used `ada-scan`. About 30 minutes. This page is the path; the other documents hold the detail and are linked, not copied.

Every command below was checked against `ada-scan --help`. The fix-flow commands were also run on a scratch project (a git repo outside your site) with a real `ScanReportV2` file.

What the tool is: a scanner for Paradox career sites (WCAG 2.2 AA, HTML validity, page speed). It finds problems, points at the `file:line` that causes them, and writes one task per problem for your editor chat. It never edits your site by itself in this flow, and a clean scan is not a compliance statement (see "Limits" in the [README](../README.md)).

## 1. Install (nothing global)

Run these in your site project. Nothing is installed globally and no config outside the project is touched.

```bash
pnpm add -D git+https://<your-git-host>/ada-scan.git#v1.1.0
npx playwright install chromium
npx ada-scan init
npx ada-scan doctor
```

- `pnpm add -D` adds a dev dependency to this project only.
- `npx playwright install chromium` downloads Chromium into Playwright's per-user browser cache (outside the project, shared by other Playwright projects). It is the only thing that lives outside the project.
- `init` writes one file, `.scan-config.json`, and asks nothing. `npx ada-scan init --dry-run` prints it without writing. It does not edit `vite.config.*` or `package.json`.
- `doctor` prints PASS, WARN or FAIL per check with a fix hint (Node version, Chromium, lockfile, dev server, build script, tracing). Fix every FAIL before scanning. A Node version WARN means: run `nvm use` (the project asks for Node 20.18.1 or newer, see `.nvmrc`).
- Add `.ada-scan/` to `.gitignore`: all output goes there.

Source tracing (finding to `file:line`) needs the Vite plugin. It is optional: the scan adds it through a temporary config when your Vite config does not. `doctor` reports `tracing-ready`. Details: [README, Install](../README.md#install).

## 2. First scan of a local PDK site

```bash
npx ada-scan --page /jobs      # one page, quickest first run
npx ada-scan                   # all pages in .scan-config.json
```

The scan starts the dev server, builds an instrumented `dist`, runs the layers and writes everything to `.ada-scan/`. Exit code 0 means ok, 1 violations, 2 bad arguments or an incomplete scan.

Expect two limits on a local scan:

- Paradox pages are shells made of `{{snippet:uuid}}` and `{{data:..}}`, `{{attribute:..}}` and `data-pdk-*` that the platform binds at runtime. Locally they are unbound. A defect that exists only because platform data is unbound is not a confirmed defect (it shows as owner `site`, kind `unbound-data`, and is never confirmed).
- The pass/fail source for QA is the preview URL scan (`npx ada-scan --url <preview-url> --psi --no-fail`), because it renders platform widgets. A local scan is the one that can trace to your files. Add `--source .` to a preview scan to trace it too. See [README, Quick start](../README.md#quick-start).

Save the result as the baseline so later scans show fixed, remaining and new:

```bash
npx ada-scan --page /jobs --baseline
```

## 3. Read the report

Open `.ada-scan/qa-report.html` (verdict and top issues) and `.ada-scan/scan-visual.html` (every finding, filters). `latest.json` is the same data for tools.

**Verdict of a finding** (README, "Limits of automated testing"; per-rule ceiling in [verdict-matrix.md](verdict-matrix.md)):

| Verdict | Meaning | Gates pass/fail? |
|---|---|---|
| `confirmed` | the tool proved it | yes, only these |
| `likely` | probable, shown | no |
| `needs-review` | a person must judge it | no |

The report never says "compliant".

**Owner** (badge on every finding; "Origin" in `scan-visual.html`, table in [README, Who owns a finding](../README.md#who-owns-a-finding-origin)):

| Owner | Who fixes it |
|---|---|
| `site` | you, in this project's templates |
| `platform` | the Paradox platform team (listed apart, not fixable in Liquid) |
| `third-party` | the vendor: OneTrust, GTM, YouTube, chat widget DOM is not site code |

**Where**: a traced finding carries `file:line` and a snippet; the task files in section 4 list them, and `tasks/INDEX.md` has a "By file" order. A finding with no traced line has no task and is not auto-fixable.

Other files: `baseline.json`, `history/`, `scan.sarif` (with `--sarif`), `tasks/`. See [README, Reports](../README.md#reports). The rule list is [accessscan-rule-coverage.md](accessscan-rule-coverage.md).

## 4. Fix with an editor chat (Cursor or Claude Code)

The loop is: export tasks, let the agent edit, keep the edits uncommitted, let the harness check them.

**Step 1. Export the tasks and install the rules and skill for your editor.**

```bash
npx ada-scan fix --export --target cursor     # Cursor
npx ada-scan fix --export --target claude     # Claude Code
npx ada-scan fix --export --target cursor --dry-run   # preview, writes nothing
```

This uses no AI and no network. It writes `.ada-scan/tasks/INDEX.md` plus one `.md` and `.json` per finding, and installs the fix skill and one rules file (`.cursor/rules/ada-scan.mdc` and `.cursor/rules/ada-scan-fix-skill/`, or `.claude/ada-scan.md` and `.claude/skills/ada-scan-fix/`). These are generated files that ada-scan owns (marked, regenerated, never overwrites a file without its marker). For Claude Code add the printed line `@.claude/ada-scan.md` to your own `CLAUDE.md`; ada-scan never edits it. Filters: `--severity`, `--rule`, `--page`, `--max`, `--include-needs-review`, `--group-by-file`. Details: [fix-export.md](fix-export.md), [fix-skill.md](fix-skill.md).

**Step 2. Tell the agent to do the tasks and not to commit.** The export prints the prompt:

> Fix the accessibility tasks in .ada-scan/tasks/INDEX.md, file by file, following the ada-scan rules. Leave the edits uncommitted.

Do not let the agent commit, stash or reset: the harness reads `git diff HEAD`, so the changes must be in the working tree. Start from a clean tree (commit or stash your own work first) so every hunk belongs to a task.

Optional quick check before the harness (static, instant):

```bash
npx ada-scan fix --verify
```

It lists changed files no task names, changed `{{data:..}}`, `data-pdk-*` and colour declarations, and anything under `dist/`. It exits 1 on a violation. It is not a substitute for the harness.

**Step 3. Verify what the agent changed.**

```bash
npx ada-scan fix --harness --from-working-tree
```

Needs a local source tree (a URL-only report stays scan-only) and a build command in `.scan-config.json` (`verifyBuildCommand`, else `buildCommand`). Add `--report <file>` if your report is not `.ada-scan/latest.json` and `--source <dir>` if the project is not the current directory.

The harness copies the project into a shadow directory, builds it, takes a baseline, replays each task's hunks and gates them one task at a time. With `--from-working-tree` it never writes to your project: your edits are already there. It prints one line per task (`accepted`, `queued`, `rolled_back`, ...) and writes `.ada-scan/harness/<timestamp>/report/harness-report.md` and `remaining.md`. It also lists changed hunks that belong to no scanned task (not verified). Full description: [fix-harness.md](fix-harness.md).

## 5. What each gate means

A task is accepted only if every gate passes. Missing evidence fails the gate. Thresholds and exact rules are in [fix-harness.md, section 4](fix-harness.md).

| Gate | In plain words |
|---|---|
| G1 targeted | the finding you meant to fix is gone, and no new confirmed or needs-review finding appeared |
| G2 scope | only allowed files and lines changed; backend tags and `data-pdk-*` are identical; colours, opacity, backgrounds and tokens are identical |
| G3 layout | every other visible element kept its position and size (1 px tolerance) |
| G4 visual | screenshots outside the fixed element did not change |
| G5 style | computed styles of every other element did not change |
| G6 behaviour | no new console error or failed request, no changed link, tab order only gained intended stops, controls still behave |
| G7 performance | Lighthouse medians did not get worse beyond measured noise (off when `harness.perfRuns` is 0 or `harness.lighthouse` is false, and the report says so) |
| G8 build | the build passes, HTML validation errors did not increase, the Paradox export is still valid, the formatter is clean |

When all gates pass, a small safe change is accepted; a larger or riskier one is `queued` for a human (the report says why). A human cannot waive G2 or G8.

## 6. What to do on rollback

A `rolled_back` (or `rejected`) line names the failed gates, for example `[G3,G4]`. In the `--from-working-tree` flow the rollback happens only inside the harness's shadow copy. **Your project keeps the agent's edit.** The harness does not undo it.

1. Open `harness-report.md` and read the failed gate and its evidence (offending element, before and after values).
2. Either undo that hunk yourself (`git restore -p <file>`, or `git diff` and edit by hand), or give the agent the gate evidence and ask for a smaller change. Keep the edit uncommitted.
3. Run `npx ada-scan fix --harness --from-working-tree` again.
4. Do not commit a change whose task was rolled back, queued or never verified.

Other outcomes are not failures of your edit. `remaining.md` gives every unresolved finding one reason: `needs_design_decision`, `platform_or_third_party`, `data_not_bound_locally`, `needs_human_content`, `gate_failed`, `awaiting_review`, `not_reproduced_locally`, `fixer_could_not_produce_safe_change` ([fix-harness.md, section 7](fix-harness.md)).

After the harness, rescan to see fixed, remaining and new: `npx ada-scan --page /jobs`. A finding counts as fixed only when it is gone from a complete scan of the same target.

## 7. The contrast rule: never fix colour contrast by changing colours

Colour contrast findings (and anything else design-locked) are design decisions. They are listed apart in the tasks and are never auto-fixed. Neither you nor the agent changes a colour, opacity, background or token to make a contrast finding go away: G2 and `fix --verify` fail on that, and the task says "ask a human". Raise it with design, who may choose a new colour pair. Details: [fix-skill.md](fix-skill.md), `design-locked.md` in the installed skill, [pixel-contrast.md](pixel-contrast.md).

## 8. Giving feedback

- A wrong finding or a missed one: label it. Each finding in `qa-report.html` shows a ready-to-copy command.

```bash
npx ada-scan label --from-report 1 --tp --by <your-name> --note "why"   # real problem
npx ada-scan label <stableId> --fp --by <your-name> --note "why"        # false positive
npx ada-scan labels stats                                               # precision per rule
```

  Labels are stored in `.ada-scan/labels.json`. After at least 10 labels per rule, `npx ada-scan labels apply --yes` demotes rules with precision below 70 percent to `needs-review`.
- A fix the harness rejected that you believe is right, or a task that told your agent something wrong: send the maintainers `harness-report.md` and the task `.json` from `.ada-scan/`. Remove snippets you do not want to share first: reports embed `outerHTML` and source snippets.
- Record manual checks the tool cannot do with `npx ada-scan manual list|sign|status`.

## Where to go next

| Need | Read |
|---|---|
| All flags and config keys | [README](../README.md) |
| Export format and recipes | [fix-export.md](fix-export.md) |
| The editor skill and `--verify` | [fix-skill.md](fix-skill.md) |
| The gates, outcomes, limits | [fix-harness.md](fix-harness.md) |
| Reviewed CIS fix flow | [cis-contract.md](cis-contract.md) |
| Rule reference | [accessscan-rules-for-po.md](accessscan-rules-for-po.md) |
| Report UI | [report-ui.md](report-ui.md) |
