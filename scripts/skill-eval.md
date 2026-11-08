# Evaluating the fix skill (manual protocol)

Goal: measure whether an AI coding tool, given the installed skill, fixes ada-scan findings correctly and safely. Run it on a copy
of a fixture project, never on a real site repository.

## Setup

1. Copy a fixture project (a Paradox style tree with `src/layouts`, `src/partials`, `src/pages`, `.liquid.json` sidecars and a git
   history) to a scratch folder. `git init` and commit it so the diff is the evidence. Build it so a scan can run locally.
2. Scan it and save a baseline: `ada-scan --baseline`. Keep the report.
3. Seed or pick findings covering the families below. Export for the tool under test:
   `ada-scan fix --export --target cursor` (or `claude`). Confirm the skill folder was installed.
4. Record the task list: id, rule, file, expected outcome (fix, skip, or ask).

## Task list (one or more per row)

| Family | Expected |
| --- | --- |
| button-name, link-name, image-alt (decorative and informative) | fix; informative alt from data is asked about |
| form label in a loop | fix with `forloop.index` ids |
| nav labels, main landmark | fix once in the shared partial |
| skip link missing | fix once in the layout, visible on focus |
| heading order, missing h1 | tag change only, classes unchanged |
| disclosure aria-expanded | markup plus script, Enter and Space work |
| target size | grow hit area with arbitrary px, neighbours unmoved |
| label in name | name starts with visible text |
| colour contrast | skip, reported for the design owner (trap) |
| finding inside `data-react-component` | skip, not actionable (trap) |
| label needing translation or data meaning | ask a person (trap) |

## Run

Give the tool only this prompt: "Fix accessibility findings from ada-scan." Do not hint at rules. Let it work to completion.
Then in the copy run `ada-scan fix --verify`, rebuild, rescan with `ada-scan --url <site>` (compares with the saved baseline), and open the changed pages at 375, 768
and 1280 px, tabbing through each.

## Metrics

| Metric | How to count |
| --- | --- |
| Correct fixes | tasks whose rule is gone for the task's ids, with the pattern's expected edit, and nothing else changed |
| Broken things | any of: layout or spacing shift, colour change, new finding on rescan, missing or moved element, tab order change, removed focus style, `fix --verify` violation, changed backend tag |
| Instructions ignored | a rule in `SKILL.md`, `workflow.md` or a pattern the tool broke: edited a design-locked task, did not read INDEX.md, edited files out of order, skipped verification, invented text where it should have asked, claimed verified without a rescan |
| Correct skips and questions | trap tasks left alone with a stated reason |
| Report quality | the final report has a row per task and lists open questions |

Score: correct fixes over fixable tasks; broken things must be zero; ignored instructions must be zero for the hard rules (colours, backend
tags, generated files). For every ignored or broken item, find the sentence in the skill that should have prevented it and make it more
concrete, or add a row to the wrong-fix table. Rerun until clean. Compare two tools or two skill versions on the same copy and the same tasks.

## Static companion

`node --import ./test/helpers/hermetic-env.mjs --test test/fix/fix-skill.test.js` checks that every exported rule family has a pattern
file, that the bundle has no em or en dashes and no forbidden advice, and that the installer is safe. Run it after editing the skill.
