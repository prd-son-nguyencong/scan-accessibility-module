# ADA & Performance Automation Tool — Architecture Plan (v2)

## Context

The team runs a 4-step manual QA pipeline (axe-devtools, W3C validator, accessiBe AccessScan, PageSpeed Insights) for every page before production migration. This blocks velocity and is error-prone. The goal is a single CLI tool — integrated directly into the existing `scripts/` structure — that automates scanning, traces errors to source snippet partials, auto-fixes the majority of violations, and generates a comparison ROI document for leadership buy-in.

---

## Critical Insight: AccessScan Is Not Just axe-core

AccessScan by accessiBe goes well beyond what axe-core covers. Research shows:

- **axe-core alone covers only ~57% of WCAG violations** (static DOM analysis)
- **Lighthouse + axe-core together cover only 30–40% of real WCAG violations**
- **Only ~13% of WCAG 2.2 criteria are fully automatable** — the rest require behavioral simulation or manual review

**What AccessScan uniquely tests that axe-core misses:**
- Custom/unsemantic elements (e.g., `<div>` styled as a button — AI pattern detection)
- Keyboard navigation flow (actual tab order, focus traps, escape key behavior)
- ARIA live region announcements (dynamic content updates)
- Focus management in modals and carousels
- Interactive widget patterns (dropdown menus, accordions, carousels with arrow keys)
- Form validation states (`aria-invalid`, error message associations)
- Visual hover/focus state contrast (not just static computed styles)
- Screen reader reading order (landmark traversal, heading jump navigation)
- Dynamic content rescanning after user interactions

The tool must address all of these with a **4-layer scanner architecture**, not just axe-core.

---

## 4-Layer Scanner Architecture

```
Layer 1: Static Analysis      → axe-core + Lighthouse + W3C (structural violations)
Layer 2: Behavioral Testing   → Playwright keyboard/interaction flows (dynamic violations)
Layer 3: Screen Reader Sim    → @guidepup/virtual-screen-reader (SR reading patterns)
Layer 4: Manual Review Queue  → Flag context-dependent violations for human review
```

---

## Decisions

### AI Model Strategy (CIS)
**Hybrid — Rule engine first, CIS AI for escalation**

- **Rule engine** handles ~80% deterministically: missing alt, aria-label patterns, `font-display: swap`, `loading="lazy"`, `defer`/`async`, heading order, form label associations, landmark injection, focus-visible CSS.
- **CIS AI (Haiku by default)** handles complex cases: contextual alt text, ARIA restructuring, semantic HTML rewrites, color contrast alternatives. Escalate to Opus when Haiku confidence < 0.85 or the fix spans multiple elements.
- Config: `CIS_PROXY_URL`, `CIS_AUTH_TOKEN`, `CIS_MODEL` (default: `haiku`) in `.env`.

### Source Tracing
**Instrumented build mode — inject `data-partial-src` + `data-partial-line` attributes**

Vite plugin `scan-instrumentation.ts` runs only when `SCAN_MODE=true`. It injects attributes on the root DOM element of every rendered partial. Playwright reads these after violations are found — providing exact `file:line` references.

### Tool Packaging
**`scripts/scan/` module with `pnpm scan*` scripts** (mirrors `scripts/sync/` pattern)

### W3C Validator
**Nu HTML Checker via HTTP API** — no Java/vnu-jar dependency needed.

---

## File Structure

```
scripts/scan/
├── index.js
├── scanner/
│   ├── browser.js             # Playwright lifecycle
│   ├── axe.js                 # Layer 1: axe-core WCAG 2.2 AA
│   ├── lighthouse.js          # Layer 1: Core Web Vitals
│   ├── w3c.js                 # Layer 1: Nu HTML Checker API
│   ├── keyboard.js            # Layer 2: Keyboard navigation flow
│   ├── aria-live.js           # Layer 2: ARIA live region testing
│   ├── focus-trap.js          # Layer 2: Modal focus management
│   ├── dynamic-content.js     # Layer 2: Post-interaction accessibility
│   └── screen-reader.js       # Layer 3: @guidepup/virtual-screen-reader
├── tracer/
│   ├── partial-map.js         # DOM → source partial mapper
│   └── build-instrumented.js  # Triggers SCAN_MODE=true vite build
├── fixer/
│   ├── rules/
│   │   ├── index.js
│   │   ├── alt-text.js
│   │   ├── aria.js
│   │   ├── landmarks.js
│   │   ├── font-display.js
│   │   ├── lazy-load.js
│   │   ├── scripts.js
│   │   ├── headings.js
│   │   ├── forms.js
│   │   ├── focus.js
│   │   ├── skip-link.js
│   │   └── lang.js
│   ├── ai-client.js           # CIS POST /v1alpha1/predictions wrapper
│   ├── ai-fixer.js            # Haiku → Opus escalation
│   ├── agent.js               # Orchestrator
│   └── rollback.js            # Git stash rollback
├── reporter/
│   ├── scan-report.js
│   ├── html-report.js
│   ├── exec-summary.js        # Executive summary (leader doc)
│   └── roi-doc.js             # ROI comparison doc
├── plugins/
│   └── scan-instrumentation.ts
└── utils/
    ├── config.js
    ├── logger.js
    ├── paths.js
    ├── server.js              # Dev server auto-start
    └── git.js
```

---

## AccessScan Coverage Matrix

| AccessScan Check | Layer 1 (axe+LH) | Layer 2 (Playwright) | Layer 3 (Guidepup) | Manual |
|---|:---:|:---:|:---:|:---:|
| Missing alt text | ✅ axe | | | |
| Missing ARIA labels/roles | ✅ axe | | | |
| Heading hierarchy | ✅ axe | | | |
| Form label associations | ✅ axe | | | |
| Color contrast (static) | ✅ axe | | | |
| Color contrast (hover/focus) | | ✅ keyboard.js | | |
| HTML5 validity | ✅ W3C | | | |
| Core Web Vitals | ✅ LH | | | |
| Render-blocking resources | ✅ LH | | | |
| Font-display: swap | ✅ LH | | | |
| Lazy loading | ✅ LH | | | |
| Keyboard navigation (tab order) | | ✅ keyboard.js | | |
| No keyboard trap | | ✅ focus-trap.js | | |
| Skip navigation links | ✅ axe | ✅ keyboard.js | | |
| Modal focus management | | ✅ focus-trap.js | | |
| ARIA live region announcements | | ✅ aria-live.js | | |
| Dynamic content after interaction | | ✅ dynamic-content.js | | |
| Carousel/accordion accessibility | | ✅ dynamic-content.js | | |
| Screen reader reading order | | | ✅ screen-reader.js | |
| Landmark traversal | | | ✅ screen-reader.js | |
| Heading jump navigation | | | ✅ screen-reader.js | |
| Contextual link/button text | ✅ axe | | ✅ screen-reader.js | |
| Form validation error states | | ✅ dynamic-content.js | | |
| `html[lang]` attribute | ✅ axe | | | |
| Cognitive accessibility | | | | ⚠️ manual |

**Estimated automated coverage: ~75–80% of AccessScan checks**

---

## pnpm Scripts

```bash
pnpm scan              # Scan localhost:1234 (auto-starts server if needed)
pnpm scan:fix          # Scan + rule-based auto-fix
pnpm scan:fix:ai       # Scan + rule-fix + CIS AI escalation
pnpm scan:url <url>    # Scan a remote preview URL
pnpm scan:baseline     # Save current state as ROI baseline
pnpm scan:report       # Regenerate ROI docs from last scan
```

**Key flags:** `--dry-run`, `--page <path>`, `--changed-only`, `--no-server`, `--layers <list>`

---

## New Dependencies

```
playwright                        # Headless Chromium
@axe-core/playwright              # Axe WCAG engine
lighthouse                        # Core Web Vitals
@guidepup/virtual-screen-reader   # Virtual screen reader (Layer 3)
```

---

## CIS AI Client

All AI requests route to `POST /v1alpha1/predictions` on the Workday CIS proxy.

```javascript
// Env vars: CIS_PROXY_URL, CIS_AUTH_TOKEN, CIS_MODEL (default: haiku)
// Haiku → Opus escalation when confidence < 0.85
```

---

## Implementation Phases

| Phase | Deliverable |
|---|---|
| 1 | `pnpm scan` — traced JSON report with source file + line per violation |
| 2 | Full Layer 2 + 3 (keyboard, ARIA live, focus traps, screen reader) |
| 3 | `pnpm scan:fix` — rule-based fixes with git stash rollback |
| 4 | `pnpm scan:fix --ai` — Lighthouse + CIS AI fixer |
| 5 | `pnpm scan:baseline` + `pnpm scan:report` — ROI comparison documents |
