# Scan + Auto-Fix Pipeline — Design Spec

**Date:** 2026-05-02
**Last updated:** 2026-05-11
**Status:** Approved
**Project:** local-career-site (Paradox CEM production)
**Scope:** On-demand developer tooling — no CI/CD integration

---

## Overview

A fully automated scanning and interactive auto-fix tool for Liquid source files. The pipeline runs on-demand locally, supports scanning both local source files and live URLs, produces multiple output formats, and routes proposed fixes through 6 selectable AI modes.

---

## Architecture: Layered Modules + Shared Violation Schema

```
scripts/scan/
├── index.js                  CLI entry, arg parsing, orchestration
├── schema.js                 Shared Violation type + normalizers (all layers produce this shape)
│
├── scanner/
│   ├── browser.js            Playwright browser lifecycle (getBrowser, newPage, resilientGoto)
│   ├── axe.js                axe-core via @axe-core/playwright
│   ├── access-scan/
│   │   ├── index.js          Runs all 11 category files, returns Violation[]
│   │   ├── 01-general.js     14 rules
│   │   ├── 02-interactive.js 18 rules
│   │   ├── 03-forms.js       6 rules
│   │   ├── 04-landmarks.js   10 rules
│   │   ├── 05-graphics.js    6 rules
│   │   ├── 06-dragging.js    1 rule
│   │   ├── 07-aria.js        2 rules
│   │   ├── 08-lists.js       2 rules
│   │   ├── 09-metadata.js    8 rules
│   │   ├── 10-tabs.js        9 rules
│   │   └── 11-tables.js      7 rules
│   ├── w3c.js                W3C Nu HTML Checker
│   ├── links.js              Dead link crawler
│   ├── lighthouse.js         Lighthouse + PageSpeed Insights API (Core Web Vitals)
│   ├── keyboard.js           Keyboard navigation (tab order, traps)
│   ├── focus-trap.js         Focus trap detection (modals, overlays)
│   ├── aria-live.js          ARIA live region validation
│   ├── dynamic-content.js    Dynamic content accessibility checks
│   └── screen-reader.js      Screen reader accessibility tree analysis
│
├── tracer/
│   ├── index.js              Re-exports partial-map + resolve-source
│   ├── build-instrumented.js Instrumented Vite build (SCAN_MODE=true) + manifest loader
│   ├── partial-map.js        dist scan-manifest → Liquid file mapping
│   └── resolve-source.js     Element → Liquid source file + line resolver
│
├── fixer/
│   ├── engine.js             Rule-based patch generator + AI escalation router
│   ├── presenter.js          Terminal diff UI (readline key-driven review)
│   ├── agent.js              Alternate agent-mode fixer (deterministic + AI bulk)
│   ├── ai-client.js          CIS proxy HTTP client
│   ├── ai-fixer.js           AI bulk fixer with file context escalation
│   ├── rollback.js           Git stash rollback points for safe apply
│   ├── rules/
│   │   ├── index.js          findRule() + getAllRules() registry
│   │   ├── alt-text.js       Image alt text patch rules
│   │   ├── aria.js           ARIA attribute patch rules
│   │   ├── focus.js          Focus management patch rules
│   │   ├── font-display.js   Font display strategy rules
│   │   ├── forms.js          Form field accessibility rules
│   │   ├── headings.js       Heading hierarchy rules
│   │   ├── landmarks.js      Landmark region rules
│   │   ├── lang.js           Language attribute rules
│   │   ├── lazy-load.js      Lazy loading attribute rules
│   │   ├── scripts.js        Script tag accessibility rules
│   │   ├── semantic.js       Semantic HTML rules
│   │   └── skip-link.js      Skip link patch rules
│   ├── ui/
│   │   ├── server.js         HTTP dashboard for --ui (browser fix review)
│   │   └── state.js          FixState class (session state for browser UI)
│   └── modes/
│       ├── vscode.js         VS Code + Copilot integration (writeFixContext)
│       ├── cursor.js         Cursor IDE integration (writeFixContext)
│       ├── windsurf.js       Windsurf/Cascade integration (writeFixContext)
│       ├── codex.js          OpenAI GPT-4o API (generateFix)
│       ├── claude.js         Anthropic SDK Haiku/Sonnet (generateFix)
│       └── cis.js            Workday CIS proxy (generateFix)
│
├── reporter/
│   ├── scan-report.js        writeReport, writeBaseline, loadBaseline, printConsoleSummary
│   ├── html.js               writeHtmlReport — main visual dashboard (scan-visual.html)
│   ├── html-report.js        writeVisualReport — legacy alternate reporter (unused)
│   ├── exec-summary.js       generateExecSummary — ROI comparison generation
│   └── roi-doc.js            generateRoiDocuments — roi-comparison.html + roi-technical.html
│
└── utils/
    ├── config.js             loadConfig — .scan-config.json loader with defaults
    ├── server.js             isServerRunning, startDevServer, ensureServer
    ├── paths.js              getDirname, getProjectRoot, distToSrcLiquid, urlToPageFile
    ├── git.js                hasGitRepo, gitStash, gitStashPop, gitDiffFiles, gitChangedSinceLastCommit
    └── logger.js             log, info, warn, error, section, subsection
```

---

## Section 1 — Foundation

### 1.1 Shared Violation Schema (`schema.js`)

Every scan layer returns `Violation[]`. This is the single source of truth consumed by the reporter and fixer.

```js
{
  id:              string,   // uuid per violation
  ruleId:          string,   // e.g. "StrongMismatch", "image-alt"
  layer:           string,   // "axe" | "accessScan" | "w3c" | "links" | "lighthouse" | "keyboard" | "focusTrap" | "ariaLive" | "dynamicContent" | "screenReader"
  category:        string,   // "accessibility" | "markup" | "reliability" | "performance"
  wcagRef:         string?,  // "WCAG 2.1 AA 2.4.7"
  impact:          string,   // "critical" | "serious" | "moderate" | "minor"
  priority:        number,   // 1-4 (mapped from impact via impactToPriority)
  count:           number,   // occurrence count (default 1)
  foundAt:         string,   // ISO timestamp
  related:         array,    // related violation IDs

  element: {
    outerHTML:     string,   // captured DOM snapshot
    selector:      string,   // CSS selector path
    scanId:        string?,  // data-scan-id (local mode only)
  },

  source: {
    mode:          string,   // "local" | "url"
    file:          string?,  // src/partials/jobs/results-header.liquid
    line:          number?,  // 12
    snippet:       string?,  // +-5 lines of Liquid source with context
    url:           string?,  // live URL (url mode only)
  },

  fix: {
    deterministic: boolean,  // true = rule engine patches it; false = AI escalation
    hint:          string,   // human-readable fix instruction
    patch:         string?,  // pre-computed Liquid diff (if deterministic)
  },
}
```

**Schema utilities** (also exported from `schema.js`):

| Export | Purpose |
|--------|---------|
| `createViolation(opts)` | Factory — builds a Violation with UUID, timestamp, defaults |
| `ACCESSSCAN_CATEGORIES` | 11-category mapping of ruleIds → category labels + WCAG versions |
| `getAccessScanCategory(ruleId)` | Lookup category for a given accessScan rule |
| `IMPACT_ORDER` | `['critical', 'serious', 'moderate', 'minor']` |
| `impactToPriority(impact)` | Maps impact string to priority 1–4 |
| `sortViolations(violations)` | Sort by priority, then impact severity |
| `groupViolations(violations, keyFn)` | Group into `Map<key, Violation[]>` |
| `normalizeAxeViolation(v, node, mode)` | axe-core node → Violation |
| `normalizeW3cViolation(v, mode, src)` | W3C error → Violation |
| `normalizeLighthouseViolation(v, mode, src)` | Lighthouse audit → Violation (with resource hints) |
| `normalizeBehavioralViolation(v, layer, mode)` | Behavioral scanner → Violation |

### 1.2 Scanner Pipeline (7 steps)

1. **Parse args + load config** — `.scan-config.json` (pages, thresholds, layer toggles, usePSI). CLI flags override config.
2. **Resolve target mode** — no `--url` flag = Local mode (instrumented Vite build). With `--url` = URL mode (Playwright opens directly).
3. **Start dev server** (local mode) — `ensureServer()` starts `pnpm dev` if nothing is listening on `baseUrl`.
4. **Run all 10 scanner layers per page** — controlled concurrency (default: 2). Each layer returns `Violation[]`:
   - `axe` — axe-core via `@axe-core/playwright`
   - `accessScan` — 83 custom rules across 11 category files
   - `w3c` — W3C Nu HTML Checker validation
   - `links` — dead link crawler
   - `lighthouse` — Lighthouse / PSI API (Core Web Vitals + performance audits)
   - `keyboard` — keyboard navigation + tab order
   - `focusTrap` — focus trap detection
   - `ariaLive` — ARIA live region validation
   - `dynamicContent` — dynamic content accessibility
   - `screenReader` — screen reader tree analysis
5. **Source tracer** (local mode only) — resolves `data-scan-id` → Liquid file + line + ±5-line snippet via `dist/scan-manifest.json`.
6. **Emit reports** — `scan-reports/latest.json` + `scan-reports/scan-visual.html` + `scan-reports/roi-comparison.html` + `scan-reports/roi-technical.html`. Copy to timestamped history entry.
7. **Launch fixer** (if `--fix` flag) — reads violations, presents IDE-style diffs, applies accepted patches, re-scans.

### 1.3 Dual-Target Execution

**Local mode** (`pnpm scan`):
- Runs `vite build` with `SCAN_MODE=true` (via `tracer/build-instrumented.js`)
- Vite plugin instruments each partial with `data-scan-id="partial:line"`
- Emits `dist/scan-manifest.json` mapping scan IDs to source paths
- Starts dev server on localhost
- Violations carry `scanId` → tracer resolves to Liquid file + line + ±5-line context

**URL mode** (`pnpm scan --url https://example.com`):
- No build step — Playwright opens URL directly
- Tracer is a no-op — source fields (`file`, `line`, `snippet`) are null
- Violations carry `element.outerHTML` from rendered DOM
- HTML report shows DOM snapshot with page URL as location reference

### 1.4 Lighthouse / PSI API Dual Mode

For **remote URLs**, the Lighthouse scanner uses the **PageSpeed Insights API** by default to produce results identical to `pagespeed.web.dev`:

```
scanWithLighthouse(url, config)
    │
    ├── Remote URL + usePSI ≠ false ──→ PSI API (googleapis.com/pagespeedonline/v5)
    │       ├── fetchPSI(url, 'mobile')
    │       ├── fetchPSI(url, 'desktop')
    │       ├── normalizePSIResponse() ──→ unified { scores, metrics, audits, groups, passedAudits }
    │       └── Falls back to local Lighthouse on API error
    │
    └── Local URL or usePSI = false ──→ Local Lighthouse (chrome-launcher)
            ├── runLighthouseForDevice('mobile', port)
            └── runLighthouseForDevice('desktop', port)
```

**Key features:**
- `GOOGLE_API_KEY` env var for higher PSI API rate limits
- `--psi` / `--no-psi` CLI flags to override auto-detection
- `config.usePSI` in `.scan-config.json` (default: `true`)
- Console output shows source: `lighthouse (PSI API)` or `lighthouse (local)`
- Audit-level `wastedMs` from `overallSavingsMs` (not per-item only)
- Type-aware detail extraction for LCP element, CLS elements, third-party summary
- Passing audits (score=1) captured and rendered in collapsed report section

---

## Section 2 — 83-Rule Coverage (accessScan)

Coverage strategy: axe-core handles the WCAG overlap, custom Playwright DOM checks fill every remaining gap. Rules are organized across 11 category files.

> **Detailed rule reference:** See [accessScan Rule Coverage](./accessscan-rule-coverage.md) for every rule's WCAG criterion, level, impact, and description.
> **PO-facing checklist:** See [accessScan Rules for PO](./accessscan-rules-for-po.md) for all 83 rules with requirements and code examples.

**Rule distribution by category file:**

| File | Rule Count | WCAG Versions |
|------|-----------|---------------|
| `01-general.js` | 14 | WCAG 2.1, WCAG 2.0 |
| `02-interactive.js` | 18 | WCAG 2.2, WCAG 2.0 |
| `03-forms.js` | 6 | WCAG 2.0 |
| `04-landmarks.js` | 10 | WCAG 2.0 |
| `05-graphics.js` | 6 | WCAG 2.0 |
| `06-dragging.js` | 1 | WCAG 2.2 |
| `07-aria.js` | 2 | WCAG 2.1 |
| `08-lists.js` | 2 | WCAG 2.2, WCAG 2.0 |
| `09-metadata.js` | 8 | WCAG 2.0 |
| `10-tabs.js` | 9 | WCAG 2.0 |
| `11-tables.js` | 7 | WCAG 2.0 |
| **Total** | **83** | |

### Complete Rule Registry (from `schema.js` ACCESSSCAN_CATEGORIES)

#### 01-general.js (14 rules)
`AltMisuse`, `AriaDescribedByHasReference`, `AriaLabelledByHasReference`, `BreadcrumbsNav`, `EmphasisMismatch`, `IframeDiscernible`, `LinkAnchorAmbiguous`, `NoExtraInformationInTitle`, `NoRoleApplication`, `SalePriceDiscernible`, `StrongMismatch`, `VisibilityMismatch`, `VisibilityMisuse`, `FigureDiscernible`

#### 02-interactive.js (18 rules)
`AriaControlsHasReference`, `ButtonDiscernible`, `ButtonMismatch`, `FocusNotObscuredFooter`, `LinkAnchorDiscernible`, `LinkCurrentPage`, `LinkImageWarning`, `LinkMailtoWarning`, `LinkNavigationAmbiguous`, `LinkNavigationDiscernible`, `LinkOpensNewWindow`, `LinkPDFWarning`, `MenuAvoid`, `MenuBarAvoid`, `MenuItemAvoid`, `MenuTriggerClickable`, `NoAutofocus`, `TargetSize`

#### 03-forms.js (6 rules)
`CheckboxDiscernible`, `FormContextChangeWarning`, `FormSubmitButtonMismatch`, `MainNavigationMismatch`, `RadioDiscernible`, `RequiredFormFieldAriaRequired`

#### 04-landmarks.js (10 rules)
`ArticleMisuse`, `BreadcrumbsMismatch`, `NavigationMisuse`, `RegionMainContentMismatch`, `RegionMainContentMisuse`, `RegionMainContentSingle`, `RegionFooterMismatch`, `RegionFooterMisuse`, `RegionFooterSingle`, `SearchFormMismatch`

#### 05-graphics.js (6 rules)
`BackgroundImageDiscernibleImage`, `DecorativeGraphicExposed`, `IconDiscernible`, `ImageDiscernible`, `ImageDiscernibleCorrectly`, `ImageMisuse`

#### 06-dragging.js (1 rule)
`DraggingAlternative`

#### 07-aria.js (2 rules)
`AriaLabelledbyContentMismatch`, `VisibleTextPartOfAccessibleName`

#### 08-lists.js (2 rules)
`StickyHeaderObscuresFocus`, `ListEmpty`

#### 09-metadata.js (8 rules)
`HtmlLang`, `HtmlLangValid`, `MetaDescription`, `MetaRefresh`, `MetaViewportPresent`, `MetaViewportScalable`, `PageTitle`, `PageTitleDescriptive`

#### 10-tabs.js (9 rules)
`TablistRole`, `TabAriaControls`, `TabAriaSelected`, `TabListMisuse`, `TabMismatch`, `TabMisuse`, `TabPanelMismatch`, `TabPanelMisuse`, `TabpanelLabelledBy`

#### 11-tables.js (7 rules)
`TableCaption`, `TableHeaderEmpty`, `TableHeaders`, `TableMisuse`, `TableNesting`, `TableRoles`, `TableRowHeaderMismatch`

---

## Section 3 — Fix Engine + 6 AI Modes

### 3.1 Fix Engine Flow (`fixer/engine.js`)

1. Load violations — filter actionable violations, skip third-party-injected Paradox elements (logged as `known-third-party`), group by source file
2. **Deterministic rule engine** — for `fix.deterministic = true` violations, apply matching rule from `fixer/rules/` (13 rule modules). These generate Liquid patches directly without AI.
3. For `fix.deterministic = false` violations with an **API-based mode** (claude / cis / codex): call the API **on demand** when that fix card is displayed — not upfront in bulk. The API receives the violation object + surrounding Liquid source context + fix hint and returns a proposed unified diff patch.
4. Present each fix as an IDE-style diff (terminal or browser UI). User chooses:
   - **Accept** — patch is queued, written to Liquid source at end of session
   - **Reject** — violation skipped, logged as unresolved
   - **Re-fix with comment** — user's comment is sent back to the same API with the original context; revised patch is shown immediately
5. After the session, all accepted patches are written to Liquid source files at once
6. Targeted re-scan (only the pages containing patched files, only the rule layers those files affect) verifies all accepted fixes pass. Exit 0 only when verification passes.

**Important:** For **IDE-based modes** (cursor / vscode / windsurf), the tool does NOT call any external API. Instead it writes fix context (violation + code snippet + instructions) into the IDE's config files. The developer applies fixes inside their IDE using the IDE's own built-in AI.

### 3.2 Deterministic Fix Rules (`fixer/rules/`)

13 rule modules, each exporting a rule object with `id`, `handles(violation)`, and `fix(violation, fileContent)`:

| Rule module | Fix scope |
|-------------|-----------|
| `alt-text.js` | Missing/empty image alt attributes |
| `aria.js` | ARIA attribute corrections |
| `focus.js` | Focus management (tabindex, focus-visible) |
| `font-display.js` | Font display strategy (`font-display: swap`) |
| `forms.js` | Form field labels and associations |
| `headings.js` | Heading hierarchy corrections |
| `landmarks.js` | Landmark region additions (main, nav, footer) |
| `lang.js` | Missing/invalid lang attributes |
| `lazy-load.js` | Image lazy loading attributes |
| `scripts.js` | Script tag accessibility attributes |
| `semantic.js` | Semantic HTML upgrades (strong/em, lists) |
| `skip-link.js` | Skip navigation link insertion |

Registry: `rules/index.js` exports `findRule(violation)` and `getAllRules()`.

### 3.3 IDE-Style Diff Format

```
<<<<<<< Current · src/partials/jobs/results-header.liquid:12
-  <span class="results-header__content__total">{{ total }}</span>
======= Incoming fix · accessScan · StrongMismatch · P2 · WCAG 2.0 A
+  <strong class="results-header__content__total">{{ total }}</strong>
>>>>>>>
```

Developer actions: `[a] Accept  [r] Reject  [f] Re-fix with suggestion  [s] Skip all like this`

### 3.4 Fix Modes (`fixer/modes/`)

#### IDE-Integrated Modes (write context only — no API calls)

**vscode** (`--fix-mode vscode`)
- Writes patches to `.vscode/scan-fixes/`
- Generates `.vscode/tasks.json` entries for Command Palette
- Writes fix context to `.github/copilot-instructions.md` for Copilot Chat
- Compatible with any VS Code AI extension (Copilot, CodeGPT, Tabnine)

**cursor** (`--fix-mode cursor`)
- Writes patch files to `.cursor/patches/`
- Generates `.cursor/rules/scan-fixes.md` with violation context + fix instructions
- Supports `--agent` flag for Cursor Agent autonomous apply
- Developer uses Cursor's native diff UI in-editor

**windsurf** (`--fix-mode windsurf`)
- Generates `.windsurf/scan-task.md` as a Cascade task prompt
- Each violation formatted as a Cascade instruction with file path, line range, expected outcome
- Cascade multi-file edit handles cross-partial changes
- Post-fix confirmation written to `.windsurf/applied.json`

#### Direct API Modes (call on-demand per fix)

**codex** (`--fix-mode codex`)
- OpenAI SDK (`openai` npm package)
- GPT-4o-mini for fast fixes, GPT-4o on escalation
- Requires `OPENAI_API_KEY` in `.env`

**claude** (`--fix-mode claude`)
- Anthropic SDK (`@anthropic-ai/sdk`)
- Haiku 4.5 for fast/cheap fixes, auto-escalates to Sonnet 4.6 for complex Liquid logic
- Requires `ANTHROPIC_API_KEY` in `.env`

**cis** (`--fix-mode cis`)
- POST to `CIS_PROXY_URL` with `CIS_AUTH_TOKEN` header
- Model controlled by `CIS_MODEL` env var — zero code changes to swap models
- Matches Workday `/v1alpha1/predictions` payload schema
- Escalates to higher model if response confidence < 0.85

### 3.5 Fix Routing Logic

| Condition | Action |
|-----------|--------|
| `fix.deterministic = true` (any mode) | Rule engine generates patch — no AI call |
| `fix.deterministic = false` + `--fix-mode vscode` | `.vscode/scan-fixes/` + `copilot-instructions.md` |
| `fix.deterministic = false` + `--fix-mode cursor` | `.cursor/patches/` + `.cursor/rules/scan-fixes.md` |
| `fix.deterministic = false` + `--fix-mode windsurf` | `.windsurf/scan-task.md` → Cascade multi-file edit |
| `fix.deterministic = false` + `--fix-mode codex` | GPT-4o-mini → GPT-4o on escalation |
| `fix.deterministic = false` + `--fix-mode claude` | Haiku 4.5 → Sonnet 4.6 on escalation |
| `fix.deterministic = false` + `--fix-mode cis` | CIS_PROXY_URL → higher model if confidence < 0.85 |
| `violation.source = "third-party"` (Paradox widget) | Skip — logged as `known-third-party` |

### 3.6 Dual Presentation UX

**Terminal UI** (default):
- Key-driven: `a` accept, `r` reject, `f` re-fix, `s` skip all like this, `q` quit
- Shows priority, rule ID, source location, and colored diff per violation
- Powered by `fixer/presenter.js`

**Browser UI** (`--ui` flag):
- Local dashboard served by `fixer/ui/server.js`
- Session state managed by `fixer/ui/state.js` (FixState class)
- Sidebar: violations by priority + file
- Main panel: side-by-side diff (current code vs proposed fix)
- For API modes (claude / cis / codex): API is called on demand when the fix card is opened — user sees a loading state while the patch is generated, then the diff appears
- For Re-fix: user types a comment, clicks Re-fix — API is called again with the comment as additional context, revised diff replaces the previous one immediately
- Action bar per fix: **Accept / Reject / Re-fix**
- Per-fix mode switcher — swap between all 6 modes for any individual fix
- "Apply All Accepted" writes all queued patches to Liquid source files then triggers targeted re-scan
- Session saved to `scan-reports/fix-session-[ts].json` with full audit trail

### 3.7 Rollback Safety

`fixer/rollback.js` provides git stash-based rollback points. Before applying patches, a rollback point is created so all changes can be safely reverted if the re-scan fails.

---

## Section 4 — Multi-Format Reporters

### 4.1 JSON Report (`reporter/scan-report.js`)

Output: `scan-reports/latest.json` + `scan-reports/history/[timestamp]/scan.json`

Machine-readable. Every violation includes the full schema from Section 1.1. Consumed directly by the fixer engine.

**Exports:**
- `writeReport(scanResults)` — writes latest.json + history copy
- `writeBaseline(report)` — saves baseline.json for ROI comparison
- `loadBaseline()` — reads baseline.json
- `printConsoleSummary(report)` — terminal summary (pages scanned, violation count, top violations)

### 4.2 HTML Visual Report (`reporter/html.js`)

Output: `scan-reports/scan-visual.html` (self-contained, no server required)

Airbnb-inspired design with responsive layout. 5 grouped sections:

**Accessibility**
- Sources: axe-core + all 83 accessScan rules + behavioral scanners
- Per issue: rule ID, WCAG version/level, accessScan category, impact, source file + line, ±5-line Liquid context, fix hint, auto-fixable badge
- Grouped by: page → priority → rule

**Markup Validation**
- Source: W3C Nu HTML Checker
- Per issue: error type (error/warning/info), failing HTML element, W3C message verbatim, source file + line, parent element chain, fix recommendation
- Grouped by: page → error type

**Reliability — Dead Links**
- Source: Playwright link crawler
- Per issue: broken URL, HTTP status code, link text, element type (href/src/action), source file + line, redirect chain if > 2 hops
- Classification: 404 / 500 / empty href / redirect loop
- Grouped by: page → status code

**Performance — Core Web Vitals**
- Source: Lighthouse / PSI API
- Per page per device: overall score gauges (Performance, Accessibility, Best Practices, SEO)
- Core Web Vitals metrics: LCP, CLS, TBT, FCP, Speed Index, TTI with good/average/poor ratings
- Gap-to-100 breakdown: each opportunity listed with estimated score improvement in points
- Steps to 100: actionable checklist per page
- Diagnostics: failing audits grouped by category (Render Blocking, Image Delivery, Code Optimization, etc.)
- Passed audits: collapsed section showing passing audits (matching PSI behavior)
- Mobile/Desktop toggle tabs per page

**Behavioral**
- Sources: keyboard, focus-trap, aria-live, dynamic-content, screen-reader scanners
- Per issue: rule, description, element, impact
- Grouped by scanner layer

### 4.3 Executive Summary + ROI Reports (`reporter/exec-summary.js` + `roi-doc.js`)

Output: `scan-reports/roi-comparison.html` + `scan-reports/roi-technical.html`

Generated after every scan. When a baseline exists, produces a comparative ROI analysis showing violations fixed, remaining, and new since baseline.

### 4.4 Output File Map

| File | Purpose |
|------|---------|
| `scan-reports/latest.json` | Always overwritten. AI fix agent reads this. |
| `scan-reports/scan-visual.html` | Always overwritten. Dev & QA open in browser. |
| `scan-reports/history/[ts]/scan.json` | Timestamped copy after each run. Trend tracking. |
| `scan-reports/baseline.json` | Set via `pnpm scan:baseline`. Baseline diff suppresses pre-existing issues. |
| `scan-reports/roi-comparison.html` | Executive ROI comparison against baseline. |
| `scan-reports/roi-technical.html` | Technical ROI breakdown. |
| `scan-reports/fix-session-[ts].json` | Written after each fix session. Full audit trail. |
| `dist/scan-manifest.json` | Generated by Vite plugin on `SCAN_MODE=true`. Maps scan IDs to Liquid source. |

---

## Section 5 — Configuration

### 5.1 Scan Config (`.scan-config.json`)

```json
{
  "baseUrl": "http://localhost:1234",
  "pages": [],
  "concurrency": 2,
  "thresholds": {
    "wcag": 0,
    "performance": 90,
    "bestPractices": 90
  },
  "layers": {
    "axe": true,
    "accessScan": true,
    "w3c": true,
    "links": true,
    "lighthouse": true,
    "keyboard": true,
    "ariaLive": true,
    "focusTrap": true,
    "dynamicContent": true,
    "screenReader": true
  },
  "usePSI": true,
  "customRules": [],
  "skipRules": []
}
```

### 5.2 Page Targeting

| Flag | Behaviour |
|------|-----------|
| _(no flag)_ | Scans all pages defined in `.scan-config.json` (default, same as `--all`) |
| `--page homepage` | Scans the single named page from `.scan-config.json` |
| `--page /jobs` | Scans the page matching that path from `.scan-config.json` |
| `--all` | Explicitly scans all pages — runs in background with live progress display |
| `--url https://...` | Scans a single live URL (URL mode — no page config lookup) |

### 5.3 Background Execution + Live Progress Display

When scanning all pages, the orchestrator:

1. Starts all page scans with controlled concurrency (default: 2, configurable via `concurrency` field)
2. Prints a live progress display to the terminal — updated in-place using ANSI cursor movement
3. When all pages complete, clears the progress display and prints the final summary
4. Emits all reports as a single batch

**Progress display format:**

```
Scanning 7 pages  [===========>          ]  4 / 7

  homepage           done    18 violations
  job-listing        done     6 violations
  job-detail         done     3 violations
  careers            scanning...
  our-story          queued
  benefits           queued
  service-tech       queued

Elapsed: 00:00:42
```

Rules:
- Pages update from `queued` → `scanning...` → `done N violations` as they complete
- The progress bar advances by page count (not by rule count)
- `scanning...` pages show the currently active layer in parentheses when verbose: `scanning... (axe-core)`
- On error, the page row shows `error — <message>` in place of violation count and the scan continues with remaining pages
- No chalk, ora, or external libraries — plain `process.stdout.write` + ANSI escape codes

---

## Section 6 — CLI Reference

### npm Scripts (`package.json`)

```bash
pnpm scan                          # All pages (background + progress display)
pnpm scan:fix                      # Scan + interactive fix (terminal UI, claude default)
pnpm scan:fix:ai                   # Scan + fix with AI escalation
pnpm scan:fix:cursor               # Scan + fix with Cursor IDE mode
pnpm scan:fix:vscode               # Scan + fix with VS Code mode
pnpm scan:fix:windsurf             # Scan + fix with Windsurf/Cascade mode
pnpm scan:fix:codex                # Scan + fix with OpenAI GPT-4o mode
pnpm scan:fix:claude               # Scan + fix with Claude Anthropic mode
pnpm scan:fix:cis                  # Scan + fix with Workday CIS proxy mode
pnpm scan:url <url>                # Scan a live URL
pnpm scan:baseline                 # Save current state as ROI baseline
pnpm scan:report                   # Regenerate reports from last scan (no re-scan)
```

### All CLI Flags

```bash
# Scan scope
pnpm scan                          # All pages
pnpm scan --all                    # Explicit all-pages
pnpm scan --page homepage          # Single page by name
pnpm scan --page /jobs             # Single page by path
pnpm scan --url https://...        # Single live URL (URL mode)
pnpm scan --changed-only           # Only pages with modified .liquid files

# Layer filtering
pnpm scan --layers axe,w3c         # Specific layers only

# Performance mode
pnpm scan --psi                    # Force PSI API (even if disabled in config)
pnpm scan --no-psi                 # Force local Lighthouse (even for remote URLs)

# Fix modes
pnpm scan --fix                    # Interactive fix after scan
pnpm scan --fix --fix-mode cursor  # Fix with specific mode
pnpm scan --fix --ui               # Fix with browser UI dashboard
pnpm scan --fix --agent            # Autonomous apply (Cursor agent mode)
pnpm scan --fix --ai               # AI-assisted fix escalation

# Reporting
pnpm scan --baseline               # Save baseline for ROI tracking
pnpm scan --report-only            # Regenerate reports without scanning

# Build control
pnpm scan --force-build            # Force instrumented build (skip cache)
pnpm scan --no-server              # Skip auto-starting dev server

# Output control
pnpm scan --verbose                # Show active layers and detailed progress
pnpm scan --no-fail                # Exit 0 even with violations
pnpm scan --dry-run                # Preview without modifying files
pnpm scan --include-third-party    # Include Paradox widget violations
```

---

## Section 7 — Environment Variables

```bash
# PageSpeed Insights API (higher rate limits for remote URL scans)
GOOGLE_API_KEY=...

# Claude fix mode
ANTHROPIC_API_KEY=...

# Codex fix mode
OPENAI_API_KEY=...

# CIS fix mode
CIS_PROXY_URL=https://...
CIS_AUTH_TOKEN=...
CIS_MODEL=...

# Scan instrumentation (set automatically by pnpm scan in local mode)
SCAN_MODE=true

# Suppress browser auto-open
BROWSER=
```

---

## Section 8 — Tech Stack

| Concern | Package |
|---------|---------|
| Browser automation | `playwright` (installed) |
| Accessibility engine | `@axe-core/playwright` (installed) |
| HTML validation | W3C Nu Checker API (remote) |
| Performance — local | `lighthouse` + `chrome-launcher` (installed) |
| Performance — remote | PageSpeed Insights API v5 (native `fetch`) |
| AI fix — Claude | `@anthropic-ai/sdk` |
| AI fix — Codex | `openai` |
| AI fix — CIS | native `fetch` |
| HTML reports | vanilla HTML/CSS, self-contained, Airbnb-inspired design |
| Module system | ESM, `.js` extensions on all imports |
| CLI args | `new Set(process.argv.slice(2)).has()` (no yargs) |
| Config | `.scan-config.json` + `dotenv` for `.env` |
| Git operations | native `child_process` git commands |

---

## Constraints

- No CI/CD integration — on-demand, developer-run only
- No chalk / ora / yargs — plain `console.log` + ANSI codes only
- All imports use `.js` extensions (ESM)
- `fileURLToPath(import.meta.url)` for `__dirname`
- `main().catch(e => { console.error(e.message); process.exit(1); })`
- Third-party Paradox widget violations are logged as `known-third-party`, never auto-fixed
- Deterministic fixes never trigger an AI call
- Re-scan after fix targets only affected rules on affected pages (not a full scan)
- PSI API auto-used for remote URLs; local Lighthouse for localhost URLs
