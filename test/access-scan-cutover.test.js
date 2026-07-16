import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

import { scanWithAccessScan } from '../src/scanner/access-scan/index.js';
import { installRuntimeHooks } from '../src/scanner/access-scan/runtime/index.js';
import {
  ACCESSSCAN_CATEGORIES,
  createViolation,
  getAccessScanCategory,
  listAccessScanCatalogRuleIds,
} from '../src/schema.js';
import {
  getAccessScanRuleMetadata,
  getAccessScanRuleRequirement,
} from '../src/scanner/access-scan/engine/public-catalog.js';
import { canonicalizeRuleId } from '../src/reporter/rule-aliases.js';
import { stableFindingFingerprint } from '../src/reporter/fingerprint.js';
import {
  buildScanReportV2,
  projectReportV1,
} from '../src/reporter/report-v2.js';
import {
  lookupPolicyDecision,
  POLICIES,
} from '../src/fix/policy/registry.js';
import { buildAccessScanRun } from '../src/index.js';
import {
  ACTIVE_RULE_COUNT,
  CATALOG_RULE_COUNT,
  ENGINE_VIOLATION_FIELD_CONTRACT,
  LEGACY_NON_EMITTING_RULE_ID,
  STICKY_HEADER_DUAL_CATEGORY_CONTRACT,
  assertExactViolationFieldContract,
  loadGoldenCatalogRuleIds,
} from './helpers/access-scan-contract.js';
import {
  getSharedBuiltInRuleRegistry,
  loadBuiltInRuleRegistry,
} from '../src/scanner/access-scan/engine/builtin-registry.js';
import {
  AccessScanUnknownRuleError,
  findingToViolation,
  isPlaywrightNavigationTimeout,
} from '../src/scanner/access-scan/index.js';
import { normalizeFinding, toViolation } from '../src/scanner/access-scan/engine/finding.js';
import * as html from '../src/reporter/html.js';

const reportFixture = JSON.parse(
  readFileSync(new URL('./fixtures/fix/report-v2.json', import.meta.url), 'utf8'),
);

const dualRunFixture = JSON.parse(
  readFileSync(new URL('./fixtures/access-scan/dual-run-neutral.json', import.meta.url), 'utf8'),
);

async function withPage(markup, run) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  page.on('console', () => {});
  page.on('pageerror', () => {});
  try {
    await installRuntimeHooks(page);
    await page.setContent(markup, { waitUntil: 'domcontentloaded' });
    return await run(page);
  } finally {
    await context.close();
    await browser.close();
  }
}

test('public catalog exposes 83 registry-backed rules across 11 categories', () => {
  const catalog = listAccessScanCatalogRuleIds().sort();
  const golden = loadGoldenCatalogRuleIds();
  assert.equal(ACCESSSCAN_CATEGORIES.length, 11);
  assert.equal(catalog.length, CATALOG_RULE_COUNT);
  assert.equal(new Set(catalog).size, CATALOG_RULE_COUNT);
  assert.deepEqual(catalog, golden);
  assert.equal(
    ACCESSSCAN_CATEGORIES.flatMap((category) => category.rules).length,
    CATALOG_RULE_COUNT,
  );
  assert.equal(
    catalog.filter((ruleId) => ruleId !== LEGACY_NON_EMITTING_RULE_ID).length,
    ACTIVE_RULE_COUNT,
  );
});

test('getAccessScanCategory returns null for unknown or stale rule ids', () => {
  assert.equal(getAccessScanCategory('TotallyUnknownRule'), null);
  assert.equal(getAccessScanCategory(''), null);
  assert.equal(getAccessScanCategory('ListEmpty').id, 'lists');
});

test('public catalog getters return frozen clones that cannot mutate internal state', () => {
  const category = getAccessScanCategory('ListEmpty');
  assert.ok(category);
  assert.throws(() => {
    category.rules.push('InjectedRule');
  });
  const requirement = getAccessScanRuleRequirement('ListEmpty');
  assert.throws(() => {
    requirement.title = 'mutated';
  });
  const metadata = getAccessScanRuleMetadata('ListEmpty');
  assert.throws(() => {
    metadata.fix.deterministic = false;
  });
  const before = ACCESSSCAN_CATEGORIES[0].rules.length;
  assert.throws(() => {
    ACCESSSCAN_CATEGORIES[0].rules.push('InjectedRule');
  });
  assert.equal(ACCESSSCAN_CATEGORIES[0].rules.length, before);
});

test('toViolation preserves exact engine violation field contract', async () => {
  const registry = await getSharedBuiltInRuleRegistry();
  const rule = registry.getRule('ListEmpty');
  const finding = normalizeFinding({
    element: {
      outerHTML: '<ul id="empty"></ul>',
      selector: '#empty',
      framePath: [0],
      shadowPath: [],
    },
  }, rule);
  const violation = toViolation(finding, {
    layer: 'accessScan',
    source: { mode: 'url', url: 'fixture://contract' },
    rule,
  });
  assertExactViolationFieldContract(violation, ENGINE_VIOLATION_FIELD_CONTRACT);
});

test('shared built-in registry promise is concurrency-safe and identity-stable', async () => {
  const [first, second, third] = await Promise.all([
    getSharedBuiltInRuleRegistry(),
    getSharedBuiltInRuleRegistry(),
    getSharedBuiltInRuleRegistry(),
  ]);
  assert.equal(first, second);
  assert.equal(second, third);
  const fresh = await loadBuiltInRuleRegistry({ enforceCatalogContract: false });
  assert.notEqual(fresh, first);
});

test('findingToViolation throws unknown_rule typed error for missing registry rule', async () => {
  const registry = await getSharedBuiltInRuleRegistry();
  const finding = normalizeFinding({
    element: { outerHTML: '<div></div>', selector: 'div' },
  }, registry.getRule('ListEmpty'));
  finding.ruleId = 'TotallyUnknownRule';
  assert.throws(
    () => findingToViolation(registry, finding, { layer: 'accessScan', source: { mode: 'url', url: 'x' } }),
    (error) => error instanceof AccessScanUnknownRuleError && error.errorCode === 'unknown_rule',
  );
});

test('isPlaywrightNavigationTimeout classifies Playwright timeout errors by name', () => {
  assert.equal(isPlaywrightNavigationTimeout({ name: 'TimeoutError' }), true);
  assert.equal(isPlaywrightNavigationTimeout(new Error('Timeout 60000ms exceeded')), false);
  assert.equal(isPlaywrightNavigationTimeout({ name: 'Error', message: 'Timeout' }), false);
});

test('standalone scanWithAccessScan navigates once and installs runtime hooks', async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  page.on('console', () => {});
  page.on('pageerror', () => {});

  let gotoCount = 0;
  const originalGoto = page.goto.bind(page);
  page.goto = async (...args) => {
    gotoCount += 1;
    return originalGoto(...args);
  };

  try {
    const url = 'data:text/html,<html><head><title>Nav</title></head><body><ul id="empty"></ul></body></html>';
    let sessionMetrics = null;
    await scanWithAccessScan(page, url, {
      skipNavigation: false,
      onExecutionRecords: (_records, meta) => {
        sessionMetrics = meta.sessionMetrics;
      },
    });
    assert.equal(gotoCount, 1);
    assert.equal(await page.evaluate(() => Boolean(globalThis.__adaScanRuntime)), true);
    assert.equal(sessionMetrics.scannerNavigationCount, 1);
    assert.equal(sessionMetrics.externalNavigationCount, 0);
    assert.equal(sessionMetrics.navigationCount, 1);
  } finally {
    await context.close();
    await browser.close();
  }
});

test('scanWithAccessScan activates below-fold lazy content before snapshotting', async () => {
  await withPage(
    `
      <!doctype html>
      <html>
        <head><title>Lazy page</title></head>
        <body>
          <div style="height: 1800px"></div>
          <div id="lazy-sentinel">Waiting</div>
          <script>
            const sentinel = document.getElementById('lazy-sentinel');
            const observer = new IntersectionObserver((entries) => {
              if (!entries.some((entry) => entry.isIntersecting)) return;
              sentinel.innerHTML = '<ul id="activated-empty-list"></ul>';
              observer.disconnect();
            });
            observer.observe(sentinel);
          </script>
        </body>
      </html>
    `,
    async (page) => {
      const violations = await scanWithAccessScan(page, 'fixture://lazy-content', {
        skipNavigation: true,
        skipRules: (await getSharedBuiltInRuleRegistry()).getActiveRuleIds()
          .filter((ruleId) => ruleId !== 'ListEmpty'),
      });
      const activated = violations.find((violation) => violation.ruleId === 'ListEmpty');
      assert.ok(activated);
      assert.match(activated.element.outerHTML, /activated-empty-list/);
      assert.equal(await page.evaluate(() => window.scrollY), 0);
    },
  );
});

test('scanWithAccessScan retries navigation after Playwright TimeoutError', async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  page.on('console', () => {});
  page.on('pageerror', () => {});

  let attempts = 0;
  const originalGoto = page.goto.bind(page);
  page.goto = async (...args) => {
    attempts += 1;
    if (attempts === 1) {
      const err = new Error('Timeout 60000ms exceeded');
      err.name = 'TimeoutError';
      throw err;
    }
    return originalGoto(...args);
  };

  try {
    const url = 'data:text/html,<html><head><title>Retry</title></head><body><ul id="empty"></ul></body></html>';
    const violations = await scanWithAccessScan(page, url, { skipNavigation: false });
    assert.equal(attempts, 2);
    assert.ok(violations.some((violation) => violation.ruleId === 'ListEmpty'));
  } finally {
    await context.close();
    await browser.close();
  }
});

test('scanOnePage path reports total navigation with externalNavigationCount', async () => {
  await withPage(
    '<!doctype html><html lang="en"><head><title>One nav</title></head><body></body></html>',
    async (page) => {
      let sessionMetrics = null;
      await scanWithAccessScan(page, 'fixture://one-nav', {
        skipNavigation: true,
        externalNavigationCount: 1,
        onExecutionRecords: (_records, meta) => {
          sessionMetrics = meta.sessionMetrics;
        },
      });
      assert.equal(sessionMetrics.navigationCount, 1);
      assert.equal(sessionMetrics.externalNavigationCount, 1);
      assert.equal(sessionMetrics.scannerNavigationCount, 0);
      assert.ok(sessionMetrics.runtimeInstallCount >= 0);
    },
  );
});

test('onExecutionRecords observer exceptions are contained and scan still returns findings', async () => {
  await withPage(
    '<!doctype html><html><head><title>t</title></head><body><ul id="empty"></ul></body></html>',
    async (page) => {
      const violations = await scanWithAccessScan(page, 'fixture://observer', {
        skipNavigation: true,
        onExecutionRecords: () => {
          throw new Error('observer blew up');
        },
      });
      assert.ok(violations.some((violation) => violation.ruleId === 'ListEmpty'));
    },
  );
});

test('scanWithAccessScan forwards ruleTimeoutMs and abort signal without failing scan', async () => {
  await withPage(
    '<!doctype html><html><head><title>t</title></head><body><ul id="empty"></ul></body></html>',
    async (page) => {
      const controller = new AbortController();
      controller.abort();
      let records = null;
      const violations = await scanWithAccessScan(page, 'fixture://signal', {
        skipNavigation: true,
        ruleTimeoutMs: 1,
        signal: controller.signal,
        onExecutionRecords: (executionRecords) => {
          records = executionRecords;
        },
      });
      assert.ok(Array.isArray(violations));
      assert.ok(Array.isArray(records));
    },
  );
});

test('buildAccessScanSection renders Uncatalogued accordion for stale accessScan findings', () => {
  assert.equal(typeof html.buildAccessScanSection, 'function');
  const markup = html.buildAccessScanSection([
    createViolation({
      ruleId: 'ListEmpty',
      layer: 'accessScan',
      wcagRef: 'WCAG 2.0 A 1.3.1',
      impact: 'moderate',
      element: { outerHTML: '<ul id="empty"></ul>', selector: '#empty' },
      source: { mode: 'url', url: 'fixture://stale' },
    }),
    createViolation({
      ruleId: 'StaleLegacyRuleXYZ',
      layer: 'accessScan',
      wcagRef: 'WCAG 2.0 A 1.3.1',
      impact: 'serious',
      element: { outerHTML: '<div id="stale"></div>', selector: '#stale' },
      source: { mode: 'url', url: 'fixture://stale' },
      fix: { deterministic: false, hint: 'Review manually.', patch: null },
    }),
  ]);

  assert.match(markup, /Uncatalogued/);
  assert.match(markup, /StaleLegacyRuleXYZ/);
  assert.doesNotMatch(markup, /cat-label[^<]*General[^<]*StaleLegacyRuleXYZ/s);
});

test('StickyHeaderObscuresFocus keeps interactive public category and lists historical category', () => {
  const metadata = getAccessScanRuleMetadata(STICKY_HEADER_DUAL_CATEGORY_CONTRACT.ruleId);
  assert.equal(getAccessScanCategory(STICKY_HEADER_DUAL_CATEGORY_CONTRACT.ruleId).id, 'interactive');
  assert.equal(metadata.publicCategory, 'interactive');
  assert.equal(metadata.category, 'lists');
});

test('registry-backed reporter copy replaces static RULE_REQUIREMENTS', () => {
  for (const ruleId of loadGoldenCatalogRuleIds()) {
    const requirement = getAccessScanRuleRequirement(ruleId);
    assert.ok(requirement?.title, ruleId);
    assert.ok(requirement?.requirement, ruleId);
    assert.ok(requirement?.recommendation, ruleId);
  }
});

test('production scanWithAccessScan returns Violation[] from descriptor engine', async () => {
  await withPage(
    '<!doctype html><html><head><title>t</title></head><body><ul id="empty"></ul></body></html>',
    async (page) => {
      const violations = await scanWithAccessScan(page, 'fixture://cutover', { skipNavigation: true });
      assert.ok(Array.isArray(violations));
      assert.ok(violations.length > 0);
      const listEmpty = violations.find((violation) => violation.ruleId === 'ListEmpty');
      assert.ok(listEmpty);
      assert.equal(listEmpty.layer, 'accessScan');
      assert.equal(listEmpty.fix.deterministic, true);
      assert.equal(listEmpty.evidence.publicCategory, 'lists');
      assert.equal(listEmpty.evidence.fixPolicy, 'mechanically_safe');
    },
  );
});

test('includeThirdParty maps to commercial-parity profile and skipRules works', async () => {
  await withPage(
    '<!doctype html><html><head><title>Home</title></head><body><ul id="empty"></ul></body></html>',
    async (page) => {
      let parityProfile = null;
      const parity = await scanWithAccessScan(page, 'fixture://parity', {
        skipNavigation: true,
        includeThirdParty: true,
        onExecutionRecords: (_records, meta) => {
          parityProfile = meta.profile;
        },
      });
      assert.equal(parityProfile, 'commercial-parity');

      let standardsProfile = null;
      const standards = await scanWithAccessScan(page, 'fixture://standards', {
        skipNavigation: true,
        includeThirdParty: false,
        skipRules: ['HtmlLang', 'MetaDescription', 'MetaViewportPresent', 'PageTitleDescriptive'],
        onExecutionRecords: (_records, meta) => {
          standardsProfile = meta.profile;
        },
      });
      assert.equal(standardsProfile, 'standards');
      assert.equal(standards.some((violation) => violation.ruleId === 'HtmlLang'), false);
      assert.equal(parity.some((violation) => violation.ruleId === 'ListEmpty'), true);
    },
  );
});

test('buildAccessScanRun records engine profile and execution aggregates additively', () => {
  const run = buildAccessScanRun(
    [{ ruleId: 'ListEmpty', count: 1 }],
    {
      includeThirdParty: false,
      engineVersion: '1.0.1',
      profile: 'standards',
      execution: {
        profile: 'standards',
        complete: 70,
        inapplicable: 10,
        error: 1,
        timeout: 1,
        candidates: 120,
        findings: 1,
      },
      sessionMetrics: {
        navigationCount: 0,
        snapshotCount: 1,
      },
    },
  );

  assert.equal(run.evidence.profile, 'standards');
  assert.equal(run.evidence.ruleGroups, 1);
  assert.equal(run.evidence.engine.rules.complete, 70);
  assert.equal(run.evidence.engine.session.navigationCount, 0);
});

test('toViolation metadata preserves V1 aliases and fix policy registry honors descriptor evidence', () => {
  const violation = createViolation({
    ruleId: 'StickyHeaderObscuresFocus',
    layer: 'accessScan',
    impact: 'critical',
    priority: 1,
    element: { outerHTML: '<button id="covered">Go</button>', selector: '#covered', scanId: null },
    source: { mode: 'url', url: 'fixture://policy' },
    fix: { deterministic: false, hint: 'Adjust header offset.', patch: null },
  });
  violation.evidence = {
    violationType: 'confirmed',
    fixPolicy: 'manual_only',
    publicCategory: 'interactive',
  };

  assert.equal(canonicalizeRuleId(violation.ruleId), 'FocusNotObscuredHeader');
  const decision = lookupPolicyDecision({
    fixUnitId: 'u-cutover',
    kind: 'accessibility',
    findings: [violation],
  });
  assert.equal(decision.policy, POLICIES.MANUAL_ONLY);

  const deterministicViolation = {
    ...violation,
    fix: { deterministic: true, hint: 'Populate list.', patch: null },
    evidence: {
      violationType: 'confirmed',
      fixPolicy: 'mechanically_safe',
    },
  };
  const safeDecision = lookupPolicyDecision({
    fixUnitId: 'u-safe',
    kind: 'accessibility',
    findings: [deterministicViolation],
  });
  assert.equal(safeDecision.policy, POLICIES.MECHANICALLY_SAFE);
});

test('V2 DOM fingerprint includes framePath only when non-empty', () => {
  const lightDom = stableFindingFingerprint({
    nativeRuleId: 'ListEmpty',
    route: '/',
    element: {
      selector: '#empty',
      outerHTML: '<ul id="empty"></ul>',
      framePath: [],
      shadowPath: [],
    },
  });
  const framed = stableFindingFingerprint({
    nativeRuleId: 'ListEmpty',
    route: '/',
    element: {
      selector: '#empty',
      outerHTML: '<ul id="empty"></ul>',
      framePath: [0],
      shadowPath: [],
    },
  });
  const shadowed = stableFindingFingerprint({
    nativeRuleId: 'ListEmpty',
    route: '/',
    element: {
      selector: '#empty',
      outerHTML: '<ul id="empty"></ul>',
      framePath: [],
      shadowPath: [0, 1],
    },
  });

  assert.notEqual(lightDom, framed);
  assert.notEqual(lightDom, shadowed);
  assert.notEqual(framed, shadowed);
});

test('frozen dual-run evidence matches production engine counts on neutral fixture', async () => {
  const markup = `
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
  `;

  await withPage(markup, async (page) => {
    const violations = await scanWithAccessScan(page, 'fixture://dual-run', { skipNavigation: true });
    for (const expected of dualRunFixture.rules) {
      const actualCount = violations.filter((violation) => violation.ruleId === expected.ruleId).length;
      assert.equal(
        actualCount,
        expected.engineCount,
        `${expected.ruleId} count mismatch`,
      );
    }
  });
});

test('production scan projects through report V2 without field drift', async () => {
  await withPage(
    '<!doctype html><html><head><title>Home</title></head><body><ul id="empty"></ul></body></html>',
    async (page) => {
      const violations = await scanWithAccessScan(page, 'fixture://report', { skipNavigation: true });
      const report = buildScanReportV2([{
        name: 'Cutover',
        url: 'fixture://report',
        violations,
        scannerRuns: [buildAccessScanRun(violations, {
          engineVersion: reportFixture.context.producer.version,
        })],
      }], reportFixture.context);
      const legacy = projectReportV1(report);
      assert.ok(report.pages[0].findings.length > 0);
      assert.ok(legacy.pages[0].violations.length > 0);
      const finding = report.pages[0].findings.find((entry) => entry.nativeRuleId === 'ListEmpty');
      assert.ok(finding);
      assert.equal(finding.canonicalRuleId, 'ListEmpty');
    },
  );
});
