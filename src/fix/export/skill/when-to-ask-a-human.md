# When to ask a human

Stop and ask rather than guess. Put each question in the final report with the task id, the file and a proposed default.

| Situation | Why | What to ask |
| --- | --- | --- |
| Content bound to data (`{{data:..}}`, `{{attribute:..}}`, a loop over data) | The value is not in the template; a fixed string would be wrong for most items | Where do the per-item labels or alt texts come from? Add them to the sidecar or the platform data? |
| A label, alt text or heading needs real meaning | The scan cannot know what an image shows or what a control does | What does this image convey, or what does this control do? |
| Text must be translated | A wrong-language name fails users and breaks 2.5.3 | Which strings exist per locale, and who translates the new one? |
| Brand or design decision (colour, spacing, size, layout, type, motion) | Design owns it | Is this change acceptable to the designer? |
| Task verdict is needs-review | The tool is unsure the finding is real | Is this a true defect on the live page? |
| Third-party or platform-owned DOM (`data-react-component`, vendor widget, iframe, injected banner) | The code is not in this project | Who owns it, and should it be reported to them? |
| Task says "locate manually" with low confidence or several candidates | A wrong file edit is worse than none | Which of these candidate files renders the element? |
| The fix needs a new element, a changed heading level or a moved landmark on many pages | Layout and document outline change | Is the new structure approved? |
| The script that toggles a widget is not in `src/scripts/` | Markup alone cannot fix state | Where does this widget's behaviour live? |
| Two attempts at the same task failed | You are guessing | What am I missing? |

## How to ask

- One short question per item, with the file and line, what you found, and the default you would pick.
- Continue with the other tasks; do not wait on a question that blocks only one task.
- Never fill in a value "for now" that looks final (a placeholder alt, a fake label). A placeholder is visible to users.

## Do not

- Do not invent alt text, labels, titles or translations.
- Do not fix a needs-review finding by removing the element.
- Do not edit platform or third-party markup to make a finding go away.
