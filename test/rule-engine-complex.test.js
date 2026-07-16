import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

import { loadBuiltInRuleRegistry } from '../src/scanner/access-scan/engine/builtin-registry.js';
import { runRules } from '../src/scanner/access-scan/engine/runner.js';
import { PROFILES } from '../src/scanner/access-scan/engine/profiles.js';
import {
  ACTIVE_RULE_COUNT,
  CATALOG_RULE_COUNT,
  LEGACY_NON_EMITTING_RULE_ID,
  loadGoldenCatalogRuleIds,
} from './helpers/access-scan-contract.js';
import { createScanSession } from '../src/scanner/access-scan/runtime/index.js';

const COMPLEX_RULE_IDS = [
  'BreadcrumbsNav', 'EmphasisMismatch', 'LinkAnchorAmbiguous', 'SalePriceDiscernible',
  'StrongMismatch', 'VisibilityMismatch', 'VisibilityMisuse',
  'FocusNotObscuredFooter', 'ButtonMismatch', 'LinkCurrentPage', 'LinkNavigationAmbiguous', 'TargetSize',
  'FormContextChangeWarning', 'FormSubmitButtonMismatch', 'MainNavigationMismatch',
  'ArticleMisuse', 'BreadcrumbsMismatch', 'NavigationMisuse', 'RegionMainContentMismatch',
  'RegionMainContentMisuse', 'RegionMainContentSingle', 'SearchFormMismatch',
  'RegionFooterMismatch', 'RegionFooterMisuse', 'RegionFooterSingle',
  'BackgroundImageDiscernibleImage', 'DecorativeGraphicExposed', 'IconDiscernible',
  'ImageDiscernible', 'ImageDiscernibleCorrectly', 'ImageMisuse',
  'DraggingAlternative', 'StickyHeaderObscuresFocus',
  'TablistRole', 'TabAriaControls', 'TabAriaSelected', 'TabListMisuse', 'TabMismatch',
  'TabMisuse', 'TabPanelMismatch', 'TabPanelMisuse', 'TabpanelLabelledBy',
  'TableCaption', 'TableHeaderEmpty', 'TableHeaders', 'TableMisuse', 'TableNesting',
  'TableRoles', 'TableRowHeaderMismatch',
];

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

async function runComplexRules(page, ruleIds = COMPLEX_RULE_IDS) {
  const session = await createScanSession(page);
  const registry = await loadBuiltInRuleRegistry({ enforceCatalogContract: true });
  const skip = registry.getActiveRuleIds().filter((id) => !ruleIds.includes(id));
  const result = await runRules({
    registry,
    profile: PROFILES.STANDARDS,
    context: { snapshot: session.snapshot, session },
    skipRules: skip,
  });
  return { session, registry, result };
}

function findingsForRule(result, ruleId) {
  return result.findings.filter((finding) => finding.ruleId === ruleId);
}

test('built-in registry enforces full catalog: 82 active + one legacy-readable', async () => {
  const registry = await loadBuiltInRuleRegistry({ enforceCatalogContract: true });
  const golden = loadGoldenCatalogRuleIds().sort();

  assert.equal(registry.getActiveRuleIds().length, ACTIVE_RULE_COUNT);
  assert.equal(registry.listRules().length, CATALOG_RULE_COUNT);
  assert.deepEqual(registry.getLegacyReadableRuleIds(), [LEGACY_NON_EMITTING_RULE_ID]);
  assert.deepEqual(registry.getActiveRuleIds().sort(), golden.filter((id) => id !== LEGACY_NON_EMITTING_RULE_ID).sort());
  assert.equal(registry.isEmittingRule(LEGACY_NON_EMITTING_RULE_ID), false);
  assert.equal(registry.getRule('StickyHeaderObscuresFocus').category, 'lists');

  for (const ruleId of golden) {
    assert.ok(registry.getRule(ruleId), `missing descriptor for ${ruleId}`);
  }
});

test('legacy AriaLabelledbyContentMismatch is readable with empty checks and manual automation', async () => {
  const registry = await loadBuiltInRuleRegistry({ enforceCatalogContract: true });
  const legacy = registry.getRule('AriaLabelledbyContentMismatch');
  assert.equal(legacy.status, 'legacy-readable');
  assert.equal(legacy.automation, 'manual');
  assert.deepEqual(legacy.checks, []);
  assert.ok(legacy.reporting.title.length > 0);
});

test('complex rules comprehensive fixture emits standards classifications only', async () => {
  const expectations = {
    StrongMismatch: 'potential',
    EmphasisMismatch: 'potential',
    VisibilityMisuse: 'potential',
    VisibilityMismatch: 'confirmed',
    BreadcrumbsNav: 'confirmed',
    SalePriceDiscernible: 'potential',
    LinkAnchorAmbiguous: 'potential',
    ButtonMismatch: 'potential',
    LinkNavigationAmbiguous: 'potential',
    FormSubmitButtonMismatch: 'confirmed',
    MainNavigationMismatch: 'potential',
    NavigationMisuse: 'potential',
    RegionMainContentSingle: 'confirmed',
    SearchFormMismatch: 'potential',
    ImageDiscernible: 'confirmed',
    ImageMisuse: 'potential',
    IconDiscernible: 'potential',
    TableHeaders: 'potential',
    TableNesting: 'confirmed',
    TablistRole: 'confirmed',
    TabAriaSelected: 'confirmed',
    TabListMisuse: 'confirmed',
    DraggingAlternative: 'potential',
  };

  await withPage(
    `
      <html lang="en"><head><title>Complex fixture</title></head><body>
        <span id="bold-span" style="font-weight:700">Important</span>
        <span id="italic-span" style="font-style:italic">Emphasis</span>
        <div id="hidden-interactive" hidden><button id="hidden-btn">Go</button></div>
        <p id="visually-hidden-at" style="opacity:0">Screen reader only copy here for misuse</p>
        <p id="visible-hidden" aria-hidden="true">Visible hidden text content here</p>
        <nav aria-label="Breadcrumb"><a href="/">Home</a></nav>
        <p><del id="sale-price">$19.99</del> <span>$9.99</span></p>
        <a id="empty-anchor" href="#">Learn more</a>
        <a id="fake-button" href="#" style="display:inline-block;padding:8px 16px;background:#333;color:#fff">Apply</a>
        <a id="dup-a" href="/jobs">Careers</a>
        <a id="dup-b" href="/about">Careers</a>
        <button id="tiny-btn" style="width:18px;height:18px;padding:0">x</button>
        <form id="bad-submit"><button type="button">Send</button><input name="q"></form>
        <header><ul><li><a href="/a">One</a></li><li><a href="/b">Two</a></li><li><a href="/c">Three</a></li></ul></header>
        <nav id="empty-nav"></nav>
        <main id="main-one">Primary</main>
        <main id="main-two">Duplicate</main>
        <form id="search-form"><input type="search" name="q"><button type="submit">Search</button></form>
        <img id="no-alt" src="photo.jpg">
        <div role="img" id="text-as-img">Not an image</div>
        <svg id="bare-svg" role="img" width="16" height="16"><circle r="8"/></svg>
        <table id="data-table"><tr><td>A</td><td>B</td></tr><tr><td>1</td><td>2</td></tr></table>
        <table id="outer-table"><tr><td><table id="inner-table"><tr><td>nested</td></tr></table></td></tr></table>
        <div id="missing-tablist">
          <button role="tab" id="tab-x" aria-controls="panel-x">X</button>
          <button role="tab" id="tab-y" aria-controls="panel-y">Y</button>
        </div>
        <div id="panel-x">X panel</div>
        <div id="panel-y">Y panel</div>
        <div role="tablist" id="empty-tablist"></div>
        <div role="tablist" id="real-tablist">
          <button role="tab" id="tab-a" aria-controls="panel-a">A</button>
          <button role="tab" id="tab-b">B</button>
        </div>
        <div role="tabpanel" id="panel-a">Panel A</div>
        <div id="custom-slider" role="slider" tabindex="-1" aria-valuenow="5"></div>
      </body></html>
    `,
    async (page) => {
      const { result } = await runComplexRules(page);
      for (const [ruleId, expected] of Object.entries(expectations)) {
        const findings = findingsForRule(result, ruleId);
        assert.ok(findings.length >= 1, `expected finding for ${ruleId}`);
        assert.equal(findings[0].violationType, expected, ruleId);
        assert.notEqual(findings[0].violationType, 'commercial-parity', ruleId);
      }
    },
  );
});

test('roleless tab inference requires state evidence and ignores accordion-like aria-controls groups', async () => {
  await withPage(
    `
      <section>
        <button aria-controls="panel-one">One</button>
        <button aria-controls="panel-two">Two</button>
        <div id="panel-one">Panel one</div>
        <div id="panel-two">Panel two</div>
      </section>
    `,
    async (page) => {
      const { result } = await runComplexRules(page, [
        'TablistRole', 'TabMismatch', 'TabPanelMismatch',
      ]);
      assert.equal(findingsForRule(result, 'TablistRole').length, 0);
      assert.equal(findingsForRule(result, 'TabMismatch').length, 0);
      assert.equal(findingsForRule(result, 'TabPanelMismatch').length, 0);
    },
  );
});

test('roleless tab inference fires when aria-selected and complete ID relationships exist', async () => {
  await withPage(
    `
      <section>
        <button aria-controls="panel-one" aria-selected="true">One</button>
        <button aria-controls="panel-two" aria-selected="false">Two</button>
        <div id="panel-one">Panel one</div>
        <div id="panel-two">Panel two</div>
      </section>
    `,
    async (page) => {
      const { result } = await runComplexRules(page, [
        'TablistRole', 'TabMismatch', 'TabPanelMismatch',
      ]);
      assert.ok(findingsForRule(result, 'TablistRole').length >= 1);
      assert.equal(findingsForRule(result, 'TablistRole')[0].violationType, 'potential');
      assert.ok(findingsForRule(result, 'TabMismatch').length >= 2);
      assert.ok(findingsForRule(result, 'TabPanelMismatch').length >= 2);
    },
  );
});

test('explicit tab-panel mismatch flags unroled controlled panels without duplicating TabpanelLabelledBy', async () => {
  await withPage(
    `
      <div role="tablist" id="tabs">
        <button role="tab" id="tab-1" aria-controls="panel-1">One</button>
        <button role="tab" id="tab-2" aria-controls="panel-2">Two</button>
      </div>
      <div id="panel-1">Panel one</div>
      <div id="panel-2">Panel two</div>
    `,
    async (page) => {
      const { result } = await runComplexRules(page, ['TabPanelMismatch', 'TabpanelLabelledBy']);
      const mismatch = findingsForRule(result, 'TabPanelMismatch');
      const labelledBy = findingsForRule(result, 'TabpanelLabelledBy');
      assert.equal(mismatch.length, 2);
      assert.equal(labelledBy.length, 0);
      assert.equal(mismatch[0].violationType, 'confirmed');
      assert.notEqual(mismatch[0].violationType, 'commercial-parity');
    },
  );
});

test('correctly roled tabpanel without label emits only TabpanelLabelledBy', async () => {
  await withPage(
    `
      <div role="tablist">
        <button role="tab" id="tab-a" aria-controls="panel-a">A</button>
      </div>
      <div role="tabpanel" id="panel-a">Panel A</div>
    `,
    async (page) => {
      const { result } = await runComplexRules(page, ['TabPanelMismatch', 'TabpanelLabelledBy']);
      assert.equal(findingsForRule(result, 'TabPanelMismatch').length, 0);
      const labelledBy = findingsForRule(result, 'TabpanelLabelledBy');
      assert.equal(labelledBy.length, 1);
      assert.equal(labelledBy[0].violationType, 'confirmed');
      assert.notEqual(labelledBy[0].violationType, 'commercial-parity');
    },
  );
});

test('scoped aria-controls references stay within shadow root boundaries', async () => {
  await withPage(
    `
      <div id="host"></div>
      <script>
        const root = document.getElementById('host').attachShadow({ mode: 'open' });
        root.innerHTML = \`
          <div role="tablist">
            <button role="tab" id="shadow-tab" aria-controls="shadow-panel">Tab</button>
            <div role="tabpanel" id="shadow-panel">Panel</div>
          </div>
        \`;
      </script>
    `,
    async (page) => {
      const { result } = await runComplexRules(page, ['TabAriaSelected', 'TabpanelLabelledBy']);
      assert.equal(findingsForRule(result, 'TabAriaSelected').length, 1);
      assert.equal(findingsForRule(result, 'TabpanelLabelledBy').length, 1);
      const tabFinding = findingsForRule(result, 'TabAriaSelected')[0];
      assert.ok(tabFinding.element.shadowPath.length > 0);
    },
  );
});

test('wrapped tablist ul li button tab graph passes TabMismatch explicit check', async () => {
  await withPage(
    `
      <div role="tablist" id="wrapped-tabs">
        <ul>
          <li><button role="tab" id="tab-1" aria-controls="panel-1">One</button></li>
          <li><button role="tab" id="tab-2" aria-controls="panel-2">Two</button></li>
        </ul>
      </div>
      <div role="tabpanel" id="panel-1">Panel one</div>
      <div role="tabpanel" id="panel-2">Panel two</div>
    `,
    async (page) => {
      const { result } = await runComplexRules(page, ['TabMismatch']);
      assert.equal(findingsForRule(result, 'TabMismatch').length, 0);
    },
  );
});

test('TargetSize reporting describes 24×24 or spacing exceptions and overlapping 24px circle detection', async () => {
  const registry = await loadBuiltInRuleRegistry({ enforceCatalogContract: true });
  const rule = registry.getRule('TargetSize');
  assert.match(rule.reporting.title, /24×24|24x24/i);
  assert.match(rule.reporting.requirement, /24×24|24x24/i);
  assert.match(rule.reporting.requirement, /spacing/i);
  assert.match(rule.reporting.requirement, /inline/i);
  assert.match(rule.reporting.requirement, /user-agent/i);
  assert.match(rule.reporting.requirement, /essential/i);
  assert.match(rule.reporting.requirement, /24px spacing circles overlap/i);
  assert.match(rule.reporting.recommendation, /24×24|24x24/i);
  assert.match(rule.reporting.recommendation, /spacing/i);
});

test('target size honors inline spacing and isolates undersized targets with sufficient center spacing', async () => {
  await withPage(
    `
      <a id="spaced-link" href="/go" style="display:inline-block;width:12px;height:12px;padding:8px">Go</a>
      <button id="small-btn" style="width:18px;height:18px;padding:0">x</button>
    `,
    async (page) => {
      const { result } = await runComplexRules(page, ['TargetSize']);
      assert.equal(findingsForRule(result, 'TargetSize').length, 0);
    },
  );
});

test('adjacent undersized targets with centers under 24px emit TargetSize potential findings', async () => {
  await withPage(
    `
      <div style="display:flex;gap:2px">
        <button id="tiny-a" style="width:18px;height:18px;padding:0">a</button>
        <button id="tiny-b" style="width:18px;height:18px;padding:0">b</button>
      </div>
    `,
    async (page) => {
      const { result } = await runComplexRules(page, ['TargetSize']);
      const findings = findingsForRule(result, 'TargetSize');
      assert.ok(findings.length >= 2);
      assert.equal(findings[0].violationType, 'potential');
    },
  );
});

test('focus obscuration audit covers open shadow root overlays with resolvable paths', async () => {
  await withPage(
    `
      <div id="host"></div>
      <script>
        const root = document.getElementById('host').attachShadow({ mode: 'open' });
        root.innerHTML = \`
          <style>
            #shadow-bar {
              position: fixed; top: 0; left: 0; right: 0; height: 64px;
              background: #111; z-index: 1000;
            }
          </style>
          <div id="shadow-bar">Bar</div>
          <button id="shadow-btn" style="position:fixed;top:8px;left:8px">Under bar</button>
        \`;
      </script>
    `,
    async (page) => {
      const { result } = await runComplexRules(page, ['StickyHeaderObscuresFocus']);
      const findings = findingsForRule(result, 'StickyHeaderObscuresFocus');
      assert.ok(findings.length >= 1, 'expected shadow obscuration finding');
      assert.ok(findings[0].element.shadowPath.length > 0);
      assert.ok(findings[0].element.selector.length > 0);
      assert.notEqual(findings[0].violationType, 'commercial-parity');
    },
  );
});

test('focus obscuration audit covers same-origin iframe overlays with resolvable paths', async () => {
  await withPage(
    `
      <iframe id="child-frame" srcdoc="
        <style>
          #frame-bar {
            position: fixed; top: 0; left: 0; right: 0; height: 64px;
            background: #111; z-index: 1000;
          }
        </style>
        <div id=&quot;frame-bar&quot;>Bar</div>
        <button id=&quot;frame-btn&quot; style=&quot;position:fixed;top:8px;left:8px&quot;>Under bar</button>
      "></iframe>
    `,
    async (page) => {
      const { result } = await runComplexRules(page, ['StickyHeaderObscuresFocus']);
      const findings = findingsForRule(result, 'StickyHeaderObscuresFocus');
      assert.ok(findings.length >= 1, 'expected iframe obscuration finding');
      assert.ok(findings[0].element.framePath.length > 0);
      assert.ok(findings[0].element.selector.length > 0);
      assert.notEqual(findings[0].violationType, 'commercial-parity');
    },
  );
});

test('focus obscuration behavioral audit covers sticky header and footer overlays', async () => {
  await withPage(
    `
      <style>
        body { margin: 0; padding-top: 80px; padding-bottom: 80px; min-height: 200vh; }
        #sticky-header {
          position: fixed; top: 0; left: 0; right: 0; height: 72px;
          background: #111; z-index: 1000;
        }
        #sticky-footer {
          position: fixed; bottom: 0; left: 0; right: 0; height: 72px;
          background: #111; z-index: 1000;
        }
      </style>
      <header id="sticky-header">Header</header>
      <footer id="sticky-footer">Footer</footer>
      <button id="under-header" style="position:fixed;top:4px;left:8px">Header target</button>
      <button id="above-footer" style="position:fixed;bottom:4px;left:8px">Footer target</button>
    `,
    async (page) => {
      const { result } = await runComplexRules(page, [
        'StickyHeaderObscuresFocus', 'FocusNotObscuredFooter',
      ]);
      const headerFindings = findingsForRule(result, 'StickyHeaderObscuresFocus');
      const footerFindings = findingsForRule(result, 'FocusNotObscuredFooter');
      assert.ok(headerFindings.length >= 1, 'expected sticky header obscuration');
      assert.ok(footerFindings.length >= 1, 'expected sticky footer obscuration');
      for (const finding of [...headerFindings, ...footerFindings]) {
        assert.notEqual(finding.violationType, 'commercial-parity');
      }
    },
  );
});

test('native range input passes dragging alternative check', async () => {
  await withPage(
    '<input type="range" id="native-range" min="0" max="10" value="5">',
    async (page) => {
      const { result } = await runComplexRules(page, ['DraggingAlternative']);
      assert.equal(findingsForRule(result, 'DraggingAlternative').length, 0);
    },
  );
});

test('runtime snapshot performance remains bounded after style field expansion', async () => {
  await withPage(
    `
      <div id="big-root"></div>
      <script>
        const root = document.getElementById('big-root');
        const parts = [];
        for (let i = 0; i < 600; i += 1) {
          parts.push('<span>item-' + i + '</span>');
        }
        root.innerHTML = parts.join('');
      </script>
    `,
    async (page) => {
      const startedAt = Date.now();
      const session = await createScanSession(page, {
        stabilityQuietMs: 40,
        stabilityMinObserveMs: 150,
        stabilityTimeoutMs: 4000,
      });
      const elapsed = Date.now() - startedAt;
      assert.ok(session.snapshot.elements.length >= 600);
      assert.equal(session.metrics.snapshotCount, 1);
      assert.ok(elapsed < 5000, `expected bounded traversal time, took ${elapsed}ms`);

      const runtimeSource = readFileSync(
        new URL('../src/scanner/access-scan/runtime/runtime.browser.js', import.meta.url),
        'utf8',
      );
      assert.equal(runtimeSource.includes("querySelectorAll('*')"), false);
      const sample = session.snapshot.elements.find((el) => el.tag === 'span');
      assert.ok(sample.computedStyle.backgroundImage !== undefined);
    },
  );
});

test('ImageMisuse follows role=img on non-graphical elements, not filename heuristics', async () => {
  await withPage(
    `
      <img src="spacer.gif" alt="layout" width="1" height="1">
      <div role="img" id="misused">Plain text content</div>
    `,
    async (page) => {
      const { result } = await runComplexRules(page, ['ImageMisuse']);
      const findings = findingsForRule(result, 'ImageMisuse');
      assert.equal(findings.length, 1);
      assert.match(findings[0].element.outerHTML, /role="img"/);
      assert.doesNotMatch(findings[0].element.outerHTML, /spacer\.gif/);
    },
  );
});

test('legacy ImageMisuse spacer heuristic differs from standards-first role=img rule', async () => {
  await withPage(
    '<img src="pixel.png" alt="x" width="1" height="1">',
    async (page) => {
      const { result } = await runComplexRules(page, ['ImageMisuse']);
      assert.equal(findingsForRule(result, 'ImageMisuse').length, 0);
    },
  );
});

test('registry rejects non-deterministic automation with deterministic fix metadata', async () => {
  const registry = await loadBuiltInRuleRegistry({ enforceCatalogContract: true });
  for (const rule of registry.listRules()) {
    if (rule.automation !== 'deterministic' && rule.fix.deterministic) {
      assert.fail(`rule ${rule.id} claims deterministic fix with ${rule.automation} automation`);
    }
  }
});

test('about:blank LinkCurrentPage is inapplicable without false findings', async () => {
  await withPage(
    '<nav><a href="/jobs">Jobs</a></nav>',
    async (page) => {
      const { result } = await runComplexRules(page, ['LinkCurrentPage']);
      assert.equal(findingsForRule(result, 'LinkCurrentPage').length, 0);
    },
  );
});

test('button mismatch detects action anchors and unsemantic clickable heading text', async () => {
  await withPage(
    `
      <a id="plain-action-anchor" href="#">Open dialog</a>
      <ul>
        <li style="cursor: pointer">
          <h3><a href="/jobs/one">Job one</a><span id="clickable-badge">Remote</span></h3>
        </li>
      </ul>
    `,
    async (page) => {
      const { result } = await runComplexRules(page, ['ButtonMismatch']);
      const findings = findingsForRule(result, 'ButtonMismatch');
      assert.equal(findings.length, 2);
      assert.ok(findings.some((finding) => /plain-action-anchor/.test(finding.element.outerHTML)));
      assert.ok(findings.some((finding) => /clickable-badge/.test(finding.element.outerHTML)));
    },
  );
});

test('strong mismatch excludes interactive and heading-style spans while retaining standalone emphasis', async () => {
  await withPage(
    `
      <a href="/jobs"><span id="interactive-bold" style="font-weight: 700">Search jobs</span></a>
      <span id="heading-bold" class="heading-3" style="font-weight: 700">At a glance</span>
      <span id="standalone-bold" data-value="110000" style="font-weight: 700">110,000</span>
    `,
    async (page) => {
      const { result } = await runComplexRules(page, ['StrongMismatch']);
      const findings = findingsForRule(result, 'StrongMismatch');
      assert.equal(findings.length, 1);
      assert.match(findings[0].element.outerHTML, /standalone-bold/);
    },
  );
});

test('navigation misuse checks whether each navigation link participates in list structure', async () => {
  await withPage(
    `
      <nav id="mixed-navigation">
        <a href="/one">One</a>
        <a href="/two">Two</a>
        <div><ul><li>Unrelated status</li></ul></div>
      </nav>
      <nav id="listed-navigation">
        <ul><li><a href="/three">Three</a></li><li><a href="/four">Four</a></li></ul>
      </nav>
    `,
    async (page) => {
      const { result } = await runComplexRules(page, ['NavigationMisuse']);
      const findings = findingsForRule(result, 'NavigationMisuse');
      assert.equal(findings.length, 1);
      assert.match(findings[0].element.outerHTML, /mixed-navigation/);
    },
  );
});

test('main navigation inference is limited to navigation lists in page banners', async () => {
  await withPage(
    `
      <main>
        <ul id="content-links">
          <li><a href="/one">One</a></li>
          <li><a href="/two">Two</a></li>
          <li><a href="/three">Three</a></li>
        </ul>
      </main>
      <header>
        <ul id="unwrapped-primary-links">
          <li><a href="/alpha">Alpha</a></li>
          <li><a href="/beta">Beta</a></li>
          <li><a href="/gamma">Gamma</a></li>
        </ul>
      </header>
    `,
    async (page) => {
      const { result } = await runComplexRules(page, ['MainNavigationMismatch']);
      const findings = findingsForRule(result, 'MainNavigationMismatch');
      assert.equal(findings.length, 1);
      assert.match(findings[0].element.outerHTML, /unwrapped-primary-links/);
    },
  );
});

test('LinkCurrentPage resolves href against scanned URL pathname', async () => {
  const server = createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end('<html><body><nav><a id="jobs-link" href="/jobs">Jobs</a></nav></body></html>');
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  try {
    await withPage(null, async (page) => {
      const { result } = await runComplexRules(page, ['LinkCurrentPage']);
      const findings = findingsForRule(result, 'LinkCurrentPage');
      assert.equal(findings.length, 1);
      assert.equal(findings[0].violationType, 'potential');
      assert.match(findings[0].element.outerHTML, /jobs-link/);
      assert.match(findings[0].element.outerHTML, /\/jobs/);
    }, { url: `http://127.0.0.1:${port}/jobs` });
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test('RegionMainContentMismatch flags substantial body content outside main and supports no-main pages', async () => {
  await withPage(
    `
      <header>Header</header>
      <section id="outside-main">This substantial primary article content lives outside the main landmark for testing purposes.</section>
    `,
    async (page) => {
      const { result } = await runComplexRules(page, ['RegionMainContentMismatch']);
      const findings = findingsForRule(result, 'RegionMainContentMismatch');
      assert.ok(findings.length >= 1);
      assert.equal(findings[0].violationType, 'potential');
    },
  );
});

test('RegionMainContentSingle emits every duplicate main landmark after the first', async () => {
  await withPage(
    '<main id="main-a">A</main><main id="main-b">B</main><div role="main" id="main-c">C</div>',
    async (page) => {
      const { result } = await runComplexRules(page, ['RegionMainContentSingle']);
      assert.equal(findingsForRule(result, 'RegionMainContentSingle').length, 2);
    },
  );
});

test('RegionFooterSingle emits every duplicate footer landmark after the first', async () => {
  await withPage(
    '<footer id="footer-a">A</footer><footer id="footer-b">B</footer>',
    async (page) => {
      const { result } = await runComplexRules(page, ['RegionFooterSingle']);
      assert.equal(findingsForRule(result, 'RegionFooterSingle').length, 1);
    },
  );
});

test('footer rules distinguish empty contentinfo from global information outside it', async () => {
  await withPage(
    `
      <footer id="misused-footer"><nav><a href="/jobs">Jobs</a></nav></footer>
      <div id="outside-global-information">© Example Company 2026. All rights reserved.</div>
    `,
    async (page) => {
      const { result } = await runComplexRules(page, [
        'RegionFooterMismatch', 'RegionFooterMisuse',
      ]);
      const mismatch = findingsForRule(result, 'RegionFooterMismatch');
      const misuse = findingsForRule(result, 'RegionFooterMisuse');
      assert.equal(mismatch.length, 1);
      assert.match(mismatch[0].element.outerHTML, /outside-global-information/);
      assert.equal(misuse.length, 1);
      assert.match(misuse[0].element.outerHTML, /misused-footer/);
    },
  );
});

test('visibility misuse and mismatch exclude viewport-only offscreen and decorative aria-hidden wrappers', async () => {
  await withPage(
    `
      <style>
        .sr-only {
          position: absolute;
          left: -10000px;
          width: 1px;
          height: 1px;
          overflow: hidden;
        }
        .clip-hide {
          clip: rect(0, 0, 0, 0);
          position: absolute;
          width: 1px;
          height: 1px;
        }
        #below-fold-spacer { height: 2000px; }
      </style>
      <div id="below-fold-spacer"></div>
      <button id="below-fold-btn">Below fold</button>
      <button id="normal-flow-off-left" style="margin-left:-40px">Peek</button>
      <div hidden><p id="hidden-copy">Hidden subtree copy</p></div>
      <div style="display:none"><p id="display-none-copy">Display none copy</p></div>
      <div style="visibility:hidden"><p id="visibility-hidden-copy">Visibility hidden copy</p></div>
      <div inert><button id="inert-btn">Inert</button></div>
      <p id="opacity-copy" style="opacity:0">Screen reader only opacity copy here</p>
      <div id="opacity-owner" style="opacity:0">
        <a id="opacity-descendant" href="/owned">Opacity inherited from a wrapper</a>
      </div>
      <p id="clipped-copy" class="clip-hide">Clipped screen reader copy here</p>
      <p id="non-hiding-clip-path"
        style="clip-path:polygon(0 0, 100% 0, 100% 180%, 0 180%)">
        Visible text inside a non-hiding clip path
      </p>
      <p id="positioned-copy" class="sr-only">Positioned offscreen screen reader copy</p>
      <div id="decorative-hero" aria-hidden="true">
        <img src="hero.jpg" alt="">
      </div>
      <p id="aria-hidden-copy" aria-hidden="true">Visible hidden text content here</p>
      <div id="aria-hidden-interactive" aria-hidden="true">
        <button id="hidden-focusable">Still focusable</button>
      </div>
      <div id="aria-hidden-parent" aria-hidden="true">
        <span id="aria-hidden-child" aria-hidden="true">Nested hidden copy here</span>
      </div>
    `,
    async (page) => {
      const misuse = await runComplexRules(page, ['VisibilityMisuse']);
      const mismatch = await runComplexRules(page, ['VisibilityMismatch']);
      const misuseFindings = findingsForRule(misuse.result, 'VisibilityMisuse');
      const mismatchFindings = findingsForRule(mismatch.result, 'VisibilityMismatch');

      assert.equal(misuseFindings.length, 4);
      assert.ok(misuseFindings.every((finding) => finding.violationType === 'potential'));
      assert.deepEqual(
        misuseFindings.map((finding) => finding.evidence.visibilityReason).sort(),
        ['clip', 'offscreen-positioned', 'opacity', 'opacity'].sort(),
      );
      assert.ok(misuseFindings.every((finding) => finding.evidence.visibilityReason));
      assert.ok(misuseFindings.some((finding) => finding.element.selector === 'div#opacity-owner'));
      assert.ok(!misuseFindings.some((finding) => /below-fold-btn|normal-flow-off-left/.test(finding.element.outerHTML)));
      assert.ok(!misuseFindings.some((finding) => /non-hiding-clip-path/.test(finding.element.outerHTML)));

      assert.equal(mismatchFindings.length, 3);
      assert.ok(mismatchFindings.every((finding) => finding.violationType === 'confirmed'));
      assert.ok(mismatchFindings.some((finding) => /aria-hidden-copy/.test(finding.element.outerHTML)));
      assert.ok(mismatchFindings.some((finding) => /aria-hidden-interactive/.test(finding.element.outerHTML)));
      assert.ok(mismatchFindings.some((finding) => /aria-hidden-parent/.test(finding.element.outerHTML)));
      assert.ok(!mismatchFindings.some((finding) => /decorative-hero|aria-hidden-child/.test(finding.element.outerHTML)));
    },
  );
});

test('VisibilityMisuse ignores hidden display none and visibility hidden controls', async () => {
  await withPage(
    `
      <div hidden><button>Hidden</button></div>
      <div style="display:none"><button>Display none</button></div>
      <div style="visibility:hidden"><button>Visibility hidden</button></div>
    `,
    async (page) => {
      const { result } = await runComplexRules(page, ['VisibilityMisuse']);
      assert.equal(findingsForRule(result, 'VisibilityMisuse').length, 0);
    },
  );
});

test('svg role img without a name emits IconDiscernible potential', async () => {
  await withPage('<svg id="icon" role="img" width="16" height="16"><circle r="8"/></svg>', async (page) => {
    const { result } = await runComplexRules(page, ['IconDiscernible']);
    const findings = findingsForRule(result, 'IconDiscernible');
    assert.equal(findings.length, 1);
    assert.equal(findings[0].violationType, 'potential');
  });
});

test('custom slider and draggable surfaces emit DraggingAlternative without directional alternatives', async () => {
  await withPage(
    `
      <div id="drag-surface" draggable="true">Drag me</div>
      <div id="slider" role="slider" tabindex="0" aria-valuenow="3"></div>
    `,
    async (page) => {
      const { result } = await runComplexRules(page, ['DraggingAlternative']);
      assert.equal(findingsForRule(result, 'DraggingAlternative').length, 2);
    },
  );
});

test('partial sticky header overlap does not emit focus obscuration findings', async () => {
  await withPage(
    `
      <style>
        #partial-header {
          position: fixed; top: 0; left: 0; right: 0; height: 24px;
          background: #111; z-index: 1000;
        }
        body { margin: 0; padding-top: 40px; }
      </style>
      <header id="partial-header">Header</header>
      <button id="mostly-visible" style="margin-top:30px">Mostly visible</button>
    `,
    async (page) => {
      const { result } = await runComplexRules(page, ['StickyHeaderObscuresFocus']);
      assert.equal(findingsForRule(result, 'StickyHeaderObscuresFocus').length, 0);
    },
  );
});

test('focus obscuration footer findings are confirmed under WCAG 2.4.11', async () => {
  const registry = await loadBuiltInRuleRegistry({ enforceCatalogContract: true });
  const footerRule = registry.getRule('FocusNotObscuredFooter');
  assert.equal(footerRule.standard.criterion, '2.4.11');
  assert.equal(footerRule.checks[0].classification, 'confirmed');
});

test('TableRoles targets ARIA table hierarchy elements', async () => {
  await withPage(
    '<div role="table" id="aria-table"><div role="cell">Only cell</div></div>',
    async (page) => {
      const { result } = await runComplexRules(page, ['TableRoles']);
      const findings = findingsForRule(result, 'TableRoles');
      assert.equal(findings.length, 1);
      assert.equal(findings[0].violationType, 'potential');
    },
  );
});

test('TableHeaderEmpty confirmed finding flags empty th cells', async () => {
  await withPage('<table><tr><th id="empty-th"></th><td>Data</td></tr></table>', async (page) => {
    const { result } = await runComplexRules(page, ['TableHeaderEmpty']);
    const findings = findingsForRule(result, 'TableHeaderEmpty');
    assert.equal(findings.length, 1);
    assert.equal(findings[0].violationType, 'confirmed');
  });
});

test('every COMPLEX_RULE_ID has an explicit standards firing assertion in focused fixtures', async () => {
  const fixtures = {
    ArticleMisuse: '<article id="tiny-article">Hi</article>',
    BackgroundImageDiscernibleImage: '<div id="hero" style="width:200px;height:200px;background-image:url(hero.jpg)"></div>',
    BreadcrumbsMismatch: '<nav><ol><li><a href="/">Home</a></li></ol></nav>',
    BreadcrumbsNav: '<nav aria-label="Breadcrumb"><a href="/">Home</a></nav>',
    ButtonMismatch: '<a id="fake-button" href="#" style="display:inline-block;padding:8px 16px;background:#333;color:#fff">Apply</a>',
    DecorativeGraphicExposed: '<a href="/go">Go <svg width="12" height="12"><circle r="6"/></svg></a>',
    DraggingAlternative: '<div role="slider" tabindex="0" aria-valuenow="3"></div>',
    EmphasisMismatch: '<span style="font-style:italic">Emphasis</span>',
    FocusNotObscuredFooter: null,
    FormContextChangeWarning: '<form><select id="country" onchange="submit()"><option>One</option></select></form>',
    FormSubmitButtonMismatch: '<form id="bad-submit"><button type="button">Send</button><input name="q"></form>',
    IconDiscernible: '<svg id="icon" role="img" width="16" height="16"><circle r="8"/></svg>',
    ImageDiscernible: '<img id="no-alt" src="photo.jpg">',
    ImageDiscernibleCorrectly: '<img id="generic-alt" src="x.jpg" alt="image">',
    ImageMisuse: '<div role="img" id="text-as-img">Not an image</div>',
    LinkAnchorAmbiguous: '<a id="empty-anchor" href="#">Learn more</a>',
    LinkCurrentPage: null,
    LinkNavigationAmbiguous: '<a id="dup-a" href="/jobs">Careers</a><a id="dup-b" href="/about">Careers</a>',
    MainNavigationMismatch: '<header><ul><li><a href="/a">One</a></li><li><a href="/b">Two</a></li><li><a href="/c">Three</a></li></ul></header>',
    NavigationMisuse: '<nav id="empty-nav"></nav>',
    RegionFooterMismatch: '<div id="outside-copyright">© Example Company. All rights reserved.</div>',
    RegionFooterMisuse: '<div role="contentinfo" id="fake-footer">Widget</div>',
    RegionFooterSingle: '<footer id="footer-a">A</footer><footer id="footer-b">B</footer>',
    RegionMainContentMismatch: '<section id="outside-main">This substantial primary article content lives outside the main landmark for testing purposes.</section>',
    RegionMainContentMisuse: '<main id="tiny-main">Hi</main>',
    RegionMainContentSingle: '<main id="main-a">A</main><main id="main-b">B</main>',
    SalePriceDiscernible: '<p><del id="sale-price">$19.99</del> <span>$9.99</span></p>',
    SearchFormMismatch: '<form id="search-form"><input type="search" name="q"><button type="submit">Search</button></form>',
    StickyHeaderObscuresFocus: null,
    StrongMismatch: '<span style="font-weight:700">Important</span>',
    TabAriaControls: '<div role="tablist"><button role="tab" id="tab-1">One</button></div>',
    TabAriaSelected: '<div role="tablist"><button role="tab" id="tab-1" aria-controls="panel-1">One</button></div><div role="tabpanel" id="panel-1">Panel</div>',
    TabListMisuse: '<div role="tablist" id="empty-tablist"></div>',
    TabMismatch: '<div role="tablist"><button id="plain-control">Plain</button></div>',
    TabMisuse: '<button role="tab" id="orphan-tab">Orphan</button>',
    TabPanelMismatch: '<div role="tablist"><button role="tab" id="tab-1" aria-controls="panel-1">One</button></div><div id="panel-1">Panel</div>',
    TabPanelMisuse: '<div role="tabpanel" id="orphan-panel">Panel</div>',
    TablistRole: '<div id="missing-tablist"><button role="tab" id="tab-x" aria-controls="panel-x">X</button><button role="tab" id="tab-y" aria-controls="panel-y">Y</button></div><div id="panel-x">X</div><div id="panel-y">Y</div>',
    TabpanelLabelledBy: '<div role="tablist"><button role="tab" id="tab-a" aria-controls="panel-a">A</button></div><div role="tabpanel" id="panel-a">Panel A</div>',
    TableCaption: '<table id="needs-caption"><thead><tr><th>Name</th></tr></thead><tbody><tr><td>A</td></tr></tbody></table>',
    TableHeaderEmpty: '<table><tr><th id="empty-th"></th><td>Data</td></tr></table>',
    TableHeaders: '<table id="data-table"><tr><td>A</td><td>B</td></tr><tr><td>1</td><td>2</td></tr></table>',
    TableMisuse: '<table id="layout-table"><tr><td>Layout only</td></tr></table>',
    TableNesting: '<table id="outer-table"><tr><td><table id="inner-table"><tr><td>nested</td></tr></table></td></tr></table>',
    TableRoles: '<div role="table" id="aria-table"><div role="cell">Only cell</div></div>',
    TableRowHeaderMismatch: '<table><thead><tr><th>Col</th></tr></thead><tbody><tr><th>Row</th><td>Data</td></tr></tbody></table>',
    TargetSize: '<div style="display:flex;gap:2px"><button id="tiny-a" style="width:18px;height:18px;padding:0">a</button><button id="tiny-b" style="width:18px;height:18px;padding:0">b</button></div>',
    VisibilityMismatch: '<p id="visible-hidden" aria-hidden="true">Visible hidden text content here</p>',
    VisibilityMisuse: '<p id="visually-hidden-at" style="opacity:0">Screen reader only copy here for misuse</p>',
  };

  const behavioralRules = new Set(['FocusNotObscuredFooter', 'StickyHeaderObscuresFocus', 'LinkCurrentPage']);

  for (const ruleId of COMPLEX_RULE_IDS) {
    if (behavioralRules.has(ruleId)) continue;
    const markup = fixtures[ruleId];
    assert.ok(markup, `missing focused fixture for ${ruleId}`);
    await withPage(`<html><body>${markup}</body></html>`, async (page) => {
      const { result } = await runComplexRules(page, [ruleId]);
      const findings = findingsForRule(result, ruleId);
      assert.ok(findings.length >= 1, `expected explicit firing for ${ruleId}`);
      assert.notEqual(findings[0].violationType, 'commercial-parity', ruleId);
    });
  }
});
