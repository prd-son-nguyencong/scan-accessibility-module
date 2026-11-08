# html-validate rule table

The offline `htmlValidate` layer runs html-validate over the rendered DOM and feeds `thresholds.w3c.errors` / `w3c.warnings`.
The preset is `DEFAULT_HTML_VALIDATE_RULES` in `src/scanner/html-validate.js`; `test/html-validate.test.js` fails when this
table and the preset disagree, so edit both together. Override per rule with `html.validate.rules` in the scan config.

- **error**: the W3C Nu validator also reports it as an error. Finding is deterministic and confirmed (impact per the table below), counted in `w3c.errors`, can fail the gate.
- **Mapping**: `error` -> impact from `HTML_VALIDATE_IMPACT` (serious, moderate or minor; an unlisted rule stays serious), type error; `warn` -> impact minor, type warning, kind heuristic (needs-review, never confirmed). Only rules that mirror a real spec error may be `error`; conventions stay `warn`.
- **warn**: Nu reports only a warning, or it is a convention. Finding is minor, kind heuristic (verdict likely), counted in `w3c.warnings` only (default target `report`).
- **off**: style only, covered by axe / accessScan (avoids double counting), or wrong for a serialized DOM and Paradox custom elements.

Calibration on the real preview home page (raw HTML, 52 findings before, 33 after, 2 errors): `script-type` 5 errors -> warnings,
`valid-id` 4 errors -> 0 (GUID-prefixed ids start with a digit, valid per the HTML standard), `attr-case` 4, `no-implicit-input-type` 4,
`no-implicit-button-type` 4, `unique-landmark` 2, `hidden-focusable` 1 -> off. Remaining errors: empty `<title>` and an `<iframe>` without `title`.

| Rule | Severity | Why |
| --- | --- | --- |
| `aria-hidden-body` | off | axe aria-hidden-body |
| `aria-label-misuse` | warn | ARIA-in-HTML conformance, noisy on widgets; axe aria-allowed-attr covers the accessibility effect. `aria-label` on `h1`-`h6` is dropped (ARIA 1.2 allows naming headings) |
| `attr-case` | off | Attribute names are case-insensitive; style only |
| `attr-delimiter` | off | Whitespace around `=` is valid HTML |
| `attr-quotes` | off | Style only |
| `attr-spacing` | error | Missing space between attributes: Nu error |
| `attribute-allowed-values` | error | Bad enumerated value: Nu error |
| `attribute-boolean-style` | off | Style only |
| `attribute-empty-style` | off | Style only |
| `attribute-misuse` | error | Attribute not allowed on the element: Nu error |
| `close-attr` | error | End tag with attributes: Nu error |
| `close-order` | error | Unclosed or stray end tag: Nu error |
| `deprecated` | error | Obsolete element: Nu error |
| `deprecated-rule` | off | Linter housekeeping |
| `doctype-html` | error | Wrong doctype: Nu error |
| `doctype-style` | off | Style only |
| `element-case` | off | Element names are case-insensitive |
| `element-name` | off | Paradox widgets use custom elements |
| `element-permitted-content` | error | Invalid nesting: Nu error |
| `element-permitted-occurrences` | error | Too many of a unique child: Nu error |
| `element-permitted-order` | error | Children out of order: Nu error |
| `element-permitted-parent` | error | Invalid parent: Nu error |
| `element-required-ancestor` | error | Missing required ancestor: Nu error |
| `element-required-attributes` | error | Missing required attribute: Nu error (also reports `<iframe>` without `title`, which Nu does not; axe frame-title covers it) |
| `element-required-content` | error | Missing required child: Nu error |
| `empty-heading` | off | Nu warning; axe empty-heading |
| `empty-title` | error | Empty `<title>`: Nu error |
| `form-dup-name` | warn | Valid HTML, convention |
| `heading-level` | off | Nu does not check; axe heading-order |
| `hidden-focusable` | off | axe aria-hidden-focus |
| `input-attributes` | error | Attribute not valid for the input type: Nu error |
| `input-missing-label` | off | axe label |
| `long-title` | off | Style only |
| `map-dup-name` | error | Duplicate map name: Nu error |
| `map-id-name` | error | Map id and name differ: Nu error |
| `meta-refresh` | off | axe meta-refresh |
| `multiple-labeled-controls` | error | Label with several controls: Nu error |
| `no-abstract-role` | off | axe aria-roles |
| `no-autoplay` | warn | Convention (WCAG 1.4.2), not Nu |
| `no-conditional-comment` | off | Style only |
| `no-deprecated-attr` | error | Obsolete attribute: Nu error |
| `no-dup-attr` | error | Duplicate attribute: Nu error |
| `no-dup-class` | warn | Repeated class token, harmless |
| `no-dup-id` | error | Duplicate id: Nu error |
| `no-implicit-button-type` | off | Default type is valid, convention |
| `no-implicit-close` | off | Omitted end tags are valid HTML |
| `no-implicit-input-type` | off | Default type is valid, convention |
| `no-inline-style` | off | Style only |
| `no-multiple-main` | error | More than one visible `<main>`: Nu error |
| `no-raw-characters` | off | The serialized DOM is always escaped |
| `no-redundant-aria-label` | warn | Convention |
| `no-redundant-for` | warn | Convention |
| `no-redundant-role` | warn | Nu warning |
| `no-self-closing` | error | Self-closing syntax on non-void element: Nu error |
| `no-trailing-whitespace` | off | Style only |
| `no-unknown-elements` | off | Paradox widgets use custom elements |
| `no-unused-disable` | off | Linter housekeeping |
| `no-utf8-bom` | off | Not visible in a serialized DOM |
| `prefer-button` | warn | Convention |
| `prefer-native-element` | warn | Convention (`role` on a generic element, `<a href role=button>` and `role=region aria-roledescription=carousel` are valid) |
| `prefer-tbody` | off | Style only |
| `require-sri` | off | Style only |
| `script-element` | error | Script end tag: Nu error |
| `script-type` | warn | Redundant `type` is a Nu warning |
| `svg-focusable` | off | Off in html-validate:recommended |
| `tel-non-breaking` | off | Style only |
| `text-content` | error | Text not allowed in the element: Nu error |
| `unique-landmark` | off | axe landmark-unique |
| `unrecognized-char-ref` | error | Unknown character reference: Nu error |
| `valid-autocomplete` | error | Bad autocomplete value: Nu error |
| `valid-id` | error | HTML standard: non-empty, no whitespace. `relaxed` mode; digits first and punctuation are valid (Paradox ids start with a GUID) |
| `void` | off | Off in html-validate:recommended |
| `void-content` | error | Content in a void element: Nu error |
| `void-style` | warn | Trailing slash on void elements is a Nu warning |
| `wcag/h30` | off | axe link-name |
| `wcag/h32` | warn | Form without submit button (WCAG 3.2.2): axe has no equivalent, not Nu |
| `wcag/h36` | off | axe input-image-alt |
| `wcag/h37` | off | axe image-alt |
| `wcag/h63` | warn | th without scope (WCAG 1.3.1): axe has no equivalent, not Nu |
| `wcag/h67` | off | axe image-alt |
| `wcag/h71` | warn | Fieldset without legend (WCAG 1.3.1): axe has no equivalent, not Nu |

## Impact of error rules

Generated from `HTML_VALIDATE_IMPACT`; `test/html-validate.test.js` fails when this table and the mapping disagree. `warn` rules are always minor.

| Rule | Impact | Why |
| --- | --- | --- |
| `attr-spacing` | minor | spec or hygiene, no assistive-technology effect |
| `attribute-allowed-values` | moderate | invalid markup an assistive technology or browser may mis-handle |
| `attribute-misuse` | moderate | invalid markup an assistive technology or browser may mis-handle |
| `close-attr` | minor | spec or hygiene, no assistive-technology effect |
| `close-order` | minor | spec or hygiene, no assistive-technology effect |
| `deprecated` | minor | spec or hygiene, no assistive-technology effect |
| `doctype-html` | minor | spec or hygiene, no assistive-technology effect |
| `element-permitted-content` | moderate | invalid markup an assistive technology or browser may mis-handle |
| `element-permitted-occurrences` | moderate | invalid markup an assistive technology or browser may mis-handle |
| `element-permitted-order` | minor | spec or hygiene, no assistive-technology effect |
| `element-permitted-parent` | moderate | invalid markup an assistive technology or browser may mis-handle |
| `element-required-ancestor` | moderate | invalid markup an assistive technology or browser may mis-handle |
| `element-required-attributes` | serious | breaks assistive-technology semantics (accessible name, id reference, document title) |
| `element-required-content` | moderate | invalid markup an assistive technology or browser may mis-handle |
| `empty-title` | serious | breaks assistive-technology semantics (accessible name, id reference, document title) |
| `input-attributes` | moderate | invalid markup an assistive technology or browser may mis-handle |
| `map-dup-name` | moderate | invalid markup an assistive technology or browser may mis-handle |
| `map-id-name` | minor | spec or hygiene, no assistive-technology effect |
| `multiple-labeled-controls` | serious | breaks assistive-technology semantics (accessible name, id reference, document title) |
| `no-deprecated-attr` | minor | spec or hygiene, no assistive-technology effect |
| `no-dup-attr` | minor | spec or hygiene, no assistive-technology effect |
| `no-dup-id` | serious | breaks assistive-technology semantics (accessible name, id reference, document title) |
| `no-multiple-main` | moderate | invalid markup an assistive technology or browser may mis-handle |
| `no-self-closing` | minor | spec or hygiene, no assistive-technology effect |
| `script-element` | minor | spec or hygiene, no assistive-technology effect |
| `text-content` | minor | spec or hygiene, no assistive-technology effect |
| `unrecognized-char-ref` | minor | spec or hygiene, no assistive-technology effect |
| `valid-autocomplete` | moderate | invalid markup an assistive technology or browser may mis-handle |
| `valid-id` | serious | breaks assistive-technology semantics (accessible name, id reference, document title) |
| `void-content` | minor | spec or hygiene, no assistive-technology effect |
