# Release data audit

Scope: the tracked working tree of this module, checked before the repo is handed to developers outside the company. Git history is not part of this audit.
Customer names do not appear in this file. Sites are named by alias (`s01` to `s27`); the alias to name map is private and is not committed.

Method: `git ls-files` (1218 files on the base branch at audit time; this branch tracks more), a token scan with the hashed denylist in `eval/release-denylist.json`, a URL and host inventory, a secret pattern
scan, and a read of every directory that could hold captured page content. The scan is now a test: `test/release-hygiene.test.js`.

## Decisions

| Area | Finding | Decision |
|---|---|---|
| `eval/corpus.json` (1580 rows) | real site ids in `site`; routes and selectors from real pages; no HTML or message text in the rows | **Anonymised.** `site` is now `s01` to `s27` (numbering follows the sorted real names). 18 distinct routes (175 rows) and 3 selectors that carried a customer term are stored as `h:<hash>`; `compare.mjs` matches both spellings. Fields kept: route, rule, selector, verdict, sourceOk, ownerOk, reviewedAt, via, provenance. Fields dropped: none present (`outerHTML` and message text were never stored; the hygiene test now rejects them) |
| `eval/compare.mjs`, `eval/metrics.mjs`, `eval/recover-corpus.mjs`, `eval/test/eval.test.mjs`, `eval/README.md` | assumed real site names | **Updated.** Alias resolution through the private `eval/site-map.local.json`; metrics print aliases only (`unmapped` for an unknown name); recover writes anonymised rows; tests added for hashed matching, aliasing and the recover path |
| `eval/blind-scan.sh` | absolute path of a developer machine | **Fixed.** `HOST_REPO` is now a required environment variable; the scanner path is resolved from the script location |
| `eval/README.md` | named four real sites in prose | **Anonymised** (prose made generic) |
| `test/fixtures/calibration/labels.json` | one class and nine ids named after a real site | **Anonymised** to `s05` (the alias of that site in the corpus) |
| `test/measured-checks.test.js` | a real company name in aria-label strings | **Replaced** by a synthetic name (`Acme Homes`); the assertions are unchanged |
| `test/unresolved-text.test.js` | a real brand and a real charity name in label strings | **Replaced** by synthetic names; the apostrophe cases still run |
| `test/root-cause-merge.test.js` | a real customer career-site domain in two anchors | **Replaced** by `emplois.example.ca` |
| `test/environment-artefacts.test.js` | a real brand in an asset file name | **Replaced** by `brand-logo.webp` |
| `test/dup-id-svg-child.test.js`, `test/fix/i4-harness-ownership.test.js` | real site ids in comments | **Replaced** by neutral wording |
| `docs/REVIEW-2026-10-26.md` | a customer site export file name | **Replaced** by `SITE_EXPORT.json`. The file is an internal review written in Vietnamese; it is kept as history and flagged in the risks below |
| `docs/WAVE0-PLAN.md`, `docs/REVIEW-2026-10-26.md` | developer home paths and an organisation remote name | **Replaced** by `<module>`, `<host-repo>`, `<org>`, `<path>` placeholders |
| `test/fixtures/accessscan-corpus/**` (16 cases, 58 files) | captured accessScan evidence for 8 sites | **Kept.** Already neutral: text is `neutral-text-*` and `neutral-alt-*`, assets are `neutral-asset`, page titles are "Neutral page title". Case ids are opaque (`site-NNN`). Checked `page.html`, `snapshot.json`, `meta.json` and `expected.json` |
| `scripts/accessscan-corpus/source-manifest.json`, `test/fixtures/hit-01-r1-parity.json`, `docs/hit-01-r1-parity-evidence.md`, corpus tests | eight opaque platform staging hosts (`site-NNN.preview.sites.stg...`) | **Kept** (opaque numbers, no customer name, needed by the host allowlist tests). Real labels and URLs are loaded from the gitignored `source-manifest.local.json`; the example file is generic. See the risks section |
| `test/fixtures/paradox-site`, `harness-site`, `harness-paradox-fragments`, `fix-corpus`, `truth-corpus`, `rule-seeds`, `trace-*`, `keyboard-contrast`, `menu-keyboard`, `calibration/site`, `cis` | hand written fixtures | **Kept.** Synthetic content ("Acme Careers", `site-A`, lorem style job rows). No customer copy, no captured HTML, no screenshots. Only tracked images are small SVG fixtures |
| `scan-reports/` | listed in `.gitignore` | **Kept ignored.** 0 tracked files |
| `templates/`, `src/`, `vite/`, `bin/` | platform product names only (Paradox, Olivia chat widget, Workday) | **Kept.** These are product names the tool must know to classify platform owned markup; no customer data |
| `CHANGELOG.md`, other `docs/*.md` | scanned with the denylist | **Kept.** No hits besides the files listed above |
| `test/fixtures/cis/tls/*.pem` | four PEM files, two private keys | **Kept.** Throwaway test CA ("ada-scan test CA"), used by the CIS TLS tests only. A `README.md` in that directory says so, and the secret test allows private keys only there |

## Secrets

`test/release-hygiene.test.js` scans every tracked text file for: `BEGIN ... PRIVATE KEY`, AWS key ids, GitHub tokens, `sk-ant-` and `sk-live-` keys, Google API keys, Slack tokens,
long bearer tokens and quoted `api_key`, `secret`, `password` or `auth_token` assignments. Result at audit time: the only match is the test CA keys above. Other hits of the words
`token`, `secret` or `Bearer` are redaction test fixtures with obviously fake values (for example `must-not-leak`, `super-secret-feature-key-sentinel-value`).
It also fails on developer home paths (`/Users/<name>/`, `/home/<name>/`) and personal mail addresses.

## Files that must never be committed

All are listed in `.gitignore`, and the hygiene test checks both the ignore entries and that nothing like them is tracked.

| Path or pattern | Why |
|---|---|
| `.eval/` | measurement rounds: scans, rows files, screenshots, reviewer scripts with real site names |
| `eval/site-map.local.json` | the private map from real site name to alias |
| `scripts/accessscan-corpus/source-manifest.local.json`, `redaction-tokens.local.json`, any `*.local.json` | real labels, hosts and redaction tokens (only `*.local.example.json` is tracked) |
| `.env`, `.env.*` (except `.env.example`) | CIS endpoint, host and feature key |
| `cis-env*`, `.cis-env*` | CIS environment dumps |
| `.ada-scan/`, `scan-reports/`, `.tmp-*/`, `oracle-artifacts/` | scan output embeds `outerHTML` and source snippets of the scanned site |
| `.ada-worktrees/` | agent worktrees, each a full checkout |
| `node_modules/` | dependencies |

Never put tokens, keys or passwords in tracked files. CIS credentials go in the gitignored `.env` only.

## Keeping it clean

- Add a customer term to the denylist with `node scripts/release-denylist.mjs add <term>` (hashes only are written) and run `node --test test/release-hygiene.test.js`.
- New corpus rows: run `node eval/anonymise-corpus.mjs <raw.json> <out.json>` before committing.
- A real page must never become a fixture. Write a small synthetic page that shows the same defect.

## Risks left

- The denylist cannot know names nobody added to it. Re-run the audit by reading new fixtures when a new customer site is used for a test.
- Hashing hides names but is not encryption: someone with a list of candidate names can test them against the hashes. It is a guard rail against accidents, not secrecy.
- The staging host numbers in the manifest and in a few tests are internal infrastructure ids. Replace them with `site-001` style placeholders before a fully public release.
- `docs/REVIEW-2026-10-26.md`, `docs/WAVE0-PLAN.md` and `docs/TASKS.md` are internal planning documents (partly Vietnamese). Consider dropping them from a public copy.
- Git history was not audited. Older commits may still hold names, paths and HTML. Publish from a squashed or filtered copy.
