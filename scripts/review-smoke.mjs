import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { computeInstrumentationDigest } from '../src/tracer/build-instrumented.js';
import { buildScanReportV2 } from '../src/reporter/report-v2.js';
import { startFixController } from '../src/fix/controller/index.js';
import { createReviewState } from '../src/fix/review/state.js';
import { startReviewServer } from '../src/fix/review/server.js';
import { buildFixUnits } from '../src/fix/canonical/fix-unit.js';
import { buildTraceCandidatesFromFindings } from '../src/fix/trace/candidates.js';
import { traceAllFindings } from '../src/fix/trace/inbox.js';
import { FIXTURE_CANDIDATE_HASH, withFixtureCandidates } from '../test/fix/review-fixtures.js';

const baseFixture = JSON.parse(await import('node:fs').then((m) => m.readFileSync(new URL('../test/fixtures/fix/report-v2.json', import.meta.url), 'utf8')));
const REVISION = 'git:abc123';
const PREIMAGE_A = 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function performanceFinding() {
  return {
    findingId: 'sha256:smoke-perf-lcp',
    nativeRuleId: 'largest-contentful-paint',
    canonicalRuleId: 'largest-contentful-paint',
    category: 'performance',
    layer: 'lighthouse',
    pageState: 'initial',
    route: '/',
    metric: 'largest-contentful-paint',
    device: 'mobile',
    affectedResources: ['https://example.test/hero.webp'],
    source: {
      file: 'src/partials/hero.liquid',
      line: 4,
      confidence: 'medium',
      method: 'hint-search',
      preimageSha256: PREIMAGE_A,
    },
    evidence: {
      message: 'LCP element is slow.',
      device: 'mobile',
      affectedResources: ['https://example.test/hero.webp'],
    },
  };
}

function unmappedAccessibilityFinding() {
  return {
    findingId: 'sha256:smoke-unresolved-partial',
    nativeRuleId: 'button-name',
    canonicalRuleId: 'button-name',
    category: 'accessibility',
    layer: 'axe',
    pageState: 'initial',
    route: '/',
    element: { selector: '#orphan-btn', normalizedHtmlHash: 'sha256:btn' },
    source: {},
    evidence: { message: 'Button has no accessible name.' },
    traceCandidates: [{
      file: 'src/pages/index.liquid',
      line: 0,
      confidence: 'low',
      method: 'guess',
      preimageSha256: 'invalid',
    }],
  };
}

function writeTempProject(root) {
  writeFileSync(join(root, '.scan-config.json'), JSON.stringify({ outDir: 'dist' }));
  mkdirSync(join(root, 'dist'), { recursive: true });
  mkdirSync(join(root, 'src', 'partials', 'hero'), { recursive: true });
  writeFileSync(join(root, 'src', 'partials', 'hero.liquid'), '<img src="hero.webp" />\n');
  const manifest = { 'dist/pages/index.html': 'src/pages/index.liquid' };
  writeFileSync(join(root, 'dist', 'scan-manifest.json'), JSON.stringify(manifest));
  const digest = computeInstrumentationDigest(manifest);
  writeFileSync(join(root, 'dist', 'scan-attestation.json'), JSON.stringify({ buildRevision: REVISION, instrumentationDigest: digest }));
  return digest;
}

function localReport(digest) {
  return buildScanReportV2(baseFixture.scanResults, {
    ...baseFixture.context,
    target: { mode: 'local-only', url: 'http://localhost:1234/', buildRevision: REVISION, instrumentationDigest: digest },
  });
}

async function startServer(root, { withCandidate = true } = {}) {
  const digest = writeTempProject(root);
  const report = localReport(digest);
  const controller = startFixController({ report, localRoot: root });
  const perfUnits = buildFixUnits([performanceFinding()]).map((unit) => ({ ...unit, status: 'ready' }));
  const unmappedUnits = buildFixUnits([unmappedAccessibilityFinding()]);
  let fixUnits = [...withFixtureCandidates(controller.fixUnits), ...perfUnits, ...unmappedUnits];
  if (!withCandidate) {
    fixUnits = fixUnits.map((unit) => {
      const next = structuredClone(unit);
      delete next.candidate;
      delete next.candidateHash;
      return next;
    });
  }
  const traceInbox = structuredClone(controller.traceInbox);
  const unmappedCandidates = buildTraceCandidatesFromFindings([unmappedAccessibilityFinding()]);
  if (unmappedCandidates[0]) traceInbox.candidates.push(unmappedCandidates[0]);
  const traceResults = traceAllFindings(traceInbox, fixUnits.flatMap((unit) => unit.findings || []));
  const state = createReviewState({
    sessionDir: controller.sessionDir,
    reportId: report.reportId,
    sessionId: controller.session.sessionId,
    fixUnits,
    traceResults,
    policyRoutes: fixUnits.map((unit) => ({ fixUnitId: unit.fixUnitId, proposalAllowed: unit.status === 'ready' })),
    traceInbox,
    localRoot: root,
  });
  const server = await startReviewServer({ state });
  return { server, state, fixUnits };
}

const checks = [];
const root = mkdtempSync(join(tmpdir(), 'ada-review-smoke-'));
const browser = await chromium.launch({ headless: true });
try {
  const noCandidateRoot = mkdtempSync(join(tmpdir(), 'ada-review-smoke-no-candidate-'));
  try {
    const { server } = await startServer(noCandidateRoot, { withCandidate: false });
    const page = await browser.newPage();
    await page.goto(server.reviewUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(400);
    checks.push(['no-candidate accept disabled', await page.locator('#accept-btn').isDisabled()]);
    await page.close();
    await server.close();
  } finally {
    rmSync(noCandidateRoot, { recursive: true, force: true });
  }

  const { server } = await startServer(root, { withCandidate: true });
  const page = await browser.newPage();
  await page.goto(server.reviewUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(500);
  checks.push(['boot title', (await page.title()).includes('Accessibility & Performance Fix Review')]);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(400);
  checks.push(['reload after token scrub succeeds', (await page.locator('#apply-gate').textContent()).includes('Gate')]);

  checks.push(['accessibility review shows source snippets', await page.locator('#review-panel details summary', { hasText: 'sort.liquid' }).count() >= 1]);
  checks.push(['accessibility review shows scanner evidence', await page.locator('#review-panel details summary', { hasText: 'Scanner evidence' }).count() >= 1]);
  checks.push(['candidate diff follows snippets and evidence', await page.evaluate(() => {
    const panel = document.getElementById('review-panel');
    const text = panel ? panel.textContent : '';
    const snippetsIdx = text.indexOf('Source snippets');
    const evidenceIdx = text.indexOf('Scanner evidence');
    const diffIdx = text.indexOf('Candidate diff');
    return snippetsIdx >= 0 && evidenceIdx > snippetsIdx && diffIdx > evidenceIdx;
  })]);

  checks.push(['trace inbox manual mapping with unusable partials', await page.evaluate(() => {
    const inbox = document.getElementById('source-list');
    if (!inbox) return false;
    const hasManual = [...inbox.querySelectorAll('button')].some((btn) => btn.textContent === 'Manual mapping');
    const hasNote = inbox.textContent.includes('Missing valid file, line, or preimage hash');
    return hasManual && hasNote;
  })]);

  await page.locator('#mode-performance').click();
  await page.waitForTimeout(300);
  const perfButtons = page.locator('#unit-list .list-item');
  if (await perfButtons.count() > 0) {
    await perfButtons.first().click();
    await page.waitForTimeout(200);
    checks.push(['performance review shows owner candidates', await page.locator('#review-panel', { hasText: 'Owner candidates' }).count() === 1]);
    checks.push(['owner candidates precede multi-file plan', await page.evaluate(() => {
      const panel = document.getElementById('review-panel');
      const text = panel ? panel.textContent : '';
      const ownersIdx = text.indexOf('Owner candidates');
      const planIdx = text.indexOf('Multi-file plan');
      return ownersIdx >= 0 && planIdx > ownersIdx;
    })]);
  } else {
    checks.push(['performance review shows owner candidates', false]);
    checks.push(['owner candidates precede multi-file plan', false]);
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(250);
  checks.push(['390px one-pane tabs visible', await page.locator('.mobile-tabs').isVisible()]);
  await page.locator('#tab-list').focus();
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(150);
  checks.push(['keyboard ArrowRight switches tab', await page.locator('#tab-review[aria-selected="true"]').count() === 1]);

  await page.setViewportSize({ width: 780, height: 400 });
  await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
  await page.waitForTimeout(200);
  const overflow = await page.evaluate(() => {
    const doc = document.documentElement;
    const body = document.body;
    return doc.scrollWidth <= window.innerWidth + 1 && body.scrollWidth <= body.clientWidth + 1;
  });
  checks.push(['200% equivalent viewport no horizontal overflow', overflow]);

  const decisionReachable = await page.evaluate(async () => {
    const accept = document.getElementById('accept-btn');
    if (!accept) return false;
    accept.scrollIntoView({ block: 'nearest' });
    const rect = accept.getBoundingClientRect();
    const review = document.getElementById('review-panel');
    const reviewRect = review ? review.getBoundingClientRect() : null;
    const inViewport = rect.top >= 0 && rect.bottom <= window.innerHeight;
    const reviewVisible = !reviewRect || (reviewRect.height > 0 && reviewRect.bottom > 0);
    return inViewport && reviewVisible;
  });
  checks.push(['200% decision bar and review content reachable', decisionReachable]);

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.evaluate(() => { document.documentElement.style.fontSize = ''; });
  await page.locator('#mode-accessibility').click();
  await page.waitForTimeout(200);
  checks.push(['candidate fixture accept enabled when eligible', !(await page.locator('#accept-btn').isDisabled())]);
  await page.close();
  await server.close();
} finally {
  await browser.close();
  rmSync(root, { recursive: true, force: true });
}

let failed = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  if (!ok) failed += 1;
}
console.log(`\nSmoke checks: ${checks.length - failed}/${checks.length} passed`);
if (failed > 0) process.exit(1);
