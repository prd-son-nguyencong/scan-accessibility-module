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
import { scanWithAccessScan } from '../src/scanner/access-scan/index.js';
import { installRuntimeHooks, createScanSession } from '../src/scanner/access-scan/runtime/index.js';
import {
  ACTIVE_RULE_COUNT,
  CATALOG_RULE_COUNT,
  LEGACY_NON_EMITTING_RULE_ID,
} from './helpers/access-scan-contract.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.join(__dirname, '..');
const RUNTIME_ROOT = path.join(PACKAGE_ROOT, 'src/scanner/access-scan/runtime');
const EVALUATOR_ROOT = path.join(PACKAGE_ROOT, 'src/scanner/access-scan/evaluators');

const VERIFICATION_SEED = 0x0a9132a4;
const LARGE_DOM_NODE_COUNT = 5000;
const LARGE_DOM_SCAN_BUDGET_MS = 30_000;

/** @param {number} seed */
function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
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

/**
 * @param {import('../src/scanner/access-scan/engine/finding.js').NormalizedFinding} finding
 */
function semanticTargetSignature(finding) {
  const outer = finding.element.outerHTML || '';
  const tagMatch = outer.match(/^<([a-z0-9-]+)/i);
  return JSON.stringify({
    ruleId: finding.ruleId,
    violationType: finding.violationType,
    tag: tagMatch ? tagMatch[1].toLowerCase() : 'unknown',
    frameDepth: finding.element.framePath?.length ?? 0,
    shadowDepth: finding.element.shadowPath?.length ?? 0,
    controlKind: /<(button|input|select|textarea)\b/i.test(outer) ? 'control' : 'other',
    hasAccessibleName: /aria-label=|aria-labelledby=|title=|>[^<\s][^<]*</i.test(outer),
  });
}

/**
 * @param {number} seed
 * @param {string} coreMarkup
 */
function buildSeededWrapperMarkup(seed, coreMarkup) {
  const rand = mulberry32(seed);
  const wrappers = ['div', 'section', 'article', 'span'];
  const depth = 2 + Math.floor(rand() * 4);
  const tokens = Array.from({ length: depth }, (_, index) => ({
    tag: wrappers[Math.floor(rand() * wrappers.length)],
    id: `wrap-${seed.toString(16)}-${index}-${Math.floor(rand() * 1e6)}`,
    className: `layer-${Math.floor(rand() * 1e5)} nested-${index % 3}`,
  }));

  if (rand() > 0.5) {
    tokens.reverse();
  }

  let html = coreMarkup;
  for (const token of tokens) {
    html = `<${token.tag} id="${token.id}" class="${token.className}">${html}</${token.tag}>`;
  }
  return `<html><body>${html}</body></html>`;
}

async function withPage(markup, run, options = {}) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  page.on('console', () => {});
  page.on('pageerror', () => {});
  try {
    await installRuntimeHooks(page);
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

async function runStandardsRules(page, ruleIds) {
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

test('verification gate: production registry is 82 active + 1 legacy with resolved evaluator refs', async () => {
  const registry = await loadBuiltInRuleRegistry({ enforceCatalogContract: true });
  const evaluators = registry.getEvaluators();

  assert.equal(registry.getActiveRuleIds().length, ACTIVE_RULE_COUNT);
  assert.equal(registry.listRules().length, CATALOG_RULE_COUNT);
  assert.deepEqual(registry.getLegacyReadableRuleIds(), [LEGACY_NON_EMITTING_RULE_ID]);

  for (const rule of registry.listRules()) {
    for (const check of rule.checks) {
      assert.ok(
        evaluators.has(check.evaluator),
        `${rule.id}/${check.id} references unresolved evaluator "${check.evaluator}"`,
      );
    }
  }
});

test('verification gate: closed shadow roots and sandboxed frames emit honest diagnostics', async () => {
  await withPage(
    `
      <div id="closed-host"></div>
      <iframe id="sandboxed-frame" sandbox="allow-scripts" srcdoc="<button>Sandboxed</button>"></iframe>
      <script>
        const host = document.getElementById('closed-host');
        const closedRoot = host.attachShadow({ mode: 'closed' });
        closedRoot.innerHTML = '<button id="closed-btn">Closed</button>';
      </script>
    `,
    async (page) => {
      const session = await createScanSession(page);
      const codes = session.diagnostics.map((entry) => entry.code);
      assert.ok(codes.includes('shadow-root-closed'));
      assert.ok(codes.includes('frame-inaccessible'));
      const frameDiagnostic = session.diagnostics.find((entry) => entry.code === 'frame-inaccessible');
      assert.equal(frameDiagnostic?.reason, 'sandbox');
      assert.equal(frameDiagnostic?.inspected, false);
    },
  );

  const childServer = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end('<html><body><button>Child</button></body></html>');
  });
  await new Promise((resolve) => childServer.listen(0, resolve));
  const childPort = /** @type {import('node:net').AddressInfo} */ (childServer.address()).port;

  const parentServer = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end(`<html><body><iframe id="cross-frame" src="http://127.0.0.1:${childPort}/child"></iframe></body></html>`);
  });
  await new Promise((resolve) => parentServer.listen(0, resolve));
  const parentPort = /** @type {import('node:net').AddressInfo} */ (parentServer.address()).port;

  try {
    await withPage(null, async (page) => {
      const session = await createScanSession(page);
      const crossOrigin = session.diagnostics.find((entry) => entry.code === 'frame-inaccessible');
      assert.ok(crossOrigin);
      assert.equal(crossOrigin.reason, 'cross-origin');
      assert.equal(crossOrigin.inspected, false);
    }, { url: `http://127.0.0.1:${parentPort}/parent` });
  } finally {
    await new Promise((resolve, reject) => childServer.close((error) => (error ? reject(error) : resolve())));
    await new Promise((resolve, reject) => parentServer.close((error) => (error ? reject(error) : resolve())));
  }
});

test('verification gate: nested open shadow roots remain reachable for rule findings', async () => {
  await withPage(
    `
      <div id="outer-host"></div>
      <script>
        const outer = document.getElementById('outer-host').attachShadow({ mode: 'open' });
        outer.innerHTML = '<div id="inner-host"></div>';
        const inner = outer.getElementById('inner-host').attachShadow({ mode: 'open' });
        inner.innerHTML = '<button id="deep-empty"></button>';
      </script>
    `,
    async (page) => {
      const { result } = await runStandardsRules(page, ['ButtonDiscernible']);
      assert.equal(result.findings.length, 1);
      assert.equal(result.findings[0].ruleId, 'ButtonDiscernible');
      assert.equal(result.findings[0].violationType, 'confirmed');
      assert.ok(result.findings[0].element.shadowPath.length >= 2);
    },
  );
});

test('verification gate: visibility eligibility matrix covers hidden, inert, opacity, and overrides', async () => {
  await withPage(
    `
      <style>#below-fold-spacer { height: 1800px; }</style>
      <button id="visible-empty"></button>
      <div id="below-fold-spacer"></div>
      <button id="below-fold-empty"></button>
      <button id="display-none-empty" style="display:none"></button>
      <button id="visibility-hidden-empty" style="visibility:hidden"></button>
      <button id="hidden-attr-empty" hidden></button>
      <button id="inert-empty" inert></button>
      <button id="aria-hidden-empty" aria-hidden="true"></button>
      <button id="offscreen-empty" style="position:absolute;left:-10000px;top:-10000px;width:40px;height:20px"></button>
      <p id="opacity-only" style="opacity:0">Screen reader only copy here for misuse</p>
      <p id="aria-hidden-visible" aria-hidden="true">Visible hidden text content here</p>
      <div id="decorative-hero" aria-hidden="true"><img src="hero.jpg" alt=""></div>
    `,
    async (page) => {
      const session = await createScanSession(page);
      const byDomId = new Map(
        session.snapshot.elements
          .filter((element) => element.attributes.id)
          .map((element) => [element.attributes.id, element]),
      );

      for (const id of [
        'display-none-empty',
        'visibility-hidden-empty',
        'hidden-attr-empty',
      ]) {
        const element = byDomId.get(id);
        assert.ok(element, `missing snapshot element ${id}`);
        assert.equal(element.rendered, false, `${id} rendered`);
        assert.equal(element.hiddenFromAT, true, `${id} hiddenFromAT`);
      }

      for (const id of ['inert-empty', 'aria-hidden-empty']) {
        const element = byDomId.get(id);
        assert.ok(element, `missing snapshot element ${id}`);
        assert.equal(element.rendered, true, `${id} rendered`);
        assert.equal(element.hiddenFromAT, true, `${id} hiddenFromAT`);
      }

      const offscreen = byDomId.get('offscreen-empty');
      assert.ok(offscreen);
      assert.equal(offscreen.rendered, true);
      assert.equal(offscreen.visuallyVisible, false);

      const opacityOnly = byDomId.get('opacity-only');
      assert.ok(opacityOnly);
      assert.equal(opacityOnly.rendered, true);
      assert.equal(opacityOnly.visuallyVisible, false);
      assert.equal(opacityOnly.hiddenFromAT, false);

      const buttonResult = await runStandardsRules(page, ['ButtonDiscernible']);
      assert.ok(buttonResult.result.findings.length >= 1);
      assert.ok(buttonResult.result.findings.some((finding) => /visible-empty/.test(finding.element.outerHTML)));
      assert.ok(!buttonResult.result.findings.some((finding) => /display-none-empty|hidden-attr-empty|inert-empty|aria-hidden-empty/.test(finding.element.outerHTML)));

      const misuseResult = await runStandardsRules(page, ['VisibilityMisuse']);
      assert.equal(misuseResult.result.findings.length, 1);
      assert.equal(misuseResult.result.findings[0].violationType, 'potential');
      assert.equal(misuseResult.result.findings[0].evidence.visibilityReason, 'opacity');
      assert.match(misuseResult.result.findings[0].element.outerHTML, /opacity-only/);
      assert.ok(!misuseResult.result.findings.some((finding) => /below-fold-empty|offscreen-empty/.test(finding.element.outerHTML)));

      const mismatchResult = await runStandardsRules(page, ['VisibilityMismatch']);
      assert.equal(mismatchResult.result.findings.length, 1);
      assert.equal(mismatchResult.result.findings[0].violationType, 'confirmed');
      assert.match(mismatchResult.result.findings[0].element.outerHTML, /aria-hidden-visible/);
      assert.ok(!mismatchResult.result.findings.some((finding) => /decorative-hero/.test(finding.element.outerHTML)));

      assert.throws(() => {
        session.snapshot.elements.push({});
      });
    },
  );
});

test('verification gate: delayed framework-style DOM mutations reach stability before scan', async () => {
  await withPage(
    `
      <div id="app"></div>
      <script>
        window.__adaRenderSeed = 0;
        setTimeout(() => {
          window.__adaRenderSeed += 1;
          document.getElementById('app').innerHTML = '<ul id="delayed-empty"></ul>';
        }, 180);
      </script>
    `,
    async (page) => {
      const skipRules = await buildSkipRulesExcept(['ListEmpty']);
      const violations = await scanWithAccessScan(page, 'fixture://verification-delayed-render', {
        skipNavigation: true,
        skipRules,
        stabilityMinObserveMs: 250,
      });
      const renderSeed = await page.evaluate(() => window.__adaRenderSeed);
      assert.equal(renderSeed, 1);
      assert.ok(violations.some((violation) => violation.ruleId === 'ListEmpty'));
      assert.match(
        violations.find((violation) => violation.ruleId === 'ListEmpty').element.outerHTML,
        /delayed-empty/,
      );
    },
  );
});

test('verification gate: below-fold visible labels remain available to semantic rules', async () => {
  await withPage(
    `
      <div style="height: 1800px"></div>
      <a id="below-fold-label" href="/careers" aria-label="Worldwide opportunities">
        <span>Explore careers</span>
      </a>
    `,
    async (page) => {
      const { result } = await runStandardsRules(page, ['VisibleTextPartOfAccessibleName']);
      const finding = result.findings.find(
        (candidate) => candidate.ruleId === 'VisibleTextPartOfAccessibleName',
      );
      assert.ok(finding);
      assert.match(finding.element.outerHTML, /below-fold-label/);
      assert.equal(finding.evidence.visibleText, 'explore careers');
    },
  );
});

test('verification gate: label-in-name ignores nonvisual fallback and SVG title text', async () => {
  await withPage(
    `
      <button id="matching-control" aria-label="Pause">
        pause
        <svg role="presentation"><title>Pause</title></svg>
      </button>
      <a id="font-zero-logo" href="/" aria-label="Company logo" style="font-size:0">
        Careers at Company
        <svg role="img" aria-label="Company logo graphic"></svg>
      </a>
      <button id="mismatching-control" aria-label="Open assistant">Start your search</button>
    `,
    async (page) => {
      const { result } = await runStandardsRules(page, ['VisibleTextPartOfAccessibleName']);
      const findings = result.findings.filter(
        (finding) => finding.ruleId === 'VisibleTextPartOfAccessibleName',
      );
      assert.equal(findings.length, 1);
      assert.match(findings[0].element.outerHTML, /mismatching-control/);
      assert.equal(findings[0].evidence.visibleText, 'start your search');
    },
  );
});

test('verification gate: duplicate ids still satisfy existing ARIA ID references', async () => {
  await withPage(
    `
      <span id="shared-label">First label</span>
      <input id="labelled-control" aria-labelledby="shared-label">
      <span id="shared-label">Duplicate label</span>
      <input id="missing-control" aria-labelledby="missing-label">
    `,
    async (page) => {
      const { result } = await runStandardsRules(page, ['AriaLabelledByHasReference']);
      const findings = result.findings.filter(
        (finding) => finding.ruleId === 'AriaLabelledByHasReference',
      );
      assert.equal(findings.length, 1);
      assert.match(findings[0].element.outerHTML, /missing-control/);
      assert.doesNotMatch(findings[0].element.outerHTML, /labelled-control/);
    },
  );
});

test('verification gate: seeded wrapper permutations preserve semantic finding signatures', async () => {
  const core = '<button id="semantic-empty"></button>';
  const signatures = [];

  for (let variant = 0; variant < 6; variant += 1) {
    const seed = VERIFICATION_SEED + variant;
    const markup = buildSeededWrapperMarkup(seed, core);
    await withPage(markup, async (page) => {
      const { result } = await runStandardsRules(page, ['ButtonDiscernible']);
      assert.equal(result.findings.length, 1);
      signatures.push(semanticTargetSignature(result.findings[0]));
    });
  }

  assert.equal(new Set(signatures).size, 1);
});

test('verification gate: malformed DOM and special-character ids remain scannable', async () => {
  await withPage(
    `
      <p id="unclosed><button id="empty-violation"></button>
      <button id="item:2:3"></button>
      <button id="weird.dot"></button>
      <button id="dup" aria-labelledby="dup"></button>
      <button id="dup" aria-labelledby="missing"></button>
    `,
    async (page) => {
      const { session, result } = await runStandardsRules(page, [
        'ButtonDiscernible',
        'AriaLabelledByHasReference',
      ]);
      assert.ok(session.snapshot.elements.length >= 4);
      const buttonFindings = result.findings.filter((finding) => finding.ruleId === 'ButtonDiscernible');
      assert.ok(buttonFindings.length >= 3);
      const ariaFindings = result.findings.filter((finding) => finding.ruleId === 'AriaLabelledByHasReference');
      assert.ok(ariaFindings.length >= 1);
      assert.equal(ariaFindings[0].violationType, 'confirmed');
    },
  );
});

test('verification gate: classification matrix keeps heuristic potential, deterministic confirmed, parity profile-only', async () => {
  await withPage(
    `
      <html lang="en"><head><title>Gate</title></head><body>
        <ul id="empty-list"></ul>
        <span id="bold-copy" style="font-weight:700">Important</span>
        <div class="shell-wrap-neutral">
          <header>Banner</header>
          <main>
            <h1>Login</h1>
            <form>
              <input type="password" autocomplete="current-password" value="secret123">
              <button type="submit">Sign in</button>
            </form>
          </main>
        </div>
      </body></html>
    `,
    async (page) => {
      const session = await createScanSession(page);
      const registry = await loadBuiltInRuleRegistry({ enforceCatalogContract: true });

      const standards = await runRules({
        registry,
        profile: PROFILES.STANDARDS,
        context: { snapshot: session.snapshot, session },
        skipRules: registry.getActiveRuleIds().filter((id) => ![
          'ListEmpty',
          'StrongMismatch',
          'RegionMainContentMismatch',
        ].includes(id)),
      });
      const listEmpty = standards.findings.find((finding) => finding.ruleId === 'ListEmpty');
      const strong = standards.findings.find((finding) => finding.ruleId === 'StrongMismatch');
      assert.equal(listEmpty?.violationType, 'confirmed');
      assert.equal(strong?.violationType, 'potential');
      assert.equal(
        standards.findings.some((finding) => finding.violationType === 'commercial-parity'),
        false,
      );

      const parity = await runRules({
        registry,
        profile: PROFILES.COMMERCIAL_PARITY,
        context: { snapshot: session.snapshot, session },
        skipRules: registry.getActiveRuleIds().filter((id) => ![
          'RegionMainContentMismatch',
        ].includes(id)),
      });
      const parityFinding = parity.findings.find((finding) => finding.ruleId === 'RegionMainContentMismatch');
      assert.equal(parityFinding?.violationType, 'commercial-parity');
    },
  );
});

test('verification gate: production scanWithAccessScan handles 5k nodes with one navigation and one snapshot', async () => {
  const nodeMarkup = Array.from({ length: LARGE_DOM_NODE_COUNT }, (_, index) => (
    `<span data-node="${index}">node-${index}</span>`
  )).join('');
  const url = `data:text/html,<html><head><title>Perf</title></head><body><div id="big">${nodeMarkup}</div><ul id="perf-empty"></ul></body></html>`;

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
    const startedAt = Date.now();
    let sessionMetrics = null;

    const skipRules = await buildSkipRulesExcept(['ListEmpty']);
    const violations = await scanWithAccessScan(page, url, {
      skipNavigation: false,
      skipRules,
      onExecutionRecords: (_records, meta) => {
        sessionMetrics = meta.sessionMetrics;
      },
    });

    const elapsed = Date.now() - startedAt;
    const spanCount = await page.evaluate(() => document.querySelectorAll('span[data-node]').length);

    assert.equal(gotoCount, 1);
    assert.equal(sessionMetrics.navigationCount, 1);
    assert.equal(sessionMetrics.scannerNavigationCount, 1);
    assert.equal(sessionMetrics.snapshotCount, 1);
    assert.ok(spanCount >= LARGE_DOM_NODE_COUNT);
    assert.ok(violations.some((violation) => violation.ruleId === 'ListEmpty'));
    assert.ok(
      elapsed < LARGE_DOM_SCAN_BUDGET_MS,
      `expected scan under ${LARGE_DOM_SCAN_BUDGET_MS}ms, took ${elapsed}ms`,
    );
  } finally {
    await context.close();
    await browser.close();
  }
});

test('verification gate: production runtime and evaluators contain no querySelectorAll("*") loops', () => {
  const roots = [
    path.join(RUNTIME_ROOT, 'runtime.browser.js'),
    path.join(RUNTIME_ROOT, 'graph-query.js'),
    path.join(RUNTIME_ROOT, 'session.js'),
    EVALUATOR_ROOT,
  ];

  for (const root of roots) {
    const files = root.endsWith('.js') ? [root] : walkJsFiles(root);
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      assert.equal(
        source.includes("querySelectorAll('*')"),
        false,
        `${path.relative(PACKAGE_ROOT, file)} must not use querySelectorAll('*')`,
      );
      assert.equal(
        source.includes('querySelectorAll("*")'),
        false,
        `${path.relative(PACKAGE_ROOT, file)} must not use querySelectorAll("*")`,
      );
    }
  }
});

/**
 * @param {string[]} keep
 */
async function buildSkipRulesExcept(keep) {
  const registry = await loadBuiltInRuleRegistry({ enforceCatalogContract: true });
  return registry.getActiveRuleIds().filter((id) => !keep.includes(id));
}
