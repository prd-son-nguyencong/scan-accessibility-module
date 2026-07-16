import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createViolation, getAccessScanCategory } from '../src/schema.js';
import { getAccessScanRuleRequirement } from '../src/scanner/access-scan/engine/public-catalog.js';
import { canonicalizeRuleId } from '../src/reporter/rule-aliases.js';
import { canonicalRuleForFixUnit } from '../src/fix/canonical/finding-aliases.js';
import {
  buildScanReportV2,
  projectReportV1,
} from '../src/reporter/report-v2.js';
import { getBrowser, closeBrowser } from '../src/scanner/browser.js';
import {
  ACTIVE_RULE_COUNT,
  CATALOG_RULE_COUNT,
  GOLDEN_CATALOG_SCHEMA_VERSION,
  LEGACY_NON_EMITTING_RULE_ID,
  STICKY_HEADER_DUAL_CATEGORY_CONTRACT,
  V1_VIOLATION_FIELD_CONTRACT,
  VIOLATION_FIELD_CONTRACT,
  assertRuleRequirementMetadata,
  compareRuleIdSets,
  createFixturePage,
  getAccessScanCatalogByRuleId,
  listAccessScanCatalogRuleIds,
  listActiveAccessScanRuleIds,
  listRegistryCatalogRuleIds,
  loadGoldenActiveCatalogRuleIds,
  loadGoldenCatalog,
  loadGoldenCatalogRuleIds,
  loadGoldenLegacyNonEmittingRuleIds,
  scanFixtureWithAccessScan,
} from './helpers/access-scan-contract.js';

const reportFixture = JSON.parse(
  readFileSync(new URL('./fixtures/fix/report-v2.json', import.meta.url), 'utf8')
);

function buildAccessScanViolation(overrides = {}) {
  return createViolation({
    ruleId: 'ListEmpty',
    layer: 'accessScan',
    category: 'accessibility',
    wcagRef: 'WCAG 2.0 A 1.3.1',
    impact: 'moderate',
    priority: 4,
    element: {
      outerHTML: '<ul id="empty"></ul>',
      selector: '#empty',
      scanId: null,
    },
    source: {
      mode: 'url',
      file: null,
      line: null,
      snippet: null,
      url: 'fixture://contract',
      confidence: 'none',
      method: 'unresolved',
      preimageSha256: null,
      preimageRange: null,
      routeDependencies: ['/'],
    },
    fix: {
      deterministic: true,
      hint: 'Populate the list or hide it from assistive technology.',
      patch: null,
    },
    ...overrides,
  });
}

test('frozen golden catalog locks 83 native rule IDs (82 active + one legacy alias)', async () => {
  const goldenCatalog = loadGoldenCatalog();
  const golden = loadGoldenCatalogRuleIds();
  const goldenActive = loadGoldenActiveCatalogRuleIds();
  const goldenLegacy = loadGoldenLegacyNonEmittingRuleIds();
  const catalog = [...listAccessScanCatalogRuleIds()].sort();
  const active = await listActiveAccessScanRuleIds();
  const registryCatalog = await listRegistryCatalogRuleIds();

  assert.equal(goldenCatalog.schemaVersion, GOLDEN_CATALOG_SCHEMA_VERSION);
  assert.equal(goldenCatalog.activeRuleCount, ACTIVE_RULE_COUNT);
  assert.equal(new Set(goldenCatalog.ruleIds).size, goldenCatalog.ruleIds.length);
  assert.deepEqual(
    goldenLegacy.filter((ruleId) => !goldenCatalog.ruleIds.includes(ruleId)),
    [],
  );
  assert.equal(golden.length, CATALOG_RULE_COUNT);
  assert.equal(goldenActive.length, ACTIVE_RULE_COUNT);
  assert.deepEqual(golden, catalog);
  assert.deepEqual(goldenActive, active);
  assert.deepEqual(registryCatalog, catalog);
  assert.deepEqual(goldenLegacy, [LEGACY_NON_EMITTING_RULE_ID]);
  assert.equal(goldenActive.includes(LEGACY_NON_EMITTING_RULE_ID), false);
});

test('registry-backed reporter metadata stays bidirectionally aligned with the 83-ID catalog', () => {
  const golden = loadGoldenCatalogRuleIds();
  const requirementKeys = golden.map((ruleId) => ruleId).filter((ruleId) => getAccessScanRuleRequirement(ruleId));
  const missingFromReporter = compareRuleIdSets(
    golden,
    requirementKeys,
    'golden catalog',
    'registry reporter metadata',
  );
  const extraInReporter = compareRuleIdSets(
    requirementKeys,
    golden,
    'registry reporter metadata',
    'golden catalog',
  );

  assert.deepEqual(missingFromReporter.onlyLeft, [], 'catalog IDs missing reporter copy');
  assert.deepEqual(extraInReporter.onlyLeft, [], 'reporter keys outside catalog');
  assert.equal(requirementKeys.length, CATALOG_RULE_COUNT);
});

test('every catalog rule ID has reporter requirement metadata and a public category', () => {
  const catalog = loadGoldenCatalogRuleIds();
  const byRuleId = getAccessScanCatalogByRuleId();

  for (const ruleId of catalog) {
    assertRuleRequirementMetadata(ruleId);
    const category = byRuleId.get(ruleId);
    assert.ok(category, `Missing category mapping for ${ruleId}`);
    assert.equal(getAccessScanCategory(ruleId).id, category.id);
  }
});

test('AriaLabelledbyContentMismatch stays in the public aria category as a legacy-readable alias', async () => {
  const ariaCategory = getAccessScanCatalogByRuleId().get(LEGACY_NON_EMITTING_RULE_ID);
  const active = await listActiveAccessScanRuleIds();
  assert.equal(getAccessScanCategory(LEGACY_NON_EMITTING_RULE_ID).id, 'aria');
  assert.equal(ariaCategory.id, 'aria');
  assert.equal(ariaCategory.label, 'ARIA');
  assert.deepEqual(
    ariaCategory.rules.filter((ruleId) => ruleId === LEGACY_NON_EMITTING_RULE_ID),
    [LEGACY_NON_EMITTING_RULE_ID],
  );
  assert.equal(active.includes(LEGACY_NON_EMITTING_RULE_ID), false);
});

test('StickyHeaderObscuresFocus keeps public interactive grouping and lists historical category', () => {
  const contract = STICKY_HEADER_DUAL_CATEGORY_CONTRACT;

  assert.equal(getAccessScanCategory(contract.ruleId).id, contract.publicCategoryId);
  assert.equal(
    getAccessScanCatalogByRuleId().get(contract.ruleId).id,
    contract.publicCategoryId,
  );
  assert.equal(contract.historicalCategoryId, 'lists');
  assert.equal(getAccessScanCategory('ListEmpty').id, contract.historicalCategoryId);
});

test('createViolation field contract remains stable for accessScan consumers', () => {
  const violation = buildAccessScanViolation({
    element: {
      outerHTML: '<ul id="empty"></ul>',
      selector: '#empty',
      scanId: 'fixture-scan-id',
    },
    source: {
      mode: 'url',
      file: 'src/pages/index.liquid',
      line: 12,
      snippet: 'fixture-snippet',
      url: 'fixture://contract',
      confidence: 'high',
      method: 'instrumentation-manifest',
      preimageSha256: 'sha256:fixture',
      preimageRange: { start: 1, end: 2 },
      partial: 'layout/header',
      page: 'src/pages/index.liquid',
      routeDependencies: ['/'],
    },
  });

  assert.deepEqual(Object.keys(violation).sort(), [...VIOLATION_FIELD_CONTRACT.topLevel].sort());
  assert.deepEqual(Object.keys(violation.element).sort(), [...VIOLATION_FIELD_CONTRACT.element].sort());
  assert.deepEqual(Object.keys(violation.source).sort(), [...VIOLATION_FIELD_CONTRACT.source].sort());
  assert.deepEqual(Object.keys(violation.fix).sort(), [...VIOLATION_FIELD_CONTRACT.fix].sort());
  assert.match(violation.id, /^[0-9a-f-]{36}$/);
  assert.doesNotThrow(() => new Date(violation.foundAt).toISOString());
  assert.deepEqual(violation.related, []);
  assert.equal(violation.count, 1);
});

test('native and canonical accessScan rule aliases remain stable', () => {
  assert.equal(canonicalizeRuleId('StickyHeaderObscuresFocus'), 'FocusNotObscuredHeader');
  assert.equal(canonicalizeRuleId('TablistRole'), 'TabListMisMatch');
  assert.equal(canonicalizeRuleId('ListEmpty'), 'ListEmpty');
  assert.equal(canonicalRuleForFixUnit('StickyHeaderObscuresFocus'), 'FocusNotObscuredHeader');
  assert.equal(canonicalRuleForFixUnit('TablistRole'), 'TabListMisMatch');
  assert.equal(canonicalRuleForFixUnit('ListEmpty'), 'ListEmpty');
});

test('ScanReportV2 and V1 projections preserve current accessScan finding contracts', () => {
  const scanResults = structuredClone(reportFixture.scanResults);
  scanResults[0].violations = [
    {
      ...buildAccessScanViolation({
        id: randomUUID(),
        ruleId: 'StickyHeaderObscuresFocus',
        wcagRef: 'WCAG 2.2 AA 2.4.11',
        impact: 'critical',
        priority: 1,
        element: {
          outerHTML: '<button id="covered">Go</button>',
          selector: '#covered',
          scanId: null,
        },
        fix: {
          deterministic: false,
          hint: 'Focused control is fully hidden by #header.',
          patch: null,
        },
      }),
      evidence: {
        obscuringHeader: '#header',
      },
    },
    buildAccessScanViolation({
      id: randomUUID(),
      ruleId: 'TablistRole',
      wcagRef: 'WCAG 2.0 A 4.1.2',
      impact: 'serious',
      priority: 3,
      element: {
        outerHTML: '<div class="tabs"></div>',
        selector: '.tabs',
        scanId: null,
      },
      fix: {
        deterministic: false,
        hint: 'Add role="tablist" to the tab container.',
        patch: null,
      },
    }),
  ];

  const report = buildScanReportV2(scanResults, reportFixture.context);
  const legacy = projectReportV1(report);
  const findings = Object.fromEntries(
    report.pages[0].findings.map((finding) => [finding.nativeRuleId, finding])
  );
  const legacyViolations = Object.fromEntries(
    legacy.pages[0].violations.map((violation) => [violation.ruleId, violation])
  );
  const stickyV1 = legacyViolations.StickyHeaderObscuresFocus;
  const tablistV1 = legacyViolations.TablistRole;

  assert.equal(findings.StickyHeaderObscuresFocus.nativeRuleId, 'StickyHeaderObscuresFocus');
  assert.equal(findings.StickyHeaderObscuresFocus.canonicalRuleId, 'FocusNotObscuredHeader');
  assert.equal(findings.TablistRole.nativeRuleId, 'TablistRole');
  assert.equal(findings.TablistRole.canonicalRuleId, 'TabListMisMatch');
  assert.equal(stickyV1.ruleId, 'StickyHeaderObscuresFocus');
  assert.equal(tablistV1.ruleId, 'TablistRole');
  assert.equal(stickyV1.canonicalRuleId, 'FocusNotObscuredHeader');
  assert.equal(tablistV1.canonicalRuleId, 'TabListMisMatch');
  assert.equal(stickyV1.id.startsWith('sha256:'), true);
  assert.equal(
    findings.StickyHeaderObscuresFocus.evidence.observations[0].evidence.obscuringHeader,
    '#header',
  );
  assert.equal(
    findings.StickyHeaderObscuresFocus.evidence.observations[0].nativeRuleId,
    'StickyHeaderObscuresFocus',
  );
  assert.deepEqual(
    findings.StickyHeaderObscuresFocus.evidence.observations[0].relatedRuleIds,
    ['FocusNotObscuredHeader'],
  );

  for (const violation of [stickyV1, tablistV1]) {
    assert.deepEqual(
      Object.keys(violation).sort(),
      [...V1_VIOLATION_FIELD_CONTRACT.topLevel].sort(),
    );
    assert.deepEqual(
      Object.keys(violation.element).sort(),
      [...V1_VIOLATION_FIELD_CONTRACT.element].sort(),
    );
    assert.deepEqual(
      Object.keys(violation.source).sort(),
      [...V1_VIOLATION_FIELD_CONTRACT.source].sort(),
    );
    assert.deepEqual(
      Object.keys(violation.fix).sort(),
      [...V1_VIOLATION_FIELD_CONTRACT.fix].sort(),
    );
    assert.deepEqual(
      Object.keys(violation.evidence).sort(),
      [...V1_VIOLATION_FIELD_CONTRACT.evidence].sort(),
    );
    assert.equal(violation.layer, 'accessScan');
    assert.deepEqual(violation.layers, ['accessScan']);
    assert.equal(violation.category, 'accessibility');
    assert.equal(Array.isArray(violation.related), true);
    assert.equal(Array.isArray(violation.manualChecks), true);
    assert.equal(violation.foundAt, report.generatedAt);
    assert.equal(violation.source.url, report.pages[0].url);
  }
});

test('neutral accessScan fixtures retain current native rule IDs and classifications', async (t) => {
  let browser;
  try {
    browser = await getBrowser();
  } catch (error) {
    t.skip(`Playwright browser unavailable: ${error.message}`);
    return;
  }

  try {
    await t.test('deterministic scanners keep standards findings', async () => {
      const page = await createFixturePage(browser, `
        <!doctype html>
        <html>
          <head><title>Contract baseline</title></head>
          <body>
            <ul id="empty-list"></ul>
          </body>
        </html>
      `);
      try {
        const violations = await scanFixtureWithAccessScan(page, 'fixture://contract-deterministic', {
          skipRules: [
            'HtmlLang', 'MetaDescription', 'MetaViewportPresent', 'PageTitleDescriptive',
          ],
        });
        const listEmpty = violations.find(({ ruleId }) => ruleId === 'ListEmpty');
        assert.ok(listEmpty);
        assert.ok(listEmpty.element.selector.includes('empty-list'));
        assert.equal(listEmpty.fix.deterministic, true);
      } finally {
        await page.context().close();
      }
    });

    await t.test('metadata scanners keep deterministic HtmlLang findings', async () => {
      const page = await createFixturePage(browser, `
        <!doctype html>
        <html>
          <head><title>Contract baseline</title></head>
          <body><p>Neutral page</p></body>
        </html>
      `);
      try {
        const violations = await scanFixtureWithAccessScan(page, 'fixture://contract-metadata', {
          skipRules: ['ListEmpty', 'MetaDescription', 'MetaViewportPresent', 'PageTitleDescriptive'],
        });
        const htmlLang = violations.find(({ ruleId }) => ruleId === 'HtmlLang');
        assert.ok(htmlLang);
        assert.equal(htmlLang.fix.deterministic, true);
        assert.equal(htmlLang.wcagRef, 'WCAG 2.0 A 3.1.1');
      } finally {
        await page.context().close();
      }
    });

    await t.test('heuristic scanners keep advisory StrongMismatch findings', async () => {
      const page = await createFixturePage(browser, `
        <style>#bold-copy { font-weight: 700; }</style>
        <p><span id="bold-copy">Important</span></p>
      `);
      try {
        const violations = await scanFixtureWithAccessScan(page, 'fixture://contract-heuristic', {
          skipRules: [
            'HtmlLang', 'MetaDescription', 'MetaViewportPresent', 'PageTitleDescriptive', 'ListEmpty',
          ],
        });
        const strong = violations.find(({ ruleId }) => ruleId === 'StrongMismatch');
        assert.ok(strong);
        assert.ok(strong.element.selector.includes('bold-copy'));
        assert.deepEqual(
          {
            impact: strong.impact,
            wcagRef: strong.wcagRef,
            deterministic: strong.fix.deterministic,
          },
          { impact: 'minor', wcagRef: 'Best Practice', deterministic: false },
        );
      } finally {
        await page.context().close();
      }
    });

    await t.test('behavioral scanners keep confirmed StickyHeaderObscuresFocus findings', async () => {
      const page = await createFixturePage(browser, `
        <style>
          header {
            position: fixed;
            inset: 0 0 auto;
            height: 100px;
            background: white;
            z-index: 2;
          }
          #covered {
            position: fixed;
            top: 10px;
            left: 10px;
            width: 40px;
            height: 20px;
            z-index: 1;
          }
        </style>
        <header id="header">Header</header>
        <button id="covered" autofocus>Go</button>
      `);
      try {
        const violations = await scanFixtureWithAccessScan(page, 'fixture://contract-behavioral', {
          skipRules: [
            'HtmlLang', 'MetaDescription', 'MetaViewportPresent', 'PageTitleDescriptive', 'ListEmpty',
          ],
        });
        const sticky = violations.find(({ ruleId }) => ruleId === 'StickyHeaderObscuresFocus');
        assert.ok(sticky);
        assert.ok(sticky.element.selector.includes('covered'));
        assert.equal(sticky.fix.deterministic, false);
        assert.equal(
          STICKY_HEADER_DUAL_CATEGORY_CONTRACT.historicalCategoryId,
          'lists',
        );
      } finally {
        await page.context().close();
      }
    });
  } finally {
    await closeBrowser();
  }
});
