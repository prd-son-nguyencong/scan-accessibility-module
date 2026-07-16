import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getBrowser, closeBrowser } from '../src/scanner/browser.js';
import { getAccessScanCategory } from '../src/schema.js';
import {
  createFixturePage,
  scanFixtureWithAccessScan,
} from './helpers/access-scan-contract.js';

async function scanPage(page, url, options = {}) {
  return scanFixtureWithAccessScan(page, url, options);
}

function selectorsFor(violations, ruleId) {
  return violations
    .filter((violation) => violation.ruleId === ruleId)
    .map((violation) => violation.element.selector);
}

function includesSelector(selector, fragment) {
  return selector.includes(fragment);
}

test('sticky header findings are grouped under Interactive Content', () => {
  assert.equal(
    getAccessScanCategory('StickyHeaderObscuresFocus').id,
    'interactive',
  );
});

test('accessScan compatibility and correctness fixtures', async (t) => {
  let browser;
  try {
    browser = await getBrowser();
  } catch (error) {
    t.skip(`Playwright browser unavailable: ${error.message}`);
    return;
  }

  try {
    await t.test('accessible names may add context when they retain the visible label', async () => {
      const page = await createFixturePage(browser, `
        <label>
          <input
            id="country"
            type="checkbox"
            aria-labelledby="country-label country-count"
          >
          <span id="country-label">United States</span>
          <span id="country-count">4</span>
        </label>
        <span id="sort-label">Sort By</span>
        <button id="sort" aria-labelledby="sort-label sort-current">
          <span id="sort-current">Date</span>
        </button>
        <button id="icon-only" aria-label="Previous category">
          <svg aria-hidden="true"></svg>
        </button>
        <a id="logo-link" href="/" aria-label="Hitachi official website">
          <img src="logo.svg" alt="Hitachi">
        </a>
        <span id="query-label">I'm Looking For</span>
        <input
          id="query"
          aria-labelledby="query-label"
          placeholder="ex. Job Title"
        >
        <button id="mismatch" aria-label="Remove item">Delete</button>
      `);
      try {
        const violations = await scanPage(page, 'fixture://aria');
        assert.deepEqual(
          violations
            .filter(({ ruleId, element }) => ruleId === 'VisibleTextPartOfAccessibleName' && includesSelector(element.selector, 'mismatch'))
            .map(({ ruleId, element }) => [ruleId, element.selector]),
          [['VisibleTextPartOfAccessibleName', violations.find(({ element }) => includesSelector(element.selector, 'mismatch')).element.selector]],
        );
      } finally {
        await page.context().close();
      }
    });

    await t.test('bold styling stays advisory while parity search uses commercial severity', async () => {
      const page = await createFixturePage(browser, `
        <style>
          .results-header__content__from,
          .results-header__content__to,
          .results-header__content__total,
          .remote { font-weight: 700; }
        </style>
        <p>
          Showing
          <span id="from" class="results-header__content__from">1</span>
          to <span id="to" class="results-header__content__to">6</span>
          of <span id="total" class="results-header__content__total">6</span> jobs
        </p>
        <h3>Engineering Lead <span id="remote" class="remote">Remote</span></h3>
        <div id="job-search" class="search-box" data-testid="jobs-search_container">
          <label for="query">I'm Looking For</label>
          <input id="query" type="text">
        </div>
      `);
      try {
        const violations = await scanPage(page, 'fixture://heuristics', {
          includeThirdParty: true,
        });
        const strong = violations.find(({ ruleId }) => ruleId === 'StrongMismatch');

        assert.equal(
          selectorsFor(violations, 'StrongMismatch').filter((selector) => (
            includesSelector(selector, 'from')
            || includesSelector(selector, 'to')
            || includesSelector(selector, 'total')
          )).length,
          3,
        );
        assert.deepEqual(
          {
            impact: strong?.impact,
            wcagRef: strong?.wcagRef,
            deterministic: strong?.fix.deterministic,
          },
          { impact: 'minor', wcagRef: 'Best Practice', deterministic: false },
        );
      } finally {
        await page.context().close();
      }
    });

    await t.test('commercial form and landmark parity is inferred from rendered structure', async () => {
      const page = await createFixturePage(browser, `
        <nav id="primary-nav" aria-label="Primary">
          <a id="current-page" class="nav-link current" href="/">Home</a>
          <a href="/about">About</a>
          <button aria-haspopup="true">More</button>
        </nav>
        <div style="display: none">
          <nav id="hidden-footer-nav" aria-label="Footer">
            <a href="/">Home</a>
            <a href="/privacy">Privacy</a>
          </nav>
        </div>
        <nav id="footer-nav" aria-label="Footer">
          <a href="/">Home</a>
          <a href="/privacy">Privacy</a>
        </nav>
        <div id="search-group">
          <label for="query">Find a role</label>
          <input id="query" type="search">
          <label for="place">Near</label>
          <input id="place" type="text">
          <a href="/jobs">Search jobs</a>
        </div>
      `);
      try {
        const options = { includeThirdParty: true };
        const violations = await scanPage(page, 'fixture://structural-parity', options);
        const required = violations.filter(
          ({ ruleId }) => ruleId === 'RequiredFormFieldAriaRequired',
        );
        const navigation = violations.filter(
          ({ ruleId }) => ruleId === 'NavigationMisuse',
        );
        const search = violations.filter(
          ({ ruleId }) => ruleId === 'SearchFormMismatch',
        );

        assert.ok(required.some(({ element }) => includesSelector(element.selector, 'current-page')));
        assert.ok(navigation.some(({ element }) => includesSelector(element.selector, 'primary-nav')));
        assert.ok(navigation.some(({ element }) => includesSelector(element.selector, 'footer-nav')));
        assert.ok(search.some(({ element }) => includesSelector(element.selector, 'search-group')));
        assert.equal(
          required[0].evidence.classification,
          'commercial-parity-heuristic',
        );
        assert.equal(required[0].fix.deterministic, false);
        assert.equal(
          search[0].evidence.classification,
          'commercial-parity-heuristic',
        );
        assert.equal(search[0].wcagRef, 'Best Practice');
        assert.equal(search[0].impact, 'minor');
      } finally {
        await page.context().close();
      }
    });

    await t.test('credential-gate parity is derived from rendered semantics', async () => {
      const page = await createFixturePage(browser, `
        <title>Northstar</title>
        <div id="gate-shell">
          <header id="gate-banner">
            <img id="functional-logo" src="/logo.png" width="120" height="40">
          </header>
          <main id="gate-main">
            <form>
              <input id="hidden-token" type="hidden" name="token" value="secret-token">
              <h2>Northstar</h2>
              <input type="password" name="password">
              <div id="hidden-error" style="display:none"></div>
              <button type="submit">Continue</button>
            </form>
          </main>
        </div>
      `);
      try {
        const selectedRules = new Set([
          'RegionMainContentMismatch',
          'RegionMainContentMisuse',
          'ImageDiscernible',
          'PageTitleDescriptive',
          'VisibilityMisuse',
        ]);
        const standards = (await scanPage(page, 'fixture://credential-gate'))
          .filter(({ ruleId }) => selectedRules.has(ruleId));
        assert.deepEqual(
          standards.map(({ ruleId }) => ruleId),
          ['ImageDiscernible'],
        );

        const parityOptions = { includeThirdParty: true };
        const parity = (await scanPage(page, 'fixture://credential-gate', parityOptions))
          .filter(({ ruleId }) => selectedRules.has(ruleId));
        const byRule = Object.fromEntries(
          parity.map((finding) => [finding.ruleId, finding]),
        );

        assert.equal(parity.length, selectedRules.size);
        assert.deepEqual(
          Object.keys(byRule).sort(),
          [...selectedRules].sort(),
        );
        assert.ok(includesSelector(byRule.RegionMainContentMismatch.element.selector, 'gate-shell'));
        assert.ok(includesSelector(byRule.RegionMainContentMisuse.element.selector, 'gate-main'));
        assert.ok(includesSelector(byRule.ImageDiscernible.element.selector, 'functional-logo'));
        assert.ok(byRule.PageTitleDescriptive.element.selector.includes('title'));
        assert.ok(byRule.VisibilityMisuse.element.selector.includes('body'));
        assert.ok(parity.every(
          ({ element }) => !element.outerHTML.includes('secret-token'),
        ));

        for (const ruleId of [
          'RegionMainContentMismatch',
          'RegionMainContentMisuse',
          'PageTitleDescriptive',
          'VisibilityMisuse',
        ]) {
          assert.equal(
            byRule[ruleId].evidence.classification,
            'commercial-parity-heuristic',
          );
          assert.equal(byRule[ruleId].fix.deterministic, false);
        }
      } finally {
        await page.context().close();
      }
    });

    await t.test('commercial parity reports a rendered top-anchored semantic header', async () => {
      const page = await createFixturePage(browser, `
        <style>
          #top-banner {
            position: fixed;
            inset: 0 0 auto;
            width: 100%;
            height: 80px;
            background: white;
          }
          main { padding-top: 100px; }
        </style>
        <header id="top-banner">Header</header>
        <main><p>Page content</p></main>
      `);
      try {
        const sticky = (await scanPage(
          page,
          'fixture://interactive-parity',
          { includeThirdParty: true },
        )).filter(
          ({ ruleId }) => ruleId === 'StickyHeaderObscuresFocus',
        );

        assert.ok(sticky.some(({ element }) => includesSelector(element.selector, 'top-banner')));
        assert.equal(
          sticky[0]?.evidence?.classification,
          'commercial-parity-heuristic',
        );
        assert.equal(sticky[0]?.fix.deterministic, false);
      } finally {
        await page.context().close();
      }
    });

    await t.test('ButtonMismatch retains rendered native button successes', async () => {
      const page = await createFixturePage(browser, `
        <a id="action-link" href="#" class="action-button">Open chat</a>
        <button id="native-button" type="button">Open menu</button>
        <div style="display: none">
          <button id="hidden-button" type="button">Hidden menu</button>
        </div>
      `);
      try {
        const violations = await scanPage(page, 'fixture://button-parity');
        assert.ok(
          violations.some(({ ruleId }) => ruleId === 'ButtonMismatch' || ruleId === 'LinkAnchorAmbiguous'),
        );
      } finally {
        await page.context().close();
      }
    });

    await t.test('a short scroll-padding value alone does not prove focus obscuration', async () => {
      const page = await createFixturePage(browser, `
        <style>
          html { scroll-padding-top: 90px; }
          header { position: fixed; inset: 0 0 auto; height: 100px; }
        </style>
        <header id="header">Header</header>
        <main><p>No focusable content</p></main>
      `);
      try {
        const violations = await scanPage(page, 'fixture://focus-clear', {
          skipRules: ['HtmlLang', 'MetaDescription', 'MetaViewportPresent', 'PageTitleDescriptive', 'PageTitle'],
        });
        assert.equal(
          violations.some(({ ruleId }) => ruleId === 'StickyHeaderObscuresFocus'),
          false,
        );
      } finally {
        await page.context().close();
      }
    });

    await t.test('focus obscuration reports the fully covered control', async () => {
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
        const violations = await scanPage(page, 'fixture://focus-covered', {
          skipRules: ['HtmlLang', 'MetaDescription', 'MetaViewportPresent', 'PageTitleDescriptive', 'NoAutofocus'],
        });
        assert.ok(
          violations.some(({ ruleId, element }) => (
            ruleId === 'StickyHeaderObscuresFocus' && includesSelector(element.selector, 'covered')
          )),
        );
      } finally {
        await page.context().close();
      }
    });

    await t.test('navigation submenu controls are not breadcrumbs', async () => {
      const page = await createFixturePage(browser, `
        <nav>
          <ul>
            <li>
              <div class="flex items-center gap-[1.4rem]">
                <a href="/our-sectors">Our Sectors</a>
                <button aria-label="Toggle Our Sectors submenu">Toggle</button>
              </div>
            </li>
          </ul>
        </nav>
      `);
      try {
        const violations = await scanPage(page, 'fixture://submenu');
        assert.equal(
          violations.some(({ ruleId }) => ruleId === 'BreadcrumbsMismatch'),
          false,
        );
      } finally {
        await page.context().close();
      }
    });

    await t.test('Paradox widgets reproduce commercial breadcrumb, sticky-header, and ARIA findings', async () => {
      const page = await createFixturePage(browser, `
        <style>
          body { margin: 0; }
          #header { position: sticky; top: 0; height: 100px; background: white; }
          main { padding-top: 32px; }
        </style>
        <header id="header" class="sticky top-0 left-0 z-100 w-full bg-white text-black">
          <nav id="desktop-navigation">
            <ul>
              <li class="sub-menu">
                <div class="flex items-center gap-[1.4rem]">
                  <a href="/our-sectors">Our Sectors</a>
                  <button class="sub-menu-toggle" aria-label="Toggle Our Sectors submenu">Toggle</button>
                </div>
              </li>
            </ul>
          </nav>
        </header>
        <main>
          <button id="continue">Continue</button>
          <div>
            <input
              id="argentina_0-option-input"
              type="checkbox"
              aria-labelledby="argentina-label-0 argentina-count-0"
              data-testid="jobs-filter_filter-group_item_checkbox"
              value="Argentina"
            >
            <span id="argentina-label-0">Argentina</span>
            <span id="argentina-count-0">10</span>
          </div>
          <div>
            <input
              id="australia_1-option-input"
              type="checkbox"
              aria-labelledby="australia-label-1 australia-count-1"
              data-testid="jobs-filter_filter-group_item_checkbox"
              value="Australia"
            >
            <span id="australia-label-1">Australia</span>
            <span id="australia-count-1">8</span>
          </div>
        </main>
      `);
      try {
        const defaultFindings = (await scanPage(page, 'fixture://commercial-parity'))
          .filter(({ ruleId }) => [
            'BreadcrumbsMismatch',
            'StickyHeaderObscuresFocus',
            'VisibleTextPartOfAccessibleName',
          ].includes(ruleId));
        assert.deepEqual(defaultFindings, []);

        const options = { includeThirdParty: true };
        const parityFindings = (await scanPage(page, 'fixture://commercial-parity', options))
          .filter(({ ruleId }) => [
            'BreadcrumbsMismatch',
            'StickyHeaderObscuresFocus',
            'VisibleTextPartOfAccessibleName',
          ].includes(ruleId));

        assert.ok(parityFindings.some(({ ruleId, element }) => (
          ruleId === 'StickyHeaderObscuresFocus' && includesSelector(element.selector, 'header')
        )));
        assert.equal(
          parityFindings.filter(({ ruleId }) => ruleId === 'VisibleTextPartOfAccessibleName').length,
          2,
        );
        assert.ok(parityFindings.every(
          ({ evidence, fix }) => (
            (evidence.classification === 'commercial-parity-heuristic'
              || evidence.violationType === 'commercial-parity')
            && fix.deterministic === false
          ),
        ));
      } finally {
        await page.context().close();
      }
    });

    await t.test('commercial filter disclosures can surface tab parity findings when structure matches', async () => {
      const page = await createFixturePage(browser, `
        <div class="tabs" id="filter-tabs">
          <button id="tab-one" role="tab" aria-selected="true" aria-controls="panel-one">One</button>
          <button id="tab-two" role="tab" aria-selected="false" aria-controls="panel-two">Two</button>
          <div id="panel-one" role="tabpanel">One panel</div>
          <div id="panel-two" role="tabpanel">Two panel</div>
        </div>
      `);
      try {
        const violations = await scanPage(page, 'fixture://filters', {
          includeThirdParty: true,
          skipRules: ['HtmlLang', 'MetaDescription', 'MetaViewportPresent', 'PageTitleDescriptive', 'PageTitle', 'TabpanelLabelledBy'],
        });
        assert.ok(violations.some(({ ruleId }) => ruleId.startsWith('Tab')));
      } finally {
        await page.context().close();
      }
    });

    await t.test('nested main landmarks and action links retain actionable rules', async () => {
      const page = await createFixturePage(browser, `
        <style>.button { display: inline-block; width: 48px; height: 48px; }</style>
        <main>
          <h1>Page</h1>
          <a id="play" class="button button--play" href="#" aria-label="Play video"></a>
          <main id="jobs-main">
            <h2>Jobs</h2>
            <p>Primary job list content.</p>
            <span class="remote">Remote</span>
          </main>
        </main>
      `);
      try {
        const violations = await scanPage(page, 'fixture://semantics', {
          skipRules: ['HtmlLang', 'MetaDescription', 'MetaViewportPresent', 'PageTitleDescriptive', 'PageTitle', 'VisibilityMismatch', 'VisibilityMisuse', 'LinkAnchorAmbiguous'],
        });
        const landmarks = violations.filter(({ ruleId }) => ruleId.startsWith('RegionMainContent'));

        assert.deepEqual(
          landmarks.map(({ ruleId }) => ruleId).sort(),
          ['RegionMainContentMisuse', 'RegionMainContentSingle'].sort(),
        );
      } finally {
        await page.context().close();
      }
    });
  } finally {
    await closeBrowser();
  }
});
