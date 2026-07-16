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

test('commercial-parity profile is a true overlay over standards checks', async () => {
  const registry = await loadBuiltInRuleRegistry({ enforceCatalogContract: true });
  const standardsChecks = registry.getChecksForProfile(PROFILES.STANDARDS);
  const parityChecks = registry.getChecksForProfile(PROFILES.COMMERCIAL_PARITY);
  const parityOnly = parityChecks.filter(
    ({ check }) => check.profiles.length === 1 && check.profiles[0] === PROFILES.COMMERCIAL_PARITY,
  );

  assert.ok(parityOnly.length >= 12, 'expected parity-only descriptor checks');
  assert.ok(parityChecks.length > standardsChecks.length);
  assert.ok(
    standardsChecks.every(({ check }) => parityChecks.some((entry) => entry.check.id === check.id)),
    'commercial-parity profile must include every standards check',
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

test('neutral credential gate emits four parity findings plus standards ImageDiscernible', async () => {
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
      assert.notEqual(image[0].violationType, 'commercial-parity');
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

test('sticky header parity candidate uses semantic-only manual review evidence', async () => {
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
      assert.equal(findings.length, 1);
      assert.equal(findings[0].violationType, 'commercial-parity');
      assert.equal(findings[0].evidence.classification, 'commercial-parity-heuristic');
      assert.equal(findings[0].evidence.hitTestConfirmed, false);
      assert.match(findings[0].evidence.semanticAssessment, /manual review/i);
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
      assert.equal(misuse.length, 6);
      assert.ok(misuse.some((finding) => /substantially-clipped/.test(finding.element.outerHTML)));
      assert.ok(!misuse.some((finding) => /near-clipped/.test(finding.element.outerHTML)));
      assert.equal(misuse.filter((finding) => /empty-placeholder-/.test(finding.element.outerHTML)).length, 2);
      assert.ok(misuse.some((finding) => /sprite-root/.test(finding.element.outerHTML)));
      assert.ok(misuse.some((finding) => finding.element.framePath.length === 0 && /^<body/.test(finding.element.outerHTML)));
      assert.ok(misuse.some((finding) => finding.element.framePath.length > 0 && /body/.test(finding.element.outerHTML)));
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
      const mainMismatch = findingsForRule(result, 'RegionMainContentMismatch');
      const mainMisuse = findingsForRule(result, 'RegionMainContentMisuse');
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
        7,
        findings.map((finding) => finding.element.outerHTML).join('\n'),
      );
      for (const marker of [
        'lazy-visual-a',
        'lazy-visual-b',
        'scroll-control-shell',
        'script-only-shell',
        'custom-root',
        'shadow-empty-root',
      ]) {
        assert.ok(
          findings.some((finding) => finding.element.outerHTML.includes(marker)),
          `missing ${marker}`,
        );
      }
      assert.ok(findings.some((finding) => /^<body/.test(finding.element.outerHTML)));
      assert.ok(!findings.some((finding) => /carousel-track|carousel-slide/.test(finding.element.outerHTML)));
      assert.ok(!findings.some((finding) => /animated-reveal|positionless-parallax/.test(finding.element.outerHTML)));
    },
  );
});

test('commercial visibility parity recognizes generic input cue elements only for stable control ids', async () => {
  await withPage(
    `
      <div>
        <i id="stable-input-cue" aria-hidden="true" style="display:inline-block;width:16px;height:16px"></i>
        <input id="stable-control" aria-label="Location">
      </div>
      <div>
        <i id="ambiguous-input-cue" aria-hidden="true" style="display:inline-block;width:16px;height:16px"></i>
        <input id="duplicated-control" aria-label="First copy">
        <input id="duplicated-control" aria-label="Second copy">
      </div>
    `,
    async (page) => {
      const { result } = await runParityRules(page, ['VisibilityMismatch']);
      const parity = findingsForRule(result, 'VisibilityMismatch')
        .filter((finding) => finding.violationType === 'commercial-parity');
      assert.equal(parity.length, 1);
      assert.match(parity[0].element.outerHTML, /stable-input-cue/);
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
