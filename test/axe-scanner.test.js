import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as axeScanner from '../src/scanner/axe.js';

function violation(id, impact, tags, target, html) {
  return {
    id,
    impact,
    tags,
    description: `${id} description`,
    nodes: [{
      target: [target],
      html,
      failureSummary: `${id} failed`,
    }],
  };
}

const desktop = {
  viewport: { name: 'desktop', width: 1280, height: 900 },
  results: {
    violations: [
      violation('heading-order', 'moderate', ['best-practice'], '.job-title', '<h3>Software Engineer</h3>'),
      violation('meta-viewport', 'moderate', ['wcag2aa', 'wcag144'], 'meta[name="viewport"]', '<meta name="viewport">'),
    ],
    passes: [{ id: 'button-name' }, { id: 'html-has-lang' }],
    incomplete: [
      violation('color-contrast', 'serious', ['wcag2aa'], '.desktop-contrast', '<p class="desktop-contrast">Text</p>'),
    ],
    inapplicable: [{ id: 'audio-caption' }],
  },
};

const mobile = {
  viewport: { name: 'mobile', width: 390, height: 844 },
  results: {
    violations: [
      violation('button-name', 'critical', ['wcag2a', 'wcag412'], '.hamburger', '<button class="hamburger"></button>'),
      violation('heading-order', 'moderate', ['best-practice'], '.job-title', '<h3 class="mobile">Software Engineer</h3>'),
      violation('meta-viewport', 'moderate', ['wcag2aa', 'wcag144'], 'meta[name="viewport"]', '<meta name="viewport">'),
    ],
    passes: [{ id: 'html-has-lang' }],
    incomplete: [
      violation('color-contrast', 'serious', ['wcag2aa'], '.mobile-contrast', '<p class="mobile-contrast">Text</p>'),
    ],
    inapplicable: [{ id: 'audio-caption' }],
  },
};

test('mergeAxeViewportResults deduplicates rules and nodes while retaining viewport evidence', () => {
  assert.equal(typeof axeScanner.mergeAxeViewportResults, 'function');

  const merged = axeScanner.mergeAxeViewportResults([desktop, mobile]);

  assert.deepEqual(merged.violations.map((item) => item.id), [
    'button-name',
    'heading-order',
    'meta-viewport',
  ]);
  assert.deepEqual(
    merged.violations.find((item) => item.id === 'heading-order').nodes[0].viewports,
    [desktop.viewport, mobile.viewport],
  );
  const headingRule = merged.violations.find((item) => item.id === 'heading-order');
  assert.deepEqual(headingRule.nodes[0].htmlSnapshots, [
    { viewport: desktop.viewport, html: '<h3>Software Engineer</h3>' },
    { viewport: mobile.viewport, html: '<h3 class="mobile">Software Engineer</h3>' },
  ]);
  assert.deepEqual(
    axeScanner.buildAxeEvidence(headingRule, headingRule.nodes[0]).htmlSnapshots,
    headingRule.nodes[0].htmlSnapshots,
  );
  assert.deepEqual(
    merged.violations.find((item) => item.id === 'button-name').nodes[0].viewports,
    [mobile.viewport],
  );
  assert.equal(merged.passesCount, 1, 'button-name is not a pass because it fails mobile');
  assert.equal(merged.incompleteCount, 1);
  assert.equal(merged.inapplicableCount, 1);
  assert.ok(Array.isArray(merged.incomplete), 'incomplete results are not preserved');
  assert.deepEqual(merged.incomplete[0].viewports, [desktop.viewport, mobile.viewport]);
  assert.deepEqual(
    merged.incomplete[0].nodes.map((node) => node.target[0]),
    ['.desktop-contrast', '.mobile-contrast'],
  );
  assert.deepEqual(merged.incomplete[0].nodes[0].viewports, [desktop.viewport]);
  assert.deepEqual(merged.incomplete[0].nodes[1].viewports, [mobile.viewport]);
});

test('mergeAxeViewportResults normalizes equivalent axe targets across viewports', () => {
  const desktopRule = violation(
    'button-name',
    'critical',
    ['wcag2a'],
    '.hamburger',
    '<button class="hamburger"></button>',
  );
  const mobileRule = violation(
    'button-name',
    'critical',
    ['wcag2a'],
    'button.hamburger',
    '<button class="hamburger"></button>',
  );
  const merged = axeScanner.mergeAxeViewportResults([
    {
      viewport: desktop.viewport,
      results: { violations: [desktopRule], passes: [], incomplete: [], inapplicable: [] },
    },
    {
      viewport: mobile.viewport,
      results: { violations: [mobileRule], passes: [], incomplete: [], inapplicable: [] },
    },
  ]);

  assert.equal(merged.violations[0].nodes.length, 1);
  assert.deepEqual(merged.violations[0].nodes[0].viewports, [desktop.viewport, mobile.viewport]);
});

test('mergeAxeViewportResults does not merge different element types sharing a class', () => {
  const merged = axeScanner.mergeAxeViewportResults([{
    viewport: desktop.viewport,
    results: {
      violations: [{
        id: 'aria-allowed-attr',
        impact: 'critical',
        tags: ['wcag2a'],
        nodes: [
          { target: ['button.shared-control'], html: '<button class="shared-control"></button>' },
          { target: ['a.shared-control'], html: '<a class="shared-control"></a>' },
        ],
      }],
      passes: [],
      incomplete: [],
      inapplicable: [],
    },
  }]);

  assert.equal(merged.violations[0].nodes.length, 2);
});

test('buildAxeSummary preserves DevTools-compatible group, impact, and best-practice counts', () => {
  assert.equal(typeof axeScanner.buildAxeSummary, 'function');

  const merged = axeScanner.mergeAxeViewportResults([desktop, mobile]);
  const summary = axeScanner.buildAxeSummary(merged.violations, [desktop, mobile], {
    artifactNodeCount: 0,
    artifactViolationGroupsSkipped: 0,
  });

  assert.deepEqual(summary, {
    totalIssueGroups: 3,
    automaticIssues: 3,
    guidedIssues: null,
    manualIssues: null,
    bestPractice: 1,
    affectedNodes: 3,
    impact: {
      critical: 1,
      serious: 0,
      moderate: 2,
      minor: 0,
    },
    artifactNodeCount: 0,
    artifactViolationGroupsSkipped: 0,
    viewports: [
      {
        name: 'desktop',
        width: 1280,
        height: 900,
        issueGroups: 2,
        affectedNodes: 2,
        incomplete: 1,
      },
      {
        name: 'mobile',
        width: 390,
        height: 844,
        issueGroups: 3,
        affectedNodes: 3,
        incomplete: 1,
      },
    ],
    unsupportedIssueTypes: ['guided', 'manual'],
  });
});

test('mergeAxeViewportResults retains incomplete evidence when a rule fails another viewport', () => {
  const rule = violation('select-name', 'critical', ['wcag2a'], 'select', '<select></select>');
  const merged = axeScanner.mergeAxeViewportResults([
    {
      viewport: desktop.viewport,
      results: { violations: [rule], passes: [], incomplete: [], inapplicable: [] },
    },
    {
      viewport: mobile.viewport,
      results: { violations: [], passes: [], incomplete: [rule], inapplicable: [] },
    },
  ]);

  assert.equal(merged.incompleteCount, 1);
  assert.deepEqual(merged.incomplete.map((item) => item.id), ['select-name']);
  assert.deepEqual(merged.incomplete[0].viewports, [mobile.viewport]);
});

test('mergeAxeViewportResults preserves responsive HTML snapshots for incomplete nodes', () => {
  const desktopRule = violation(
    'color-contrast',
    'serious',
    ['wcag2aa'],
    '.contrast-copy',
    '<p class="contrast-copy">Desktop</p>',
  );
  const mobileRule = violation(
    'color-contrast',
    'serious',
    ['wcag2aa'],
    'p.contrast-copy',
    '<p class="contrast-copy">Mobile</p>',
  );
  const merged = axeScanner.mergeAxeViewportResults([
    {
      viewport: desktop.viewport,
      results: { violations: [], passes: [], incomplete: [desktopRule], inapplicable: [] },
    },
    {
      viewport: mobile.viewport,
      results: { violations: [], passes: [], incomplete: [mobileRule], inapplicable: [] },
    },
  ]);

  assert.equal(merged.incomplete[0].nodes.length, 1);
  assert.deepEqual(merged.incomplete[0].nodes[0].htmlSnapshots, [
    { viewport: desktop.viewport, html: '<p class="contrast-copy">Desktop</p>' },
    { viewport: mobile.viewport, html: '<p class="contrast-copy">Mobile</p>' },
  ]);
});

test('filterAxeDevArtifacts only removes token-only nodes in local mode', () => {
  assert.equal(typeof axeScanner.filterAxeDevArtifacts, 'function');

  const violations = [
    violation('meta-viewport', 'moderate', ['wcag2aa'], 'meta[name="viewport"]', '<meta name="viewport">'),
    violation('empty-heading', 'moderate', ['wcag2a'], 'h1', '<h1>{{data:hero_heading}}</h1>'),
  ];

  const local = axeScanner.filterAxeDevArtifacts(violations, {
    sourceMode: 'local',
    templateTokens: ['{{', '}}', '{%', '%}'],
  });
  assert.deepEqual(local.violations.map((item) => item.id), ['meta-viewport']);
  assert.equal(local.artifactNodeCount, 1);
  assert.equal(local.artifactViolationGroupsSkipped, 1);

  const remote = axeScanner.filterAxeDevArtifacts(violations, {
    sourceMode: 'url',
    templateTokens: ['{{', '}}', '{%', '%}'],
  });
  assert.deepEqual(remote.violations.map((item) => item.id), ['meta-viewport', 'empty-heading']);
  assert.equal(remote.artifactNodeCount, 0);
  assert.equal(remote.artifactViolationGroupsSkipped, 0);

  const unspecified = axeScanner.filterAxeDevArtifacts(violations, {
    templateTokens: ['{{', '}}', '{%', '%}'],
  });
  assert.deepEqual(
    unspecified.violations.map((item) => item.id),
    ['meta-viewport', 'empty-heading'],
    'artifact filtering must require an explicit local source mode',
  );

  const localWithoutTokens = axeScanner.filterAxeDevArtifacts(violations, {
    sourceMode: 'local',
  });
  assert.deepEqual(
    localWithoutTokens.violations.map((item) => item.id),
    ['meta-viewport', 'empty-heading'],
    'local filtering must require configured tokens',
  );
});

test('buildAxeSummary excludes local template artifacts from viewport totals', () => {
  const viewportResults = [{
    viewport: desktop.viewport,
    results: {
      violations: [
        violation('meta-viewport', 'moderate', ['wcag2aa'], 'meta', '<meta name="viewport">'),
        violation('empty-heading', 'moderate', ['wcag2a'], 'h1', '<h1>{{data:hero_heading}}</h1>'),
      ],
      passes: [],
      incomplete: [],
      inapplicable: [],
    },
  }];
  const merged = axeScanner.mergeAxeViewportResults(viewportResults);
  const filtered = axeScanner.filterAxeDevArtifacts(merged.violations, {
    sourceMode: 'local',
    templateTokens: ['{{', '}}', '{%', '%}'],
  });
  const summary = axeScanner.buildAxeSummary(filtered.violations, viewportResults, filtered);

  assert.equal(summary.totalIssueGroups, 1);
  assert.equal(summary.viewports[0].issueGroups, 1);
  assert.equal(summary.viewports[0].affectedNodes, 1);
});

test('buildAxeSummary excludes artifact nodes from mixed rule groups', () => {
  const viewportResults = [{
    viewport: desktop.viewport,
    results: {
      violations: [{
        id: 'empty-heading',
        impact: 'moderate',
        tags: ['wcag2a'],
        nodes: [
          {
            target: ['h1.real'],
            html: '<h1>Real heading</h1>',
          },
          {
            target: ['h1.dynamic'],
            html: '<h1>{{data:hero_heading}}</h1>',
          },
        ],
      }],
      passes: [],
      incomplete: [],
      inapplicable: [],
    },
  }];
  const merged = axeScanner.mergeAxeViewportResults(viewportResults);
  const filtered = axeScanner.filterAxeDevArtifacts(merged.violations, {
    sourceMode: 'local',
    templateTokens: ['{{', '}}', '{%', '%}'],
  });
  const summary = axeScanner.buildAxeSummary(filtered.violations, viewportResults, filtered);

  assert.equal(filtered.violations.length, 1);
  assert.equal(summary.affectedNodes, 1);
  assert.equal(summary.viewports[0].affectedNodes, 1);
});

test('buildAxeEvidence preserves raw rule and viewport metadata for each finding', () => {
  assert.equal(typeof axeScanner.buildAxeEvidence, 'function');

  const rule = {
    id: 'button-name',
    impact: 'critical',
    tags: ['cat.name-role-value', 'wcag2a', 'wcag412'],
    help: 'Buttons must have discernible text',
    helpUrl: 'https://dequeuniversity.com/rules/axe/button-name',
    nodes: [
      { target: ['.hamburger'], html: '<button class="hamburger"></button>' },
      { target: ['.search'], html: '<button class="search"></button>' },
    ],
  };
  const node = {
    ...rule.nodes[0],
    impact: 'critical',
    failureSummary: 'Fix the button text alternative',
    viewports: [mobile.viewport],
  };

  assert.deepEqual(axeScanner.buildAxeEvidence(rule, node), {
    issueType: 'automatic',
    tags: rule.tags,
    impact: 'critical',
    help: rule.help,
    helpUrl: rule.helpUrl,
    failureSummary: node.failureSummary,
    ruleGroupNodeCount: 2,
    viewports: [mobile.viewport],
  });
});

test('HIT-01 R1 axe fixture retains all 7 rule groups across desktop and mobile', () => {
  const expectedRules = [
    'button-name',
    'heading-order',
    'landmark-main-is-top-level',
    'landmark-no-duplicate-main',
    'landmark-unique',
    'meta-viewport',
    'select-name',
  ];
  const makeHitachiRule = (id) => {
    const critical = id === 'button-name' || id === 'select-name';
    const bestPractice = id === 'heading-order' || id.startsWith('landmark-');
    return violation(
      id,
      critical ? 'critical' : 'moderate',
      bestPractice ? ['best-practice'] : ['wcag2aa'],
      `#${id}`,
      `<div id="${id}"></div>`,
    );
  };
  const viewportResults = [
    {
      viewport: desktop.viewport,
      results: {
        violations: expectedRules.filter((id) => id !== 'button-name').map(makeHitachiRule),
        passes: [],
        incomplete: [],
        inapplicable: [],
      },
    },
    {
      viewport: mobile.viewport,
      results: {
        violations: expectedRules.map(makeHitachiRule),
        passes: [],
        incomplete: [],
        inapplicable: [],
      },
    },
  ];

  const merged = axeScanner.mergeAxeViewportResults(viewportResults);
  const filtered = axeScanner.filterAxeDevArtifacts(merged.violations, { sourceMode: 'url' });
  const summary = axeScanner.buildAxeSummary(filtered.violations, viewportResults, filtered);

  assert.deepEqual(filtered.violations.map((item) => item.id), expectedRules);
  assert.equal(summary.totalIssueGroups, 7);
  assert.equal(summary.affectedNodes, 7);
  assert.deepEqual(summary.impact, {
    critical: 2,
    serious: 0,
    moderate: 5,
    minor: 0,
  });
});

test('buildAxePageMetadata preserves raw incomplete data without bulky pass rows', () => {
  assert.equal(typeof axeScanner.buildAxePageMetadata, 'function');

  const scanResult = {
    summary: {
      totalIssueGroups: 1,
      automaticIssues: 1,
      guidedIssues: null,
      manualIssues: null,
      bestPractice: 0,
      affectedNodes: 1,
      impact: { critical: 1, serious: 0, moderate: 0, minor: 0 },
      artifactNodeCount: 0,
      artifactViolationGroupsSkipped: 0,
      viewports: [mobile.viewport],
      unsupportedIssueTypes: ['guided', 'manual'],
    },
    passes: [{ id: 'html-has-lang' }],
    incomplete: [{ id: 'color-contrast' }],
    inapplicable: [{ id: 'audio-caption' }],
    passesCount: 1,
    incompleteCount: 1,
    inapplicableCount: 1,
    tags: ['wcag2a'],
    testEngine: { name: 'axe-core', version: '4.12.1' },
    toolOptions: { runOnly: { type: 'tag', values: ['wcag2a'] } },
    timestamp: '2026-07-15T00:00:00.000Z',
  };

  const metadata = axeScanner.buildAxePageMetadata(scanResult);

  assert.equal(metadata.incomplete, scanResult.incomplete);
  assert.equal('passes' in metadata, false);
  assert.equal('inapplicable' in metadata, false);
  assert.equal(metadata.passesCount, 1);
  assert.equal(metadata.inapplicableCount, 1);
  assert.deepEqual(metadata.testEngine, scanResult.testEngine);
  assert.deepEqual(metadata.toolOptions, scanResult.toolOptions);
});
