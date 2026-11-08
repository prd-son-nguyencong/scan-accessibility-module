# eval: measuring the scanner against reviewed ground truth

Everything here is committed so a measurement round can be rerun after a wiped scratch directory. The committed data is anonymised: it
holds no customer names, no page copy and no HTML. See "Anonymised data" below.

| File | Purpose |
|---|---|
| `blind-scan.sh` | scan one site worktree and assert the scan stayed inside it |
| `compare.mjs` | compare a scan report with `corpus.json` |
| `metrics.mjs` | precision and file:line with Wilson 95% intervals, overall and blind-only |
| `corpus.json` | ground truth: reviewed rows (rows: site alias `s01`..., route, rule, selector, verdict TP/FP/UNV, sourceOk yes/no/n/a, ownerOk, reviewedAt, plus via and provenance). No `outerHTML`, no message text |
| `anonymise.mjs`, `anonymise-corpus.mjs` | site aliases, route and selector hashing, the denylist matcher; `anonymise-corpus.mjs` rewrites a raw rows file into the committed form |
| `release-denylist.json` | sha256 hashes of lowercase customer tokens (no names). Add terms with `node scripts/release-denylist.mjs add <term>` |
| `site-map.local.json` | PRIVATE, gitignored: real site name to alias (`s01`). Created on first anonymise run; keep a copy outside the repo |
| `recover-corpus.mjs` | rebuilds `corpus.json` from workflow agent transcripts, already anonymised (see Provenance) |
| `test/eval.test.mjs` | `node --test eval/test/eval.test.mjs` |

## A measurement round

1. **Scan.** Make a worktree of the site (never scan inside the host repo), write a sitemap, then
   `HOST_REPO=<host repo> eval/blind-scan.sh <site> <worktree> <port> <sitemap.xml> <out-dir>`.
   It starts vite from the worktree, scans with `ada-scan --url --sitemap --out-dir`, kills the server and asserts: the output names the worktree as
   project root, nothing points into the host repo `src`, and the host `git status` and diff are unchanged. Exit 0 = all passed, 3 = project root or
   crash assertion failed, 4 = host isolation failed. ada-scan exit 1 (violations) or 2 (incomplete) is only a NOTE.
2. **Rows.** `node eval/compare.mjs <out-dir>/latest.json --site <alias-or-name>` (a real name works only when your private `site-map.local.json` lists it) prints matched TP/FP/UNV against the corpus, the confirmed findings with no
   corpus row (the unreviewed rows, which need review) and the corpus TPs lost.
3. **Review.** Two independent reviewers (lens A: rendered/DOM facts; lens B: behaviour and source) each give every unreviewed row a verdict without
   seeing the tool's conclusion. Where they disagree, an adjudicator decides with a concrete proof. UNV is allowed when blocked; a guess is not.
4. **Metrics.** Put the final rows (site, blind true/false, verdict, sourceOk) in a JSON array and run `node eval/metrics.mjs rows.json [--by-site]`.
   Output shows aliases only; a site missing from your private map prints as `unmapped`.
   Without the private map, `anonymise-corpus.mjs` numbers new sites above the highest alias already in `corpus.json` and warns; a site that is already in the corpus then gets a second alias, so merge it by hand.
   Add the adjudicated rows to `corpus.json` (run them through `node eval/anonymise-corpus.mjs <raw.json> <out.json>` first) so the next scan of that site is compared against them.
5. **Recall audit.** Independently of the scanner, find defects by hand (keyboard, zoom, screen reader pass, source read) on the same routes and list
   which ones the scan did not report as confirmed. See `docs/recall-audit.md`.

## Definitions

- **Confirmed**: a finding whose `verdict` is `confirmed` in the report (`pages[].findings[]`). Only these count in precision and in the gate.
- **TP / FP / UNV** (reviewer verdict): TP = a person applying WCAG 2.2 A/AA would file it as a real defect on that element as rendered; FP = not a
  defect (fine, hidden, vendor code, dev-server artefact, only wrong because platform data is unbound locally, or advisory only); UNV = tried, cannot decide.
- **Precision** = TP / (TP + FP) over reviewed confirmed rows. UNV is excluded and reported separately. Blind-only restricts to rows from sites
  scanned without tuning against them.
- **file:line** = share of TP rows whose cited source file:line is where the fix belongs (`sourceOk` yes; right file, within 2 lines, not a shared
  partial when the defect is per-page content), over TP rows.
- **Recall** = defects found by the independent audit that the scan reported as confirmed, over all audited defects. Corpus TPs lost is a regression
  signal, not recall.
- **Wilson 95%**: interval for a proportion k/n with z = 1.96; use it, never the bare percentage, since n is often small.

## Where ground truth lives

`eval/corpus.json` in this repo. Match key in `compare.mjs`: exact `route|rule|selector`, else `route|rule`. The rule matches the finding's
`nativeRuleId`, `canonicalRuleId` or any `nativeRuleIds`.

## Anonymised data

- `site` is an alias (`s01`, `s02`, ...). The real names live only in `eval/site-map.local.json` (gitignored, never committed).
- A route or selector that contains a denylisted customer term is stored as `h:<16 hex>` (a salted hash of the original string). `compare.mjs`
  looks every route and selector up both literally and as its hash, so matching against a real scan still works; the `lost` and `unreviewed`
  lists print the scan's literal values where the scan has them. A `lost` row exists only in the corpus, so when its route or selector was hashed it prints as `h:<hash>`.
- Rows carry no HTML and no message text. `test/release-hygiene.test.js` fails when a denylisted term appears in any tracked file.
- The denylist holds hashes only. It can confirm a guess but does not list names; keep it that way (add terms through `scripts/release-denylist.mjs`).

## Provenance of the recovered corpus

The first corpus lived in a scratch directory that was wiped. `recover-corpus.mjs` rebuilt what the workflow agent transcripts still hold: reviewer
agents printed rows (id, route, rule, selector) and returned verdicts by id. A row is kept only when route, rule, selector and a verdict are all
present in a transcript. Verdict = the latest adjudicator, else both lenses agreeing, else the row is dropped. Each row lists its transcript files in
`provenance`. These are the reviewed new or unreviewed confirmed rows of each round, not the full earlier corpora, so per-site TP/FP ratios are biased
(for example one site holds only rows that were FPs).

Not recovered: sites whose verdicts were written to scratch files (`verdict-<site>.json`) by free-form agents and only summarised in prose
(six sites and the older rounds before the workflow runs); one more site only partially.
Rerun `node eval/recover-corpus.mjs <workflows-dir>` to regenerate.
