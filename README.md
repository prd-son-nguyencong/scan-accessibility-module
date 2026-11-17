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

`init` creates `.scan-config.json` with only the home page. Fill it with every page of your site:

```bash
node node_modules/ada-scan/templates/list-pages.mjs
```

This reads `src/pages` and writes the `pages` list. Run it again when you add a page. To scan one page only: `npx ada-scan --page /careers`.

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

Open the site folder in Cursor or Claude Code and paste this into the chat:

> Fix the accessibility tasks in .ada-scan/tasks/INDEX.md, file by file, following the ada-scan rules. Leave the edits uncommitted.

Do not let the chat commit, change colours, edit `dist/`, or touch `{{data:..}}`, `{{snippet:..}}` and `data-pdk-*`.

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
