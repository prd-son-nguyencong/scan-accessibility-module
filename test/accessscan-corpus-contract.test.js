import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CORPUS_ACCEPTANCE_RULE_ID_CONVENTION,
  CORPUS_COMPARATOR_VERSION,
  CORPUS_SCHEMA_VERSION,
} from '../src/scanner/access-scan/corpus/constants.js';
import {
  validateCorpusCase,
  validateCorpusManifest,
} from '../src/scanner/access-scan/corpus/schema.js';
import {
  findCommittedAttributeViolations,
  findSnapshotAttributeViolations,
} from '../src/scanner/access-scan/corpus/attribute-allowlist.js';
import {
  buildCorpusMultiset,
  compareCorpusFindings,
  corpusFindingsEquivalent,
} from '../src/scanner/access-scan/corpus/diff.js';
import { classifyCorpusDiff } from '../src/scanner/access-scan/corpus/delta-classification.js';
import {
  AmbiguousSemanticFindingError,
  extractSemanticDescriptor,
  hasSemanticDisambiguator,
  isAmbiguousSemanticFinding,
  semanticElementFingerprint,
  semanticFindingsEquivalent,
} from '../src/scanner/access-scan/corpus/semantic-fingerprint.js';
import { containsHostLeakage } from '../src/scanner/access-scan/corpus/sanitization.js';
import {
  canonicalizeRuleId,
  isKnownExternalCommercialRuleId,
  normalizeCorpusRuleId,
  resolveCommercialRuleId,
  resolveNativeRuleId,
} from '../src/reporter/rule-aliases.js';
import { isGeneratedIdRef } from '../src/scanner/access-scan/corpus/semantic-fingerprint.js';
import { installCorpusToolingTestResetHooks } from './helpers/accessscan-corpus-test-reset.js';

installCorpusToolingTestResetHooks();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CORPUS_ROOT = path.join(__dirname, 'fixtures/accessscan-corpus');

function loadJson(relativePath) {
  return JSON.parse(readFileSync(path.join(CORPUS_ROOT, relativePath), 'utf8'));
}

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
    canonicalRuleId: canonicalizeRuleId(ruleId),
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

test('corpus manifest and neutral fixture validate against schema', () => {
  const manifest = loadJson('manifest.json');
  const validation = validateCorpusManifest(manifest, { rootDir: CORPUS_ROOT });
  assert.equal(validation.ok, true, validation.errors?.join('; '));
  assert.equal(manifest.schemaVersion, CORPUS_SCHEMA_VERSION);

  const caseDir = path.join(CORPUS_ROOT, 'cases/neutral-empty-list');
  const caseValidation = validateCorpusCase(caseDir);
  assert.equal(caseValidation.ok, true, caseValidation.errors?.join('; '));
});

test('corpus acceptance rule id convention is documented and distinct from reporter canonicalization', () => {
  assert.equal(CORPUS_ACCEPTANCE_RULE_ID_CONVENTION.acceptanceNormalizer, 'normalizeCorpusRuleId');
  assert.equal(CORPUS_ACCEPTANCE_RULE_ID_CONVENTION.reporterNormalizer, 'canonicalizeRuleId');
  assert.equal(normalizeCorpusRuleId('TablistRole'), 'TabListMisMatch');
  assert.equal(canonicalizeRuleId('TablistRole'), 'TabListMisMatch');
  assert.equal(normalizeCorpusRuleId('ListNotEmpty'), normalizeCorpusRuleId('ListEmpty'));
});

test('corpus comparator version is a stable exported contract constant', () => {
  assert.equal(CORPUS_COMPARATOR_VERSION, '1.0.0');
  assert.match(CORPUS_COMPARATOR_VERSION, /^\d+\.\d+\.\d+$/);
});

test('corpus schema validation fails closed on missing required files', () => {
  const result = validateCorpusCase(path.join(CORPUS_ROOT, 'cases/missing-contract'));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => /meta\.json|required file|does not exist/i.test(error)));
});

test('corpus schema validation rejects forbidden production tokens in committed fixtures', () => {
  const result = validateCorpusCase(path.join(CORPUS_ROOT, 'cases/token-leak'));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => /forbidden token/i.test(error)));
});

test('corpus schema validation rejects host leakage in snapshot and expected semantic fields', () => {
  const snapshotHost = validateCorpusCase(path.join(CORPUS_ROOT, 'cases/snapshot-host-leak'));
  assert.equal(snapshotHost.ok, false);
  assert.ok(snapshotHost.errors.some((error) => /host or URL leakage/i.test(error)));

  const bareHost = validateCorpusCase(path.join(CORPUS_ROOT, 'cases/snapshot-bare-host'));
  assert.equal(bareHost.ok, false);
  assert.ok(bareHost.errors.some((error) => /host or URL leakage/i.test(error)));

  const expectedHost = validateCorpusCase(path.join(CORPUS_ROOT, 'cases/expected-host-leak'));
  assert.equal(expectedHost.ok, false);
  assert.ok(expectedHost.errors.some((error) => /host or URL leakage/i.test(error)));
});

test('host leakage detection covers protocol-relative and bare host forms', () => {
  assert.equal(containsHostLeakage('https://vendor.example/jobs'), true);
  assert.equal(containsHostLeakage('//vendor.example/jobs'), true);
  assert.equal(containsHostLeakage('vendor.example/careers'), true);
  assert.equal(containsHostLeakage('/jobs'), false);
  assert.equal(containsHostLeakage('nav[primary]'), false);
  assert.equal(containsHostLeakage('Search jobs'), false);
});

test('corpus schema validation rejects object serialization and non-allowlisted framework attrs', () => {
  const violations = findSnapshotAttributeViolations({
    schemaVersion: CORPUS_SCHEMA_VERSION,
    elements: [{
      tag: 'apply-widget',
      attributes: {},
      outerHTML: '<apply-widget vce-ready="" />',
      selector: 'apply-widget',
      reportSelector: 'apply-widget',
    }, {
      tag: 'div',
      attributes: { receipient: 'neutral-text-0-abcdef12' },
      outerHTML: '<div receipient="[object Object]" />',
      selector: 'div',
      reportSelector: 'div',
    }],
    diagnostics: [],
    counts: { frameCount: 0, shadowRootCount: 0, closedShadowCount: 0 },
  });

  assert.ok(violations.some((entry) => /non-allowlisted framework attribute "vce-ready"/i.test(entry)));
  assert.ok(violations.some((entry) => /malformed serialized attribute value/i.test(entry)));
  assert.ok(violations.some((entry) => /not allowlisted for replay evidence/i.test(entry)));
  assert.ok(violations.some((entry) => /snapshot\.elements\[1\]\.attributes\.receipient is not allowlisted/i.test(entry)));

  const pageViolations = findCommittedAttributeViolations(
    '<div receipient="[object Object]"><apply-widget vce-ready=""></apply-widget></div>',
    'page.html',
  );
  assert.ok(pageViolations.some((entry) => /malformed serialized attribute value/i.test(entry)));
  assert.ok(pageViolations.some((entry) => /non-allowlisted framework attribute "vce-ready"/i.test(entry)));
});

test('corpus schema validation rejects volatile generated selectors and ids in snapshots', () => {
  const result = validateCorpusCase(path.join(CORPUS_ROOT, 'cases/snapshot-volatile-id'));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => /volatile generated/i.test(error)));
});

test('corpus schema validation rejects ambiguous expected siblings without disambiguator', () => {
  const result = validateCorpusCase(path.join(CORPUS_ROOT, 'cases/expected-ambiguous-siblings'));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => /ordinal or disambiguator/i.test(error)));
});

test('corpus schema validation rejects mismatched meta.profile and expected.profile', () => {
  const result = validateCorpusCase(path.join(CORPUS_ROOT, 'cases/profile-mismatch'));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => /meta\.profile.*expected\.profile/i.test(error)));
});

test('normalizeCorpusRuleId unifies commercial and native alias pairs', () => {
  assert.equal(normalizeCorpusRuleId('ListNotEmpty'), 'ListEmpty');
  assert.equal(normalizeCorpusRuleId('ListEmpty'), 'ListEmpty');
  assert.equal(normalizeCorpusRuleId('PageTitleValid'), 'PageTitleValid');
  assert.equal(normalizeCorpusRuleId('PageTitle'), 'PageTitleValid');
  assert.equal(normalizeCorpusRuleId('PageTitleDescriptive'), 'PageTitleValid');
  assert.equal(normalizeCorpusRuleId('PageMetaViewportValid'), 'PageMetaViewportValid');
  assert.equal(normalizeCorpusRuleId('MetaViewportScalable'), 'PageMetaViewportValid');
  assert.equal(normalizeCorpusRuleId('TabListMisMatch'), 'TabListMisMatch');
  assert.equal(normalizeCorpusRuleId('TablistRole'), 'TabListMisMatch');
});

test('external commercial aliases resolve to stable internal native rule ids', () => {
  assert.equal(resolveNativeRuleId('TabListMisMatch'), 'TablistRole');
  assert.equal(resolveNativeRuleId('ListNotEmpty'), 'ListEmpty');
  assert.equal(resolveNativeRuleId('PageTitleValid'), 'PageTitle');
  assert.equal(resolveNativeRuleId('PageMetaViewportValid'), 'MetaViewportScalable');
  assert.equal(resolveNativeRuleId('FocusNotObscuredHeader'), 'StickyHeaderObscuresFocus');
  assert.throws(() => resolveNativeRuleId('TotallyUnknownCommercialRule'));
});

test('native rule ids still canonicalize to commercial report aliases', () => {
  assert.equal(canonicalizeRuleId('StickyHeaderObscuresFocus'), 'FocusNotObscuredHeader');
  assert.equal(canonicalizeRuleId('TablistRole'), 'TabListMisMatch');
  assert.equal(canonicalizeRuleId('PageTitle'), 'PageTitleValid');
  assert.equal(canonicalizeRuleId('PageTitleDescriptive'), 'PageTitleValid');
  assert.equal(canonicalizeRuleId('MetaViewportScalable'), 'PageMetaViewportValid');
  assert.equal(canonicalizeRuleId('ListEmpty'), 'ListEmpty');
  assert.equal(resolveCommercialRuleId('TablistRole'), 'TabListMisMatch');
  assert.equal(resolveCommercialRuleId('ListEmpty'), 'ListEmpty');
});

test('commercial and native alias pairs share acceptance identity in fingerprint and diff', () => {
  const semantic = { tag: 'ul', landmarkPath: ['main'], ordinal: 0 };
  const listPairs = [
    [finding({ ruleId: 'ListEmpty', semantic }), finding({ ruleId: 'ListNotEmpty', semantic })],
    [finding({ ruleId: 'PageTitle', checkId: 'metadata:page-title', semantic: { tag: 'title', landmarkPath: [], ordinal: 0 } }),
      finding({ ruleId: 'PageTitleValid', checkId: 'metadata:page-title', semantic: { tag: 'title', landmarkPath: [], ordinal: 0 } })],
  ];

  for (const [nativeFinding, commercialFinding] of listPairs) {
    assert.equal(
      semanticElementFingerprint(nativeFinding),
      semanticElementFingerprint(commercialFinding),
    );
    assert.equal(corpusFindingsEquivalent([nativeFinding], [commercialFinding]), true);
    assert.equal(compareCorpusFindings([nativeFinding], [commercialFinding]).equivalent, true);
  }
});

test('ambiguous findings fail closed and cannot produce accepted equal fingerprints', () => {
  const siblingA = finding({
    semantic: {
      tag: 'a',
      landmarkPath: ['main'],
      attributes: { href: '/one' },
    },
  });
  const siblingB = finding({
    semantic: {
      tag: 'a',
      landmarkPath: ['main'],
      attributes: { href: '/two' },
    },
  });

  assert.equal(isAmbiguousSemanticFinding(siblingA), true);
  assert.throws(() => semanticElementFingerprint(siblingA), AmbiguousSemanticFindingError);
  assert.throws(() => semanticElementFingerprint(siblingB), AmbiguousSemanticFindingError);
  assert.throws(() => corpusFindingsEquivalent([siblingA], [siblingB]), AmbiguousSemanticFindingError);

  const disambiguatedA = finding({
    semantic: {
      tag: 'a',
      landmarkPath: ['main'],
      disambiguator: 'first-link',
      attributes: { href: '/one' },
    },
  });
  const disambiguatedB = finding({
    semantic: {
      tag: 'a',
      landmarkPath: ['main'],
      disambiguator: 'second-link',
      attributes: { href: '/two' },
    },
  });
  assert.equal(hasSemanticDisambiguator(disambiguatedA.element.semantic), true);
  assert.notEqual(
    semanticElementFingerprint(disambiguatedA),
    semanticElementFingerprint(disambiguatedB),
  );
});

test('short semantic idrefs remain distinct while explicit generated prefixes normalize', () => {
  assert.equal(isGeneratedIdRef('abc123'), false);
  assert.equal(isGeneratedIdRef('def456'), false);
  assert.equal(isGeneratedIdRef('deadbeef'), false);
  assert.equal(isGeneratedIdRef('panel-generated-1'), true);
  assert.equal(isGeneratedIdRef('a1b2c3d4e5f6'), true);

  const shortA = finding({
    semantic: {
      tag: 'button',
      attributes: { 'aria-controls': 'abc123' },
      landmarkPath: ['main'],
      ordinal: 0,
    },
  });
  const shortB = finding({
    semantic: {
      tag: 'button',
      attributes: { 'aria-controls': 'def456' },
      landmarkPath: ['main'],
      ordinal: 0,
    },
  });
  const generatedA = finding({
    semantic: {
      tag: 'button',
      attributes: { 'aria-controls': 'panel-generated-1' },
      landmarkPath: ['main'],
      ordinal: 0,
    },
  });
  const generatedB = finding({
    semantic: {
      tag: 'button',
      attributes: { 'aria-controls': 'panel-generated-99' },
      landmarkPath: ['main'],
      ordinal: 0,
    },
  });

  assert.notEqual(semanticElementFingerprint(shortA), semanticElementFingerprint(shortB));
  assert.equal(semanticElementFingerprint(generatedA), semanticElementFingerprint(generatedB));
});

test('isKnownExternalCommercialRuleId recognizes corpus oracle ids only', () => {
  assert.equal(isKnownExternalCommercialRuleId('ListNotEmpty'), true);
  assert.equal(isKnownExternalCommercialRuleId('PageTitleValid'), true);
  assert.equal(isKnownExternalCommercialRuleId('ListEmpty'), false);
});

test('semantic fingerprint ignores volatile selectors ids classes and host-specific values', () => {
  const baseline = finding({
    semantic: {
      tag: 'button',
      role: null,
      attributes: {
        type: 'button',
        'aria-expanded': 'false',
        'aria-controls': 'panel-generated-1',
        href: 'https://vendor.example/jobs',
      },
      landmarkPath: ['main', 'nav[primary]'],
      ordinal: 1,
    },
  });
  const permuted = finding({
    semantic: {
      tag: 'button',
      role: null,
      attributes: {
        type: 'button',
        'aria-expanded': 'false',
        'aria-controls': 'panel-generated-99',
        class: 'btn btn-primary x9y8z7',
        id: 'filter-toggle-abc123',
        href: 'https://vendor.example/jobs',
        'data-testid': 'filter',
      },
      landmarkPath: ['main', 'nav[primary]'],
      ordinal: 1,
    },
  });

  assert.equal(
    semanticElementFingerprint(baseline),
    semanticElementFingerprint(permuted),
  );
});

test('semantic fingerprint includes canonical rule check pattern landmarks and scope', () => {
  const left = finding({
    ruleId: 'SearchFormMismatch',
    checkId: 'parity:search-without-landmark',
    structuralPattern: 'search-controls-without-search-landmark',
    semantic: {
      tag: 'input',
      role: null,
      attributes: { type: 'search' },
      landmarkPath: ['main'],
      ordinal: 0,
      framePath: [0],
      shadowPath: [1],
    },
  });
  const right = {
    ...left,
    element: {
      semantic: {
        ...left.element.semantic,
        framePath: [],
        shadowPath: [],
      },
    },
  };

  assert.notEqual(semanticElementFingerprint(left), semanticElementFingerprint(right));
  assert.equal(left.ruleId, 'SearchFormMismatch');
  assert.equal(left.evidence.structuralPattern, 'search-controls-without-search-landmark');
  assert.deepEqual(extractSemanticDescriptor(left).landmarkPath, ['main']);
  assert.deepEqual(extractSemanticDescriptor(left).framePath, [0]);
  assert.deepEqual(extractSemanticDescriptor(left).shadowPath, [1]);
});

test('semantic fingerprint changes when landmark context or ordinal differs', () => {
  const inMain = finding({ semantic: { landmarkPath: ['main'], ordinal: 0 } });
  const inFooter = finding({ semantic: { landmarkPath: ['footer'], ordinal: 0 } });
  const secondList = finding({ semantic: { landmarkPath: ['main'], ordinal: 1 } });

  assert.notEqual(
    semanticElementFingerprint(inMain),
    semanticElementFingerprint(inFooter),
  );
  assert.notEqual(
    semanticElementFingerprint(inMain),
    semanticElementFingerprint(secondList),
  );
});

test('duplicate semantic occurrences remain distinct multiset entries', () => {
  const first = finding({ semantic: { landmarkPath: ['main'], ordinal: 0 } });
  const second = finding({ semantic: { landmarkPath: ['main'], ordinal: 1 } });
  const multiset = buildCorpusMultiset([first, first, second]);

  assert.equal(multiset.length, 3);
  assert.equal(new Set(multiset).size, 2);
});

test('diff buckets are disjoint and changed pairs do not double-count', () => {
  const expected = [
    finding({ semantic: { landmarkPath: ['main'], ordinal: 0 } }),
    finding({
      ruleId: 'TablistRole',
      checkId: 'parity:disclosure-tablist-role',
      structuralPattern: 'aria-expanded-disclosure-group',
      semantic: {
        tag: 'section',
        landmarkPath: ['main'],
        ordinal: 0,
      },
    }),
  ];
  const actual = [
    finding({ semantic: { landmarkPath: ['main'], ordinal: 1 } }),
    finding({
      ruleId: 'TablistRole',
      checkId: 'parity:disclosure-tab-mismatch',
      structuralPattern: 'aria-expanded-disclosure-trigger',
      semantic: {
        tag: 'button',
        attributes: { 'aria-expanded': 'false' },
        landmarkPath: ['main'],
        ordinal: 0,
      },
    }),
  ];

  const diff = compareCorpusFindings(expected, actual);

  assert.equal(diff.equivalent, false);
  assert.equal(diff.missing.length, 0);
  assert.equal(diff.extra.length, 0);
  assert.equal(diff.changed.length, 2);
  assert.equal(diff.changed[0].expected.ruleId, 'ListEmpty');
  assert.equal(diff.changed[0].actual.ruleId, 'ListEmpty');
  assert.equal(diff.changed[1].expected.ruleId, 'TabListMisMatch');
  assert.equal(diff.changed[1].actual.ruleId, 'TabListMisMatch');
  assert.equal(
    diff.missing.length + diff.extra.length + diff.changed.length,
    2,
  );
});

test('changed pairs support unequal per-rule replacements in disjoint buckets', () => {
  const expected = [
    finding({ semantic: { landmarkPath: ['main'], ordinal: 0 } }),
    finding({ semantic: { landmarkPath: ['main'], ordinal: 1 } }),
  ];
  const actual = [
    finding({ semantic: { landmarkPath: ['main'], ordinal: 2 } }),
  ];

  const diff = compareCorpusFindings(expected, actual);

  assert.equal(diff.missing.length, 1);
  assert.equal(diff.extra.length, 0);
  assert.equal(diff.changed.length, 1);
  assert.equal(diff.changed[0].expected.ruleId, 'ListEmpty');
  assert.equal(diff.changed[0].actual.ruleId, 'ListEmpty');
  assert.equal(
    diff.missing.length + diff.extra.length + diff.changed.length,
    2,
  );
});

test('equal multisets are equivalent even when raw selectors differ', () => {
  const expected = [
    finding({ semantic: { tag: 'ul', landmarkPath: ['main'], ordinal: 0 } }),
  ];
  const base = finding({ semantic: { tag: 'ul', landmarkPath: ['main'], ordinal: 0 } });
  const actual = [{
    ...base,
    element: {
      ...base.element,
      selector: '#different-id',
      outerHTML: '<ul class="volatile"></ul>',
    },
  }];

  const diff = compareCorpusFindings(expected, actual);
  assert.equal(diff.equivalent, true, JSON.stringify(diff));
  assert.deepEqual(diff.missing, []);
  assert.deepEqual(diff.extra, []);
  assert.deepEqual(diff.changed, []);
  assert.equal(semanticFindingsEquivalent(expected[0], actual[0]), true);
});

test('count-only parity is never accepted as corpus equivalence', () => {
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

  assert.equal(expected.length, actual.length);
  assert.equal(corpusFindingsEquivalent(expected, actual), false);
});

test('classifyCorpusDiff maps documented oracle limitations to oracle_drift', () => {
  const diff = compareCorpusFindings(
    [finding({ ruleId: 'IconDiscernible', semantic: { tag: 'svg', landmarkPath: ['main'], ordinal: 0 } })],
    [],
  );
  const classified = classifyCorpusDiff(diff, {
    caseMeta: {
      notes: ['Limitation: IconDiscernible: oracle reports 23 failures but only 10 failuresHtml snippets were captured'],
    },
  });
  assert.equal(classified.deltas.length, 1);
  assert.equal(classified.deltas[0].category, 'oracle_drift');
  assert.equal(classified.counts.oracle_drift, 1);
});

test('changed semantic drift classifies through compareCorpusFindings pipeline', () => {
  const expected = [
    finding({
      ruleId: 'ListNotEmpty',
      semantic: { landmarkPath: ['main'], ordinal: 0 },
    }),
  ];
  const actual = [
    finding({
      ruleId: 'ListEmpty',
      semantic: { landmarkPath: ['footer'], ordinal: 0 },
    }),
  ];
  const classified = classifyCorpusDiff(compareCorpusFindings(expected, actual));
  assert.equal(classified.deltas.length, 1);
  assert.equal(classified.deltas[0].category, 'signal_extraction');
  assert.notEqual(classified.deltas[0].expectedFingerprint, classified.deltas[0].actualFingerprint);
});

test('ambiguous semantic alignment is detected when ordinals and disambiguators are absent', () => {
  const ambiguous = finding({
    semantic: {
      tag: 'a',
      landmarkPath: ['nav[primary]'],
      attributes: { 'aria-current': 'page' },
    },
  });

  assert.equal(isAmbiguousSemanticFinding(ambiguous), true);
  const stable = finding({
    semantic: {
      tag: 'a',
      landmarkPath: ['nav[primary]'],
      ordinal: 0,
      attributes: { 'aria-current': 'page' },
    },
  });
  assert.equal(isAmbiguousSemanticFinding(stable), false);
});
