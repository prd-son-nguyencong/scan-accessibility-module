# ada-scan

Scans a Paradox career site for accessibility problems (WCAG 2.2 AA), HTML errors and page speed. It tells you which file and line to fix and writes one task file per problem, so **CIS chat, Cursor or Claude Code** can fix them. Then it checks the fix is safe.

> A clean report does not mean the site is compliant. Colour contrast is a design decision: do not let the chat change colours.

## 1. Set up (once)

In your career-site folder. Needs Node 20.18.1+ and pnpm.

```bash
pnpm add -D git+ssh://git@github.com/prd-son-nguyencong/scan-accessibility-module.git#v1.2.2
npx playwright install chromium
npx ada-scan init
npx ada-scan doctor
```

Fix every `FAIL` that `doctor` prints. Add `.ada-scan/` to `.gitignore`.

## 2. Choose the pages to scan

The pages live in `.scan-config.json` (site root). `init` creates it with only the home page. Two ways to list more:

**Automatic (recommended):** fill `pages` from `src/pages`. Run it again when you add a page.

```bash
node node_modules/ada-scan/templates/list-pages.mjs
```

**By hand:** edit `pages`. Example for a career site (copy and change):

```json
{
  "baseUrl": "http://localhost:1234",
  "devCommand": "pnpm dev",
  "buildCommand": "pnpm build:vite",
  "pages": [
    { "path": "/", "name": "homepage" },
    { "path": "/about" },
    { "path": "/jobs", "name": "jobs" },
    { "path": "/job-details", "name": "job-details" },
    { "path": "/404", "name": "not-found", "allowStatus": [404] }
  ]
}
```

- `path` is the URL path. `name` is optional, must be unique, and defaults to the path (`/about/team` becomes `about-team`).
- `allowStatus` is for error pages that are meant to answer 404 or 500; without it the page is reported as "not scanned".
- Keep the rest of the file as `init` wrote it (thresholds, build settings).

Check the result: `git diff .scan-config.json`. To try one page only: `npx ada-scan --page /about`.

## 3. Scan and read the report

```bash
npx ada-scan
```

Keep port 1234 free (the tool starts `pnpm dev` itself). Results are in `.ada-scan/`:

- `qa-report.html`: short view
- `scan-visual.html`: every finding, with filters

Only `confirmed` findings fail the scan (exit code 1). `likely` and `needs-review` need a person to look.

## 4. Export the tasks for the chat

Start from a clean working tree (commit or stash your own work), then:

```bash
npx ada-scan fix --export --target cursor    # or: --target claude
```

This writes `.ada-scan/tasks/INDEX.md` (the list) and one task file per problem, and installs the rules file the chat reads. It needs no network.

## 5. Fix with the chat

Open the site folder in Cursor, Claude Code or the CIS chat. Copy this whole prompt into a new chat:

````text
Fix the accessibility findings from the ada-scan export.

1. Read .ada-scan/tasks/INDEX.md first. If the ada-scan-fix skill or the ada-scan rules file is installed (.cursor/rules/ada-scan.mdc, or the skill under .claude/skills), follow it.
2. Work file by file from the "By file" list, highest line first. Open the real file, check the element shown in the task, then make the smallest edit that fixes it.
3. Never change colours, opacity, backgrounds or design tokens. Skip tasks listed under "Design decisions" and "Not actionable in source".
4. Never touch {{data:..}}, {{snippet:..}}, {{component:..}}, data-pdk-* or data-react-component, and never edit files under dist/.
5. Do not change text content, layout, classes or the number of elements unless the task says so. If a fix needs real wording, a translation or a design choice, skip it and ask me.
6. Do not run git commit, stash or reset. Leave all edits uncommitted.
7. When done, report one row per task id: done, skipped (with the reason) or reverted. List the files you changed.
````

## 6. Check the fix, then scan again

```bash
npx ada-scan fix --verify                        # quick check, no browser
npx ada-scan fix --harness --from-working-tree   # full check in a safe copy
npx ada-scan                                     # scan again
```

In the full check, `accepted` means keep the edit. `queued` means a person must look. `rolled_back` or `rejected` means a check failed: read `.ada-scan/harness/<time>/report/harness-report.md`, undo that edit or ask the chat for a smaller one. Commit the accepted changes yourself.

## More

- Troubleshooting and details: [docs/setup-with-local-career-site.md](docs/setup-with-local-career-site.md)
- Full reference (all options, scan layers, config): [docs/reference.md](docs/reference.md)
- Changes: [CHANGELOG.md](CHANGELOG.md)
