# Spike E4.2: tracing preview findings through the local build

Question: can a finding on Studio (preview) HTML, which has no snippet markers, be traced to
`src/**/*.liquid:line` by matching it against the local instrumented build of the same page? Gate 3 asks
for zero wrong `high` and at least 80% of traceable elements traced right (`high` or `medium`).

Reproduce: `nice -n 15 node --import ./test/helpers/hermetic-env.mjs --test test/fingerprint-map.test.js`
(the simulator is `test/helpers/preview-sim.js`; its `measure()` returns the rows behind every number below).

## Method

* Reference = `test/fixtures/paradox-site/pages/{index,benefits}.html` (local build with `<!-- snippets/x.html -->` markers).
* Truth for an element = what the E4.1 local pipeline traces for it in the unmutated page (`high`/`medium`
  to one `file:line`), with every index.liquid line checked by hand against the fixture source (3-5, 7, 9-13, 17, 19-23, plus the
  header/footer/layout partial lines). An earlier version of this spike was partly self-referential: `index.html` held a "Clean twins"
  section that `src/pages/index.liquid` never authored, so E4.1 guessed lines for it. The fixture now authors that section (lines 17-24), and
  a page-level hit in another page's source (the three `benefits.html` clean elements, which has no `benefits.liquid`) is not accepted as truth: the right answer there is no path.
  32 elements on the two pages qualify ("traceable"); 12 injected plus 7 source-less elements have no source.
* `simulatePreview()` turns the page into fake Studio output. Profiles are cumulative:
  `light` markers stripped + whitespace collapsed; `attrs` + attributes reversed + a `css-1a9f3c` deploy-hash class on every 3rd
  classed tag; `bound` + every 4th text node replaced by a bound value; `heavy` + a wrapper div per snippet region, an injected
  `data-react-component` widget with a link, an injected script, rewritten `<title>` and viewport, extra `<meta>`;
  `holdout` = different cadences (hash every 2nd, bind every 3rd), whitespace kept, same structure changes.
* Each element's probe is its preview outerHTML plus a CSS selector built like a scanner's (`header.site-header > nav > a:nth-child(2)`,
  three levels). Verdicts compare the preview trace with the truth; injected elements must get no path.
* Fingerprint = tag, stable classes (utility/hash noise dropped), a fixed attribute subset, leaf text (normalized, 80 chars),
  ancestry and sibling position read from the selector, plus a bonus for a lone `title`/`main`/`h1`. Scores are summed,
  `MIN_SCORE 8`, `MARGIN 4`, `HIGH_SCORE 12` (`src/tracer/fingerprint-map.js`). All local elements within `MARGIN` of the best
  score are candidates; several distinct source lines => `ambiguous`.
* No HTML parser exists in `node_modules` (no parse5/htmlparser2; only html-validate's internal one), so the index uses a small
  quote-aware tokenizer with marker regions, parent chain and sibling index.

## Results (fixture, 2 pages, 32 traceable elements per profile)

Same 32 elements every profile, so these are not independent samples. "No reference" = the E4.1 preview trace without the local build (source-side search only).

| Profile | no reference correct | no reference ambiguous | fingerprint correct (high+medium) | untraceable (miss) | wrong high | wrong other | path on element without source |
| --- | --- | --- | --- | --- | --- | --- | --- |
| light | 20 (62%) | 9 | 30 (94%), 6 high | 2 | 0 | 0 | 0 (no reference: 3 `medium`) |
| attrs | 20 (62%) | 9 | 30 (94%), 6 high | 2 | 0 | 0 | 0 |
| bound | 20 (62%) | 9 | 30 (94%), 6 high | 2 | 0 | 0 | 0 |
| heavy | 20 (62%) | 9 | 27 (84%), 6 high | 5 | 0 | 0 | 0 |
| holdout | 20 (62%) | 9 | 26 (81%), 6 high | 6 | 0 | 0 | 0 |

Confusion table, `heavy` profile, fingerprint (rows = truth, columns = result):

| truth \ result | high | medium | ambiguous | untraceable | wrong path |
| --- | --- | --- | --- | --- | --- |
| single source line (32) | 6 correct | 21 correct | 0 | 5 | 0 |
| no single source: 12 injected, 29 ambiguous, untraceable or source-less locally (41) | 0 | 0 | 10 | 31 | 0 |

The 5 misses are the viewport `<meta>` (content rewritten), a bound `<h2>` with no class or attribute, and bound or wrapper-shifted
`<footer>`/`<p>` elements whose score lands at 6-7, just under `MIN_SCORE`. In an earlier scoring round `MIN_SCORE 4` recovered one more
element with no wrong path; that was not re-measured on the final scoring and 4 points of structure alone is too weak to trust on one
fixture, so it is not adopted. The 2 misses already in `light` are the footer `<p>`s: their truth is a bare-tag `medium`, which a twin
no longer gets because `<p>` is not unique in the reference page (see below).

Foreign-page stress test (not committed): one real preview page of an unrelated site (746 elements, fetched once, saved outside the
repo) matched against the fixture's `index.html`. Truth: nothing should trace. E4.1 behaviour: 87 `medium` + 25 `ambiguous` (bare
tag-name and weak matches; that run already had low demoted). With the reference: 0 `high`, 3 `medium` (an empty `<title>`, a
`<link rel=stylesheet href=/styles.css>` and a 16px `<svg>` that really are identical in both pages), 743 `untraceable`.

## What the spike changed

* A page with markers is the truth for its route: an element with no fingerprint twin is `untraceable` (`no-match`), it no longer falls
  back to the source-side hint search that produced the 87 foreign mediums.
* Preview mode never returns `low` and never grants `medium` for a bare tag-name match. A twin traced through the reference page
  (found by fingerprint, then traced in local mode) gets a bare-tag `medium` only when its tag is unique in the reference page too;
  otherwise the lone source tag may be a different element (the `<h2>Clean twins</h2>` case traced to the Seeded defects `<h2>`).
  A twin on a page with no source file of its own no longer falls back to the cross-page hint search.
* The matched local element is traced with only its own marker regions, so identical markup in another snippet (header and
  footer both holding `<a href="/benefits">Benefits</a>`) does not turn a unique fingerprint match into an ambiguity. Without a selector
  the two stay `ambiguous`.
* Scoring corrections made while measuring: probe classes the local element never had cost -3, container text is ignored (bindings rewrite
  it), a selector landmark/id the candidate lacks costs -5 (a contradictory selector must not still pass `MIN_SCORE`), `title`/`main`/`h1` singleton bonus.
  The holdout profile was added after the first round, so it was seen while tuning; it is not blind.

## Decision and Gate 3 threshold

Ship the fingerprint map: `high` only for a unique match (no other local element within `MARGIN`), score >= 12 and a `high` local trace;
page-level matches (no marker owner) stay `medium`; ties and conflicting lines are `ambiguous` with every line listed; no match is `untraceable`.

Proposed Gate 3 numbers, to hold on every profile and on any real fixture added later (n >= 30 traceable elements):

1. Zero wrong `high` (kept).
2. Zero path (any confidence) for an element with no local twin.
3. >= 80% of elements with a single reference source traced to that source (`high` or `medium`); ambiguous counts against it, which is stricter than the TASKS wording. The fixture meets it (81-94%, hand-checked truth) but the margin on `holdout` is one element.
4. Everything else `ambiguous` or `untraceable` with a reason.

## Limits (not measured)

* The fixture is tiny and hand-written; the simulator is mine, so mutations the platform really makes (hydrated attributes, reordered
  siblings, locale text, Studio-edited copy) are guesses. The numbers say the mechanism works, not what the real rate is.
* No real preview/local pair of the same site was available (builds against the host repo are off limits here), so recall on real
  Studio output is unmeasured. The foreign-page test only supports the "no wrong path" side.
* The scanner's selector is the main position signal; findings without a selector lose it and fall to `medium` or `ambiguous`.
* `benefits` has no `src/pages/benefits.liquid` in the fixture, so its page-level elements are untraceable by design.
