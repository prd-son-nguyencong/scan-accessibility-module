# Design-locked tasks (hard rule)

Colour follows the design. A finding about contrast is a design decision, not a code defect you may repair.

## The rule

Never fix colour contrast by changing colours, tokens, utility colour classes, opacity or background images. This holds
even when the task shows a nearby passing value, even when the ratio is only just below the limit, even when asked to "just
make it pass". Report it for the design owner and move on.

## What is design-locked

- Rules `color-contrast`, `color-contrast-enhanced`, `focus-indicator-low-contrast`, `non-text-contrast`, and any rule
  whose id contains "contrast".
- Any finding whose colour chain points to a brand, primary, secondary or accent token.
- Any task in INDEX.md under "Design decisions (do not change colours)", or whose JSON sidecar has
  `requiresDesignDecision: true`.

## What you do

1. Do not edit the file for that task. Do not stage any colour change.
2. In the report, list the task id, rule, current and required ratio, the token chain, and the page.
3. Copy the task's "Questions for the designer" into the report. Add questions of your own only as questions.

## Non-colour options, as questions only

You may raise these to the design owner as questions. Never apply them.

- Is the text size or weight meant to qualify as large text (3:1 instead of 4.5:1)?
- Can the text sit on a different existing surface, or can a solid backing be added behind it?
- Is the element decorative or disabled, so a lower ratio is acceptable by design?
- Can the content be removed or merged?
- Is the contrast measured against a background image: which image state is the design intent?

## How to check

`ada-scan fix --verify` fails when a colour declaration or colour utility changed in a file that a design-locked task names,
and when any colour declaration was removed or changed anywhere. A rescan must show the contrast finding unchanged.

## Do not

- Do not edit hex, rgb, hsl, oklch values, CSS custom properties, `bg-*`, `text-*`, `border-*`, `fill-*`, `stroke-*`
  classes, `opacity-*` or `background-image` to move a ratio.
- Do not add an overlay, shadow or outline whose purpose is to raise a ratio.
- Do not use the nearest passing colour shown in a task. It is information for the designer.
- Do not mark a design-locked task as done.
