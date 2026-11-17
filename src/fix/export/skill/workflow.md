# Workflow: the mandatory procedure

Follow every step for every task. Do not batch edits across files, do not skip verification.

## 1. Orient

- Read `tasks/INDEX.md` in the export folder (the rules file names its path). Note the target URL, the task count, and the
  three lists: "Tasks", "Design decisions (do not change colours)", "Not actionable in source".
- Work only from "By file". Tasks under design decisions and "Not actionable in source" are never edited.
- Check the working tree is clean enough to review: run `git status`. Unrelated changes already present are not yours.

## 2. One file at a time, bottom-up

- Pick the next source file in "By file". Open it once.
- Apply its tasks in the order listed: highest line first, so earlier line numbers stay valid.
- Finish and verify one file before opening the next.

## 3. Per task

1. Read the task markdown: Where, Evidence, Fix, Do not, Verify. Read the pattern file for its rule.
2. Read the element and 10 lines above and below it in the real file. Line numbers can drift after earlier edits; match
   by the element shown in the task, not by number alone.
3. Decide: is this element inside a `{% for %}` loop, rendered from data, in a shared partial, platform-owned? See
   `paradox-liquid-rules.md`. If unsure, read `when-to-ask-a-human.md`.
4. Make the smallest edit that satisfies the rule. "Proposed change" is a suggestion: adapt it, never paste it blindly.
5. Re-read the edited lines. Confirm: same classes, same attribute order where possible, same element count unless the
   pattern documents an addition, no changed text content, backend tags and `data-pdk-*` identical.

## 4. Verify

- After each file: `ada-scan fix --verify` (working tree against the export). Fix every violation it prints.
- After a batch of files, or when the project can be built and served: rescan with
  `ada-scan --url <site>` (compares with the baseline saved by `ada-scan --baseline`). A task is done only when its rule no longer fires for the task's selector
  pattern and its ids (in the task `.json` sidecar) are reported as fixed, and nothing new appears.
- If a rescan is not possible, say "not rescanned" in the report. Never claim a fix verified without evidence.

## 5. Stop conditions

Stop, revert that edit, and report the task as skipped when any of these hold:

- the fix needs a colour, token, opacity or background-image change;
- the element is inside `data-react-component`, a third-party widget, or generated output;
- the text or label must come from data, or needs real meaning or a translation you do not have;
- the fix changes layout, spacing, order, focus styles or an animation;
- the same error appears twice after your fix;
- `ada-scan fix --verify` flags your edit and you cannot resolve it with a smaller change;
- the task is marked "locate manually" and the location is low confidence.

## 6. Report

End with a table, one row per task id: `done` (rule gone, evidence stated), `done, not rescanned`, `skipped` (reason and the
question for a person), or `reverted` (what broke). Then list:

- files changed, and every element added or removed;
- design-locked tasks left for the design owner;
- anything that needs a person (see `when-to-ask-a-human.md`);
- commands run and their result. Do not hide a failing command.
