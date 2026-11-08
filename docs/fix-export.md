# Fix export for AI tools

`ada-scan fix --export` writes `tasks/INDEX.md`, one markdown and one JSON file per task, and with
`--target cursor|claude` one rules file. No AI and no network are used. Everything is a suggestion for a person or an
AI coding tool; nothing is applied by ada-scan.

## Task file

Sections: Where (source excerpt, pages, element), Evidence (measured values and proof lines), Fix (the recipe, filled from the
finding), Do not (cautions), Verify (command, a compact criterion, a rule specific check). When a recipe is certain from the
excerpt, a "Proposed change" block shows a unified-diff style suggestion to adapt. Ids stay in the JSON sidecar; the markdown
states the criterion as "rule X no longer reported on pages P1..Pn for selector pattern S".

Recipes live in `src/fix/export/recipes.js`, keyed by rule id (aliases such as `TargetSize` are handled). A rule without a recipe
is marked "No recipe: use judgement" and never repeats the problem sentence as the fix.

## Liquid and Paradox guidance

Every task carries the same cautions: edit a shared partial or layout once; per-item values go in the `.liquid.json` sidecar when
the element is rendered in a `for` loop or its text comes from data; never hard-code an id inside a loop (use `forloop.index`);
keep `{{data:..}}`, `{{component:..}}`, `{{snippet:..}}` tags and `data-pdk-*` attributes; prefer Tailwind utilities already used.

## Design decisions

Colour follows the design. Rules matched by `DESIGN_LOCKED` in `recipes.js` (the contrast family, and any finding whose colour token
chain points to a brand token) are never auto-fixed: they get a "For the design owner" section (current and required ratio, the token
chain with its declaring file and line, the nearest passing colour in the same hue as information only, questions for the designer),
no diff, and a separate INDEX section "Design decisions (do not change colours)" outside the AI work list. The task JSON has
`requiresDesignDecision: true`. The prompt and the rules file state that colour values, tokens, utility colour classes, opacity and
background images are never changed to fix contrast.

## By file and --group-by-file

INDEX.md has a summary table and a "By file" section: tasks per source file, highest line first, so edits apply bottom-up and line
numbers stay valid. `--group-by-file` writes one combined task (`file-<path>.md` and `.json`) per source file instead; tasks with no
traced file and design decisions stay separate.

## Page-wide root causes

Findings with no source line (skip link, h1, landmarks) list the likely files by role (the layout holding `<body>`, the file with
`<main>`, the header partial) found in the local source tree.

## Fix skill and verify

`--target cursor|claude` also installs the fix skill (`docs/fix-skill.md`) and writes agent rules into the project (`.cursor/rules/` or `.claude/`), because the editor reads them there. Decision: ada-scan does not touch git metadata. When git does not already ignore those paths it prints a one-line `.git/info/exclude` suggestion (a local exclude, never committed); delete the files after the editor pass if you prefer. `--out-dir` exports are verified with `ada-scan fix --verify --out-dir <dir>` (the rules file says so). And `ada-scan fix --verify` checks the working tree diff against this export.
