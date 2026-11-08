# carousels: named region, controls, hidden slides unreachable

Intent: a carousel (Embla in this stack) is a labelled region with named controls, and off-screen slides are not focusable.

Before:

```liquid
<div class="embla">
  <button class="embla__prev"><i class="fa-solid fa-chevron-left"></i></button>
  <button class="embla__next"><i class="fa-solid fa-chevron-right"></i></button>
</div>
```

After:

```liquid
<section class="embla" aria-roledescription="carousel" aria-label="Featured jobs">
  <button type="button" class="embla__prev" aria-label="Previous slide"><i class="fa-solid fa-chevron-left" role="presentation"></i></button>
  <button type="button" class="embla__next" aria-label="Next slide"><i class="fa-solid fa-chevron-right" role="presentation"></i></button>
</section>
```

Slides: `role="group" aria-roledescription="slide" aria-label="{{ forloop.index }} of {{ forloop.length }}"`. Slides out of view are `inert` or `aria-hidden` plus `tabindex="-1"` on their controls, updated by the existing script on slide change.

Automatic rotation needs a visible pause control; ask before adding one (it changes the design).

Cautions:
- Control names state the action. Dots need names ("Go to slide 2") from `forloop.index`.
- Do not change the Embla options, speed or transitions.

Verify: Tab reaches only visible slide content and the controls; Enter/Space operate them. Rescan: names and `aria-hidden-focus` rules gone.

Do not:
- Do not add `aria-expanded` to dots.
- Do not remove arrows or dots.
- Do not stop autoplay without approval.
