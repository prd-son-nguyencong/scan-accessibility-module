# Use ada-scan with a local career site

This guide is for a developer who works on a career site built with the PDK (Liquid + Vite) project. It shows how to:

1. get the tool and run it next to your site,
2. set it up to scan **all pages**,
3. fix the findings with the **CIS chat** in your editor, and check the result.

Read time: about 10 minutes. Each command was run on a PDK site; where something failed on the way, it is in "When something goes wrong".

## What the tool does (and does not do)

- It opens your site in a real browser (Chromium), checks accessibility (WCAG 2.2 AA), HTML validity and page speed, and tells you which file and line to change.
- It writes a report and one small task file per problem.
- In this flow **it does not edit your site**. Your editor chat (CIS) edits the code. The tool then checks that the edit is safe.
- A clean report does **not** mean the site is compliant. See "How accurate is it?" at the end.

## 1. What you need

- Node 20.18.1 or newer (`node -v`; the site has an `.nvmrc`, so run `nvm use`).
- `pnpm`.
- Access to the tool repository with your SSH key.
- A site that starts with `pnpm dev` on port 1234 and builds with `pnpm build:vite`. This is the normal PDK site setup.

## 2. Get the tool

Choose one way.

### Way A: install it inside the site (recommended)

Run this in the site folder:

```bash
pnpm add -D git+ssh://git@github.com/prd-son-nguyencong/scan-accessibility-module.git#v1.2.0
npx playwright install chromium
npx ada-scan doctor
```

- The first command adds the tool as a dev dependency. It changes `package.json` and `pnpm-lock.yaml` of the site. Decide with your team if you commit that.
- The second command downloads the Chromium browser once, into a shared Playwright cache. It is the only thing installed outside the project.
- `doctor` checks your setup and prints PASS, WARN or FAIL with a hint. Fix every FAIL first.

From now on, write `npx ada-scan ...` in the site folder.

### Way B: clone it next to the site

Use this if you want to read or change the tool code.

```bash
cd ..                      # the folder that holds your site
git clone git@github.com:prd-son-nguyencong/scan-accessibility-module.git
cd scan-accessibility-module
git checkout v1.2.0
pnpm install
npx playwright install chromium
cd ../<your-site-folder>
node ../scan-accessibility-module/bin/ada-scan.js doctor
```

From now on, write `node ../scan-accessibility-module/bin/ada-scan.js ...` where this guide says `npx ada-scan ...`.

Note: the site may also have its own older `pnpm scan` script. That is a different tool. This guide only uses `ada-scan`.

## 3. Settings

All settings live in one file in the site root: `.scan-config.json`.

1. Create it (only if the site does not have one yet):

   ```bash
   npx ada-scan init
   ```

   `init --dry-run` shows the file without writing it. The defaults fit a PDK site (`pnpm dev` on port 1234, `pnpm build:vite`, pages in `src/pages`).

2. Add the output folder to `.gitignore`, so reports are not committed:

   ```
   .ada-scan/
   ```

3. Keep port 1234 free. The tool starts the dev server itself. If another server already answers on port 1234, the tool uses that server, even when it belongs to a different project. See "When something goes wrong".

## 4. Scan all pages

By default the config lists only the home page. To scan the whole site, list every page.

**Step 1. Fill the page list from `src/pages`.** The tool ships a small script for this. It reads your page templates and writes them into `pages` in `.scan-config.json` (it keeps your other settings):

```bash
# Way A
node node_modules/ada-scan/templates/list-pages.mjs
# Way B
node ../scan-accessibility-module/templates/list-pages.mjs
```

Check the result with `git diff .scan-config.json`. Run the script again whenever you add a page.

**Step 2. Scan.**

```bash
npx ada-scan
```

The tool starts the dev server, builds a special copy of the site, scans every page on desktop (1280 px) and mobile (390 px), and writes the result to `.ada-scan/`. Exit code: `0` fine, `1` there are confirmed problems, `2` the scan was incomplete or the arguments were wrong.

Useful options:

| You want | Command |
|---|---|
| One page only, for a quick try | `npx ada-scan --page /careers` |
| Only pages whose files you changed | `npx ada-scan --changed-only` |
| Pages from a sitemap | `npx ada-scan --sitemap <url-or-file>` |
| Find pages by following links | `npx ada-scan --crawl --max-pages 50` |
| Stop after a time limit | `npx ada-scan --max-time 1800` |
| Keep reports outside the site | `npx ada-scan --out-dir ~/ada-reports/my-site` |
| Save this scan as the baseline | `npx ada-scan --baseline` |

Good to know:

- Pages like `404`, `500` and `job-details` are shells. The platform fills them with data at runtime, so some results there are only "needs review".
- Pages that exist only on the platform (for example one page per job) are not in `src/pages`. Add them to `pages` by hand, or use `--sitemap` with the preview site.
- For the final pass or fail result, also scan the **preview URL**, because it shows the platform widgets: `npx ada-scan --url https://<site>.preview.sites.stg.paradox.ai/ --source . --no-fail`.

## 5. Read the report

Open these files in `.ada-scan/`:

- `qa-report.html` is the short view: verdict and top problems.
- `scan-visual.html` shows every finding with filters.
- `latest.json` is the same data for tools.

Each finding has a **verdict**:

| Verdict | Meaning |
|---|---|
| `confirmed` | The tool proved it. Only these fail the gate. |
| `likely` | Probably a problem. A person should look. |
| `needs-review` | A person must decide. |

Each finding also has an **owner**: `site` (you fix it in the templates), `platform` (the Paradox team) or `third-party` (a vendor widget, such as a chat or consent banner). Fix the `site` ones.

Colour contrast problems are design decisions. Do not change colours to make a finding go away. Ask design.

## 6. Fix with the CIS chat

The loop is: **export tasks, let the CIS chat edit the code, check the edit, scan again.** The tool does not talk to the chat itself in this flow. You are the link between them.

**Step 1. Start from a clean working tree.** Commit or stash your own work first. Then every changed line belongs to a task.

**Step 2. Export the tasks for your editor.**

```bash
npx ada-scan fix --export --target cursor
```

This needs no AI and no network. It writes `.ada-scan/tasks/INDEX.md` and one task file per finding. It also installs the rules file and the fix skill for the editor (`.cursor/rules/ada-scan.mdc` for Cursor). Use `--target claude` for Claude Code. You can narrow the tasks with `--severity`, `--rule`, `--page` and `--max`.

**Step 3. Open the site folder in the editor and ask the CIS chat to do the tasks.** Paste this prompt:

> Fix the accessibility tasks in .ada-scan/tasks/INDEX.md, file by file, following the ada-scan rules. Leave the edits uncommitted.

Rules for this step:

- Do not let the chat commit, stash or reset. The check reads the working tree.
- Do not let it change colours, opacity, backgrounds or design tokens.
- Do not let it touch `{{data:..}}`, `{{snippet:..}}` or `data-pdk-*`. They belong to the platform.
- Do not let it edit files under `dist/`.
- If a task says "ask a human", do not force it.

**Step 4. Quick check of the edit (instant, no browser).**

```bash
npx ada-scan fix --verify
```

It lists changed files that no task names, changed backend tags and colour changes. Exit code `1` means a rule was broken. Undo that part (`git restore -p <file>`) or ask the chat for a smaller change.

**Step 5. Full check of the edit.**

```bash
npx ada-scan fix --harness --from-working-tree
```

The tool copies the site to a safe shadow folder, builds it, and tests each task: the problem is gone, nothing else moved, nothing else changed visually, the page still works, speed did not get worse, and the build still passes. It never writes to your site here. It prints one line per task:

- `accepted`: safe. Keep the edit.
- `queued`: a person must look at it. The report says why.
- `rolled_back` or `rejected`: a check failed. **Your site still has the chat's edit.** Open `.ada-scan/harness/<time>/report/harness-report.md`, read the failed check, then undo that edit or ask the chat for a smaller one, and run step 5 again.

**Step 6. Scan again.**

```bash
npx ada-scan
```

A problem counts as fixed only when it is gone from a complete scan of the same pages. Then commit the accepted changes yourself.

A deeper description of the checks is in [fix-harness.md](fix-harness.md). The first-day walk-through is [onboarding.md](onboarding.md).

## When something goes wrong

| Symptom | What to do |
|---|---|
| `HTTP 404 — page not scanned` for a page that exists | Another server may be using port 1234. Run `lsof -nP -iTCP:1234 -sTCP:LISTEN`, stop it (`kill <pid>`), and scan again. |
| `doctor` says Node is too old | `nvm use` (needs Node 20.18.1 or newer). |
| Chromium is missing | `npx playwright install chromium`. |
| Exit code `2` and "INCOMPLETE SCAN" | A page or layer did not finish. Read the message, scan the failing page alone with `--page`, or raise `--max-time`. |
| Many `needs-review`, few `confirmed` | Normal. Only proven problems are `confirmed`. Work from `confirmed`, then look at `likely`. |
| A finding is wrong, or the tool missed one | Label it: `npx ada-scan label --from-report <n> --fp --by <your-name> --note "why"` (use `--tp` for a real problem). |

## How accurate is it?

Numbers come from fixture pages with known truth, not from real sites. In short: 15 criteria are "validated" (recall about 98 percent, no false alarm on the fixtures) and 6 are "advisory" (the tool reports them but makes no promise). Recall on real sites is **not measured** and is lower. Read [accuracy-commitments.md](accuracy-commitments.md) before you trust a clean report.

## About the CIS insecure-dev mode

The tool has a local-only mode that turns off TLS checks for the CIS service. It is for sandboxes and test fixtures only, and the code refuses to run it in CI or production. Never use it with a real site. You do not need it for the flow above.
