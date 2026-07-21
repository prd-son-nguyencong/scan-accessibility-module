import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

import { createScanSession } from '../src/scanner/access-scan/runtime/index.js';
import { loadBuiltInRuleRegistry } from '../src/scanner/access-scan/engine/builtin-registry.js';
import { runRules } from '../src/scanner/access-scan/engine/runner.js';
import { PROFILES } from '../src/scanner/access-scan/engine/profiles.js';
import { dedupeFindings, VIOLATION_TYPES } from '../src/scanner/access-scan/engine/finding.js';
import { projectFindings } from '../src/scanner/access-scan/engine/projection.js';
import { canonicalizeRuleId } from '../src/reporter/rule-aliases.js';
import { collectSignalBundle, SIGNAL_FAMILIES } from '../src/scanner/access-scan/signals/index.js';
import { getCachedSignalBundle } from '../src/scanner/access-scan/evaluators/lib/signal-bundle-cache.js';
import commercialParityEvaluator from '../src/scanner/access-scan/evaluators/commercial-parity.evaluator.js';
import labelInNameEvaluator from '../src/scanner/access-scan/evaluators/label-in-name.evaluator.js';
import standardsSignalEvaluator from '../src/scanner/access-scan/evaluators/standards-signal.evaluator.js';
import { applyAccessScanPolicy } from '../src/scanner/access-scan/policies/accessscan.js';
import { applyStandardsPolicy, mapFactToStandardsFindings } from '../src/scanner/access-scan/policies/standards.js';
import { verifyCorpus } from '../scripts/accessscan-corpus/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SIGNALS_ROOT = path.join(__dirname, '../src/scanner/access-scan/signals');
const POLICIES_ROOT = path.join(__dirname, '../src/scanner/access-scan/policies');
const EVALUATOR_ROOT = path.join(__dirname, '../src/scanner/access-scan/evaluators');
const CORPUS_ROOT = path.join(__dirname, 'fixtures/accessscan-corpus');

const SIGNAL_FORBIDDEN_TOKENS = [
  'commercial-parity',
  'commercial',
  'parity',
  'TabMismatch',
  'TablistRole',
  'RegionMainContentMismatch',
  'expectedFailureCount',
  'expected-count',
  'corpus',
  'site-',
  'profile:',
  'bnetesting',
  'paradox',
  'credentialGate',
  'disclosureTriggersExamined',
  'bundle.patterns',
];

const NEUTRAL_MARKUP = `
  <html lang="en">
    <head><title>Login</title></head>
    <body>
      <div class="shell-wrap-neutral">
        <header>Banner</header>
        <main>
          <h1>Login</h1>
          <form>
            <input type="password" autocomplete="current-password">
            <button type="submit">Sign in</button>
          </form>
        </main>
      </div>
      <div aria-hidden="true" style="width:40px;height:40px">
        <svg width="32" height="32"><circle cx="16" cy="16" r="12"/></svg>
      </div>
      <label for="mismatch">Remove</label>
      <button id="mismatch" aria-label="Dismiss item">Delete</button>
    </body>
  </html>
`;

const FAMILY_KINDS = {
  [SIGNAL_FAMILIES.VISIBILITY]: ['visibility.aria-hidden-exposed', 'visibility.structural-misuse'],
  [SIGNAL_FAMILIES.SEMANTICS]: [
    'semantics.gated-entry',
    'semantics.gated-entry.hidden',
    'semantics.accessible-name',
    'semantics.checkbox-value',
  ],
  [SIGNAL_FAMILIES.GEOMETRY]: ['geometry.top-anchored-header'],
  [SIGNAL_FAMILIES.RELATIONSHIPS]: [
    'relationships.grouped-action-buttons',
    'relationships.disclosure-group',
    'relationships.visual-tab-group',
    'relationships.separated-footer-region',
    'relationships.nested-main-boundary',
    'relationships.wrapped-footer-region',
  ],
  [SIGNAL_FAMILIES.GRAPHICS]: [
    'graphics.pointer-transparent-overlay',
    'graphics.input-cue',
    'graphics.hidden-symbol',
    'graphics.repeated-action-symbol',
    'graphics.control-state-indicator',
    'graphics.unlabeled-icon',
  ],
  [SIGNAL_FAMILIES.BEHAVIOR]: [
    'behavior.nav-current-link',
    'behavior.current-destination-link',
    'behavior.submenu-row',
    'behavior.search-unlandmarked',
  ],
};

async function withPage(markup, run) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  page.on('console', () => {});
  page.on('pageerror', () => {});
  try {
    await page.setContent(markup, { waitUntil: 'domcontentloaded' });
    return await run(page);
  } finally {
    await context.close();
    await browser.close();
  }
}

/**
 * @param {string} root
 * @returns {string[]}
 */
function walkJsFiles(root) {
  /** @type {string[]} */
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkJsFiles(fullPath));
      continue;
    }
    if (entry.name.endsWith('.js')) {
      files.push(fullPath);
    }
  }
  return files;
}

function assertDeepFrozen(value, pathLabel = 'root') {
  if (value === null || typeof value !== 'object') {
    return;
  }
  assert.equal(Object.isFrozen(value), true, `${pathLabel} must be frozen`);
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      assertDeepFrozen(item, `${pathLabel}[${index}]`);
    }
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    assertDeepFrozen(child, `${pathLabel}.${key}`);
  }
}

test('collectSignalBundle returns facts-only deeply frozen bundle without patterns', async () => {
  await withPage(NEUTRAL_MARKUP, async (page) => {
    const session = await createScanSession(page);
    const bundle = collectSignalBundle({ snapshot: session.snapshot, session });

    assertDeepFrozen(bundle);
    assert.equal('patterns' in bundle, false);
    assert.ok(Array.isArray(bundle.facts));
    assert.ok(bundle.facts.length > 0);
    assert.equal(typeof bundle.metrics.mainLandmarksScanned, 'number');

    for (const fact of bundle.facts) {
      assert.ok(Object.values(SIGNAL_FAMILIES).includes(fact.family));
      assert.equal(typeof fact.kind, 'string');
      assert.equal(typeof fact.subject.elementId, 'number');
      assert.equal(Array.isArray(fact.relatedElementIds), true);
      assert.equal('outerHTML' in fact.subject, false);
      assert.equal('factId' in fact, false);
    }
  });
});

test('shared signal bundle cache collects once per snapshot and recollects after snapshot replacement', async () => {
  await withPage(NEUTRAL_MARKUP, async (page) => {
    const sessionA = await createScanSession(page);
    const sessionB = await createScanSession(page);
    const context = { snapshot: sessionA.snapshot, session: sessionA };

    const first = getCachedSignalBundle(context);
    const second = getCachedSignalBundle(context);
    assert.equal(first, second);
    assert.equal(context.evaluatorCache.signalBundleCollectCount, 1);

    context.snapshot = sessionB.snapshot;
    const third = getCachedSignalBundle(context);
    assert.notEqual(third, first);
    assert.equal(context.evaluatorCache.signalBundleCollectCount, 2);
    const sessionBElement = sessionB.snapshot.elements[0];
    assert.equal(context.indexes.byElementId.get(sessionBElement.id), sessionBElement);
  });
});

test('signal evaluators share one cached bundle per snapshot across commercial and standards paths', async () => {
  await withPage(NEUTRAL_MARKUP, async (page) => {
    const session = await createScanSession(page);
    const context = { snapshot: session.snapshot, session };

    await commercialParityEvaluator.evaluate(context, {
      checkId: 'parity:disclosure-tablist-role',
      options: { mode: 'disclosure-tablist-role' },
    });
    const afterCommercial = context.evaluatorCache.signalBundle;
    assert.ok(afterCommercial?.bundle);

    await labelInNameEvaluator.evaluate(context, { checkId: 'standards:label-in-name' });
    assert.equal(context.evaluatorCache.signalBundle.bundle, afterCommercial.bundle);

    await standardsSignalEvaluator.evaluate(context, {
      checkId: 'standards:visibility-mismatch',
      options: { mode: 'visibility-mismatch' },
    });
    assert.equal(context.evaluatorCache.signalBundleCollectCount, 1);
    assert.equal(context.evaluatorCache.signalBundle.bundle, afterCommercial.bundle);
  });
});

const RICH_MARKUP = `
  <html lang="en">
    <head><title>Login</title></head>
    <body>
      <div class="shell-wrap-neutral">
        <header>Banner</header>
        <main>
          <h1>Login</h1>
          <form>
            <input type="password" autocomplete="current-password">
            <button type="submit">Sign in</button>
          </form>
        </main>
      </div>
      <header style="position:fixed;top:0">Sticky</header>
      <nav aria-label="Primary"><a href="/" aria-current="page">Home</a></nav>
      <section>
        <button aria-expanded="false" aria-controls="p1">One</button>
        <button aria-expanded="true" aria-controls="p2">Two</button>
        <div id="p1">A</div><div id="p2">B</div>
      </section>
      <input type="search" aria-label="Search jobs">
      <svg role="img" width="20" height="20"></svg>
      <div aria-hidden="true" style="width:40px;height:40px">
        <svg width="32" height="32"><use href="#icon"/></svg>
      </div>
    </body>
  </html>
`;

for (const [family] of Object.entries(FAMILY_KINDS)) {
  test(`signal family ${family} facts are deep-frozen when present`, async () => {
    await withPage(NEUTRAL_MARKUP, async (page) => {
      const session = await createScanSession(page);
      const bundle = collectSignalBundle({ snapshot: session.snapshot, session });
      const familyFacts = bundle.facts.filter((fact) => fact.family === family);
      for (const fact of familyFacts) {
        assertDeepFrozen(fact);
      }
    });
  });
}

test('rich fixture emits at least one fact for every signal family', async () => {
  await withPage(RICH_MARKUP, async (page) => {
    const session = await createScanSession(page);
    const bundle = collectSignalBundle({ snapshot: session.snapshot, session });
    for (const family of Object.values(SIGNAL_FAMILIES)) {
      const familyFacts = bundle.facts.filter((fact) => fact.family === family);
      assert.ok(familyFacts.length > 0, `${family} must emit facts on rich fixture`);
    }
  });
});

test('signal source including index.js avoids rule profile commercial and count vocabulary', () => {
  for (const file of walkJsFiles(SIGNALS_ROOT)) {
    const source = readFileSync(file, 'utf8');
    for (const token of SIGNAL_FORBIDDEN_TOKENS) {
      assert.doesNotMatch(
        source,
        new RegExp(token, 'i'),
        `${path.relative(__dirname, file)} must not contain "${token}"`,
      );
    }
  }
});

test('standards policy is independently callable never imports accessScan and returns nonempty findings', async () => {
  const standardsSource = readFileSync(path.join(POLICIES_ROOT, 'standards.js'), 'utf8');
  assert.doesNotMatch(standardsSource, /from\s+['"].*accessscan/i);
  assert.doesNotMatch(standardsSource, /applyAccessScanPolicy/);

  const standardsModule = await import(pathToFileURL(path.join(POLICIES_ROOT, 'standards.js')).href);
  assert.equal(typeof standardsModule.applyStandardsPolicy, 'function');

  await withPage(NEUTRAL_MARKUP, async (page) => {
    const session = await createScanSession(page);
    const context = { snapshot: session.snapshot, session };
    const bundle = collectSignalBundle(context);
    const labelFindings = applyStandardsPolicy(bundle, context, { mode: 'label-in-name' });
    assert.ok(labelFindings.length > 0, 'standards label-in-name policy must emit findings');
    assert.match(labelFindings[0].element.selector, /mismatch/);
  });
});

test('accessScan policy consumes facts and resolves elements by id', async () => {
  await withPage(NEUTRAL_MARKUP, async (page) => {
    const session = await createScanSession(page);
    const context = { snapshot: session.snapshot, session };
    const bundle = collectSignalBundle(context);

    const parity = applyAccessScanPolicy('credential-gate-region-main-mismatch', bundle, context);
    assert.equal(parity.status, 'complete');
    assert.ok(parity.findings.length > 0);
    assert.equal(parity.findings[0].element.selector.length > 0, true);

    const standards = applyStandardsPolicy(bundle, context, { mode: 'label-in-name' });
    assert.ok(standards.length > 0);
    for (const fact of bundle.facts) {
      const mapped = mapFactToStandardsFindings(fact, context, 'visibility-mismatch');
      assert.equal(Array.isArray(mapped), true);
    }
  });
});

test('projectFindings preserves native ruleId and canonicalizes alias in evidence', () => {
  const projected = projectFindings([
    {
      ruleId: 'TablistRole',
      violationType: VIOLATION_TYPES.COMMERCIAL_PARITY,
      severity: { impact: 'serious', priority: 3, wcagRef: 'WCAG 2.0 A 4.1.2' },
      element: { outerHTML: '<div></div>', selector: '#tabs', framePath: [], shadowPath: [] },
      recommendation: 'Review',
      evidence: { checkId: 'parity:tablist', profile: PROFILES.COMMERCIAL_PARITY },
    },
  ], { profile: PROFILES.COMMERCIAL_PARITY });

  assert.equal(projected[0].ruleId, 'TablistRole');
  assert.equal(projected[0].evidence.canonicalRuleId, canonicalizeRuleId('TablistRole'));
  assert.equal(projected[0].evidence.nativeRuleId, 'TablistRole');
});

test('projectFindings aggregates checkIds for same rule and element with precedence', () => {
  const findings = [
    {
      ruleId: 'RegionMainContentMisuse',
      violationType: VIOLATION_TYPES.POTENTIAL,
      severity: { impact: 'moderate', priority: 4, wcagRef: 'WCAG 2.0 A 1.3.1' },
      element: { outerHTML: '<main></main>', selector: 'main', framePath: [], shadowPath: [] },
      recommendation: 'Review',
      evidence: { checkId: 'standards:main', profile: PROFILES.COMMERCIAL_PARITY },
    },
    {
      ruleId: 'RegionMainContentMisuse',
      violationType: VIOLATION_TYPES.COMMERCIAL_PARITY,
      severity: { impact: 'moderate', priority: 4, wcagRef: 'WCAG 2.0 A 1.3.1' },
      element: { outerHTML: '<main></main>', selector: 'main', framePath: [], shadowPath: [] },
      recommendation: 'Review parity',
      evidence: { checkId: 'parity:main', profile: PROFILES.COMMERCIAL_PARITY },
    },
  ];

  const projected = projectFindings(findings, { profile: PROFILES.COMMERCIAL_PARITY });
  assert.equal(projected.length, 1);
  assert.equal(projected[0].ruleId, 'RegionMainContentMisuse');
  assert.equal(projected[0].violationType, VIOLATION_TYPES.COMMERCIAL_PARITY);
  assert.deepEqual(projected[0].evidence.checkIds.sort(), ['parity:main', 'standards:main'].sort());
});

test('projectFindings keeps distinct scoped elements separate', () => {
  const projected = projectFindings([
    {
      ruleId: 'RegionMainContentMisuse',
      violationType: VIOLATION_TYPES.COMMERCIAL_PARITY,
      severity: { impact: 'moderate', priority: 4, wcagRef: 'WCAG 2.0 A 1.3.1' },
      element: { outerHTML: '<main></main>', selector: 'main', framePath: ['f1'], shadowPath: [] },
      recommendation: 'Review',
      evidence: { checkId: 'parity:a', profile: PROFILES.COMMERCIAL_PARITY },
    },
    {
      ruleId: 'RegionMainContentMisuse',
      violationType: VIOLATION_TYPES.COMMERCIAL_PARITY,
      severity: { impact: 'moderate', priority: 4, wcagRef: 'WCAG 2.0 A 1.3.1' },
      element: { outerHTML: '<main></main>', selector: 'main', framePath: ['f2'], shadowPath: [] },
      recommendation: 'Review',
      evidence: { checkId: 'parity:b', profile: PROFILES.COMMERCIAL_PARITY },
    },
  ], { profile: PROFILES.COMMERCIAL_PARITY });
  assert.equal(projected.length, 2);
});

test('projectFindings integrates confirmed-over-parity precedence, aggregated checkIds, and scoped dedupe', () => {
  const projected = projectFindings([
    {
      ruleId: 'RegionMainContentMisuse',
      violationType: VIOLATION_TYPES.CONFIRMED,
      severity: { impact: 'moderate', priority: 4, wcagRef: 'WCAG 2.0 A 1.3.1' },
      element: { outerHTML: '<main></main>', selector: 'main', framePath: [], shadowPath: [] },
      recommendation: 'Fix',
      evidence: { checkId: 'standards:confirmed-main', profile: PROFILES.COMMERCIAL_PARITY },
    },
    {
      ruleId: 'RegionMainContentMisuse',
      violationType: VIOLATION_TYPES.COMMERCIAL_PARITY,
      severity: { impact: 'moderate', priority: 4, wcagRef: 'WCAG 2.0 A 1.3.1' },
      element: { outerHTML: '<main></main>', selector: 'main', framePath: [], shadowPath: [] },
      recommendation: 'Review parity',
      evidence: { checkId: 'parity:main', profile: PROFILES.COMMERCIAL_PARITY },
    },
    {
      ruleId: 'TablistRole',
      violationType: VIOLATION_TYPES.COMMERCIAL_PARITY,
      severity: { impact: 'serious', priority: 3, wcagRef: 'WCAG 2.0 A 4.1.2' },
      element: { outerHTML: '<div></div>', selector: '#tabs', framePath: ['f1'], shadowPath: [] },
      recommendation: 'Review',
      evidence: { checkId: 'parity:t1-frame', profile: PROFILES.COMMERCIAL_PARITY },
    },
    {
      ruleId: 'TablistRole',
      violationType: VIOLATION_TYPES.COMMERCIAL_PARITY,
      severity: { impact: 'serious', priority: 3, wcagRef: 'WCAG 2.0 A 4.1.2' },
      element: { outerHTML: '<div></div>', selector: '#tabs', framePath: ['f1'], shadowPath: ['s1'] },
      recommendation: 'Review',
      evidence: { checkId: 'parity:t1-shadow', profile: PROFILES.COMMERCIAL_PARITY },
    },
  ], { profile: PROFILES.COMMERCIAL_PARITY });

  assert.equal(projected.length, 3);

  const mainFinding = projected.find((finding) => finding.ruleId === 'RegionMainContentMisuse');
  assert.ok(mainFinding);
  assert.equal(mainFinding.violationType, VIOLATION_TYPES.CONFIRMED);
  assert.deepEqual(mainFinding.evidence.checkIds.sort(), ['parity:main', 'standards:confirmed-main'].sort());

  const tabFindings = projected.filter((finding) => finding.ruleId === 'TablistRole');
  assert.equal(tabFindings.length, 2);
  const shadowPaths = new Set(tabFindings.map((finding) => JSON.stringify(finding.element.shadowPath)));
  assert.equal(shadowPaths.size, 2);
  assert.ok(shadowPaths.has('[]'));
  assert.ok(shadowPaths.has('["s1"]'));
  assert.deepEqual(
    tabFindings.map((finding) => finding.evidence.checkIds?.[0] || finding.evidence.checkId).sort(),
    ['parity:t1-frame', 'parity:t1-shadow'],
  );
});

test('hidden standards findings cannot leak into commercial projection output', () => {
  const projected = projectFindings([
    {
      ruleId: 'LinkOpensNewWindow',
      violationType: VIOLATION_TYPES.CONFIRMED,
      severity: { impact: 'moderate', priority: 4, wcagRef: 'WCAG 2.0 AAA 3.2.5' },
      element: { outerHTML: '<a></a>', selector: '#leak', framePath: [], shadowPath: [] },
      recommendation: 'Fix',
      evidence: { checkId: 'standards:link', profile: PROFILES.STANDARDS },
    },
    {
      ruleId: 'RegionMainContentMismatch',
      violationType: VIOLATION_TYPES.COMMERCIAL_PARITY,
      severity: { impact: 'moderate', priority: 4, wcagRef: 'WCAG 2.0 A 1.3.1' },
      element: { outerHTML: '<main></main>', selector: 'main', framePath: [], shadowPath: [] },
      recommendation: 'Review',
      evidence: { checkId: 'parity:main', profile: PROFILES.COMMERCIAL_PARITY },
    },
  ], { profile: PROFILES.COMMERCIAL_PARITY });

  assert.equal(projected.some((finding) => finding.ruleId === 'LinkOpensNewWindow'), false);
  assert.equal(projected.some((finding) => finding.ruleId === 'RegionMainContentMismatch'), true);
});

test('commercial-parity evaluator delegates through facts-driven signal and policy layers', () => {
  const evaluatorSource = readFileSync(
    path.join(EVALUATOR_ROOT, 'commercial-parity.evaluator.js'),
    'utf8',
  );
  assert.match(evaluatorSource, /getCachedSignalBundle/);
  assert.match(evaluatorSource, /applyAccessScanPolicy/);
  assert.doesNotMatch(evaluatorSource, /function collectAriaHiddenVisible/);
  assert.doesNotMatch(evaluatorSource, /bundle\.patterns/);
});

test('label-in-name evaluator delegates through standards signal policy', () => {
  const source = readFileSync(path.join(EVALUATOR_ROOT, 'label-in-name.evaluator.js'), 'utf8');
  assert.match(source, /completeStandardsPolicy/);
  assert.match(source, /getCachedSignalBundle/);
});

test('runner execution records remain unchanged after facts-driven projection wiring', async () => {
  await withPage(
    `
      <section>
        <button aria-expanded="false" aria-controls="panel-a">Alpha</button>
        <button aria-expanded="true" aria-controls="panel-b">Beta</button>
        <div id="panel-a">Alpha panel</div>
        <div id="panel-b">Beta panel</div>
      </section>
    `,
    async (page) => {
      const session = await createScanSession(page);
      const registry = await loadBuiltInRuleRegistry({ enforceCatalogContract: true });
      const { executionRecords } = await runRules({
        registry,
        profile: PROFILES.COMMERCIAL_PARITY,
        context: { snapshot: session.snapshot, session },
        skipRules: registry.getActiveRuleIds().filter((id) => !['TablistRole', 'TabMismatch'].includes(id)),
      });

      const tablistRecord = executionRecords.find((record) => record.ruleId === 'TablistRole');
      const tabRecord = executionRecords.find((record) => record.ruleId === 'TabMismatch');
      const tablistParity = tablistRecord?.checks.find((check) => check.checkId === 'parity:disclosure-tablist-role');
      const tabParity = tabRecord?.checks.find((check) => check.checkId === 'parity:disclosure-tab-mismatch');

      assert.ok(tablistParity);
      assert.ok(tabParity);
      assert.equal(tablistParity.candidateCount, 2);
      assert.equal(tablistParity.findingCount, 1);
      assert.equal(tabParity.findingCount, 2);
    },
  );
});

test('neutral credential gate parity characterization remains stable through facts-driven split', async () => {
  await withPage(NEUTRAL_MARKUP, async (page) => {
    const session = await createScanSession(page);
    const registry = await loadBuiltInRuleRegistry({ enforceCatalogContract: true });
    const parityRuleIds = [
      'RegionMainContentMismatch',
      'RegionMainContentMisuse',
      'VisibilityMisuse',
      'PageTitleDescriptive',
    ];
    const result = await runRules({
      registry,
      profile: PROFILES.COMMERCIAL_PARITY,
      context: { snapshot: session.snapshot, session },
      skipRules: registry.getActiveRuleIds().filter((id) => !parityRuleIds.includes(id)),
    });

    const parity = result.findings.filter((finding) => finding.violationType === VIOLATION_TYPES.COMMERCIAL_PARITY);
    assert.equal(parity.length, 4);
    assert.deepEqual([...new Set(parity.map((finding) => finding.ruleId))].sort(), parityRuleIds.sort());
  });
});

test('eight-site corpus replay exact gate passes via verifyCorpus', async () => {
  const result = await verifyCorpus(CORPUS_ROOT);
  assert.equal(result.ok, true, result.errors?.join('; '));
  const siteCases = result.cases.filter((entry) => entry.id.startsWith('site-'));
  assert.equal(siteCases.length, 8);
  for (const caseResult of siteCases) {
    assert.equal(caseResult.ok, true, `${caseResult.id}: ${JSON.stringify(caseResult.diff)}`);
    assert.equal(caseResult.diff?.equivalent, true);
  }
});

test('dedupeFindings export remains available for direct precedence unit tests', () => {
  const merged = dedupeFindings([
    {
      ruleId: 'RegionMainContentMisuse',
      violationType: VIOLATION_TYPES.CONFIRMED,
      severity: { impact: 'moderate', priority: 4, wcagRef: 'WCAG 2.0 A 1.3.1' },
      element: { outerHTML: '<main></main>', selector: 'main', framePath: [], shadowPath: [] },
      recommendation: 'Fix',
      evidence: { checkId: 'standards:main', profile: PROFILES.STANDARDS },
    },
    {
      ruleId: 'RegionMainContentMisuse',
      violationType: VIOLATION_TYPES.COMMERCIAL_PARITY,
      severity: { impact: 'moderate', priority: 4, wcagRef: 'WCAG 2.0 A 1.3.1' },
      element: { outerHTML: '<main></main>', selector: 'main', framePath: [], shadowPath: [] },
      recommendation: 'Review',
      evidence: { checkId: 'parity:main', profile: PROFILES.COMMERCIAL_PARITY },
    },
  ]);
  assert.equal(merged[0].violationType, VIOLATION_TYPES.CONFIRMED);
});
