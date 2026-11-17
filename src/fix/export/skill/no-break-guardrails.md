# No-break guardrails

An accessibility fix that breaks the page is a failed fix. These things must stay identical unless the task documents the
change. Check each one after editing.

| Must not change | How to check |
| --- | --- |
| Layout and spacing | Compare the page before and after at 375, 768, 1280 px: nothing shifts. A skip link or sr-only text is out of flow. Rescan with `ada-scan` (it compares with the saved baseline) and look for new findings |
| Typography | No `text-*`, `font-*`, `leading-*`, `tracking-*` change. Heading level fixes change the tag only, never the classes |
| Colours, opacity, backgrounds | `ada-scan fix --verify` reports colour declaration changes. Zero is the only acceptable number |
| DOM order | The diff shows no moved block. A new element goes where the pattern says and nowhere else |
| Element count | Only the additions a pattern documents (skip link, visible label, sr-only text). No element is removed to silence a finding |
| Tab order | Tab through the page: same stops in the same order, plus only documented additions. No `tabindex` above 0 |
| Focus styles | A focus ring may be added, never removed or weakened. Check with Tab on the changed control |
| Animations and transitions | No class or script change that starts, stops or retimes motion |
| Visible text | Strings unchanged. A new accessible name must start with the visible text (see `patterns/label-in-name.md`) |
| Performance | No new script, font, image or large inline block. A fix is attributes and small markup |
| Backend tags and `data-pdk-*` | `ada-scan fix --verify` compares the multiset; it must be identical |

## Tempting wrong fixes

| Wrong fix | Why it is wrong | Do this instead |
| --- | --- | --- |
| `aria-hidden="true"` on a container that holds focusable content | Hides it from screen readers while keyboard users still reach it | Make closed content `inert` or `hidden`, or leave it visible and named |
| `display: none` on a skip link to hide it | Removes it from the tab order, so it never works | `sr-only focus:not-sr-only` so it appears on focus |
| Removing the element that triggers a finding | The user loses the feature; the scan goes quiet | Fix the element, or ask a person |
| `role="presentation"` on a real control (button, link, input) | It strips the control's role and name | Give it a name; remove only decorative icons from the tree |
| `aria-label` that contradicts the visible text | Breaks speech input and 2.5.3 | Start the name with the visible text, or drop the label |
| `tabindex="3"` to repair order | Creates a second, fragile tab order | Fix DOM order, or use `tabindex="0"` only on custom widgets |
| `id="panel"` repeated in a loop | Duplicate ids break every reference | `id="panel-{{ forloop.index }}"` everywhere it is referenced |
| `title` as the only accessible name | Not reliably announced, absent on touch | Visible text or `aria-label`, `title` optional |
| `outline: none` for tidiness | Removes the focus indicator | Replace with a `focus-visible:` style, never remove |
| A bigger icon or font to reach 24px | Changes the design | Grow the hit area with padding or min size on the control |
| Changing a colour "just a little" to pass contrast | Design-locked | Report it; see `design-locked.md` |
| An empty `alt=""` on an informative image | The information is lost | Describe it, or ask what it conveys |

## Do not

- Do not "improve" nearby code while you are there. One task, one edit.
- Do not reformat a file. The diff must show only the lines you meant to change.
- Do not change line endings or indentation style.
- Do not add dependencies or scripts.
