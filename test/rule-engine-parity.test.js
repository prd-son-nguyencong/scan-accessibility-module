import { readFileSync, readdirSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

import { loadBuiltInRuleRegistry } from '../src/scanner/access-scan/engine/builtin-registry.js';
import { runRules } from '../src/scanner/access-scan/engine/runner.js';
import { PROFILES } from '../src/scanner/access-scan/engine/profiles.js';
import { dedupeFindings } from '../src/scanner/access-scan/engine/finding.js';
import { createScanSession } from '../src/scanner/access-scan/runtime/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENGINE_ROOT = path.join(__dirname, '../src/scanner/access-scan/engine');
const EVALUATOR_ROOT = path.join(__dirname, '../src/scanner/access-scan/evaluators');
const RULES_ROOT = path.join(__dirname, '../src/scanner/access-scan/rules');
const RUNTIME_ROOT = path.join(__dirname, '../src/scanner/access-scan/runtime');

const FORBIDDEN_SOURCE_TOKENS = [
  'paradox',
  'bnetesting',
  'BNE',
  'Fresenius',
  'Hitachi',
  'data-testid',
  'referenceHtml',
  'reference-snapshot',
  'expectedFailureCount',
];

const PARITY_RULE_IDS = [
  'RegionMainContentMismatch',
  'RegionMainContentMisuse',
  'VisibilityMisuse',
  'PageTitleDescriptive',
  'TablistRole',
  'TabMismatch',
  'TabPanelMismatch',
  'StickyHeaderObscuresFocus',
  'RequiredFormFieldAriaRequired',
  'BreadcrumbsMismatch',
  'VisibleTextPartOfAccessibleName',
  'SearchFormMismatch',
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

async function runParityRules(page, ruleIds = PARITY_RULE_IDS) {
  const session = await createScanSession(page);
  const registry = await loadBuiltInRuleRegistry({ enforceCatalogContract: true });
  const skip = registry.getActiveRuleIds().filter((id) => !ruleIds.includes(id));
  const result = await runRules({
    registry,
    profile: PROFILES.COMMERCIAL_PARITY,
    context: { snapshot: session.snapshot, session },
    skipRules: skip,
  });
  return { session, registry, result };
}

function findingsForRule(result, ruleId) {
  return result.findings.filter((finding) => finding.ruleId === ruleId);
}

function elementKey(finding) {
  const { selector, framePath = [], shadowPath = [] } = finding.element;
  return `${finding.ruleId}|${selector}|${JSON.stringify(framePath)}|${JSON.stringify(shadowPath)}`;
}

test('commercial-parity and standards profiles expose independent check sets', async () => {
  const registry = await loadBuiltInRuleRegistry({ enforceCatalogContract: true });
  const standardsChecks = registry.getChecksForProfile(PROFILES.STANDARDS);
  const parityChecks = registry.getChecksForProfile(PROFILES.COMMERCIAL_PARITY);
  const parityOnly = parityChecks.filter(
    ({ check }) => check.profiles.length === 1 && check.profiles[0] === PROFILES.COMMERCIAL_PARITY,
  );
  const shared = parityChecks.filter(
    ({ check }) => check.profiles.includes(PROFILES.STANDARDS)
      && check.profiles.includes(PROFILES.COMMERCIAL_PARITY),
  );
  const standardsOnly = standardsChecks.filter(
    ({ check }) => !check.profiles.includes(PROFILES.COMMERCIAL_PARITY),
  );

  assert.ok(parityOnly.length >= 12, 'expected parity-only descriptor checks');
  assert.ok(shared.length >= 20, 'expected shared dual-profile checks');
  assert.ok(standardsOnly.length >= 40, 'expected standards-only checks');
  assert.ok(parityChecks.length < standardsChecks.length);
  assert.ok(
    shared.every(({ check }) => standardsChecks.some((entry) => entry.check.id === check.id)),
    'shared checks must also be available in standards',
  );
  assert.ok(
    standardsOnly.every(({ check }) => !parityChecks.some((entry) => entry.check.id === check.id)),
    'standards-only checks must not run in commercial-parity',
  );
});

test('commercial parity reports native italic markup as EmphasisMismatch without styled spans', async () => {
  await withPage(
    `
      <main>
        <p><i id="native-italic">Fortune</i></p>
        <p><span id="styled-italic" style="font-style: italic">Important</span></p>
      </main>
    `,
    async (page) => {
      const { result } = await runParityRules(page, ['EmphasisMismatch']);
      const findings = findingsForRule(result, 'EmphasisMismatch');
      assert.deepEqual(
        findings.map((finding) => finding.element.selector),
        ['i#native-italic'],
      );
    },
  );
});

test('commercial nested main boundary reports wrapper as RegionMainContentMismatch', async () => {
  await withPage(
    `
      <html lang="en">
        <head><title>Careers</title></head>
        <body>
          <header>
            <nav aria-label="Primary"><a href="/jobs">Jobs</a></nav>
          </header>
          <div id="themed-content">
            <div id="page-content">
              <main id="home">
                <h1>Restaurant careers</h1>
                <p>Find restaurant opportunities, learn about employee benefits, and choose a role that fits your experience and schedule.</p>
              </main>
            </div>
          </div>
          <footer>
            <p>© Example Company 2026. All Rights Reserved.</p>
          </footer>
        </body>
      </html>
    `,
    async (page) => {
      const { result } = await runParityRules(page, [
        'RegionMainContentMismatch',
        'RegionMainContentMisuse',
      ]);
      const mismatch = findingsForRule(result, 'RegionMainContentMismatch')
        .filter((finding) => finding.violationType === 'commercial-parity');
      const misuse = findingsForRule(result, 'RegionMainContentMisuse')
        .filter((finding) => finding.violationType === 'commercial-parity');
      assert.equal(mismatch.length, 1);
      assert.match(mismatch[0].element.outerHTML, /themed-content/);
      assert.equal(misuse.length, 1);
      assert.match(misuse[0].element.outerHTML, /id="home"/);
    },
  );
});

test('commercial icon projection honors an authored SVG alt label', async () => {
  await withPage(
    `
      <main>
        <svg id="brand-mark" role="img" alt="Example brand" width="120" height="60" viewBox="0 0 120 60">
          <rect width="120" height="60"></rect>
        </svg>
        <svg id="utility-icon" alt="Unsupported SVG label" width="24" height="24" viewBox="0 0 24 24">
          <path d="M2 12h20"></path>
        </svg>
      </main>
    `,
    async (page) => {
      const { result } = await runParityRules(page, ['AltMisuse', 'IconDiscernible']);
      assert.equal(findingsForRule(result, 'AltMisuse').length, 2);
      assert.deepEqual(
        findingsForRule(result, 'IconDiscernible')
          .map((finding) => finding.element.selector),
        ['svg#utility-icon'],
      );
    },
  );
});

test('commercial icon projection flags unnamed SVGs inside labeled icon-only controls', async () => {
  await withPage(
    `
      <main>
        <a id="home-link" href="/" aria-label="Go to careers home">
          <svg id="home-logo" width="143" height="28" viewBox="0 0 143 28">
            <rect width="143" height="28"></rect>
          </svg>
        </a>
        <a id="social-link" href="https://example.com/social" aria-label="Go to Example on Social">
          <svg id="social-icon" width="24" height="24" viewBox="0 0 24 24">
            <use href="#i-social"></use>
          </svg>
        </a>
      </main>
    `,
    async (page) => {
      const { result } = await runParityRules(page, ['IconDiscernible']);
      const icons = findingsForRule(result, 'IconDiscernible');
      assert.equal(icons.length, 2);
      assert.ok(icons.some((finding) => /home-logo/.test(finding.element.outerHTML)));
      assert.ok(icons.some((finding) => /social-icon/.test(finding.element.outerHTML)));
    },
  );
});

test('commercial svg role=img without aria name reports ImageDiscernible and ImageMisuse', async () => {
  await withPage(
    `
      <svg xmlns="http://www.w3.org/2000/svg" width="0" height="0" aria-hidden="true">
        <symbol id="brand-mark" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"></circle></symbol>
      </svg>
      <svg id="footer-logo" role="img" class="footer-logo" alt="Brand logo" width="140" height="60">
        <use href="#brand-mark"></use>
      </svg>
    `,
    async (page) => {
      const { result } = await runParityRules(page, ['ImageDiscernible', 'ImageMisuse']);
      const discernible = findingsForRule(result, 'ImageDiscernible')
        .filter((finding) => /footer-logo/.test(finding.element.outerHTML));
      const misuse = findingsForRule(result, 'ImageMisuse')
        .filter((finding) => /footer-logo/.test(finding.element.outerHTML));
      assert.equal(discernible.length, 1);
      assert.equal(misuse.length, 1);
    },
  );
});

test('commercial visibility misuse reports collapsed list items wrapping hidden disabled controls', async () => {
  await withPage(
    `
      <nav aria-label="Pagination">
        <ul>
          <li id="first-page-item">
            <a class="page-link page-link-first" aria-disabled="true" style="display:none">
              First
            </a>
          </li>
          <li id="prev-page-item">
            <a class="page-link page-link-previous" aria-disabled="true" style="display:none">
              Previous
            </a>
          </li>
          <li id="next-page-item">
            <a class="page-link page-link-next" href="/page/2" aria-disabled="false">
              Next
            </a>
          </li>
        </ul>
      </nav>
    `,
    async (page) => {
      const { result } = await runParityRules(page, ['VisibilityMisuse']);
      const findings = findingsForRule(result, 'VisibilityMisuse')
        .filter((finding) => finding.violationType === 'commercial-parity')
        .filter((finding) => (
          finding.evidence?.structuralPattern === 'collapsed-list-item-hidden-disabled-control'
        ));
      assert.equal(findings.length, 2);
      assert.ok(findings.every((finding) => /^<li\b/.test(finding.element.outerHTML)));
      assert.ok(findings.some((finding) => /first-page-item/.test(finding.element.outerHTML)));
      assert.ok(findings.some((finding) => /prev-page-item/.test(finding.element.outerHTML)));
      assert.ok(!findings.some((finding) => /next-page-item/.test(finding.element.outerHTML)));
    },
  );
});

test('commercial profile emits LinkPDFWarning when name lacks pdf and new-window cues', async () => {
  await withPage(
    `
      <main>
        <a href="/guide.pdf">Company handbook</a>
        <a href="/policy.PDF">Policy statement</a>
        <a href="/legal.pdf" aria-label="Legal PDF (opens in a new tab)">Legal</a>
      </main>
    `,
    async (page) => {
      const { result } = await runParityRules(page, ['LinkPDFWarning']);
      const findings = findingsForRule(result, 'LinkPDFWarning');
      assert.equal(findings.length, 2);
      assert.ok(findings.every((finding) => /\.pdf/i.test(finding.element.outerHTML)));
      assert.ok(!findings.some((finding) => /legal\.pdf/i.test(finding.element.outerHTML)));
    },
  );
});

test('commercial navigation misuse reports navigation links outside list structure', async () => {
  await withPage(
    `
      <nav id="primary-navigation" aria-label="Main navigation">
        <a href="/">Home</a>
        <a href="/jobs">Jobs</a>
      </nav>
      <nav id="footer-navigation" aria-label="Footer navigation">
        <a href="/privacy">Privacy</a>
      </nav>
    `,
    async (page) => {
      const { result } = await runParityRules(page, ['NavigationMisuse']);
      assert.deepEqual(
        findingsForRule(result, 'NavigationMisuse')
          .map((finding) => finding.element.selector)
          .sort(),
        ['nav#footer-navigation', 'nav#primary-navigation'],
      );
    },
  );
});

test('standards profile never runs parity-only checks', async () => {
  await withPage(
    `
      <html lang="en"><head><title>Login</title></head><body>
        <div class="shell-wrap-xyz">
          <header>Banner</header>
          <main>
            <h1>Login</h1>
            <form>
              <input type="password" autocomplete="current-password">
              <button type="submit">Sign in</button>
            </form>
          </main>
        </div>
      </body></html>
    `,
    async (page) => {
      const session = await createScanSession(page);
      const registry = await loadBuiltInRuleRegistry({ enforceCatalogContract: true });
      const result = await runRules({
        registry,
        profile: PROFILES.STANDARDS,
        context: { snapshot: session.snapshot, session },
        skipRules: registry.getActiveRuleIds().filter((id) => !PARITY_RULE_IDS.includes(id)),
      });
      assert.equal(
        result.findings.filter((finding) => finding.violationType === 'commercial-parity').length,
        0,
      );
    },
  );
});

test('neutral credential gate emits four parity findings plus captured ImageDiscernible', async () => {
  await withPage(
    `
      <html lang="en"><head><title>Login</title></head><body>
        <div class="shell-wrap-neutral">
          <header>Banner</header>
          <main>
            <h1>Login</h1>
            <form>
              <input type="password" autocomplete="current-password" value="secret123">
              <input type="hidden" name="token" value="tok">
              <button type="submit">Sign in</button>
            </form>
          </main>
        </div>
        <img src="logo.png">
      </body></html>
    `,
    async (page) => {
      const { result } = await runParityRules(page, [
        ...PARITY_RULE_IDS,
        'ImageDiscernible',
      ]);

      const parity = result.findings.filter((f) => f.violationType === 'commercial-parity');
      const ruleIds = new Set(parity.map((f) => f.ruleId));
      assert.deepEqual([...ruleIds].sort(), [
        'PageTitleDescriptive',
        'RegionMainContentMismatch',
        'RegionMainContentMisuse',
        'VisibilityMisuse',
      ]);
      assert.equal(parity.length, 4);

      const image = findingsForRule(result, 'ImageDiscernible');
      assert.equal(image.length, 1);
      assert.equal(image[0].violationType, 'confirmed');
      assert.equal(image[0].evidence.checkId, 'graphics:image-discernible');
    },
  );
});

test('credential gate evidence redacts secrets and never fabricates iframe entries', async () => {
  await withPage(
    `
      <html lang="en"><head><title>Gate</title></head><body>
        <div class="shell">
          <header>Banner</header>
          <main>
            <h1>Gate</h1>
            <form>
              <input type="password" value="p@ss">
              <input type="hidden" name="csrf" value="abc">
              <button type="submit">Go</button>
            </form>
          </main>
        </div>
      </body></html>
    `,
    async (page) => {
      const { result } = await runParityRules(page);
      const visibility = findingsForRule(result, 'VisibilityMisuse')[0];
      assert.equal(visibility.evidence.classification, 'commercial-parity-heuristic');
      assert.equal(visibility.evidence.domObserved, true);
      assert.match(JSON.stringify(visibility.evidence), /\[redacted\]/i);
      assert.doesNotMatch(JSON.stringify(visibility.evidence), /p@ss|abc/);
      const hidden = visibility.evidence.successfulHiddenElements || [];
      assert.ok(hidden.length >= 1);
      assert.ok(hidden.every((entry) => entry.outerHTML && entry.selector));
      assert.equal(hidden.some((entry) => /iframe/i.test(entry.outerHTML)), false);
    },
  );
});

test('disclosure aria-expanded groups derive counts from fixture without synthetic panels', async () => {
  const markup = `
    <section class="disclosure-wrap">
      <button aria-expanded="false" aria-controls="panel-a">Alpha</button>
      <button aria-expanded="true" aria-controls="panel-b">Beta</button>
      <div id="panel-a">Alpha panel</div>
      <div id="panel-b">Beta panel</div>
    </section>
  `;
  await withPage(markup, async (page) => {
    const { result } = await runParityRules(page, ['TablistRole', 'TabMismatch', 'TabPanelMismatch']);
    assert.equal(findingsForRule(result, 'TablistRole').length, 1);
    assert.equal(findingsForRule(result, 'TabMismatch').length, 2);
    assert.equal(findingsForRule(result, 'TabPanelMismatch').length, 2);
    for (const finding of result.findings) {
      assert.equal(finding.violationType, 'commercial-parity');
      assert.equal(finding.evidence.classification, 'commercial-parity-heuristic');
      assert.equal(finding.evidence.domObserved, true);
    }
  });
});

test('disclosure groups without aria-controls relationships emit no panel findings', async () => {
  await withPage(
    `
      <section>
        <button aria-expanded="false">One</button>
        <button aria-expanded="true">Two</button>
      </section>
    `,
    async (page) => {
      const { result } = await runParityRules(page, ['TablistRole', 'TabMismatch', 'TabPanelMismatch']);
      assert.equal(findingsForRule(result, 'TablistRole').length, 1);
      assert.equal(findingsForRule(result, 'TabMismatch').length, 2);
      assert.equal(findingsForRule(result, 'TabPanelMismatch').length, 0);
    },
  );
});

test('disclosure groups without aria-controls relationships emit no panel findings', async () => {
  await withPage(
    `
      <section>
        <button aria-expanded="false">One</button>
        <button aria-expanded="true">Two</button>
      </section>
    `,
    async (page) => {
      const { result } = await runParityRules(page, ['TablistRole', 'TabMismatch', 'TabPanelMismatch']);
      assert.equal(findingsForRule(result, 'TablistRole').length, 1);
      assert.equal(findingsForRule(result, 'TabMismatch').length, 2);
      assert.equal(findingsForRule(result, 'TabPanelMismatch').length, 0);
    },
  );
});

test('nested below-fold disclosure wrappers emit observed tab parity without viewport gating', async () => {
  await withPage(
    `
      <style>#below-fold-spacer { height: 2200px; }</style>
      <div id="below-fold-spacer"></div>
      <div id="filter-root" class="wrapper-outer">
        <div class="wrapper-inner-a">
          <div class="wrapper-inner-b">
            <button id="filter-a" aria-expanded="false">Filter A</button>
            <button id="filter-b" aria-expanded="false">Filter B</button>
            <button id="filter-c" aria-expanded="true">Filter C</button>
            <button id="filter-d" aria-expanded="false">Filter D</button>
          </div>
        </div>
      </div>
    `,
    async (page) => {
      const { result } = await runParityRules(page, ['TablistRole', 'TabMismatch', 'TabPanelMismatch']);
      const tablist = findingsForRule(result, 'TablistRole');
      const tabMismatch = findingsForRule(result, 'TabMismatch');
      const panelMismatch = findingsForRule(result, 'TabPanelMismatch');

      assert.equal(tablist.length, 1);
      assert.equal(tabMismatch.length, 4);
      assert.equal(panelMismatch.length, 0);
      assert.equal(tablist[0].evidence.triggerCount, 4);
      assert.ok(tablist[0].element.outerHTML.includes('wrapper-inner-b') || tablist[0].element.selector.includes('wrapper-inner-b'));
      assert.deepEqual(
        tabMismatch.map((finding) => finding.evidence.structuralPattern),
        Array(4).fill('aria-expanded-disclosure-trigger'),
      );
    },
  );
});

test('below-fold disclosure groups with scoped aria-controls panels emit panel parity', async () => {
  await withPage(
    `
      <style>#below-fold-spacer { height: 2200px; }</style>
      <div id="below-fold-spacer"></div>
      <section id="panel-group">
        <div class="wrapper-inner">
          <button id="trigger-a" aria-expanded="false" aria-controls="panel-a">Alpha</button>
          <button id="trigger-b" aria-expanded="true" aria-controls="panel-b">Beta</button>
        </div>
        <div id="panel-a">Alpha panel</div>
        <div id="panel-b">Beta panel</div>
      </section>
    `,
    async (page) => {
      const { result } = await runParityRules(page, ['TablistRole', 'TabMismatch', 'TabPanelMismatch']);
      assert.equal(findingsForRule(result, 'TablistRole').length, 1);
      assert.equal(findingsForRule(result, 'TabMismatch').length, 2);
      assert.equal(findingsForRule(result, 'TabPanelMismatch').length, 2);
    },
  );
});

test('random wrapper permutations preserve nested disclosure parity counts', async () => {
  const variants = [
    `
      <div id="below-fold-spacer" style="height:2200px"></div>
      <div class="shell-a">
        <div class="shell-b">
          <button aria-expanded="false">One</button>
          <button aria-expanded="true">Two</button>
          <button aria-expanded="false">Three</button>
          <button aria-expanded="false">Four</button>
        </div>
      </div>
    `,
    `
      <div style="height:2200px"></div>
      <section id="z9y8x7">
        <div class="layer-1">
          <button aria-expanded="false">One</button>
          <button aria-expanded="true">Two</button>
          <button aria-expanded="false">Three</button>
          <button aria-expanded="false">Four</button>
        </div>
      </section>
    `,
  ];

  const signatures = [];
  for (const body of variants) {
    await withPage(`<html><body>${body}</body></html>`, async (page) => {
      const { result } = await runParityRules(page, ['TablistRole', 'TabMismatch', 'TabPanelMismatch']);
      signatures.push(JSON.stringify({
        tablist: findingsForRule(result, 'TablistRole').length,
        tabMismatch: findingsForRule(result, 'TabMismatch').length,
        tabPanelMismatch: findingsForRule(result, 'TabPanelMismatch').length,
      }));
    });
  }

  assert.deepEqual(signatures, [
    JSON.stringify({ tablist: 1, tabMismatch: 4, tabPanelMismatch: 0 }),
    JSON.stringify({ tablist: 1, tabMismatch: 4, tabPanelMismatch: 0 }),
  ]);
});

test('below-fold checkbox search and current-nav parity scan page-wide active content', async () => {
  const server = createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end(`
      <html><body>
        <div style="height:2200px"></div>
        <nav aria-label="Primary">
          <a id="current-jobs" href="/jobs" aria-current="page">Jobs</a>
          <a href="/about">About</a>
        </nav>
        <label id="lbl">Accept terms</label>
        <input type="checkbox" id="agree" value="yes" aria-labelledby="lbl">
        <div class="search-group">
          <label for="query">Search jobs</label>
          <input id="query" type="search" name="role-query" placeholder="Search jobs">
          <button type="submit">Find roles</button>
        </div>
      </body></html>
    `);
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  try {
    await withPage(null, async (page) => {
      const { result } = await runParityRules(page, [
        'RequiredFormFieldAriaRequired',
        'SearchFormMismatch',
        'VisibleTextPartOfAccessibleName',
      ]);
      const current = findingsForRule(result, 'RequiredFormFieldAriaRequired')
        .filter((finding) => finding.violationType === 'commercial-parity');
      const search = findingsForRule(result, 'SearchFormMismatch')
        .filter((finding) => finding.violationType === 'commercial-parity');
      const checkbox = findingsForRule(result, 'VisibleTextPartOfAccessibleName')
        .filter((finding) => finding.violationType === 'commercial-parity');

      assert.equal(current.length, 1);
      assert.match(current[0].element.outerHTML, /current-jobs|Jobs/);
      assert.equal(search.length, 1);
      assert.equal(search[0].evidence.structuralPattern, 'search-controls-without-search-landmark');
      assert.equal(checkbox.length, 1);
      assert.equal(checkbox[0].evidence.visibleText, 'yes');
    }, { url: `http://127.0.0.1:${port}/jobs` });
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test('static sticky header does not emit parity without an obscuration signal', async () => {
  await withPage(
    `
      <style>
        #top-header { position: sticky; top: 0; height: 48px; background: #111; }
      </style>
      <header id="top-header">Sticky</header>
      <button id="safe-btn" style="margin-top:80px">Safe</button>
    `,
    async (page) => {
      const { result } = await runParityRules(page, ['StickyHeaderObscuresFocus']);
      const findings = findingsForRule(result, 'StickyHeaderObscuresFocus');
      assert.equal(findings.length, 0);
    },
  );
});

test('fixed and dynamically transformed sticky headers retain parity evidence', async () => {
  await withPage(
    `
      <header id="fixed-header" style="position: fixed; top: 0; width: 100%; height: 48px">
        Fixed navigation
      </header>
      <header id="transforming-header"
        style="position: sticky; top: 0; height: 48px; transform: translateY(0px)">
        Transforming navigation
      </header>
      <main style="margin-top: 120px">Content</main>
    `,
    async (page) => {
      const { result } = await runParityRules(page, ['StickyHeaderObscuresFocus']);
      const findings = findingsForRule(result, 'StickyHeaderObscuresFocus')
        .filter((finding) => finding.violationType === 'commercial-parity');

      assert.equal(findings.length, 2);
      assert.ok(findings.every((finding) => finding.evidence.hitTestConfirmed === false));
      assert.ok(findings.every((finding) => /manual review/i.test(finding.evidence.semanticAssessment)));
    },
  );
});

test('substantial static sticky headers retain parity evidence', async () => {
  await withPage(
    `
      <header id="substantial-header"
        style="position: sticky; top: 0; width: 100%; height: 120px">
        <a href="/">Home</a>
      </header>
      <main>Content</main>
    `,
    async (page) => {
      const { result } = await runParityRules(page, ['StickyHeaderObscuresFocus']);
      const findings = findingsForRule(result, 'StickyHeaderObscuresFocus')
        .filter((finding) => finding.violationType === 'commercial-parity');

      assert.equal(findings.length, 1);
      assert.match(findings[0].element.outerHTML, /substantial-header/);
    },
  );
});

test('current-link parity matches aria-current on direct-link navigation', async () => {
  await withPage(
    `
      <nav aria-label="Primary">
        <a id="current-aria" href="/about" aria-current="page">About</a>
        <a href="/contact">Contact</a>
      </nav>
    `,
    async (page) => {
      const { result } = await runParityRules(page, ['RequiredFormFieldAriaRequired']);
      const parity = findingsForRule(result, 'RequiredFormFieldAriaRequired')
        .filter((f) => f.violationType === 'commercial-parity');
      assert.equal(parity.length, 1);
      assert.match(parity[0].element.outerHTML, /current-aria|About/);
    },
  );
});

test('current-link parity matches exact session URL on direct-link navigation', async () => {
  const server = createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end(`
      <html><body>
        <nav aria-label="Primary">
          <a id="url-current" href="/jobs">Jobs</a>
          <a href="/about">About</a>
        </nav>
      </body></html>
    `);
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  try {
    await withPage(null, async (page) => {
      const { result } = await runParityRules(page, ['RequiredFormFieldAriaRequired']);
      const parity = findingsForRule(result, 'RequiredFormFieldAriaRequired')
        .filter((f) => f.violationType === 'commercial-parity');
      assert.equal(parity.length, 1);
      assert.match(parity[0].element.outerHTML, /url-current|Jobs/);
    }, { url: `http://127.0.0.1:${port}/jobs` });
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test('current-link parity matches standalone current class token on direct-link navigation', async () => {
  await withPage(
    `
      <nav aria-label="Primary">
        <a id="class-current" class="current" href="/about">About</a>
        <a href="/contact">Contact</a>
      </nav>
    `,
    async (page) => {
      const { result } = await runParityRules(page, ['RequiredFormFieldAriaRequired']);
      const parity = findingsForRule(result, 'RequiredFormFieldAriaRequired')
        .filter((f) => f.violationType === 'commercial-parity');
      assert.equal(parity.length, 1);
      assert.match(parity[0].element.outerHTML, /class-current|About/);
    },
  );
});

test('current navigation label groups preserve destination parity across active and aria-hidden menus', async () => {
  await withPage(
    `
      <nav aria-label="Desktop navigation">
        <a id="desktop-current" class="current" href="/">Careers Home</a>
      </nav>
      <nav aria-label="Mobile navigation" aria-hidden="true" style="display:none">
        <a id="mobile-current" class="current" href="/" tabindex="-1">Careers Home</a>
      </nav>
      <nav aria-label="Footer navigation">
        <a id="footer-copy" href="/">Careers Home</a>
      </nav>
      <div style="display:none">
        <nav aria-label="Hidden footer navigation">
          <a id="hidden-footer-copy" href="/">Careers Home</a>
        </nav>
      </div>
    `,
    async (page) => {
      const { result } = await runParityRules(page, ['LinkNavigationAmbiguous']);
      const parity = findingsForRule(result, 'LinkNavigationAmbiguous')
        .filter((finding) => finding.violationType === 'commercial-parity');
      assert.equal(parity.length, 3);
      assert.deepEqual(
        parity.map((finding) => finding.element.outerHTML.match(/id="([^"]+)"/)?.[1]).sort(),
        ['desktop-current', 'footer-copy', 'mobile-current'],
      );
    },
  );
});

test('current-link parity ignores links pointing to a different URL', async () => {
  const server = createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end(`
      <html><body>
        <nav aria-label="Primary">
          <a id="other-page" href="/about">About</a>
          <a href="/contact">Contact</a>
        </nav>
      </body></html>
    `);
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  try {
    await withPage(null, async (page) => {
      const { result } = await runParityRules(page, ['RequiredFormFieldAriaRequired']);
      const parity = findingsForRule(result, 'RequiredFormFieldAriaRequired')
        .filter((f) => f.violationType === 'commercial-parity');
      assert.equal(parity.length, 0);
    }, { url: `http://127.0.0.1:${port}/jobs` });
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test('semantic text job-search input maps to SearchFormMismatch parity without type=search', async () => {
  await withPage(
    `
      <div class="job-search-group">
        <label for="role-query">Search jobs</label>
        <input id="role-query" type="text" name="role-query" placeholder="Search jobs">
        <button type="submit">Find roles</button>
      </div>
    `,
    async (page) => {
      const { result } = await runParityRules(page, ['SearchFormMismatch']);
      const parity = findingsForRule(result, 'SearchFormMismatch')
        .filter((f) => f.violationType === 'commercial-parity');
      assert.equal(parity.length, 1);
      assert.equal(parity[0].evidence.structuralPattern, 'search-controls-without-search-landmark');
    },
  );
});

test('generic text input without search semantics does not map to SearchFormMismatch parity', async () => {
  await withPage(
    `
      <div class="contact-group">
        <label for="email">Email address</label>
        <input id="email" type="text" name="email" placeholder="you@example.com">
        <button type="submit">Send</button>
      </div>
    `,
    async (page) => {
      const { result } = await runParityRules(page, ['SearchFormMismatch']);
      const parity = findingsForRule(result, 'SearchFormMismatch')
        .filter((f) => f.violationType === 'commercial-parity');
      assert.equal(parity.length, 0);
    },
  );
});

test('credential gate hidden evidence stays scoped to the detected shell only', async () => {
  await withPage(
    `
      <html lang="en"><head><title>Gate</title></head><body>
        <input type="hidden" name="outside-secret" value="outside-token">
        <div class="shell">
          <header>Banner</header>
          <main>
            <h1>Gate</h1>
            <form>
              <input type="password" value="inside-pass">
              <input type="hidden" name="inside-secret" value="inside-token">
              <button type="submit">Go</button>
            </form>
          </main>
        </div>
      </body></html>
    `,
    async (page) => {
      const { result } = await runParityRules(page, ['VisibilityMisuse']);
      const visibility = findingsForRule(result, 'VisibilityMisuse')
        .find((f) => f.violationType === 'commercial-parity');
      assert.ok(visibility);
      const hidden = visibility.evidence.successfulHiddenElements || [];
      assert.ok(hidden.length >= 1);
      assert.ok(hidden.every((entry) => !/outside-secret|outside-token/.test(entry.outerHTML)));
      assert.ok(hidden.some((entry) => /inside-secret|\[redacted\]/.test(entry.outerHTML)));
      assert.doesNotMatch(JSON.stringify(visibility.evidence), /outside-token|inside-pass/);
    },
  );
});

test('same-origin iframe parity findings preserve non-empty framePath', async () => {
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
      const parity = result.findings.filter((f) => f.violationType === 'commercial-parity');
      assert.ok(parity.length >= 1);
      assert.ok(parity.some((f) => f.element.framePath.length > 0));
    },
  );
});

test('non-gate login shell does not emit credential gate parity findings', async () => {
  await withPage(
    `
      <html lang="en"><head><title>Workspace</title></head><body>
        <main>
          <h1>Workspace</h1>
          <form>
            <input type="password" autocomplete="current-password">
            <button type="submit">Sign in</button>
          </form>
        </main>
      </body></html>
    `,
    async (page) => {
      const { result } = await runParityRules(page, [
        'RegionMainContentMismatch',
        'RegionMainContentMisuse',
        'VisibilityMisuse',
        'PageTitleDescriptive',
      ]);
      const parity = result.findings.filter((f) => f.violationType === 'commercial-parity');
      const credentialGateFindings = parity.filter((finding) => (
        (finding.evidence.checkIds || [finding.evidence.checkId])
          .some((checkId) => checkId?.startsWith('parity:credential-gate-'))
      ));
      assert.equal(credentialGateFindings.length, 0);
      assert.equal(parity.filter((finding) => finding.ruleId === 'VisibilityMisuse').length, 1);
    },
  );
});

test('ordinary link and button row without disclosure evidence is not a submenu parity row', async () => {
  await withPage(
    `
      <nav aria-label="Primary">
        <div class="plain-row">
          <a href="/careers">Careers</a>
          <button type="button">Filter</button>
        </div>
      </nav>
    `,
    async (page) => {
      const { result } = await runParityRules(page, ['BreadcrumbsMismatch']);
      const parity = findingsForRule(result, 'BreadcrumbsMismatch')
        .filter((f) => f.violationType === 'commercial-parity');
      assert.equal(parity.length, 0);
    },
  );
});

test('dedupeFindings prefers commercial-parity over manual-review on same element', () => {
  const merged = dedupeFindings([
    {
      ruleId: 'StickyHeaderObscuresFocus',
      violationType: 'manual-review',
      severity: { impact: 'critical', priority: 1, wcagRef: 'WCAG 2.2 AA 2.4.11' },
      element: { outerHTML: '<header></header>', selector: 'header', framePath: [], shadowPath: [] },
      recommendation: 'Review',
      evidence: { checkId: 'manual:header', profile: 'standards' },
    },
    {
      ruleId: 'StickyHeaderObscuresFocus',
      violationType: 'commercial-parity',
      severity: { impact: 'critical', priority: 1, wcagRef: 'WCAG 2.2 AA 2.4.11' },
      element: { outerHTML: '<header></header>', selector: 'header', framePath: [], shadowPath: [] },
      recommendation: 'Review parity',
      evidence: { checkId: 'parity:header', profile: 'commercial-parity' },
    },
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].violationType, 'commercial-parity');
});

test('parity execution records expose honest per-mode examined counts', async () => {
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
      const { result } = await runParityRules(page, ['TablistRole', 'TabMismatch']);
      const tablistRecord = result.executionRecords.find((record) => record.ruleId === 'TablistRole');
      const tabRecord = result.executionRecords.find((record) => record.ruleId === 'TabMismatch');
      const tablistParity = tablistRecord?.checks.find((check) => check.checkId === 'parity:disclosure-tablist-role');
      const tabParity = tabRecord?.checks.find((check) => check.checkId === 'parity:disclosure-tab-mismatch');
      assert.ok(tablistParity);
      assert.ok(tabParity);
      assert.ok(tablistParity.candidateCount > 0);
      assert.ok(tablistParity.candidateCount < 500);
      assert.equal(tablistParity.candidateCount, tabParity.candidateCount);
      assert.equal(tablistParity.candidateCount, 2);
    },
  );
});

test('direct-link navigation current anchor maps to RequiredFormFieldAriaRequired parity', async () => {
  const server = createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end(`
      <html><body>
        <nav aria-label="Primary">
          <a id="current-page" href="/jobs" aria-current="page">Jobs</a>
          <a href="/about">About</a>
        </nav>
      </body></html>
    `);
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  try {
    await withPage(null, async (page) => {
      const { result } = await runParityRules(page, ['RequiredFormFieldAriaRequired']);
      const findings = findingsForRule(result, 'RequiredFormFieldAriaRequired');
      const parity = findings.filter((f) => f.violationType === 'commercial-parity');
      assert.equal(parity.length, 1);
      assert.match(parity[0].element.outerHTML, /current-page|Jobs/);
      assert.equal(parity[0].evidence.structuralPattern, 'current-link-in-direct-link-navigation');
    }, { url: `http://127.0.0.1:${port}/jobs` });
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test('primary-navigation submenu row maps to BreadcrumbsMismatch parity', async () => {
  await withPage(
    `
      <nav aria-label="Primary">
        <div class="submenu-row">
          <a href="/careers">Careers</a>
          <button aria-expanded="false">More</button>
        </div>
      </nav>
    `,
    async (page) => {
      const { result } = await runParityRules(page, ['BreadcrumbsMismatch']);
      const findings = findingsForRule(result, 'BreadcrumbsMismatch');
      assert.equal(findings.length, 1);
      assert.equal(findings[0].violationType, 'commercial-parity');
      assert.equal(findings[0].evidence.semanticAssessment, 'primary-navigation-submenu');
    },
  );
});

test('submenu row with generic toggle accessible name maps to BreadcrumbsMismatch parity', async () => {
  await withPage(
    `
      <nav aria-label="Primary">
        <div class="split-row">
          <a href="/careers">Careers</a>
          <button type="button" aria-label="Toggle Careers submenu">Toggle</button>
        </div>
        <div class="link-panel">
          <a href="/jobs/eng">Engineering</a>
          <a href="/jobs/sales">Sales</a>
        </div>
      </nav>
    `,
    async (page) => {
      const { result } = await runParityRules(page, ['BreadcrumbsMismatch']);
      const findings = findingsForRule(result, 'BreadcrumbsMismatch');
      assert.equal(findings.length, 1);
      assert.equal(findings[0].violationType, 'commercial-parity');
    },
  );
});

test('search-entry disclosure containers do not emit tab parity but checkbox filter groups still do', async () => {
  await withPage(
    `
      <section id="search-filters">
        <input type="search" placeholder="Find jobs">
        <button aria-expanded="false">Category</button>
        <button aria-expanded="true">Location</button>
      </section>
      <section id="checkbox-filters">
        <input type="checkbox" id="remote" name="remote">
        <label for="remote">Remote only</label>
        <button aria-expanded="false">Benefits</button>
        <button aria-expanded="true">Schedule</button>
      </section>
    `,
    async (page) => {
      const { result } = await runParityRules(page, ['TablistRole', 'TabMismatch', 'TabPanelMismatch']);
      assert.equal(findingsForRule(result, 'TablistRole').length, 1);
      assert.equal(findingsForRule(result, 'TabMismatch').length, 2);
      assert.equal(findingsForRule(result, 'TabPanelMismatch').length, 0);
      const tablist = findingsForRule(result, 'TablistRole')[0];
      assert.match(tablist.element.outerHTML, /checkbox-filters|Benefits|Schedule/i);
      assert.doesNotMatch(tablist.element.outerHTML, /search-filters|Category|Location/i);
    },
  );
});

test('independent labelled checkbox disclosures do not synthesize tab parity', async () => {
  await withPage(
    `
      <section id="independent-filters">
        <div>
          <div id="category-label" role="button" tabindex="0" aria-expanded="false">Category</div>
          <div role="group" aria-labelledby="category-label" hidden>
            <label><input type="checkbox"> Accounting</label>
          </div>
        </div>
        <div>
          <div id="state-label" role="button" tabindex="0" aria-expanded="false">State</div>
          <div role="group" aria-labelledby="state-label" hidden>
            <label><input type="checkbox"> Virginia</label>
          </div>
        </div>
        <div>
          <div id="city-label" role="button" tabindex="0" aria-expanded="false">City</div>
          <div role="group" aria-labelledby="city-label" hidden>
            <label><input type="checkbox"> Richmond</label>
          </div>
        </div>
      </section>
    `,
    async (page) => {
      const { result } = await runParityRules(page, ['TablistRole', 'TabMismatch']);

      assert.equal(findingsForRule(result, 'TablistRole').length, 0);
      assert.equal(findingsForRule(result, 'TabMismatch').length, 0);
    },
  );
});

test('visually exposed collapsed checkbox regions preserve tab parity', async () => {
  await withPage(
    `
      <section id="exposed-filters">
        <div>
          <div id="country-label" role="button" tabindex="0" aria-expanded="false">Country</div>
          <div role="group" aria-labelledby="country-label">
            <label><input type="checkbox"> Canada</label>
          </div>
        </div>
        <div>
          <div id="state-label" role="button" tabindex="0" aria-expanded="false">State</div>
          <div role="group" aria-labelledby="state-label">
            <label><input type="checkbox"> Ontario</label>
          </div>
        </div>
        <div>
          <div id="city-label" role="button" tabindex="0" aria-expanded="false">City</div>
          <div role="group" aria-labelledby="city-label">
            <label><input type="checkbox"> Toronto</label>
          </div>
        </div>
      </section>
    `,
    async (page) => {
      const { result } = await runParityRules(page, ['TablistRole', 'TabMismatch']);

      assert.equal(findingsForRule(result, 'TablistRole').length, 1);
      assert.equal(findingsForRule(result, 'TabMismatch').length, 3);
    },
  );
});

test('co-located popup launchers do not synthesize tab parity', async () => {
  await withPage(
    `
      <div id="assistant-launcher" aria-describedby="assistant-popover" tabindex="-1">
        <span role="button" tabindex="0" aria-haspopup="true" aria-expanded="false">
          Open recruiting assistant
        </span>
        <div role="button" tabindex="0" aria-haspopup="true" aria-expanded="false">
          Chat with recruiting assistant
        </div>
      </div>
      <div id="assistant-popover" role="dialog" hidden>Assistant</div>
    `,
    async (page) => {
      const { result } = await runParityRules(page, ['TablistRole', 'TabMismatch']);

      assert.equal(findingsForRule(result, 'TablistRole').length, 0);
      assert.equal(findingsForRule(result, 'TabMismatch').length, 0);
    },
  );
});

test('semantically equivalent responsive nav copies dedupe RequiredFormFieldAriaRequired parity', async () => {
  const server = createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end(`
      <html><body>
        <nav aria-label="Primary" class="desktop-copy">
          <a href="/jobs" aria-current="page">Jobs</a>
          <a href="/about">About</a>
        </nav>
        <nav aria-label="Primary" class="mobile-copy">
          <a href="/jobs" aria-current="page">Jobs</a>
          <a href="/about">About</a>
        </nav>
      </body></html>
    `);
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  try {
    await withPage(null, async (page) => {
      const { result } = await runParityRules(page, ['RequiredFormFieldAriaRequired']);
      const parity = findingsForRule(result, 'RequiredFormFieldAriaRequired')
        .filter((finding) => finding.violationType === 'commercial-parity');
      assert.equal(parity.length, 1);
    }, { url: `http://127.0.0.1:${port}/jobs` });
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test('distinct navigation landmarks keep separate submenu parity rows', async () => {
  await withPage(
    `
      <nav aria-label="Primary">
        <div><a href="/careers">Careers</a><button aria-label="Toggle submenu">More</button></div>
      </nav>
      <nav aria-label="Utility">
        <div><a href="/help">Help</a><button aria-label="Open menu">Menu</button></div>
      </nav>
    `,
    async (page) => {
      const { result } = await runParityRules(page, ['BreadcrumbsMismatch']);
      const findings = findingsForRule(result, 'BreadcrumbsMismatch')
        .filter((finding) => finding.violationType === 'commercial-parity');
      assert.equal(findings.length, 2);
    },
  );
});

test('checkbox aria-labelledby value anomaly maps to VisibleTextPartOfAccessibleName parity', async () => {
  await withPage(
    `
      <label id="lbl">Accept terms</label>
      <input type="checkbox" id="agree" value="yes" aria-labelledby="lbl">
    `,
    async (page) => {
      const { result } = await runParityRules(page, ['VisibleTextPartOfAccessibleName']);
      const parity = findingsForRule(result, 'VisibleTextPartOfAccessibleName')
        .filter((f) => f.violationType === 'commercial-parity');
      assert.equal(parity.length, 1);
      assert.equal(parity[0].evidence.visibleText, 'yes');
      assert.equal(typeof parity[0].evidence.labelInNameActuallyPasses, 'boolean');
      assert.ok(parity[0].evidence.accessibleName.length > 0);
    },
  );
});

test('search controls outside search landmark map to SearchFormMismatch parity', async () => {
  await withPage(
    `
      <div class="search-group">
        <label for="query">Find a role</label>
        <input id="query" type="search">
        <input id="place" type="text">
        <button type="submit">Search</button>
      </div>
    `,
    async (page) => {
      const { result } = await runParityRules(page, ['SearchFormMismatch']);
      const parity = findingsForRule(result, 'SearchFormMismatch')
        .filter((f) => f.violationType === 'commercial-parity');
      assert.equal(parity.length, 1);
      assert.equal(parity[0].evidence.structuralPattern, 'search-controls-without-search-landmark');
      assert.ok(parity[0].evidence.targetStrategy);
    },
  );
});

test('hydrated jobs-search chrome without role=search maps to SearchFormMismatch parity', async () => {
  await withPage(
    `
      <main id="page-main"><h1>Careers</h1><p>Primary content for the page.</p></main>
      <div class="c-jobs">
        <main class="c-jobs__main">
          <div class="c-jobs-list-only-wrap jobs-list-only" data-react-component="jobs-list-only">
            <ul><li><a href="/jobs/1">Role one</a></li></ul>
          </div>
        </main>
        <div
          class="c-jobs-search custom-search-box c-jobs-search__horizontal"
          data-testid="jobs-search_container">
          <div class="c-jobs-search__keyword">
            <label for="keyword-search">I'm Looking For</label>
            <input id="keyword-search" type="text" placeholder="Search jobs">
          </div>
          <div class="c-jobs-search__location">
            <label for="location-search">Positions Near</label>
            <input id="location-search" type="text" placeholder="City or zip">
          </div>
          <button type="button" class="c-jobs-search__button-search">Search</button>
        </div>
      </div>
    `,
    async (page) => {
      const { result } = await runParityRules(page, [
        'SearchFormMismatch',
        'RegionMainContentSingle',
      ]);
      const search = findingsForRule(result, 'SearchFormMismatch')
        .filter((finding) => finding.violationType === 'commercial-parity');
      assert.equal(search.length, 1);
      assert.match(search[0].element.outerHTML, /c-jobs-search|jobs-search_container/);

      const mains = findingsForRule(result, 'RegionMainContentSingle');
      assert.equal(mains.length, 1);
      assert.match(mains[0].element.outerHTML, /c-jobs__main/);
    },
  );
});

test('nested jobs-list main landmark maps to RegionMainContentMisuse parity', async () => {
  await withPage(
    `
      <main id="page-main">
        <h1>Careers</h1>
        <p>Primary content that establishes the page subject for screen reader users.</p>
        <div class="c-jobs">
          <main class="c-jobs__main">
            <div class="c-jobs-list-only-wrap jobs-list-only" data-react-component="jobs-list-only">
              <h3>Filter Results</h3>
              <ul><li><a href="/jobs/1">Role one</a></li></ul>
            </div>
          </main>
        </div>
      </main>
    `,
    async (page) => {
      const { result } = await runParityRules(page, [
        'RegionMainContentMisuse',
        'RegionMainContentSingle',
      ]);
      const misuse = findingsForRule(result, 'RegionMainContentMisuse')
        .filter((finding) => finding.violationType === 'commercial-parity');
      assert.equal(misuse.length, 1);
      assert.match(misuse[0].element.outerHTML, /c-jobs__main/);

      const singles = findingsForRule(result, 'RegionMainContentSingle');
      assert.equal(singles.length, 1);
      assert.match(singles[0].element.outerHTML, /c-jobs__main/);
    },
  );
});

test('duplicated responsive search control ids are not synthesized as search-landmark failures', async () => {
  await withPage(
    `
      <section>
        <label id="shared-query-label" for="shared-query">Find a role</label>
        <input id="shared-query" type="text" aria-labelledby="shared-query-label">
        <input type="text" aria-label="Location">
        <button type="button">Search jobs</button>
      </section>
      <section>
        <label id="shared-query-label" for="shared-query">Find a role</label>
        <input id="shared-query" type="text" aria-labelledby="shared-query-label">
        <input type="text" aria-label="Location">
        <button type="button">Search jobs</button>
      </section>
    `,
    async (page) => {
      const { result } = await runParityRules(page, ['SearchFormMismatch']);
      const parity = findingsForRule(result, 'SearchFormMismatch')
        .filter((finding) => finding.violationType === 'commercial-parity');
      assert.equal(parity.length, 0);
    },
  );
});

test('spatially distinct repeated search groups produce one semantic parity finding', async () => {
  await withPage(
    `
      <section>
        <label id="shared-query-label" for="shared-query">Search by keyword</label>
        <input id="shared-query" type="text" aria-labelledby="shared-query-label">
        <input type="text" aria-label="Location">
        <button type="button">Search jobs</button>
      </section>
      <div style="height: 1200px"></div>
      <section>
        <label id="shared-query-label" for="shared-query">Search by keyword</label>
        <input id="shared-query" type="text" aria-labelledby="shared-query-label">
        <input type="text" aria-label="Location">
        <button type="button">Search jobs</button>
      </section>
    `,
    async (page) => {
      const { result } = await runParityRules(page, ['SearchFormMismatch']);
      const parity = findingsForRule(result, 'SearchFormMismatch')
        .filter((finding) => finding.violationType === 'commercial-parity');

      assert.equal(parity.length, 1);
      assert.equal(
        parity[0].evidence.structuralPattern,
        'search-controls-without-search-landmark',
      );
    },
  );
});

test('visual button and panel state infers generic tab parity without class selectors', async () => {
  await withPage(
    `
      <section>
        <div id="visual-controls">
          <button data-slot="0">Clinical</button>
          <button data-slot="1">Corporate</button>
          <button data-slot="2">Technology</button>
        </div>
        <div style="width: 240px; overflow: hidden">
          <div style="display: flex">
            <div id="active-panel" style="width: 240px; flex: 0 0 auto; opacity: 1; pointer-events: auto">Panel one</div>
            <div style="width: 240px; flex: 0 0 auto; opacity: 0; pointer-events: none">Panel two</div>
            <div style="width: 240px; flex: 0 0 auto; opacity: 0; pointer-events: none">Panel three</div>
          </div>
        </div>
      </section>
    `,
    async (page) => {
      const { result } = await runParityRules(page, [
        'TablistRole', 'TabMismatch', 'TabPanelMismatch',
      ]);
      const tablists = findingsForRule(result, 'TablistRole')
        .filter((finding) => finding.violationType === 'commercial-parity');
      const tabs = findingsForRule(result, 'TabMismatch')
        .filter((finding) => finding.violationType === 'commercial-parity');
      const panels = findingsForRule(result, 'TabPanelMismatch')
        .filter((finding) => finding.violationType === 'commercial-parity');

      assert.equal(tablists.length, 1);
      assert.match(tablists[0].element.outerHTML, /visual-controls/);
      assert.equal(tabs.length, 3);
      assert.equal(panels.length, 1);
      assert.match(panels[0].element.outerHTML, /active-panel/);
    },
  );
});

test('commercial visibility parity observes exposed hidden structures without vendor tokens', async () => {
  await withPage(
    `
      <div style="position: relative; width: 100px; height: 40px">
        <div id="visible-but-hidden-from-at" aria-hidden="true"
          style="position: absolute; inset: 0; pointer-events: none">
          <img src="hero.jpg" alt="">
        </div>
      </div>
      <div style="position: relative; width: 200px; height: 100px; overflow: hidden">
        <div id="near-clipped" style="position: absolute; left: 220px; width: 100px; height: 80px">Near</div>
        <div id="substantially-clipped" style="position: absolute; left: 320px; width: 100px; height: 80px">Far</div>
      </div>
      <div id="empty-placeholder-a" style="width: 100px"><span></span></div>
      <div id="empty-placeholder-b" style="width: 100px"><span></span></div>
      <svg id="sprite-root" width="0" height="0"><symbol id="sprite-symbol"></symbol></svg>
      <iframe title="empty-frame" style="width: 0; height: 0" srcdoc="<body></body>"></iframe>
    `,
    async (page) => {
      const { result } = await runParityRules(page, ['VisibilityMismatch', 'VisibilityMisuse']);
      const mismatch = findingsForRule(result, 'VisibilityMismatch');
      const misuse = findingsForRule(result, 'VisibilityMisuse')
        .filter((finding) => finding.violationType === 'commercial-parity');

      assert.equal(mismatch.length, 1);
      assert.match(mismatch[0].element.outerHTML, /visible-but-hidden-from-at/);
      assert.equal(misuse.length, 5);
      assert.ok(misuse.some((finding) => /substantially-clipped/.test(finding.element.outerHTML)));
      assert.ok(!misuse.some((finding) => /near-clipped/.test(finding.element.outerHTML)));
      assert.equal(misuse.filter((finding) => /empty-placeholder-/.test(finding.element.outerHTML)).length, 2);
      assert.ok(misuse.some((finding) => /sprite-root/.test(finding.element.outerHTML)));
      assert.ok(misuse.some((finding) => finding.element.framePath.length === 0 && /^<body/.test(finding.element.outerHTML)));
      assert.ok(!misuse.some((finding) => finding.element.framePath.length > 0 && /body/.test(finding.element.outerHTML)));
    },
  );
});

test('commercial visibility parity identifies hidden symbol graphics by geometry and disabled context', async () => {
  await withPage(
    `
      <svg width="0" height="0" aria-hidden="true">
        <symbol id="decorative-symbol" viewBox="0 0 20 20"><path d="M0 0h20v20z"></path></symbol>
      </svg>
      <button aria-label="Previous item" disabled>
        <svg id="disabled-control-symbol" aria-hidden="true" width="22" height="22">
          <use href="#decorative-symbol"></use>
        </svg>
      </button>
      <button aria-label="Next item">
        <svg id="enabled-control-symbol" aria-hidden="true" width="22" height="22">
          <use href="#decorative-symbol"></use>
        </svg>
      </button>
      <div>
        <svg id="large-standalone-symbol-a" aria-hidden="true" width="70" height="140">
          <use href="#decorative-symbol"></use>
        </svg>
        <span>First recognition</span>
        <svg id="large-standalone-symbol-b" aria-hidden="true" width="140" height="30">
          <use href="#decorative-symbol"></use>
        </svg>
      </div>
    `,
    async (page) => {
      const { result } = await runParityRules(page, ['VisibilityMismatch']);
      const findings = findingsForRule(result, 'VisibilityMismatch')
        .filter((finding) => finding.violationType === 'commercial-parity');

      assert.equal(findings.length, 3);
      assert.ok(findings.some((finding) => /disabled-control-symbol/.test(finding.element.outerHTML)));
      assert.ok(findings.some((finding) => /large-standalone-symbol-a/.test(finding.element.outerHTML)));
      assert.ok(findings.some((finding) => /large-standalone-symbol-b/.test(finding.element.outerHTML)));
      assert.ok(!findings.some((finding) => /enabled-control-symbol/.test(finding.element.outerHTML)));
    },
  );
});

test('commercial landmark parity recognizes generic nested main and footer boundaries', async () => {
  await withPage(
    `
      <html lang="en">
        <head><title>Careers</title></head>
        <body>
          <div id="banner-shell">
            <header>
              <nav aria-label="Primary">
                <a href="/jobs">Jobs</a>
                <a href="/about">About</a>
              </nav>
            </header>
          </div>
          <div id="primary-shell">
            <div id="primary-boundary">
              <main id="primary-main">
                <h1>Restaurant careers</h1>
                <p>Find restaurant opportunities, learn about employee benefits, and choose a role that fits your experience and schedule.</p>
              </main>
            </div>
          </div>
          <div id="footer-shell">
            <div id="footer-boundary">
              <footer id="site-footer">
                <nav aria-label="Footer">
                  <a href="/privacy">Privacy</a>
                  <a href="/terms">Terms</a>
                </nav>
                <p>© Example Company 2026. All Rights Reserved.</p>
              </footer>
            </div>
            <div id="footer-scripts">
              <script type="application/json">{"analytics":true}</script>
              <noscript>Analytics fallback</noscript>
            </div>
          </div>
        </body>
      </html>
    `,
    async (page) => {
      const { result } = await runParityRules(page, [
        'RegionMainContentMismatch',
        'RegionMainContentMisuse',
        'RegionFooterMismatch',
        'RegionFooterMisuse',
      ]);
      const mainMismatch = findingsForRule(result, 'RegionMainContentMismatch')
        .filter((finding) => finding.violationType === 'commercial-parity');
      const mainMisuse = findingsForRule(result, 'RegionMainContentMisuse')
        .filter((finding) => finding.violationType === 'commercial-parity');
      const footerMismatch = findingsForRule(result, 'RegionFooterMismatch')
        .filter((finding) => finding.violationType === 'commercial-parity');
      const footerMisuse = findingsForRule(result, 'RegionFooterMisuse')
        .filter((finding) => finding.violationType === 'commercial-parity');

      assert.equal(mainMismatch.length, 1);
      assert.match(mainMismatch[0].element.outerHTML, /primary-shell/);
      assert.equal(mainMisuse.length, 1);
      assert.match(mainMisuse[0].element.outerHTML, /primary-main/);
      assert.equal(footerMismatch.length, 1);
      assert.match(footerMismatch[0].element.outerHTML, /footer-boundary/);
      assert.equal(footerMisuse.length, 1);
      assert.match(footerMisuse[0].element.outerHTML, /site-footer/);
    },
  );
});

test('commercial graphics parity derives inline symbol findings from semantics', async () => {
  await withPage(
    `
      <svg width="0" height="0" aria-hidden="true">
        <symbol id="generic-shape" viewBox="0 0 20 20">
          <rect width="20" height="20"></rect>
        </symbol>
      </svg>
      <a href="/search">
        <span>
          <svg id="unlabelled-action-symbol" width="30" height="30">
            <use href="#generic-shape"></use>
          </svg>
        </span>
        Search jobs
      </a>
      <div>
        <svg id="unlabelled-standalone-symbol" width="30" height="30">
          <use href="#generic-shape"></use>
        </svg>
        <span>© Example Company</span>
      </div>
      <a href="#top">
        <span>
          <svg id="contextually-decorative-symbol" width="30" height="30">
            <use href="#generic-shape"></use>
          </svg>
        </span>
        <span>Back to top</span>
      </a>
      <svg id="named-symbol-a" role="img" aria-label="Benefit one" width="30" height="30">
        <use href="#generic-shape"></use>
      </svg>
      <svg id="named-symbol-b" role="img" aria-label="Benefit two" width="30" height="30">
        <use href="#generic-shape"></use>
      </svg>
    `,
    async (page) => {
      const { result } = await runParityRules(page, ['IconDiscernible', 'ImageMisuse']);
      const icons = findingsForRule(result, 'IconDiscernible')
        .filter((finding) => finding.violationType === 'commercial-parity');
      const imageRoles = findingsForRule(result, 'ImageMisuse')
        .filter((finding) => finding.violationType === 'commercial-parity');

      assert.equal(icons.length, 2);
      assert.ok(icons.some((finding) => /unlabelled-action-symbol/.test(finding.element.outerHTML)));
      assert.ok(icons.some((finding) => /unlabelled-standalone-symbol/.test(finding.element.outerHTML)));
      assert.ok(!icons.some((finding) => /contextually-decorative-symbol/.test(finding.element.outerHTML)));
      assert.equal(imageRoles.length, 2);
      assert.ok(imageRoles.every((finding) => /named-symbol-/.test(finding.element.outerHTML)));
    },
  );
});

test('commercial article parity reviews rendered article regions even when they have headings', async () => {
  await withPage(
    `
      <article id="article-one">
        <h2>Customer service</h2>
        <p>Self-contained information with enough detail to satisfy the standards heuristic.</p>
      </article>
      <article id="article-two">
        <h2>Operations</h2>
        <p>Another self-contained card with a heading and substantial supporting copy.</p>
      </article>
      <article id="hidden-article" hidden><h2>Hidden</h2></article>
    `,
    async (page) => {
      const { result } = await runParityRules(page, ['ArticleMisuse']);
      const parity = findingsForRule(result, 'ArticleMisuse')
        .filter((finding) => finding.violationType === 'commercial-parity');

      assert.equal(parity.length, 2);
      assert.ok(parity.some((finding) => /article-one/.test(finding.element.outerHTML)));
      assert.ok(parity.some((finding) => /article-two/.test(finding.element.outerHTML)));
      assert.ok(!parity.some((finding) => /hidden-article/.test(finding.element.outerHTML)));
    },
  );
});

test('commercial icon parity checks every rendered unnamed SVG but honors its own semantics', async () => {
  await withPage(
    `
      <svg width="0" height="0" aria-hidden="true">
        <symbol id="shape" viewBox="0 0 16 16"><path d="M0 0h16v16H0z"></path></symbol>
      </svg>
      <a href="/jobs">
        <span>Search jobs</span>
        <svg id="unnamed-symbol" width="16" height="16"><use href="#shape"></use></svg>
      </a>
      <button>
        Sort
        <span aria-hidden="true">
          <svg id="hidden-by-parent" width="16" height="16"><path d="M0 0h16v16H0z"></path></svg>
        </span>
      </button>
      <svg id="standalone-path" width="16" height="16"><path d="M0 0h16v16H0z"></path></svg>
      <svg id="decorative-vector-overlay" width="100" height="100" viewBox="0 0 100 100" preserveAspectRatio="none">
        <path d="M0 0h100v50H0z"></path>
        <path d="M0 50h100v50H0z"></path>
      </svg>
      <a href="/chat">
        <svg id="presentational" role="presentation" width="16" height="16"><use href="#shape"></use></svg>
        Chat
      </a>
      <svg id="named" aria-label="Status" width="16" height="16"><use href="#shape"></use></svg>
      <svg id="self-hidden" aria-hidden="true" width="16" height="16"><use href="#shape"></use></svg>
      <div hidden>
        <svg id="not-rendered" width="16" height="16"><use href="#shape"></use></svg>
      </div>
    `,
    async (page) => {
      const { result } = await runParityRules(page, ['IconDiscernible']);
      const parity = findingsForRule(result, 'IconDiscernible')
        .filter((finding) => finding.violationType === 'commercial-parity');

      assert.equal(parity.length, 2);
      assert.ok(parity.some((finding) => /unnamed-symbol/.test(finding.element.outerHTML)));
      assert.ok(parity.some((finding) => /standalone-path/.test(finding.element.outerHTML)));
      assert.ok(!parity.some((finding) => /id="(?:hidden-by-parent|decorative-vector-overlay|presentational|named|self-hidden|not-rendered)"/.test(
        finding.element.outerHTML,
      )));
    },
  );
});

test('commercial link parity reports repeated active link text across card contexts', async () => {
  await withPage(
    `
      <article>
        <h2>Operations</h2>
        <a id="learn-operations" href="/operations"><span>Learn more</span></a>
      </article>
      <article>
        <h2>Maintenance</h2>
        <a id="learn-maintenance" href="/maintenance"><span>Learn more</span></a>
      </article>
      <article>
        <h2>Technology</h2>
        <a href="/technology" aria-label="Learn more about technology">Learn more</a>
      </article>
      <a href="/job/one" aria-label="Apply now, Engineer">Engineer</a>
      <a href="/job/two" aria-label="Apply now, Engineer">Engineer</a>
      <a href="https://example.com/login" aria-label="Current associate login">Login</a>
      <a href="https://example.org/login" aria-label="Current associate login">Login</a>
      <a id="responsive-read-one" href="/story/one">Read more</a>
      <a id="responsive-read-copy" href="/story/one">Read more</a>
      <a id="responsive-read-two" href="/story/two">Read more</a>
    `,
    async (page) => {
      const { result } = await runParityRules(page, ['LinkNavigationAmbiguous']);
      const parity = findingsForRule(result, 'LinkNavigationAmbiguous')
        .filter((finding) => finding.violationType === 'commercial-parity');

      assert.equal(parity.length, 2);
      assert.ok(parity.some((finding) => /learn-operations/.test(finding.element.outerHTML)));
      assert.ok(parity.some((finding) => /learn-maintenance/.test(finding.element.outerHTML)));
      assert.ok(!parity.some((finding) => /responsive-read/.test(finding.element.outerHTML)));
    },
  );
});

test('commercial mismatch parity catches pseudo href hosts, chrome icon links, and deferred deictic CTAs', async () => {
  await withPage(
    `
      <nav aria-label="Primary">
        <span id="language-toggle" href="#" style="cursor:pointer">Language</span>
        <a href="/" aria-label="Home">Home</a>
      </nav>
      <footer>
        <a id="social-linkedin" href="https://www.linkedin.com/company/example/">
          <i class="fa-brands fa-linkedin"></i>
        </a>
      </footer>
      <main>
        <a id="signup-cta" href="https://example.com/introduceYourself" target="_blank"
           style="visibility:hidden;opacity:0">Sign up here</a>
        <a id="unique-learn" href="/only-learn">Learn more</a>
      </main>
    `,
    async (page) => {
      const buttonResult = await runParityRules(page, ['ButtonMismatch']);
      const buttons = findingsForRule(buttonResult.result, 'ButtonMismatch');
      assert.ok(buttons.some((finding) => /language-toggle/.test(finding.element.outerHTML)));

      const discernibleResult = await runParityRules(page, ['LinkNavigationDiscernible']);
      const discernible = findingsForRule(discernibleResult.result, 'LinkNavigationDiscernible');
      assert.ok(discernible.some((finding) => /social-linkedin/.test(finding.element.outerHTML)));

      const ambiguousResult = await runParityRules(page, ['LinkNavigationAmbiguous']);
      const ambiguous = findingsForRule(ambiguousResult.result, 'LinkNavigationAmbiguous')
        .filter((finding) => finding.violationType === 'commercial-parity');
      assert.ok(ambiguous.some((finding) => /signup-cta/.test(finding.element.outerHTML)));
      assert.ok(!ambiguous.some((finding) => /unique-learn/.test(finding.element.outerHTML)));
    },
  );
});

test('commercial visibility parity recognizes hidden action symbols and control state indicators', async () => {
  await withPage(
    `
      <svg width="0" height="0" aria-hidden="true">
        <symbol id="chevron" viewBox="0 0 8 12"><path d="M0 0l8 6-8 6z"></path></symbol>
      </svg>
      <a href="/one">Learn more <svg id="action-one" aria-hidden="true" width="8" height="12"><use href="#chevron"></use></svg></a>
      <a href="/two">Learn more <svg id="action-two" aria-hidden="true" width="8" height="12"><use href="#chevron"></use></svg></a>
      <a href="/one-off">Explore opportunities <svg id="one-off-action" aria-hidden="true" width="8" height="12"><use href="#chevron"></use></svg></a>
      <a href="/described-one" aria-label="Learn more about benefits">Learn more <svg id="described-action-one" aria-hidden="true" width="8" height="12"><use href="#chevron"></use></svg></a>
      <a href="/described-two" aria-label="Learn more about culture">Learn more <svg id="described-action-two" aria-hidden="true" width="8" height="12"><use href="#chevron"></use></svg></a>
      <a href="/safe">
        <span role="presentation">
          <svg id="presentation-symbol" aria-hidden="true" width="8" height="12"><use href="#chevron"></use></svg>
        </span>
        Safe
      </a>
      <button aria-haspopup="listbox">
        Date
        <span id="state-indicator" aria-hidden="true">
          <svg width="16" height="16"><path d="M0 0h16v16H0z"></path></svg>
        </span>
      </button>
      <button aria-label="Use your location">
        <svg id="labelled-control-cue" aria-hidden="true" width="16" height="16">
          <text x="0" y="12">Use your location</text>
        </svg>
      </button>
    `,
    async (page) => {
      const { result } = await runParityRules(page, ['VisibilityMismatch']);
      const parity = findingsForRule(result, 'VisibilityMismatch')
        .filter((finding) => finding.violationType === 'commercial-parity');

      assert.equal(parity.length, 3);
      assert.ok(parity.some((finding) => /action-one/.test(finding.element.outerHTML)));
      assert.ok(parity.some((finding) => /action-two/.test(finding.element.outerHTML)));
      assert.ok(parity.some((finding) => /state-indicator/.test(finding.element.outerHTML)));
      assert.ok(!parity.some((finding) => /one-off-action|described-action|presentation-symbol|labelled-control-cue/.test(
        finding.element.outerHTML,
      )));
    },
  );
});

test('commercial visibility parity includes zero-height component mounts with only an empty list', async () => {
  await withPage(
    `
      <div id="empty-status-mount" data-component="current-state" style="width: 300px; height: 0">
        <span>Search filters</span>
        <ul></ul>
      </div>
      <div id="populated-status-mount" data-component="current-state">
        <span>Search filters</span>
        <ul><li>Remote</li></ul>
      </div>
    `,
    async (page) => {
      const { result } = await runParityRules(page, ['VisibilityMisuse']);
      const parity = findingsForRule(result, 'VisibilityMisuse')
        .filter((finding) => (
          finding.violationType === 'commercial-parity'
          && finding.evidence.structuralPattern === 'empty-framework-component-mount'
        ));

      assert.equal(parity.length, 1);
      assert.match(parity[0].element.outerHTML, /empty-status-mount/);
    },
  );
});

test('commercial tab parity prefers the first grouped action buttons over later disclosures', async () => {
  await withPage(
    `
      <section aria-label="Privacy notice">
        <div id="notice-actions" style="display:flex; gap:8px">
          <button aria-haspopup="dialog">Customise</button>
          <button>Reject all</button>
          <button>Accept all</button>
        </div>
      </section>
      <div style="height: 800px"></div>
      <section id="later-disclosures">
        <button aria-expanded="false">Career path</button>
        <button aria-expanded="false">Country</button>
        <button aria-expanded="false">Workplace</button>
      </section>
    `,
    async (page) => {
      const { result } = await runParityRules(page, ['TablistRole', 'TabMismatch']);
      const tablists = findingsForRule(result, 'TablistRole')
        .filter((finding) => finding.violationType === 'commercial-parity');
      const tabs = findingsForRule(result, 'TabMismatch')
        .filter((finding) => finding.violationType === 'commercial-parity');

      assert.equal(tablists.length, 1);
      assert.match(tablists[0].element.outerHTML, /notice-actions/);
      assert.equal(tabs.length, 3);
      assert.ok(tabs.every((finding) => /Customise|Reject all|Accept all/.test(
        finding.element.outerHTML,
      )));
    },
  );
});

test('commercial navigation parity preserves layout-wrapper and multi-list landmark targets', async () => {
  await withPage(
    `
      <header>
        <nav aria-label="Primary">
          <div id="main-layout">
            <ul>
              <li><a href="/one">One</a></li>
              <li><a href="/two">Two</a></li>
              <li><a href="/three">Three</a></li>
            </ul>
            <a href="/search">Search</a>
          </div>
        </nav>
      </header>
      <footer>
        <nav id="multi-list-nav">
          <section><span>Regional notices</span><ul><li><a href="/a">A</a></li></ul></section>
          <section><span>Global notices</span><ul><li><a href="/b">B</a></li></ul></section>
        </nav>
      </footer>
    `,
    async (page) => {
      const { result } = await runParityRules(page, ['MainNavigationMismatch', 'NavigationMisuse']);
      const mainLayout = findingsForRule(result, 'MainNavigationMismatch')
        .filter((finding) => finding.violationType === 'commercial-parity');
      const navigation = findingsForRule(result, 'NavigationMisuse')
        .filter((finding) => finding.violationType === 'commercial-parity');

      assert.equal(mainLayout.length, 1);
      assert.match(mainLayout[0].element.outerHTML, /main-layout/);
      assert.equal(navigation.length, 1);
      assert.ok(navigation.some((finding) => /multi-list-nav/.test(finding.element.outerHTML)));
    },
  );
});

test('commercial search parity suppresses multiple stable unlandmarked search widgets', async () => {
  await withPage(
    `
      <section>
        <label for="query-one">Search by keyword</label>
        <input id="query-one" type="text">
        <input id="place-one" type="text" aria-label="Location">
        <button type="button">Search jobs</button>
      </section>
      <div style="height: 900px"></div>
      <section>
        <label for="query-two">Search by keyword</label>
        <input id="query-two" type="text">
        <input id="place-two" type="text" aria-label="Location">
        <button type="button">Search jobs</button>
      </section>
    `,
    async (page) => {
      const { result } = await runParityRules(page, ['SearchFormMismatch']);
      const parity = findingsForRule(result, 'SearchFormMismatch')
        .filter((finding) => finding.violationType === 'commercial-parity');
      assert.equal(parity.length, 0);
    },
  );
});

test('commercial submenu parity requires separate link and disclosure controls', async () => {
  await withPage(
    `
      <nav aria-label="Primary">
        <ul>
          <li id="single-control-row">
            <a href="/careers" role="button">Careers</a>
            <div><ul><li><a href="/careers/one">Career one</a></li></ul></div>
          </li>
        </ul>
      </nav>
    `,
    async (page) => {
      const { result } = await runParityRules(page, ['BreadcrumbsMismatch']);
      const parity = findingsForRule(result, 'BreadcrumbsMismatch')
        .filter((finding) => finding.violationType === 'commercial-parity');
      assert.equal(parity.length, 0);
    },
  );
});

test('commercial visibility parity derives generic lazy, scroll, script, and custom-root structures', async () => {
  await withPage(
    `
      <main id="top">
        <div id="lazy-visual-a" data-scroll
          style="position:relative;width:200px;height:100px">
          <div role="img" aria-label="First scene" data-src="/first.jpg"
            style="position:absolute;inset:0;background-image:url('/first.jpg')"></div>
        </div>
        <div id="lazy-visual-b" data-scroll data-scroll-speed="-1" data-scroll-position="middle"
          style="position:relative;width:200px;height:100px">
          <div role="img" aria-label="Second scene" data-src="/second.jpg"
            style="position:absolute;inset:0;background-image:url('/second.jpg')"></div>
        </div>
        <div id="animated-reveal" data-scroll data-scroll-class="is-visible"
          style="position:relative;width:200px;height:100px">
          <div role="img" aria-label="Reveal scene" data-src="/reveal.jpg"></div>
        </div>
        <div id="positionless-parallax" data-scroll data-scroll-speed="-1"
          style="position:relative;width:200px;height:100px">
          <div role="img" aria-label="Parallax scene" data-src="/parallax.jpg"></div>
        </div>
      </main>
      <div id="scroll-control-shell" style="height:100px">
        <a data-scroll-to href="#top"><span>Back to top</span></a>
      </div>
      <div id="script-only-shell">
        <script type="application/json">{"enabled":true}</script>
        <noscript>Fallback integration</noscript>
      </div>
      <div style="width:200px;height:100px;overflow:hidden">
        <div id="carousel-track" aria-live="off"
          style="display:flex;transform:translateX(-600px)">
          <div id="carousel-slide" role="group" style="width:200px;flex:0 0 auto">Slide</div>
        </div>
      </div>
      <generic-apply-root id="custom-root"></generic-apply-root>
      <script>
        customElements.define('generic-apply-root', class extends HTMLElement {
          connectedCallback() {
            this.attachShadow({ mode: 'open' }).innerHTML =
              '<div id="shadow-empty-root"><span></span></div>';
          }
        });
      </script>
    `,
    async (page) => {
      const { result } = await runParityRules(page, ['VisibilityMisuse']);
      const findings = findingsForRule(result, 'VisibilityMisuse')
        .filter((finding) => finding.violationType === 'commercial-parity');

      assert.equal(
        findings.length,
        6,
        findings.map((finding) => finding.element.outerHTML).join('\n'),
      );
      for (const marker of [
        'lazy-visual-a',
        'lazy-visual-b',
        'scroll-control-shell',
        'script-only-shell',
        'custom-root',
      ]) {
        assert.ok(
          findings.some((finding) => finding.element.outerHTML.includes(marker)),
          `missing ${marker}`,
        );
      }
      // Shadow-tree empties are skipped (shadowPath) to avoid chat-widget over-fire;
      // the custom host itself still counts.
      assert.ok(!findings.some((finding) => /shadow-empty-root/.test(finding.element.outerHTML)));
      assert.ok(findings.some((finding) => (
        finding.element.framePath.length === 0
        && /^<body/.test(finding.element.outerHTML)
      )));
      assert.ok(!findings.some((finding) => /carousel-track|carousel-slide/.test(finding.element.outerHTML)));
      assert.ok(!findings.some((finding) => /animated-reveal|positionless-parallax/.test(finding.element.outerHTML)));
    },
  );
});

test('commercial visibility parity flags empty opacity overlays without counting opaque content trees', async () => {
  await withPage(
    `
      <div style="position: relative; width: 240px; height: 160px">
        <img src="/card.jpg" alt="Career card">
        <div id="empty-opacity-overlay-a"
          style="position: absolute; inset: 0; opacity: 0; background: rgba(0,80,40,0.4)"> </div>
        <div id="empty-opacity-overlay-b"
          style="position: absolute; top: 0; right: 0; bottom: 0; left: 0; opacity: 0"></div>
        <div id="contentful-opacity-overlay"
          style="position: absolute; inset: 0; opacity: 0; pointer-events: none">
          Hover details for assistive technology
        </div>
        <div id="static-empty-opacity"
          style="opacity: 0; width: 40px; height: 40px"></div>
      </div>
    `,
    async (page) => {
      const { result } = await runParityRules(page, ['VisibilityMisuse']);
      const findings = findingsForRule(result, 'VisibilityMisuse')
        .filter((finding) => finding.violationType === 'commercial-parity');

      assert.equal(
        findings.filter((finding) => /empty-opacity-overlay-/.test(finding.element.outerHTML)).length,
        2,
      );
      assert.ok(!findings.some((finding) => /contentful-opacity-overlay/.test(finding.element.outerHTML)));
      assert.ok(!findings.some((finding) => /static-empty-opacity/.test(finding.element.outerHTML)));
    },
  );
});

test('commercial visibility parity flags collapsed text, dual-state images, and thin presentation dividers', async () => {
  await withPage(
    `
      <video controls width="320" height="180">
        <source src="/hero.mp4" type="video/mp4">
        <p id="video-fallback-copy">Your browser does not support HTML5 video.</p>
      </video>
      <video id="opacity-hidden-video" src="/clip.mp4"
        style="width: 320px; height: 180px; opacity: 0"></video>
      <div style="width: 320px">
        <p id="collapsed-hover-copy" class="paragraph"
          style="overflow: auto; max-height: 0; height: 0; margin: 0">
          Explore open clinical roles across the region.
        </p>
      </div>
      <div style="position: relative; width: 160px; height: 48px">
        <img id="visible-dual-logo" src="/logo-light.png" alt=""
          style="position: absolute; inset: 0; width: 160px; height: 48px; opacity: 1">
        <img id="hidden-dual-logo" src="/logo-dark.png" alt=""
          style="position: absolute; inset: 0; width: 160px; height: 48px; opacity: 0">
      </div>
      <div style="position: relative; width: 80px; height: 80px">
        <img src="/poster.jpg" alt="">
        <i id="opacity-play-icon" role="presentation" class="fa-solid fa-play"
          style="position: absolute; inset: 0; opacity: 0; width: 24px; height: 24px"></i>
      </div>
      <div id="thin-presentation-divider" role="presentation"
        style="width: 2px; height: 173px; background: #ddd"></div>
      <div id="full-bleed-presentation" role="presentation"
        style="width: 640px; height: 360px; background: #eee"></div>
    `,
    async (page) => {
      const { result } = await runParityRules(page, ['VisibilityMisuse']);
      const findings = findingsForRule(result, 'VisibilityMisuse')
        .filter((finding) => finding.violationType === 'commercial-parity');

      for (const marker of [
        'video-fallback-copy',
        'opacity-hidden-video',
        'collapsed-hover-copy',
        'hidden-dual-logo',
        'visible-dual-logo',
        'opacity-play-icon',
        'thin-presentation-divider',
      ]) {
        assert.ok(
          findings.some((finding) => finding.element.outerHTML.includes(marker)),
          marker,
        );
      }
      assert.ok(!findings.some((finding) => /full-bleed-presentation/.test(finding.element.outerHTML)));
    },
  );
});

test('descriptive labels ending in Apply Here are not deictic LinkNavigationAmbiguous', async () => {
  await withPage(
    `
      <a id="employee-apply" href="https://example.com/login">Current Employees Apply Here</a>
      <a id="bare-apply" href="https://example.com/apply">Apply here</a>
    `,
    async (page) => {
      const { result } = await runParityRules(page, ['LinkNavigationAmbiguous']);
      const parity = findingsForRule(result, 'LinkNavigationAmbiguous')
        .filter((finding) => finding.violationType === 'commercial-parity');

      assert.ok(parity.some((finding) => /bare-apply/.test(finding.element.outerHTML)));
      assert.ok(!parity.some((finding) => /employee-apply/.test(finding.element.outerHTML)));
    },
  );
});

test('decorated See Jobs and Learn More CTAs are LinkNavigationAmbiguous', async () => {
  await withPage(
    `
      <main>
        <a id="see-jobs" class="a__btn" href="/jobs">See Jobs ›</a>
        <a id="learn-more-arrow" class="a__btn" href="/living">Learn More ›</a>
        <a id="nursing-see" href="/nursing-jobs">Nursing See Jobs ›</a>
      </main>
    `,
    async (page) => {
      const { result } = await runParityRules(page, ['LinkNavigationAmbiguous']);
      const parity = findingsForRule(result, 'LinkNavigationAmbiguous')
        .filter((finding) => finding.violationType === 'commercial-parity');
      assert.ok(parity.some((finding) => /see-jobs/.test(finding.element.outerHTML)));
      assert.ok(parity.some((finding) => /learn-more-arrow/.test(finding.element.outerHTML)));
      assert.ok(!parity.some((finding) => /nursing-see/.test(finding.element.outerHTML)));
      assert.equal(parity.length, 2);
    },
  );
});

test('View Jobs card CTAs and Search Jobs Now inventory links are LinkNavigationAmbiguous', async () => {
  await withPage(
    `
      <main>
        <a id="view-ops" href="/operations" class="text-teal">View Jobs</a>
        <a id="view-ops-hover" href="/operations" class="text-teal" style="visibility:hidden;opacity:0">View Jobs</a>
        <a id="view-corp" href="/corporate" class="text-teal">View Jobs</a>
        <a id="view-corp-hover" href="/corporate" class="text-teal" style="visibility:hidden;opacity:0">View Jobs</a>
        <a id="view-care" href="/care" class="text-teal">View Jobs</a>
        <a id="search-now" href="/jobs" class="button">Search Jobs Now</a>
        <a id="search-now-mobile" href="/jobs" class="button" style="display:none">Search Jobs Now</a>
        <a id="view-all" href="/jobs">View All Jobs</a>
        <a id="search-plain" href="/jobs">Search Jobs</a>
      </main>
      <header>
        <a id="logo-link" href="/"><svg width="100" height="40"><rect width="100" height="40"></rect></svg></a>
      </header>
    `,
    async (page) => {
      const ambiguousResult = await runParityRules(page, ['LinkNavigationAmbiguous']);
      const ambiguous = findingsForRule(ambiguousResult.result, 'LinkNavigationAmbiguous')
        .filter((finding) => finding.violationType === 'commercial-parity');

      assert.ok(ambiguous.some((finding) => /view-ops/.test(finding.element.outerHTML)));
      assert.ok(ambiguous.some((finding) => /view-corp/.test(finding.element.outerHTML)));
      assert.ok(ambiguous.some((finding) => /view-care/.test(finding.element.outerHTML)));
      assert.ok(ambiguous.some((finding) => /search-now/.test(finding.element.outerHTML)));
      assert.ok(ambiguous.some((finding) => /view-all/.test(finding.element.outerHTML)));
      assert.ok(!ambiguous.some((finding) => /view-ops-hover|view-corp-hover|search-now-mobile|search-plain/.test(
        finding.element.outerHTML,
      )));
      assert.equal(ambiguous.length, 5);

      const discernibleResult = await runParityRules(page, ['LinkNavigationDiscernible']);
      const discernible = findingsForRule(discernibleResult.result, 'LinkNavigationDiscernible');
      assert.ok(discernible.some((finding) => /logo-link/.test(finding.element.outerHTML)));
    },
  );
});

test('page-wide RegionFooterSingle parity flags shadow contentinfo beside a page footer', async () => {
  await withPage(
    `
      <footer id="page-footer">© Example. All rights reserved.</footer>
      <div id="chat-host"></div>
      <script>
        const host = document.getElementById('chat-host');
        const root = host.attachShadow({ mode: 'open' });
        root.innerHTML = '<div role="contentinfo" id="chat-footer" style="position:static">Powered by Chat</div>'
          + '<div id="dock" style="position:fixed;bottom:40px;right:20px;width:300px;height:200px"></div>';
        root.getElementById('dock').appendChild(root.getElementById('chat-footer'));
      </script>
    `,
    async (page) => {
      const { result } = await runParityRules(page, ['RegionFooterSingle', 'FocusNotObscuredFooter']);
      const footers = findingsForRule(result, 'RegionFooterSingle');
      assert.equal(footers.length, 1);
      assert.match(footers[0].element.outerHTML, /chat-footer|Powered by Chat|contentinfo/);

      const focusFooter = findingsForRule(result, 'FocusNotObscuredFooter')
        .filter((finding) => finding.violationType === 'commercial-parity');
      assert.ok(focusFooter.length >= 1);
    },
  );
});

test('empty exposed filter lists are VisibilityMisuse parity', async () => {
  await withPage(
    `
      <div style="height: 40px">
        <ul id="empty-tag-list" class="jobs-current-searches__tag-list" style="height: 0"></ul>
      </div>
      <div data-react-component="jobs-current-searches" style="width: 300px; height: 0">
        <ul id="collapsed-mount-list" class="jobs-current-searches__tag-list" style="height: 0"></ul>
      </div>
      <ul id="populated-list"><li>Remote</li></ul>
    `,
    async (page) => {
      const { result } = await runParityRules(page, ['VisibilityMisuse']);
      const findings = findingsForRule(result, 'VisibilityMisuse')
        .filter((finding) => finding.violationType === 'commercial-parity');
      assert.ok(findings.some((finding) => /empty-tag-list/.test(finding.element.outerHTML)));
      assert.ok(!findings.some((finding) => /collapsed-mount-list|populated-list/.test(finding.element.outerHTML)));
    },
  );
});

test('commercial visibility parity flags absolute display:none disclosure panels with links', async () => {
  await withPage(
    `
      <nav aria-label="Primary">
        <button aria-expanded="false">Explore</button>
        <div id="absolute-hidden-menu" class="menu-panel"
          style="display: none; position: absolute; top: 100%; left: 0">
          <div id="absolute-hidden-menu-inner">
            <a href="/nursing">Nursing</a>
            <a href="/allied">Allied Health</a>
          </div>
        </div>
        <div id="fixed-hidden-menu"
          style="display: none; position: fixed; top: 0; left: 0; width: 100%">
          <a href="/a">A</a>
          <a href="/b">B</a>
        </div>
      </nav>
    `,
    async (page) => {
      const { result } = await runParityRules(page, ['VisibilityMisuse']);
      const findings = findingsForRule(result, 'VisibilityMisuse')
        .filter((finding) => finding.violationType === 'commercial-parity');

      assert.ok(findings.some((finding) => /id="absolute-hidden-menu"/.test(finding.element.outerHTML)));
      assert.ok(findings.some((finding) => /id="absolute-hidden-menu-inner"/.test(finding.element.outerHTML)));
      assert.ok(!findings.some((finding) => /id="fixed-hidden-menu"/.test(finding.element.outerHTML)));
    },
  );
});

test('commercial visibility parity does not emit opacity-0 text or overflow-clipped copy by default', async () => {
  await withPage(
    `
      <div style="opacity: 0; width: 200px; height: 40px">
        <h4 id="opacity-hidden-title">Why Join Our Team?</h4>
      </div>
      <a id="opacity-hidden-link" href="https://example.com/widget"
        style="position: absolute; opacity: 0; width: 120px; height: 32px">Created with</a>
      <div style="width: 240px; height: 200px; overflow: hidden">
        <div style="display: flex; width: 480px">
          <div class="swiper-slide video" style="width: 220px; height: 200px; flex: 0 0 auto">
            Onscreen video slide copy for the active peer.
          </div>
          <div id="clipped-video-slide" class="swiper-slide video"
            style="width: 220px; height: 200px; flex: 0 0 auto">
            Hear from our fellows about clinical careers across the region today.
          </div>
        </div>
      </div>
      <div style="width: 240px; overflow: hidden">
        <div style="display: flex; width: 720px">
          <p style="width: 240px; flex: 0 0 auto; margin: 0">Visible slide copy stays here for readers.</p>
          <p id="clipped-slide-copy" style="width: 240px; flex: 0 0 auto; margin: 0">
            From thriving cities to quaint small towns, our network offers urban and rural lifestyles.
          </p>
          <p style="width: 240px; flex: 0 0 auto; margin: 0">Another offscreen paragraph for the carousel track.</p>
        </div>
      </div>
    `,
    async (page) => {
      const { result } = await runParityRules(page, ['VisibilityMisuse']);
      const findings = findingsForRule(result, 'VisibilityMisuse')
        .filter((finding) => finding.violationType === 'commercial-parity');

      // These helpers over-fire on carousel copy vs commercial occurrence counts.
      assert.ok(!findings.some((finding) => /opacity-hidden-title/.test(finding.element.outerHTML)));
      assert.ok(!findings.some((finding) => /opacity-hidden-link/.test(finding.element.outerHTML)));
      assert.ok(!findings.some((finding) => /clipped-slide-copy/.test(finding.element.outerHTML)));
      assert.ok(!findings.some((finding) => /clipped-video-slide/.test(finding.element.outerHTML)));
    },
  );
});

test('commercial visibility parity flags carousel media hosts clipped at the overflow edge', async () => {
  await withPage(
    `
      <div class="carousel overflow-hidden" style="width: 300px; height: 220px; overflow: hidden; position: relative">
        <div style="display: flex; width: 900px">
          <div id="edge-clipped-media" class="shrink-0"
            style="width: 300px; height: 220px; flex: 0 0 auto; margin-left: -150px">
            <img src="/edge.jpg" alt="Half-clipped media" style="width: 100%; height: 100%; object-fit: cover">
          </div>
          <div id="onscreen-media" class="shrink-0 current"
            style="width: 300px; height: 220px; flex: 0 0 auto">
            <img src="/on.jpg" alt="Onscreen media" style="width: 100%; height: 100%; object-fit: cover">
          </div>
          <div id="fully-clipped-media" class="shrink-0"
            style="width: 300px; height: 220px; flex: 0 0 auto">
            <img src="/off.jpg" alt="Offscreen media" style="width: 100%; height: 100%; object-fit: cover">
          </div>
        </div>
      </div>
    `,
    async (page) => {
      const { result } = await runParityRules(page, ['VisibilityMisuse']);
      const findings = findingsForRule(result, 'VisibilityMisuse')
        .filter((finding) => finding.violationType === 'commercial-parity');

      assert.ok(findings.some((finding) => /edge-clipped-media/.test(finding.element.outerHTML)));
      assert.ok(findings.some((finding) => /fully-clipped-media/.test(finding.element.outerHTML)));
      assert.ok(!findings.some((finding) => /onscreen-media/.test(finding.element.outerHTML)));
    },
  );
});

test('commercial visibility parity includes every inactive panel in an exclusive visual set', async () => {
  await withPage(
    `
      <div style="width: 300px; height: 180px; overflow: hidden">
        <div style="display: flex">
          <div id="active-visual-panel" style="width: 300px; height: 180px; flex: 0 0 auto">
            <img src="/active.jpg" alt="Active scene">
          </div>
          <div id="inactive-visual-panel-1" style="width: 300px; height: 180px; flex: 0 0 auto; opacity: 0; pointer-events: none">
            <img src="/one.jpg" alt="First inactive scene">
          </div>
          <div id="inactive-visual-panel-2" style="width: 300px; height: 180px; flex: 0 0 auto; opacity: 0; pointer-events: none">
            <img src="/two.jpg" alt="Second inactive scene">
          </div>
          <div id="inactive-visual-panel-3" style="width: 300px; height: 180px; flex: 0 0 auto; opacity: 0; pointer-events: none">
            <img src="/three.jpg" alt="Third inactive scene">
          </div>
          <div id="inactive-visual-panel-4" style="width: 300px; height: 180px; flex: 0 0 auto; opacity: 0; pointer-events: none">
            <img src="/four.jpg" alt="Fourth inactive scene">
          </div>
          <div id="inactive-visual-panel-5" style="width: 300px; height: 180px; flex: 0 0 auto; opacity: 0; pointer-events: none">
            <img src="/five.jpg" alt="Fifth inactive scene">
          </div>
        </div>
      </div>
    `,
    async (page) => {
      const { result } = await runParityRules(page, ['VisibilityMisuse']);
      const inactivePanels = findingsForRule(result, 'VisibilityMisuse').filter(
        (finding) => /inactive-visual-panel-/.test(finding.element.outerHTML),
      );

      assert.equal(inactivePanels.length, 5);
    },
  );
});

test('commercial visibility parity recognizes empty framework mounts and text blocks', async () => {
  await withPage(
    `
      <p id="empty-text-block"> </p>
      <div id="empty-component-a" data-react-component="status" style="width: 300px; height: 0">
        <div></div>
      </div>
      <div id="empty-component-b" data-react-component="location" style="width: 300px; height: 0">
        <div></div>
      </div>
      <div id="empty-component-c" data-component="radius" style="width: 0; height: 30px">
        <div></div>
      </div>
      <div id="empty-pagination" data-react-component="results-pagination" style="width: 300px; height: 0">
        <div></div>
      </div>
      <div id="generic-empty-container" style="width: 300px; height: 0"><div></div></div>
    `,
    async (page) => {
      const { result } = await runParityRules(page, ['VisibilityMisuse']);
      const findings = findingsForRule(result, 'VisibilityMisuse');

      for (const marker of [
        'empty-text-block',
        'empty-component-a',
        'empty-component-b',
        'empty-component-c',
      ]) {
        assert.ok(
          findings.some((finding) => finding.element.outerHTML.includes(marker)),
          marker,
        );
      }
      assert.ok(!findings.some((finding) => /generic-empty-container/.test(finding.element.outerHTML)));
      assert.ok(!findings.some((finding) => /empty-pagination/.test(finding.element.outerHTML)));
    },
  );
});

test('commercial visibility parity recognizes generic input cue elements only for stable control ids', async () => {
  await withPage(
    `
      <div>
        <svg id="stable-input-cue" aria-hidden="true" width="16" height="16"><path d="M0 0h16v16H0z"></path></svg>
        <input id="stable-control" aria-label="Location">
      </div>
      <div>
        <svg id="ambiguous-input-cue" aria-hidden="true" width="16" height="16"><path d="M0 0h16v16H0z"></path></svg>
        <input id="duplicated-control" aria-label="First copy">
        <input id="duplicated-control" aria-label="Second copy">
      </div>
      <div>
        <i id="css-font-cue" aria-hidden="true" style="display:inline-block;width:16px;height:16px"></i>
        <input id="font-cue-control" aria-label="Location">
      </div>
    `,
    async (page) => {
      const { result } = await runParityRules(page, ['VisibilityMismatch']);
      const parity = findingsForRule(result, 'VisibilityMismatch')
        .filter((finding) => finding.violationType === 'commercial-parity');
      assert.equal(parity.length, 1);
      assert.match(parity[0].element.outerHTML, /stable-input-cue/);
      assert.ok(!parity.some((finding) => /css-font-cue/.test(finding.element.outerHTML)));
    },
  );
});

test('visually separated legal strips preserve commercial footer parity', async () => {
  await withPage(
    `
      <footer id="global-footer" style="background: rgb(0, 0, 0); color: white">
        <nav><a href="/jobs">Jobs</a><a href="/about">About</a></nav>
        <div style="background: rgb(0, 70, 120)">
          <div id="legal-strip-content">
            <div><p>© Example Company 2026. All Rights Reserved.</p></div>
          </div>
        </div>
      </footer>
    `,
    async (page) => {
      const { result } = await runParityRules(page, [
        'RegionFooterMismatch', 'RegionFooterMisuse',
      ]);
      const mismatch = findingsForRule(result, 'RegionFooterMismatch')
        .filter((finding) => finding.violationType === 'commercial-parity');
      const misuse = findingsForRule(result, 'RegionFooterMisuse')
        .filter((finding) => finding.violationType === 'commercial-parity');
      assert.equal(mismatch.length, 1);
      assert.match(mismatch[0].element.outerHTML, /legal-strip-content/);
      assert.equal(misuse.length, 1);
      assert.match(misuse[0].element.outerHTML, /global-footer/);
    },
  );
});

test('random wrapper class and id invariance for credential gate parity', async () => {
  const variants = [
    `
      <div class="a1b2c3">
        <header>Hdr</header>
        <main id="m-99">
          <h2>Portal</h2>
          <form><input type="password"><button type="submit">Go</button></form>
        </main>
      </div>
    `,
    `
      <div id="z9y8x7">
        <header>Hdr</header>
        <main class="content-main">
          <h2>Portal</h2>
          <form><input type="password"><button type="submit">Go</button></form>
        </main>
      </div>
    `,
  ];

  const counts = [];
  for (const body of variants) {
    await withPage(
      `<html lang="en"><head><title>Portal</title></head><body>${body}</body></html>`,
      async (page) => {
        const { result } = await runParityRules(page);
        counts.push(
          result.findings.filter((f) => f.violationType === 'commercial-parity').length,
        );
      },
    );
  }
  assert.deepEqual(counts, [4, 4]);
});

test('shadow paths are preserved on parity findings', async () => {
  await withPage(
    `
      <html lang="en"><head><title>Gate</title></head><body>
      <div id="host"></div>
      <script>
        const root = document.getElementById('host').attachShadow({ mode: 'open' });
        root.innerHTML = \`
          <div class="shell">
            <header>Banner</header>
            <main>
              <h1>Gate</h1>
              <form>
                <input type="password">
                <button type="submit">Go</button>
              </form>
            </main>
          </div>
        \`;
      </script>
      </body></html>
    `,
    async (page) => {
      const { result } = await runParityRules(page);
      const parity = result.findings.filter((f) => f.violationType === 'commercial-parity');
      assert.ok(parity.length >= 1);
      assert.ok(parity.some((f) => f.element.shadowPath.length > 0));
    },
  );
});

test('dedupeFindings prefers confirmed standards over commercial-parity on same element', () => {
  const merged = dedupeFindings([
    {
      ruleId: 'RegionMainContentMisuse',
      violationType: 'commercial-parity',
      severity: { impact: 'moderate', priority: 4, wcagRef: 'WCAG 2.0 A 1.3.1' },
      element: { outerHTML: '<main></main>', selector: 'main', framePath: [], shadowPath: [] },
      recommendation: 'Review',
      evidence: { checkId: 'parity:main', profile: 'commercial-parity' },
    },
    {
      ruleId: 'RegionMainContentMisuse',
      violationType: 'confirmed',
      severity: { impact: 'moderate', priority: 4, wcagRef: 'WCAG 2.0 A 1.3.1' },
      element: { outerHTML: '<main></main>', selector: 'main', framePath: [], shadowPath: [] },
      recommendation: 'Fix',
      evidence: { checkId: 'standards:main', profile: 'standards' },
    },
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].violationType, 'confirmed');
  assert.deepEqual(merged[0].evidence.checkIds.sort(), ['parity:main', 'standards:main'].sort());
});

test('dedupeFindings prefers commercial-parity over potential standards on same element', () => {
  const merged = dedupeFindings([
    {
      ruleId: 'RegionMainContentMisuse',
      violationType: 'commercial-parity',
      severity: { impact: 'moderate', priority: 4, wcagRef: 'WCAG 2.0 A 1.3.1' },
      element: { outerHTML: '<main></main>', selector: 'main', framePath: [], shadowPath: [] },
      recommendation: 'Review',
      evidence: { checkId: 'parity:main', profile: 'commercial-parity', note: 'parity' },
    },
    {
      ruleId: 'RegionMainContentMisuse',
      violationType: 'potential',
      severity: { impact: 'moderate', priority: 4, wcagRef: 'WCAG 2.0 A 1.3.1' },
      element: { outerHTML: '<main></main>', selector: 'main', framePath: [], shadowPath: [] },
      recommendation: 'Fix',
      evidence: { checkId: 'standards:main', profile: 'standards', note: 'standards' },
    },
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].violationType, 'commercial-parity');
  assert.deepEqual(merged[0].evidence.checkIds.sort(), ['parity:main', 'standards:main'].sort());
  assert.ok(merged[0].evidence.note === 'standards' || merged[0].evidence.mergedEvidence);
});

test('dedupeFindings keeps distinct elements separate', () => {
  const merged = dedupeFindings([
    {
      ruleId: 'TabMismatch',
      violationType: 'commercial-parity',
      severity: { impact: 'serious', priority: 3, wcagRef: 'WCAG 2.0 A 4.1.2' },
      element: { outerHTML: '<button>a</button>', selector: '#a', framePath: [], shadowPath: [] },
      recommendation: 'Review',
      evidence: { checkId: 'parity:a', profile: 'commercial-parity' },
    },
    {
      ruleId: 'TabMismatch',
      violationType: 'commercial-parity',
      severity: { impact: 'serious', priority: 3, wcagRef: 'WCAG 2.0 A 4.1.2' },
      element: { outerHTML: '<button>b</button>', selector: '#b', framePath: [], shadowPath: [] },
      recommendation: 'Review',
      evidence: { checkId: 'parity:b', profile: 'commercial-parity' },
    },
  ]);
  assert.equal(merged.length, 2);
});

test('normalized parity findings include checkId and profile evidence', async () => {
  await withPage(
    `
      <nav aria-label="Primary">
        <a href="/" aria-current="page">Home</a>
        <a href="/about">About</a>
      </nav>
    `,
    async (page) => {
      const { result } = await runParityRules(page, ['RequiredFormFieldAriaRequired']);
      const finding = findingsForRule(result, 'RequiredFormFieldAriaRequired')[0];
      assert.ok(finding.evidence.checkId);
      assert.equal(finding.evidence.profile, 'commercial-parity');
    },
  );
});

test('production access-scan sources are free of forbidden tokens', () => {
  const cleanRoots = [
    path.join(__dirname, '../src/scanner/access-scan/index.js'),
    path.join(EVALUATOR_ROOT, 'commercial-parity.evaluator.js'),
    path.join(__dirname, '../src/scanner/access-scan/signals'),
    path.join(__dirname, '../src/scanner/access-scan/policies'),
    RULES_ROOT,
    path.join(RUNTIME_ROOT, 'runtime.browser.js'),
    path.join(RUNTIME_ROOT, 'graph-query.js'),
    path.join(RUNTIME_ROOT, 'graph-relationships.js'),
    path.join(RUNTIME_ROOT, 'eligibility.js'),
    path.join(RUNTIME_ROOT, 'session.js'),
    path.join(ENGINE_ROOT, 'public-catalog.js'),
  ];
  const excludedFiles = new Set([
    path.join(ENGINE_ROOT, 'portability.js'),
    path.join(ENGINE_ROOT, 'target-validation.js'),
  ]);

  for (const root of cleanRoots) {
    const files = root.endsWith('.js') ? [root] : walkJsFiles(root);
    for (const file of files) {
      if (excludedFiles.has(file)) continue;
      const source = readFileSync(file, 'utf8');
      for (const token of FORBIDDEN_SOURCE_TOKENS) {
        assert.doesNotMatch(
          source,
          new RegExp(token, 'i'),
          `${path.relative(__dirname, file)} must not contain forbidden token "${token}"`,
        );
      }
    }
  }
});

test('retired imperative scanner files are absent after consumer cutover', () => {
  const retired = [
    '01-general.js',
    '02-interactive.js',
    '03-forms.js',
    '04-landmarks.js',
    '05-graphics.js',
    '06-dragging.js',
    '07-aria.js',
    '08-lists.js',
    '09-metadata.js',
    '10-tabs.js',
    '11-tables.js',
    'dom-signals.js',
    path.join('engine', 'source-debt.js'),
  ];
  for (const relativePath of retired) {
    assert.throws(
      () => readFileSync(path.join(__dirname, '../src/scanner/access-scan', relativePath)),
      /ENOENT/,
    );
  }
});

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
