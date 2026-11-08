# Bypass blocks and invisible focus stops

Two deterministic keyboard checks. Both are measured in the live DOM of the scanned page and carry their measurement as proof.

## skip-link-missing (WCAG 2.4.1)

A skip link is an in-page anchor (`href="#id"`) among the first 10 visible focusable stops whose name says skip, jump, main content or content. When none exists:

- The description lists the first 5 focusable stops (tag, name, href), the number of focusable stops inside header, nav, banner or navigation landmarks that come before the main content, and whether a main landmark or a heading exists.
- `confirmed` when there are 3 or more such header/nav stops and a main landmark, `h1` or `h2` to skip to.
- `needs-review` otherwise: a small header (fewer than 3 stops) or a page with nothing to skip to may not need a bypass.

Seeds (bad / good): `skip-absent-nav` (confirmed) against `skip-target-present` (silent); `skip-absent` and `skip-absent-no-target` (needs-review).

## focus-invisible-stop (WCAG 2.4.7, 2.4.11)

A tabbable element that cannot be seen but stays in the tab order, for example the links of a closed mobile menu hidden with `opacity: 0`.

- Invisible means: effective opacity 0, zero size, a 1px or clipped box (`clip`, `clip-path: inset(50%)`), or a box fully outside the document. `display: none`, `visibility: hidden`, `inert` and `aria-hidden` are not reported (they leave the tab order or belong to another rule).
- Static pass: every such tabbable element, with the count and the first 5 short selectors. Skip links are left out.
- Tab simulation: the first 40 Tab presses are watched. The element that holds focus is tested at its focus state, so a skip link or menu that becomes visible on focus is fine.
- `confirmed` when focus lands on an element that is still invisible. `needs-review` when the invisible stops were only found statically (focus never reached them within 40 presses), or when the only landed element is a checkbox, radio or file input (custom controls are often drawn on their label).

Seeds (bad / good): `invisible-menu-bad` (confirmed) against `invisible-menu-good` (silent: display none, visibility hidden, aria-hidden, skip link shown on focus); `invisible-checkbox` and `invisible-after-window` (needs-review).
