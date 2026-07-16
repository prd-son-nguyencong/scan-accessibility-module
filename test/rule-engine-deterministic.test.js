import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

import { validateRuleDescriptor } from '../src/scanner/access-scan/engine/schema.js';
import { loadRuleDescriptors } from '../src/scanner/access-scan/engine/loader.js';
import { loadBuiltInRuleRegistry } from '../src/scanner/access-scan/engine/builtin-registry.js';
import { runRules } from '../src/scanner/access-scan/engine/runner.js';
import { PROFILES } from '../src/scanner/access-scan/engine/profiles.js';
import {
  createScanSession,
  queryGraph,
  validateGraphSelector,
  buildSnapshotIndexes,
  resolveIdRefs,
  resolveScopedDomId,
} from '../src/scanner/access-scan/runtime/index.js';
import { readFileSync } from 'node:fs';
import { filterByRoots } from '../src/scanner/access-scan/evaluators/lib/runtime-context.js';
import { scanWithAccessScan } from '../src/scanner/access-scan/index.js';
import { installRuntimeHooks } from '../src/scanner/access-scan/runtime/index.js';

const dualRunFixture = JSON.parse(
  readFileSync(new URL('./fixtures/access-scan/dual-run-neutral.json', import.meta.url), 'utf8'),
);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RULES_DIR = path.join(__dirname, '../src/scanner/access-scan/rules');

const MIGRATED_RULE_IDS = [
  'AltMisuse', 'IframeDiscernible', 'NoRoleApplication', 'NoExtraInformationInTitle',
  'FigureDiscernible', 'AriaDescribedByHasReference', 'AriaLabelledByHasReference',
  'ButtonDiscernible', 'LinkAnchorDiscernible', 'LinkNavigationDiscernible', 'LinkOpensNewWindow',
  'NoAutofocus', 'MenuTriggerClickable', 'MenuAvoid', 'MenuBarAvoid', 'MenuItemAvoid',
  'AriaControlsHasReference', 'LinkImageWarning', 'LinkMailtoWarning', 'LinkPDFWarning',
  'CheckboxDiscernible', 'RadioDiscernible', 'RequiredFormFieldAriaRequired', 'ListEmpty',
  'HtmlLang', 'HtmlLangValid', 'MetaDescription', 'MetaRefresh', 'MetaViewportPresent',
  'MetaViewportScalable', 'PageTitle', 'PageTitleDescriptive', 'VisibleTextPartOfAccessibleName',
];

async function withPage(markup, run) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  page.on('console', () => {});
  page.on('pageerror', () => {});
  try {
    await page.setContent(markup, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      globalThis.cssPath = (element) => (
        element.id ? `#${element.id}` : element.tagName.toLowerCase()
      );
    });
    return await run(page);
  } finally {
    await context.close();
    await browser.close();
  }
}

async function runMigratedRules(page, ruleIds = MIGRATED_RULE_IDS) {
  const session = await createScanSession(page);
  const registry = await loadBuiltInRuleRegistry({ enforceCatalogContract: false });
  const skip = registry.getActiveRuleIds().filter((id) => !ruleIds.includes(id));
  const result = await runRules({
    registry,
    profile: PROFILES.STANDARDS,
    context: { snapshot: session.snapshot },
    skipRules: skip,
  });
  return { session, result };
}

function findingsByRule(result) {
  return Object.fromEntries(
    MIGRATED_RULE_IDS.map((ruleId) => [
      ruleId,
      result.findings.filter((finding) => finding.ruleId === ruleId),
    ]),
  );
}

test('validateGraphSelector accepts prefix/suffix/substring attribute operators', () => {
  for (const selector of [
    'a[href^="#"]',
    'a[href^="mailto:"]',
    'a[target="_blank"]',
    "input[type='checkbox']",
    '[autofocus]',
  ]) {
    const result = validateGraphSelector(selector);
    assert.equal(result.valid, true, selector);
  }
  const broken = validateGraphSelector('a[href^');
  assert.equal(broken.valid, false);
});

test('descriptor loading rejects unsupported target selectors without plugin fallback', async () => {
  await assert.rejects(
    () => loadRuleDescriptors([{
      id: 'BrokenRule',
      status: 'active',
      category: 'general',
      standard: { version: 'WCAG 2.0', level: 'A', criterion: '1.3.1' },
      severity: { impact: 'moderate', priority: 4 },
      automation: 'deterministic',
      checks: [{
        id: 'broken:selector',
        profiles: ['standards'],
        evaluator: 'list-structure',
        target: { selector: 'div > span' },
      }],
      reporting: { title: 't', requirement: 'r', recommendation: 'c' },
      fix: { deterministic: true, policy: 'mechanically_safe' },
    }]),
    /plugin fallback/i,
  );
});

test('queryGraph prefix selectors return matches instead of silent empty diagnostics', async () => {
  await withPage(
    `
      <a id="anchor" href="#section">Section</a>
      <a id="mailto" href="mailto:team@example.com">Write us</a>
      <a id="plain" href="/about">About</a>
    `,
    async (page) => {
      const session = await createScanSession(page);
      const anchorMatches = queryGraph(session.snapshot, 'a[href^="#"]');
      const mailtoMatches = queryGraph(session.snapshot, 'a[href^="mailto:"]');
      const diagnostics = [];
      queryGraph(session.snapshot, 'div > span', { diagnostics });
      assert.equal(anchorMatches.length, 1);
      assert.equal(mailtoMatches.length, 1);
      assert.equal(diagnostics.length, 1);
      assert.equal(diagnostics[0].code, 'selector-unsupported');
    },
  );
});

test('snapshot exposes descendant visibleText for wrapped controls', async () => {
  await withPage(
    '<button id="wrapped"><span>Delete</span></button>',
    async (page) => {
      const session = await createScanSession(page);
      const button = session.snapshot.elements.find((el) => el.attributes.id === 'wrapped');
      assert.equal(button.text, '');
      assert.match(button.visibleText, /delete/i);
    },
  );
});

test('scoped duplicate dom ids preserve first occurrence deterministically', async () => {
  await withPage(
    `
      <button id="dup" aria-labelledby="dup">First</button>
      <button id="dup" aria-labelledby="missing">Second</button>
    `,
    async (page) => {
      const session = await createScanSession(page);
      const indexes = buildSnapshotIndexes(session.snapshot);
      const dupes = session.snapshot.elements.filter((el) => el.attributes.id === 'dup');
      const first = dupes[0];
      const second = dupes[1];
      assert.ok(first.id < second.id);
      assert.equal(resolveScopedDomId(indexes, second, 'dup')?.id, first.id);
      assert.deepEqual(resolveIdRefs(second, indexes, 'aria-labelledby').missing, ['missing']);
      assert.ok(indexes.ambiguousDomIds.get(`f:|s:`)?.has('dup'));
    },
  );
});

test('filterByRoots scopes document, shadow, and frame candidates', async () => {
  await withPage(
    `
      <button id="doc-btn">Doc</button>
      <div id="host"></div>
      <iframe srcdoc="<button id='frame-btn'>Frame</button>"></iframe>
      <script>
        document.getElementById('host').attachShadow({ mode: 'open' })
          .innerHTML = '<button id="shadow-btn">Shadow</button>';
      </script>
    `,
    async (page) => {
      const session = await createScanSession(page);
      const buttons = queryGraph(session.snapshot, 'button');
      assert.equal(filterByRoots(buttons, ['document']).length, 1);
      assert.equal(filterByRoots(buttons, ['shadow']).length, 1);
      assert.equal(filterByRoots(buttons, ['frame']).length, 1);
      assert.equal(filterByRoots(buttons, ['all']).length, 3);
    },
  );
});

test('comprehensive migrated rules fixture reports exact rule ids and classifications', async (t) => {
  const expectations = {
    AltMisuse: 'confirmed',
    IframeDiscernible: 'confirmed',
    NoRoleApplication: 'confirmed',
    NoExtraInformationInTitle: ['confirmed', 'potential'],
    FigureDiscernible: 'potential',
    AriaDescribedByHasReference: 'confirmed',
    AriaLabelledByHasReference: 'confirmed',
    ButtonDiscernible: 'confirmed',
    LinkAnchorDiscernible: 'confirmed',
    LinkNavigationDiscernible: 'confirmed',
    LinkOpensNewWindow: 'potential',
    NoAutofocus: 'confirmed',
    MenuTriggerClickable: 'confirmed',
    MenuAvoid: 'potential',
    MenuBarAvoid: 'potential',
    MenuItemAvoid: 'potential',
    AriaControlsHasReference: 'confirmed',
    LinkImageWarning: 'potential',
    LinkMailtoWarning: 'potential',
    LinkPDFWarning: 'potential',
    CheckboxDiscernible: 'confirmed',
    RadioDiscernible: 'confirmed',
    RequiredFormFieldAriaRequired: 'potential',
    ListEmpty: 'confirmed',
    HtmlLang: 'confirmed',
    MetaDescription: 'potential',
    MetaRefresh: 'confirmed',
    MetaViewportScalable: 'confirmed',
    PageTitleDescriptive: 'potential',
    VisibleTextPartOfAccessibleName: 'potential',
  };

  await withPage(
    `
      <html>
        <head>
          <title>Home</title>
          <meta http-equiv="refresh" content="5;url=/next">
          <meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no">
        </head>
        <body>
          <div role="application" id="app">App</div>
          <span alt="misplaced">X</span>
          <iframe id="frame-no-title"></iframe>
          <figure id="bare-figure"><img src="x.png" alt=""></figure>
          <button id="broken-desc" aria-describedby="missing-desc">Go</button>
          <button id="broken-labelby" aria-labelledby="missing-label">Go</button>
          <button id="empty-btn"></button>
          <button id="title-only" title="Save draft"></button>
          <button id="dup-title" title="Apply">Apply</button>
          <a id="anchor-empty" href="#section"></a>
          <nav><a id="nav-empty" href="/jobs"></a></nav>
          <a id="blank-link" href="/ext" target="_blank">External</a>
          <input id="autofocus-input" autofocus>
          <div id="popup" aria-haspopup="true">More</div>
          <div role="menu" id="menu-nav"><a href="/a">A</a></div>
          <div role="menubar" id="menubar-nav"><a href="/b">B</a></div>
          <a id="menuitem-link" href="/c" role="menuitem">C</a>
          <button id="broken-controls" aria-controls="missing-panel">Toggle</button>
          <a id="image-link" href="/assets/photo.png">View</a>
          <a id="mailto-link" href="mailto:hello@example.com">Hello</a>
          <a id="pdf-link" href="/files/guide.pdf">Guide</a>
          <input id="checkbox-title-only" type="checkbox" title="Subscribe">
          <input id="radio-no-label" type="radio" name="size">
          <label for="required-visual">Name *</label>
          <input id="required-visual" type="text">
          <ul id="empty-list"></ul>
          <button id="label-mismatch" aria-label="Remove item"><span>Delete</span></button>
        </body>
      </html>
    `,
    async (page) => {
      const { result } = await runMigratedRules(page);
      const byRule = findingsByRule(result);

      for (const [ruleId, expected] of Object.entries(expectations)) {
        const findings = byRule[ruleId];
        assert.ok(findings.length >= 1, `expected finding for ${ruleId}`);
        const expectedTypes = Array.isArray(expected) ? expected : [expected];
        assert.deepEqual(
          [...new Set(findings.map((finding) => finding.violationType))].sort(),
          [...new Set(expectedTypes)].sort(),
          ruleId,
        );
      }
      assert.equal(byRule.HtmlLangValid.length, 0);
      assert.equal(byRule.PageTitle.length, 0);
      assert.equal(byRule.MetaViewportPresent.length, 0);
    },
  );

  await t.test('MetaViewportPresent when viewport meta is absent', async () => {
    await withPage(
      '<html lang="en"><head><title>Viewport missing case</title></head><body></body></html>',
      async (page) => {
        const { result } = await runMigratedRules(page, ['MetaViewportPresent']);
        assert.equal(result.findings.length, 1);
        assert.equal(result.findings[0].ruleId, 'MetaViewportPresent');
        assert.equal(result.findings[0].violationType, 'confirmed');
      },
    );
  });

  await t.test('HtmlLangValid on invalid language code', async () => {
    await withPage(
      '<html lang="not-a-language"><head><title>Valid title here</title></head><body></body></html>',
      async (page) => {
        const { result } = await runMigratedRules(page, ['HtmlLangValid', 'PageTitleDescriptive']);
        assert.equal(result.findings.length, 1);
        assert.equal(result.findings[0].ruleId, 'HtmlLangValid');
        assert.equal(result.findings[0].violationType, 'confirmed');
      },
    );
  });

  await t.test('PageTitle without PageTitleDescriptive when title element is absent', async () => {
    await withPage('<html lang="en"><head></head><body></body></html>', async (page) => {
      const { result } = await runMigratedRules(page, ['PageTitle', 'PageTitleDescriptive']);
      assert.deepEqual(
        result.findings.map((finding) => [finding.ruleId, finding.violationType]),
        [['PageTitle', 'confirmed']],
      );
    });
  });
});

test('title-only control and checkbox-with-title-only behaviors', async () => {
  await withPage(
    `
      <button id="title-only" title="Save"></button>
      <input id="checkbox-title-only" type="checkbox" title="Subscribe">
      <input id="checkbox-labeled" type="checkbox" title="Fallback" aria-label="Alerts">
    `,
    async (page) => {
      const { result } = await runMigratedRules(page, [
        'NoExtraInformationInTitle',
        'CheckboxDiscernible',
      ]);
      const titleRule = result.findings.filter((f) => f.ruleId === 'NoExtraInformationInTitle');
      const checkboxRule = result.findings.filter((f) => f.ruleId === 'CheckboxDiscernible');
      assert.ok(titleRule.some((f) => f.violationType === 'confirmed'));
      assert.equal(checkboxRule.length, 1);
      assert.match(checkboxRule[0].element.selector, /checkbox-title-only/);
    },
  );
});

test('wrapped link warning text uses visible descendant text', async () => {
  await withPage(
    '<a id="wrapped-pdf" href="/files/report.pdf"><span>Annual report</span></a>',
    async (page) => {
      const { result } = await runMigratedRules(page, ['LinkPDFWarning']);
      assert.equal(result.findings.length, 1);
      assert.match(result.findings[0].element.selector, /wrapped-pdf/);
      assert.equal(result.findings[0].violationType, 'potential');
    },
  );
});

test('hidden and AT-hidden candidates are skipped by default eligibility', async () => {
  await withPage(
    `
      <button id="visible-empty"></button>
      <button id="hidden-empty" hidden></button>
      <button id="aria-hidden-empty" aria-hidden="true"></button>
    `,
    async (page) => {
      const { result } = await runMigratedRules(page, ['ButtonDiscernible']);
      assert.equal(result.findings.length, 1);
      assert.match(result.findings[0].element.selector, /visible-empty/);
    },
  );
});

test('aria IDREF resolution stays scoped within shadow roots and frames', async () => {
  await withPage(
    `
      <div id="host"></div>
      <iframe srcdoc="<button aria-labelledby='missing-frame'>Frame Btn</button>"></iframe>
      <script>
        document.getElementById('host').attachShadow({ mode: 'open' }).innerHTML =
          '<button aria-labelledby="missing-shadow">Shadow Btn</button>';
      </script>
    `,
    async (page) => {
      const { result } = await runMigratedRules(page, ['AriaLabelledByHasReference']);
      assert.equal(result.findings.length, 2);
      assert.deepEqual(
        new Set(result.findings.map((finding) => finding.violationType)),
        new Set(['confirmed']),
      );
    },
  );
});

test('frozen dual-run evidence matches production engine counts on neutral fixture', async () => {
  await withPage(
    `
      <html>
        <head><title>Home</title></head>
        <body>
          <div role="application" id="app-shell">App</div>
          <span alt="wrong">Decorative</span>
          <ul id="legacy-empty"></ul>
          <nav><a href="/jobs" target="_blank">Jobs</a></nav>
          <label for="req">Email *</label>
          <input id="req" type="email" placeholder="you@example.com">
          <button id="mismatch" aria-label="Remove item">Delete</button>
        </body>
      </html>
    `,
    async (page) => {
      await installRuntimeHooks(page);
      const violations = await scanWithAccessScan(page, 'fixture://deterministic-parity', {
        skipNavigation: true,
      });
      for (const expected of dualRunFixture.rules) {
        const actualCount = violations.filter((violation) => violation.ruleId === expected.ruleId).length;
        assert.equal(actualCount, expected.engineCount, expected.ruleId);
      }
    },
  );
});

test('loadBuiltInRuleRegistry loads 82 active rules with graph-supported selectors', async () => {
  const registry = await loadBuiltInRuleRegistry({ enforceCatalogContract: false });
  assert.equal(registry.getActiveRuleIds().length, 82);
  for (const ruleId of registry.getActiveRuleIds()) {
    const rule = registry.getRule(ruleId);
    for (const check of rule.checks) {
      if (check.target?.selector) {
        assert.equal(validateGraphSelector(check.target.selector).valid, true, `${ruleId} ${check.id}`);
      }
    }
  }
  assert.equal(registry.getRule('MenuAvoid').automation, 'heuristic');
  assert.equal(registry.getRule('MenuBarAvoid').automation, 'heuristic');
  assert.equal(registry.getRule('MenuItemAvoid').automation, 'heuristic');
});
