# Accessibility fix skill

A skill and rules bundle that tells Cursor and Claude Code how to fix the findings of an `ada-scan fix --export` safely in
Paradox, Liquid and Tailwind projects. It is plain markdown: no AI, no network, nothing is applied by ada-scan.

Source: `src/fix/export/skill/`. It is derived from, and does not copy, the `frontend-accessibility-guide` skill (a WCAG 2.2 AA
reference for semantics, forms, keyboard, focus, names and custom widgets). Differences on purpose: colour contrast is never
fixed by choosing another colour (the reference tells a developer to pick one; here it is design-locked), and every rule is tied
to the export's task files and to Paradox conventions (sidecars, `forloop.index`, backend tags).

## Install

```
ada-scan fix --export --target cursor   # .cursor/rules/ada-scan-fix-skill/*.mdc  (+ .cursor/rules/ada-scan.mdc)
ada-scan fix --export --target claude   # .claude/skills/ada-scan-fix/            (+ .claude/ada-scan.md)
```

- Cursor files are `.mdc` with `description`, `globs` (`**/*.liquid,**/*.css,**/*.js`) and `alwaysApply: false`. `skill.mdc` is the entry.
- Claude Code gets a skill folder: `SKILL.md` (frontmatter `name: ada-scan-fix` and a description that triggers on "fix accessibility
  findings from ada-scan" and "apply ada-scan tasks") plus the reference files.
- Every installed file carries the ada-scan marker in its first lines. A file without the marker is never overwritten (it is reported as
  skipped), a symlinked skill folder is refused, files that are no longer part of the bundle are removed, a re-run changes nothing.
  `--dry-run` reports what would happen. `CLAUDE.md` is never touched. The generated rules file points to the skill entry.

## Contents

| File | Purpose |
| --- | --- |
| `SKILL.md` | entry, reading order, rule to pattern table, five overriding rules |
| `workflow.md` | mandatory per-task procedure: INDEX.md, one file at a time bottom-up, read around the element, minimal edit, verify, stop conditions, report |
| `paradox-liquid-rules.md` | shared partials once, sidecars, `forloop.index`, never touch backend tags or `data-pdk-*`, `dist/` and generated files |
| `no-break-guardrails.md` | what must not change, how to check each, tempting wrong fixes |
| `design-locked.md` | contrast and design tasks are reported, never fixed; non-colour options only as questions |
| `when-to-ask-a-human.md` | data-bound content, meaning and translation, design, needs-review, third-party DOM, low-confidence locations |
| `patterns/*.md` | one file per rule family: intent, before and after, cautions, verify, do not |

## `ada-scan fix --verify [--baseline <report>]`

Checks the working tree against the export, using git (`diff HEAD` plus untracked files, relative to `--source`):

| Check | Violation when |
| --- | --- |
| Files | a changed file is not named by a task (its `source`, candidates, likely locations, scripts the task cites; the `.liquid.json` sidecar of an allowed template is allowed) |
| Generated | anything under `dist/`, `paradox-export.json` or a generated `+.css` changed |
| Data tags | the multiset of `{{data|component|snippet|attribute:..}}` tags and `data-pdk-*` attributes differs (`src/fix/harness/tokens.js`) |
| Colours | a colour, opacity, background or token declaration was removed or changed, or any colour declaration changed in a file a design-locked task names. A pure addition elsewhere is a warning |

Tasks come from `<out-dir>/tasks/*.json`, or from `--baseline <report>` (the task set is rebuilt from that report). Files owned by ada-scan
(the skill, rules, `.ada-scan/`) are ignored. The command prints a table and exits 1 on any violation, 0 otherwise. It is a quick static
check; it does not replace a rescan, and the harness gates G1 to G8 (`fix-harness.md`) remain the full proof.

## Evaluating the skill

`scripts/skill-eval.md` is a manual protocol for running an AI tool on a copy of a fixture project and scoring correct fixes, broken
things and ignored instructions. `checkCoverage()` (`src/fix/export/skill/coverage.js`, tested in `test/fix/fix-skill.test.js`) is the
automated static check: every rule that `recipes.js` can export maps to a pattern file that exists and is listed in `SKILL.md`, and no
pattern file is orphaned. Add a recipe rule and the test fails until its pattern is written and mapped. A lint test also rejects em and en
dashes and forbidden advice (changing a colour, positive `tabindex`, hiding a skip link) in every skill file.
