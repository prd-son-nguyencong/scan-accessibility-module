import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

import {
  AccessScanUnknownProfileError,
  resolveScanProfile,
  resolveOrchestratorScanProfile,
  scanWithAccessScan,
} from '../src/scanner/access-scan/index.js';
import { installRuntimeHooks } from '../src/scanner/access-scan/runtime/index.js';
import { loadBuiltInRuleRegistry } from '../src/scanner/access-scan/engine/builtin-registry.js';
import {
  filterChecksForProfile,
  PROFILES,
} from '../src/scanner/access-scan/engine/profiles.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHARACTERIZATION_FIXTURE = JSON.parse(
  readFileSync(path.join(__dirname, 'fixtures/access-scan/standards-characterization.json'), 'utf8'),
);

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

const CHARACTERIZATION_MARKUP = `
  <html lang="en">
    <head>
      <title>Neutral characterization</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">
    </head>
    <body>
      <div role="application" id="app-shell">App</div>
      <span alt="wrong">Decorative</span>
      <ul id="legacy-empty"></ul>
      <nav><a href="/jobs" target="_blank">Jobs</a></nav>
      <label for="req">Email *</label>
      <input id="req" type="email" placeholder="you@example.com">
      <button id="mismatch" aria-label="Remove item">Delete</button>
      <a href="file.pdf">Download</a>
      <nav role="menu"><a href="/" role="menuitem">Home</a></nav>
    </body>
  </html>
`;

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

function buildFindingSignature(violations) {
  return violations
    .map((violation) => ({
      ruleId: violation.ruleId,
      violationType: violation.evidence?.violationType,
      checkId: violation.evidence?.checkId,
      selector: violation.element?.selector,
    }))
    .sort((left, right) => (
      left.ruleId.localeCompare(right.ruleId)
      || String(left.selector).localeCompare(String(right.selector))
    ));
}

test('filterChecksForProfile uses exact profile membership', () => {
  const checks = [
    { id: 'both', profiles: ['standards', 'commercial-parity'] },
    { id: 'parity', profiles: ['commercial-parity'] },
    { id: 'standards', profiles: ['standards'] },
  ];

  assert.deepEqual(
    filterChecksForProfile(checks, PROFILES.STANDARDS).map((check) => check.id),
    ['both', 'standards'],
  );
  assert.deepEqual(
    filterChecksForProfile(checks, PROFILES.COMMERCIAL_PARITY).map((check) => check.id),
    ['both', 'parity'],
  );
});

test('resolveScanProfile preserves legacy includeThirdParty mapping when profile is omitted', () => {
  assert.equal(resolveScanProfile({}), PROFILES.STANDARDS);
  assert.equal(resolveScanProfile({ includeThirdParty: false }), PROFILES.STANDARDS);
  assert.equal(resolveScanProfile({ includeThirdParty: true }), PROFILES.COMMERCIAL_PARITY);
});

test('resolveScanProfile gives explicit profile precedence over includeThirdParty', () => {
  assert.equal(
    resolveScanProfile({ profile: PROFILES.STANDARDS, includeThirdParty: true }),
    PROFILES.STANDARDS,
  );
  assert.equal(
    resolveScanProfile({ profile: PROFILES.COMMERCIAL_PARITY, includeThirdParty: false }),
    PROFILES.COMMERCIAL_PARITY,
  );
});

test('resolveScanProfile fails closed on unknown profile with stable typed error', () => {
  assert.throws(
    () => resolveScanProfile({ profile: 'overlay' }),
    (error) => {
      assert.ok(error instanceof AccessScanUnknownProfileError);
      assert.equal(error.name, 'AccessScanUnknownProfileError');
      assert.equal(error.errorCode, 'unknown_profile');
      assert.equal(error.profile, 'overlay');
      return true;
    },
  );
});

test('resolveScanProfile resolves nullish explicit profile to standards', () => {
  assert.equal(resolveScanProfile({ profile: undefined }), PROFILES.STANDARDS);
  assert.equal(resolveScanProfile({ profile: null }), PROFILES.STANDARDS);
});

test('resolveScanProfile rejects empty explicit profile string', () => {
  assert.throws(
    () => resolveScanProfile({ profile: '' }),
    (error) => {
      assert.ok(error instanceof AccessScanUnknownProfileError);
      assert.equal(error.errorCode, 'unknown_profile');
      assert.equal(error.profile, '');
      return true;
    },
  );
});

test('resolveScanProfile rejects non-string explicit profile values', () => {
  for (const profile of [42, true, {}, []]) {
    assert.throws(
      () => resolveScanProfile({ profile }),
      (error) => {
        assert.ok(error instanceof AccessScanUnknownProfileError);
        assert.equal(error.errorCode, 'unknown_profile');
        assert.equal(error.profile, String(profile));
        return true;
      },
    );
  }
});

test('resolveScanProfile ignores includeThirdParty when profile key is present even if nullish', () => {
  assert.equal(
    resolveScanProfile({ profile: null, includeThirdParty: true }),
    PROFILES.STANDARDS,
  );
  assert.equal(
    resolveScanProfile({ profile: undefined, includeThirdParty: true }),
    PROFILES.STANDARDS,
  );
});

test('resolveOrchestratorScanProfile honors includeThirdParty when profile is unset/nullish', () => {
  assert.equal(
    resolveOrchestratorScanProfile({ profile: undefined, includeThirdParty: true }),
    PROFILES.COMMERCIAL_PARITY,
  );
  assert.equal(
    resolveOrchestratorScanProfile({ profile: null, includeThirdParty: true }),
    PROFILES.COMMERCIAL_PARITY,
  );
  assert.equal(
    resolveOrchestratorScanProfile({ includeThirdParty: true }),
    PROFILES.COMMERCIAL_PARITY,
  );
  assert.equal(
    resolveOrchestratorScanProfile({ includeThirdParty: false }),
    PROFILES.STANDARDS,
  );
  assert.equal(
    resolveOrchestratorScanProfile({
      profile: PROFILES.STANDARDS,
      includeThirdParty: true,
    }),
    PROFILES.STANDARDS,
  );
});

test('commercial-parity profile does not execute standards-only descriptor checks', async () => {
  const registry = await loadBuiltInRuleRegistry({ enforceCatalogContract: true });
  const parityChecks = registry.getChecksForProfile(PROFILES.COMMERCIAL_PARITY);
  const parityCheckIds = new Set(parityChecks.map(({ check }) => check.id));

  for (const rule of registry.listRules()) {
    for (const check of rule.checks) {
      const isStandardsOnly = (
        check.profiles.includes(PROFILES.STANDARDS)
        && !check.profiles.includes(PROFILES.COMMERCIAL_PARITY)
      );
      if (isStandardsOnly) {
        assert.equal(
          parityCheckIds.has(check.id),
          false,
          `standards-only check ${check.id} must not run in commercial-parity`,
        );
      }
    }
  }
});

test('standards profile never executes parity-only descriptor checks', async () => {
  const registry = await loadBuiltInRuleRegistry({ enforceCatalogContract: true });
  const standardsChecks = registry.getChecksForProfile(PROFILES.STANDARDS);
  const standardsCheckIds = new Set(standardsChecks.map(({ check }) => check.id));

  for (const rule of registry.listRules()) {
    for (const check of rule.checks) {
      const isParityOnly = (
        check.profiles.includes(PROFILES.COMMERCIAL_PARITY)
        && !check.profiles.includes(PROFILES.STANDARDS)
      );
      if (isParityOnly) {
        assert.equal(
          standardsCheckIds.has(check.id),
          false,
          `parity-only check ${check.id} must not run in standards`,
        );
      }
    }
  }
});

test('commercial scan suppresses standards-only link warnings and metadata extras', async () => {
  await withPage(CHARACTERIZATION_MARKUP, async (page) => {
    const violations = await scanWithAccessScan(page, 'fixture://commercial-profile', {
      skipNavigation: true,
      profile: PROFILES.COMMERCIAL_PARITY,
    });

    const leaked = violations.filter((violation) => STANDARDS_ONLY_RULE_IDS.includes(violation.ruleId));
    assert.deepEqual(leaked.map((violation) => violation.ruleId).sort(), []);
    assert.ok(violations.some((violation) => violation.ruleId === 'ListEmpty'));
    assert.ok(violations.some((violation) => violation.ruleId === 'AltMisuse'));
  });
});

test('frozen standards characterization snapshot remains unchanged', async () => {
  await withPage(CHARACTERIZATION_MARKUP, async (page) => {
    const violations = await scanWithAccessScan(page, 'fixture://standards-characterization', {
      skipNavigation: true,
      profile: PROFILES.STANDARDS,
    });

    const signature = buildFindingSignature(violations);
    const digest = createHash('sha256').update(JSON.stringify(signature)).digest('hex');

    assert.equal(violations.length, CHARACTERIZATION_FIXTURE.findingCount);
    assert.equal(digest, CHARACTERIZATION_FIXTURE.digest);

    const expected = CHARACTERIZATION_FIXTURE.signature.map((entry) => ({
      ruleId: entry.ruleId,
      violationType: entry.violationType,
      checkId: entry.checkId,
    }));
    const actual = signature.map((entry) => ({
      ruleId: entry.ruleId,
      violationType: entry.violationType,
      checkId: entry.checkId,
    }));
    assert.deepEqual(actual, expected);
  });
});

test('scanWithAccessScan rejects unknown profile before navigation', async () => {
  await withPage('<html><body></body></html>', async (page) => {
    await assert.rejects(
      () => scanWithAccessScan(page, 'fixture://unknown-profile', {
        skipNavigation: true,
        profile: 'legacy-overlay',
      }),
      (error) => {
        assert.ok(error instanceof AccessScanUnknownProfileError);
        assert.equal(error.errorCode, 'unknown_profile');
        return true;
      },
    );
  });
});
