import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

import {
  compareCorpusFindings,
  DELTA_CATEGORIES,
  classifyCorpusDeltaEntry,
  classifyCorpusDiff,
  computeCommercialParityMetrics,
  meetsCommercialParityThreshold,
  serializeClassifiedCorpusDiff,
} from '../src/scanner/access-scan/corpus/index.js';
import { normalizeCorpusRuleId } from '../src/reporter/rule-aliases.js';
import { PROFILES } from '../src/scanner/access-scan/engine/profiles.js';
import { loadBuiltInRuleRegistry } from '../src/scanner/access-scan/engine/builtin-registry.js';
import { runRules } from '../src/scanner/access-scan/engine/runner.js';
import { createScanSession } from '../src/scanner/access-scan/runtime/index.js';
import { evaluateCorpusDifferentials } from '../scripts/accessscan-corpus/lib/differential.js';
import { verifyCorpus } from '../scripts/accessscan-corpus/index.js';
import { runCorpusVerifyCli } from '../scripts/accessscan-corpus/verify.js';
import { installCorpusToolingTestResetHooks } from './helpers/accessscan-corpus-test-reset.js';

installCorpusToolingTestResetHooks();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CORPUS_ROOT = path.join(__dirname, 'fixtures/accessscan-corpus');

const STANDARDS_ONLY_RULE_IDS = [
  'LinkOpensNewWindow',
  'LinkImageWarning',
  'MetaDescription',
  'TargetSize',
  'LinkCurrentPage',
  'FormSubmitButtonMismatch',
  'FormContextChangeWarning',
  'TablistRole',
  'TableCaption',
];

function finding({
  ruleId = 'ListEmpty',
  checkId = 'lists:list-empty',
  structuralPattern = null,
  semantic = {},
  framePath = [],
  shadowPath = [],
} = {}) {
  return {
    ruleId,
    canonicalRuleId: ruleId,
    evidence: {
      ...(checkId ? { checkId } : {}),
      ...(structuralPattern ? { structuralPattern } : {}),
    },
    element: {
      semantic: {
        tag: 'ul',
        role: null,
        attributes: {},
        landmarkPath: ['main'],
        framePath,
        shadowPath,
        ...semantic,
      },
    },
  };
}

function entryFromFinding(findingValue, fingerprint = 'fp-test') {
  return {
    key: `${normalizeCorpusRuleId(findingValue.ruleId)}|${fingerprint}`,
    fingerprint,
    ruleId: normalizeCorpusRuleId(findingValue.ruleId),
    finding: findingValue,
  };
}

async function withPage(markup, run, options = {}) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  page.on('console', () => {});
  page.on('pageerror', () => {});
  try {
    if (options.url) {
      await page.goto(options.url, { waitUntil: 'domcontentloaded' });
    }
    if (markup) {
      await page.setContent(markup, { waitUntil: 'domcontentloaded' });
    }
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

async function runParityRules(page, ruleIds = null) {
  const session = await createScanSession(page);
  const registry = await loadBuiltInRuleRegistry({ enforceCatalogContract: true });
  const skipRules = ruleIds
    ? registry.getActiveRuleIds().filter((id) => !ruleIds.includes(id))
    : registry.getActiveRuleIds().filter((id) => ![
      'RegionMainContentMismatch',
      'RegionMainContentMisuse',
      'VisibilityMisuse',
      'PageTitleDescriptive',
    ].includes(id));
  const result = await runRules({
    registry,
    profile: PROFILES.COMMERCIAL_PARITY,
    context: { snapshot: session.snapshot, session },
    skipRules,
  });
  return { session, registry, result };
}

test('delta categories are stable and machine-readable', () => {
  assert.deepEqual(DELTA_CATEGORIES, [
    'signal_extraction',
    'policy_mapping',
    'aliasing',
    'runtime_state',
    'oracle_drift',
  ]);
});

test('classifyCorpusDeltaEntry maps alias and runtime deltas deterministically', () => {
  const aliasMissing = classifyCorpusDeltaEntry(
    'missing',
    entryFromFinding(finding({ ruleId: 'ListNotEmpty' }), 'fp-alias'),
    entryFromFinding(finding({ ruleId: 'ListEmpty' }), 'fp-alias'),
  );
  assert.equal(aliasMissing.category, 'aliasing');

  const runtimeChanged = classifyCorpusDeltaEntry(
    'changed',
    entryFromFinding(finding({ semantic: { landmarkPath: ['main'], ordinal: 0, framePath: [0] } }), 'fp-a'),
    entryFromFinding(finding({ semantic: { landmarkPath: ['main'], ordinal: 0, framePath: [1] } }), 'fp-b'),
  );
  assert.equal(runtimeChanged.category, 'runtime_state');
  assert.equal(runtimeChanged.reason, 'frame_or_shadow_scope_delta');

  const policyChanged = classifyCorpusDeltaEntry(
    'changed',
    entryFromFinding(finding({
      checkId: 'parity:disclosure-tablist-role',
      structuralPattern: 'aria-expanded-disclosure-group',
      semantic: { tag: 'section', landmarkPath: ['main'], ordinal: 0 },
    }), 'fp-policy-a'),
    entryFromFinding(finding({
      checkId: 'parity:disclosure-tablist-role',
      structuralPattern: 'aria-expanded-disclosure-trigger',
      semantic: { tag: 'section', landmarkPath: ['main'], ordinal: 0 },
    }), 'fp-policy-b'),
  );
  assert.equal(policyChanged.category, 'policy_mapping');
  assert.equal(policyChanged.reason, 'policy_projection_delta');

  const aliasSemanticDrift = classifyCorpusDeltaEntry(
    'changed',
    entryFromFinding(finding({ ruleId: 'ListNotEmpty', semantic: { landmarkPath: ['main'], ordinal: 0 } }), 'fp-expected'),
    entryFromFinding(finding({ ruleId: 'ListEmpty', semantic: { landmarkPath: ['footer'], ordinal: 0 } }), 'fp-actual'),
  );
  assert.equal(aliasSemanticDrift.category, 'signal_extraction');
  assert.equal(aliasSemanticDrift.reason, 'semantic_identity_delta');
  assert.equal(aliasSemanticDrift.expectedFingerprint, 'fp-expected');
  assert.equal(aliasSemanticDrift.actualFingerprint, 'fp-actual');
  assert.notEqual(aliasSemanticDrift.expectedFingerprint, aliasSemanticDrift.actualFingerprint);
});

test('missing and extra defaults classify as signal_extraction without unsupported guesses', () => {
  const missingDefault = classifyCorpusDeltaEntry(
    'missing',
    entryFromFinding(finding({ ruleId: 'IconDiscernible' }), 'fp-missing'),
  );
  const extraDefault = classifyCorpusDeltaEntry(
    'extra',
    entryFromFinding(finding({ ruleId: 'ImageMisuse' }), 'fp-extra'),
  );

  assert.equal(missingDefault.category, 'signal_extraction');
  assert.equal(missingDefault.reason, 'expected_finding_not_emitted');
  assert.equal(extraDefault.category, 'signal_extraction');
  assert.equal(extraDefault.reason, 'unexpected_finding_emitted');
});

test('serializeClassifiedCorpusDiff preserves defined empty-string fingerprints', () => {
  const classified = classifyCorpusDiff({
    equivalent: false,
    missing: [entryFromFinding(finding(), '')],
    extra: [],
    changed: [],
  });
  const serialized = serializeClassifiedCorpusDiff(classified);
  assert.equal(serialized.deltas[0].fingerprint, '');
  assert.equal('expectedFingerprint' in serialized.deltas[0], true);
});

test('classifyCorpusDiff serializes without case or host identifiers', () => {
  const diff = compareCorpusFindings(
    [finding({ semantic: { landmarkPath: ['main'], ordinal: 0 } })],
    [finding({ semantic: { landmarkPath: ['footer'], ordinal: 0 } })],
  );
  const classified = classifyCorpusDiff(diff);
  const serialized = serializeClassifiedCorpusDiff(classified);
  const payload = JSON.stringify(serialized);

  assert.equal(serialized.equivalent, false);
  assert.equal(payload.includes('site-'), false);
  assert.equal(payload.includes('https://'), false);
  assert.equal(payload.includes('paradox'), false);
  assert.ok(serialized.deltas.length > 0);
  for (const delta of serialized.deltas) {
    assert.ok(DELTA_CATEGORIES.includes(delta.category));
  }
});

test('computeCommercialParityMetrics uses semantic identity not counts only', () => {
  const expected = [
    finding({ semantic: { landmarkPath: ['main'], ordinal: 0 } }),
    finding({
      ruleId: 'TablistRole',
      checkId: 'parity:disclosure-tablist-role',
      semantic: { tag: 'section', landmarkPath: ['main'], ordinal: 0 },
    }),
  ];
  const actual = [
    finding({ semantic: { landmarkPath: ['footer'], ordinal: 0 } }),
    finding({
      ruleId: 'TablistRole',
      checkId: 'parity:disclosure-tab-mismatch',
      semantic: { tag: 'button', landmarkPath: ['main'], ordinal: 0 },
    }),
  ];

  const diff = compareCorpusFindings(expected, actual);
  const metrics = computeCommercialParityMetrics(diff, {
    expectedCount: expected.length,
    actualCount: actual.length,
  });

  assert.equal(metrics.truePositives, 0);
  assert.equal(metrics.falseNegatives, 2);
  assert.equal(metrics.falsePositives, 2);
  assert.equal(metrics.precision, 0);
  assert.equal(metrics.recall, 0);
  assert.equal(meetsCommercialParityThreshold(metrics), false);
});

test('changed-only diff yields zero true positives and fails strict threshold', () => {
  const expected = [finding({ semantic: { landmarkPath: ['main'], ordinal: 0 } })];
  const actual = [finding({ semantic: { landmarkPath: ['main'], ordinal: 1 } })];
  const diff = compareCorpusFindings(expected, actual);

  assert.equal(diff.changed.length, 1);
  assert.equal(diff.missing.length, 0);
  assert.equal(diff.extra.length, 0);

  const metrics = computeCommercialParityMetrics(diff, {
    expectedCount: expected.length,
    actualCount: actual.length,
  });
  assert.equal(metrics.truePositives, 0);
  assert.equal(metrics.falseNegatives, 1);
  assert.equal(metrics.falsePositives, 1);
  assert.equal(metrics.precision, 0);
  assert.equal(metrics.recall, 0);
  assert.equal(meetsCommercialParityThreshold(metrics, { precision: 1, recall: 1 }), false);
});

test('perfect-match metrics meet strict 1.0 threshold boundary', () => {
  const expected = [finding({ semantic: { landmarkPath: ['main'], ordinal: 0 } })];
  const diff = compareCorpusFindings(expected, [...expected]);
  const metrics = computeCommercialParityMetrics(diff, {
    expectedCount: expected.length,
    actualCount: expected.length,
  });

  assert.equal(metrics.truePositives, 1);
  assert.equal(metrics.falsePositives, 0);
  assert.equal(metrics.falseNegatives, 0);
  assert.equal(metrics.precision, 1);
  assert.equal(metrics.recall, 1);
  assert.equal(meetsCommercialParityThreshold(metrics, { precision: 1, recall: 1 }), true);
});

test('compareCorpusFindings pairs changed entries by semantic-best-match within rule', () => {
  const expected = [
    finding({ checkId: 'lists:exp-a', semantic: { landmarkPath: ['main'], ordinal: 0 } }),
    finding({ checkId: 'lists:exp-b', semantic: { landmarkPath: ['main'], ordinal: 1 } }),
  ];
  const actual = [
    finding({ checkId: 'lists:act-b', semantic: { landmarkPath: ['main'], ordinal: 1 } }),
    finding({ checkId: 'lists:act-a', semantic: { landmarkPath: ['footer'], ordinal: 0 } }),
  ];

  const diff = compareCorpusFindings(expected, actual);
  assert.equal(diff.changed.length, 2);
  assert.equal(diff.missing.length, 0);
  assert.equal(diff.extra.length, 0);

  const exactMatch = diff.changed.find((pair) => (
    pair.expected.finding.evidence.checkId === 'lists:exp-b'
    && pair.actual.finding.evidence.checkId === 'lists:act-b'
    && pair.expected.finding.element.semantic.ordinal === 1
    && pair.actual.finding.element.semantic.ordinal === 1
  ));
  assert.ok(exactMatch, 'ordinal 1 replacement must pair by semantic affinity, not index order');

  const driftMatch = diff.changed.find((pair) => (
    pair.expected.finding.evidence.checkId === 'lists:exp-a'
    && pair.actual.finding.evidence.checkId === 'lists:act-a'
  ));
  assert.ok(driftMatch, 'remaining replacement must pair lower-affinity drift deterministically');
});

test('verifyCorpus fails closed when injected scan returns parity drift', async () => {
  const result = await verifyCorpus(CORPUS_ROOT, {
    scanCase: async () => [],
  });

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => /commercial parity metrics below required threshold|not equivalent/i.test(error)));
  const drifted = result.cases.find((caseResult) => caseResult.id === 'neutral-empty-list');
  assert.ok(drifted);
  assert.equal(drifted.ok, false);
  assert.equal(drifted.diff.metrics.precision < 1 || drifted.diff.metrics.recall < 1, true);
});

test('corpus verify CLI exits nonzero when parity threshold is not met', async () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'corpus-verify-fail-'));
  const caseDir = path.join(tempRoot, 'cases/parity-fail');
  mkdirSync(caseDir, { recursive: true });
  writeFileSync(path.join(tempRoot, 'manifest.json'), JSON.stringify({
    schemaVersion: '1.0.0',
    cases: [{ id: 'parity-fail', path: 'cases/parity-fail' }],
  }));
  writeFileSync(path.join(caseDir, 'meta.json'), JSON.stringify({
    schemaVersion: '1.0.0',
    id: 'parity-fail',
    profile: 'commercial-parity',
    route: '/',
    captureState: 'initial',
    viewport: { width: 1280, height: 900 },
    notes: ['temp fixture for verify CLI parity failure'],
  }));
  writeFileSync(path.join(caseDir, 'page.html'), '<html><body><main></main></body></html>');
  writeFileSync(path.join(caseDir, 'snapshot.json'), JSON.stringify({
    schemaVersion: '1.0.0',
    elements: [{
      id: 1,
      parentId: null,
      tag: 'main',
      attributes: {},
      text: '',
      visibleText: '',
      selector: 'main',
      reportSelector: 'main',
      framePath: [],
      shadowPath: [],
      outerHTML: '<main></main>',
      rect: { x: 0, y: 0, width: 100, height: 20 },
      computedStyle: { display: 'block', visibility: 'visible', position: 'static', pointerEvents: 'auto' },
      accessibleName: '',
      effectiveOpacity: 1,
      rendered: true,
      visuallyVisible: true,
      hiddenFromAT: false,
      focusable: false,
    }],
    diagnostics: [],
    counts: { frameCount: 0, shadowRootCount: 0, closedShadowCount: 0 },
  }));
  writeFileSync(path.join(caseDir, 'expected.json'), JSON.stringify({
    schemaVersion: '1.0.0',
    profile: 'commercial-parity',
    findings: [{
      ruleId: 'ListEmpty',
      canonicalRuleId: 'ListEmpty',
      violationType: 'commercial-parity',
      evidence: { checkId: 'lists:list-empty' },
      element: {
        semantic: {
          tag: 'ul',
          role: null,
          attributes: {},
          landmarkPath: ['main'],
          ordinal: 0,
          framePath: [],
          shadowPath: [],
        },
      },
    }],
  }));

  const exitCode = await runCorpusVerifyCli(['--root', tempRoot]);
  assert.equal(exitCode, 1);
});

test('evaluateCorpusDifferentials replays every frozen case with precision and recall 1.0', async () => {
  const result = await evaluateCorpusDifferentials(CORPUS_ROOT);
  assert.equal(result.ok, true, JSON.stringify(result.cases.filter((entry) => !entry.ok)));
  assert.equal(result.caseCount, 9);
  assert.equal(result.aggregate.precision, 1);
  assert.equal(result.aggregate.recall, 1);
  assert.equal(result.aggregate.falsePositives, 0);
  assert.equal(result.aggregate.falseNegatives, 0);

  const siteCases = result.cases.filter((entry) => entry.id.startsWith('site-'));
  assert.equal(siteCases.length, 8);
  for (const caseResult of result.cases) {
    assert.equal(caseResult.ok, true, `${caseResult.id}: ${JSON.stringify(caseResult.diff)}`);
    assert.equal(caseResult.metrics.precision, 1, caseResult.id);
    assert.equal(caseResult.metrics.recall, 1, caseResult.id);
    assert.equal(
      meetsCommercialParityThreshold({
        ...caseResult.metrics,
        precision: caseResult.metrics.precision,
        recall: caseResult.metrics.recall,
      }, { precision: 1, recall: 1 }),
      true,
      caseResult.id,
    );
    assert.equal(caseResult.classification.equivalent, true, caseResult.id);
    assert.deepEqual(caseResult.classification.counts, {
      signal_extraction: 0,
      policy_mapping: 0,
      aliasing: 0,
      runtime_state: 0,
      oracle_drift: 0,
    });
  }
  assert.equal(result.aggregate?.meetsThreshold, true);
});

test('evaluateCorpusDifferentials schemaOnly validates without misleading replay metrics', async () => {
  const result = await evaluateCorpusDifferentials(CORPUS_ROOT, { schemaOnly: true });
  assert.equal(result.ok, true);
  assert.equal(result.aggregate, null);
  for (const caseResult of result.cases) {
    assert.equal(caseResult.schemaOk, true);
    assert.equal(caseResult.replaySkipped, true);
    assert.equal(caseResult.diff, null);
    assert.equal(caseResult.metrics, null);
    assert.equal(caseResult.classification, null);
  }
});

test('evaluateCorpusDifferentials isolates scan errors and continues deterministically', async () => {
  const result = await evaluateCorpusDifferentials(CORPUS_ROOT, {
    scanCase: async (context) => {
      if (context.meta.id === 'neutral-empty-list') {
        throw new Error('injected replay failure');
      }
      const { defaultReplayScanCase } = await import('../scripts/accessscan-corpus/lib/replay.js');
      return defaultReplayScanCase(context);
    },
  });

  assert.equal(result.ok, false);
  const failed = result.cases.find((caseResult) => caseResult.id === 'neutral-empty-list');
  const passed = result.cases.find((caseResult) => caseResult.id === 'site-124');
  assert.equal(failed?.ok, false);
  assert.deepEqual(failed?.errors, ['scan_failure']);
  assert.equal(failed?.diff, null);
  assert.equal(passed?.ok, true);
  assert.ok(passed?.metrics);
});

test('evaluateCorpusDifferentials fails closed when page.html is missing for replay', async () => {
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'corpus-missing-page-'));
  const caseDir = path.join(tempRoot, 'cases/missing-page');
  mkdirSync(caseDir, { recursive: true });
  writeFileSync(path.join(tempRoot, 'manifest.json'), JSON.stringify({
    schemaVersion: '1.0.0',
    cases: [{ id: 'missing-page', path: 'cases/missing-page' }],
  }));
  writeFileSync(path.join(caseDir, 'meta.json'), JSON.stringify({
    schemaVersion: '1.0.0',
    id: 'missing-page',
    profile: 'standards',
    route: '/',
    captureState: 'initial',
    viewport: { width: 1280, height: 900 },
    notes: ['temp fixture without page.html'],
  }));
  writeFileSync(path.join(caseDir, 'snapshot.json'), JSON.stringify({
    schemaVersion: '1.0.0',
    elements: [{
      tag: 'ul',
      attributes: {},
      outerHTML: '<ul></ul>',
      selector: 'ul',
      reportSelector: 'ul',
      framePath: [],
      shadowPath: [],
      rect: { x: 0, y: 0, width: 100, height: 20 },
      computedStyle: { display: 'block', visibility: 'visible', position: 'static', pointerEvents: 'auto' },
    }],
    diagnostics: [],
    counts: { frameCount: 0, shadowRootCount: 0, closedShadowCount: 0 },
  }));
  writeFileSync(path.join(caseDir, 'expected.json'), JSON.stringify({
    schemaVersion: '1.0.0',
    profile: 'standards',
    findings: [],
  }));

  const result = await evaluateCorpusDifferentials(tempRoot);
  const broken = result.cases.find((caseResult) => caseResult.id === 'missing-page');
  assert.equal(broken?.ok, false);
  assert.deepEqual(broken?.errors, ['replay_requires_page_html']);
  assert.equal(broken?.metrics, null);
  assert.equal(broken?.diff, null);
});

// Frozen corpus replay was already exact at Task-6 baseline; inline neutral characterization
// fixtures below guard shared primitives without inventing a historical failing corpus delta.
test('frozen corpus aggregate finding inventory remains stable', () => {
  const manifest = JSON.parse(readFileSync(path.join(CORPUS_ROOT, 'manifest.json'), 'utf8'));
  /** @type {Record<string, number>} */
  const inventory = {};
  let total = 0;

  for (const entry of manifest.cases) {
    const expected = JSON.parse(readFileSync(path.join(CORPUS_ROOT, entry.path, 'expected.json'), 'utf8'));
    const findings = Array.isArray(expected.findings) ? expected.findings : [];
    inventory[entry.id] = findings.length;
    total += findings.length;
  }

  assert.equal(total, 59);
  assert.deepEqual(inventory, {
    'neutral-empty-list': 1,
    'site-124': 5,
    'site-203': 14,
    'site-375': 19,
    'site-538': 10,
    'site-695': 2,
    'site-710': 1,
    'site-728': 4,
    'site-731': 3,
  });
});

test('characterization gate: image taxonomy precedence favors ImageMisuse over IconDiscernible', async () => {
  await withPage(
    `
      <svg width="0" height="0" aria-hidden="true">
        <symbol id="generic-shape" viewBox="0 0 20 20"><path d="M0 0h20v20z"></path></symbol>
      </svg>
      <a href="#action">
        <svg id="unlabelled-action-symbol" width="30" height="30">
          <use href="#generic-shape"></use>
        </svg>
      </a>
      <div>
        <svg id="unlabelled-standalone-symbol" width="30" height="30">
          <use href="#generic-shape"></use>
        </svg>
      </div>
      <svg id="named-symbol-a" role="img" aria-label="Benefit one" width="30" height="30">
        <use href="#generic-shape"></use>
      </svg>
      <svg id="named-symbol-b" role="img" aria-label="Benefit two" width="30" height="30">
        <use href="#generic-shape"></use>
      </svg>
    `,
    async (page) => {
      const { result } = await runParityRules(page, ['IconDiscernible', 'ImageMisuse']);
      const icons = result.findings.filter((finding) => finding.ruleId === 'IconDiscernible');
      const images = result.findings.filter((finding) => finding.ruleId === 'ImageMisuse');

      assert.equal(icons.length, 2);
      assert.equal(images.length, 2);
      assert.ok(images.every((finding) => /named-symbol-/.test(finding.element.outerHTML)));
      assert.ok(icons.some((finding) => /unlabelled-action-symbol/.test(finding.element.outerHTML)));
      assert.ok(icons.some((finding) => /unlabelled-standalone-symbol/.test(finding.element.outerHTML)));
      assert.ok(!icons.some((finding) => /named-symbol-/.test(finding.element.outerHTML)));
    },
  );
});

test('characterization gate: visibility ownership keeps iframe body misuse top-level', async () => {
  await withPage(
    `
      <div style="position: relative; width: 200px; height: 100px; overflow: hidden">
        <div id="substantially-clipped" style="position: absolute; left: 320px; width: 100px; height: 80px">Far</div>
      </div>
      <div id="empty-placeholder-a" style="width: 100px"><span></span></div>
      <svg id="sprite-root" width="0" height="0"><symbol id="sprite-symbol"></symbol></svg>
      <iframe title="empty-frame" style="width: 0; height: 0" srcdoc="<body></body>"></iframe>
    `,
    async (page) => {
      const { result } = await runParityRules(page, ['VisibilityMismatch', 'VisibilityMisuse']);
      const misuse = result.findings.filter((finding) => finding.ruleId === 'VisibilityMisuse');

      assert.ok(misuse.some((finding) => /substantially-clipped/.test(finding.element.outerHTML)));
      assert.ok(misuse.some((finding) => /sprite-root/.test(finding.element.outerHTML)));
      assert.ok(misuse.some((finding) => (
        finding.element.framePath.length === 0 && /^<body/.test(finding.element.outerHTML)
      )));
      assert.ok(!misuse.some((finding) => (
        finding.element.framePath.length > 0 && /body/.test(finding.element.outerHTML)
      )));
    },
  );
});

test('characterization gate: target-size remains standards-only outside commercial corpus', async () => {
  const registry = await loadBuiltInRuleRegistry({ enforceCatalogContract: true });
  const commercialChecks = registry.getChecksForProfile(PROFILES.COMMERCIAL_PARITY);
  assert.equal(
    commercialChecks.some(({ check }) => check.id === 'interactive:target-size'),
    false,
  );

  await withPage(
    `
      <div style="display:flex;gap:2px">
        <button id="tiny-a" style="width:18px;height:18px;padding:0">a</button>
        <button id="tiny-b" style="width:18px;height:18px;padding:0">b</button>
      </div>
    `,
    async (page) => {
      const session = await createScanSession(page);
      const standards = await runRules({
        registry,
        profile: PROFILES.STANDARDS,
        context: { snapshot: session.snapshot, session },
        skipRules: registry.getActiveRuleIds().filter((id) => id !== 'TargetSize'),
      });
      const commercial = await runParityRules(page, ['TargetSize']);
      assert.ok(standards.findings.some((finding) => finding.ruleId === 'TargetSize'));
      assert.equal(commercial.result.findings.some((finding) => finding.ruleId === 'TargetSize'), false);
    },
  );
});

test('characterization gate: accessible-name context maps checkbox label/value mismatch', async () => {
  await withPage(
    `
      <label id="filter-label" for="filter-box">Show remote only</label>
      <input id="filter-box" type="checkbox" aria-labelledby="filter-label" value="on">
    `,
    async (page) => {
      const { result } = await runParityRules(page, ['VisibleTextPartOfAccessibleName']);
      const findings = result.findings.filter((finding) => finding.ruleId === 'VisibleTextPartOfAccessibleName');
      assert.equal(findings.length, 1);
      assert.match(findings[0].element.outerHTML, /filter-box/);
    },
  );
});

test('characterization gate: third-party frame handling preserves non-empty framePath', async () => {
  await withPage(
    `
      <iframe id="child-frame" srcdoc="
        <html lang='en'><head><title>Gate</title></head><body>
          <div class='shell'>
            <header>Banner</header>
            <main>
              <h1>Gate</h1>
              <form>
                <input type='password'>
                <button type='submit'>Go</button>
              </form>
            </main>
          </div>
        </body></html>
      "></iframe>
    `,
    async (page) => {
      const { result } = await runParityRules(page);
      const parity = result.findings.filter((finding) => finding.violationType === 'commercial-parity');
      assert.ok(parity.length >= 1);
      assert.ok(parity.some((finding) => finding.element.framePath.length > 0));
    },
  );
});

test('characterization gate: commercial projection suppresses standards-only findings', async () => {
  await withPage(
    `
      <html lang="en">
        <head><title>Neutral characterization</title></head>
        <body>
          <ul id="legacy-empty"></ul>
          <nav><a href="/jobs" target="_blank">Jobs</a></nav>
          <button style="width: 20px; height: 20px; padding: 0" aria-label="Tiny">Go</button>
        </body>
      </html>
    `,
    async (page) => {
      const { result } = await runParityRules(page, [
        'ListEmpty',
        'LinkOpensNewWindow',
        'TargetSize',
        'MetaDescription',
      ]);
      const leaked = result.findings.filter((finding) => STANDARDS_ONLY_RULE_IDS.includes(finding.ruleId));
      assert.deepEqual(leaked.map((finding) => finding.ruleId).sort(), []);
      assert.ok(result.findings.some((finding) => finding.ruleId === 'ListEmpty'));
    },
  );
});
