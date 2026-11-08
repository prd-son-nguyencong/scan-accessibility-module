// Small neutral ScanReportV2 for the report UI tests and `npm run report:audit`: every owner kind, verdict, a long selector and URL,
// a shared source across pages, an unresolved source, a dead link, a failed and a skipped page, a failing gate.
import { buildScanReportV2 } from '../../src/reporter/report-v2.js';
import { evaluateGate } from '../../src/utils/thresholds.js';

const ctx = { generatedAt: '2026-10-28T09:30:00.000Z', producer: { name: 'ada-scan', version: '1.0.1' }, target: { mode: 'url-only', url: 'https://example.test/' } };
const runs = [{ layer: 'axe', engine: { name: 'axe-core', version: '4.12.1' }, status: 'complete' }, { layer: 'links', engine: { name: 'ada-scan links', version: '1.0.1' }, status: 'complete' }];
const origin = {
  site: { owner: 'site', kind: 'site-source', label: 'Site source', evidence: [] },
  unbound: { owner: 'site', kind: 'unbound-data', label: 'Site source: platform data not bound in local render', evidence: ['unrendered PDK marker data-pdk-for in the node'] },
  unknown: { owner: 'site', kind: 'unknown-probe-failed', label: 'Origin unknown (probe failed)', evidence: ['probe timed out'] },
  vendor: { owner: 'third-party', kind: 'vendor-script', vendor: 'vendor-a', label: 'Consent banner (vendor-script: vendor-a)', evidence: ['class "va-window"', 'script https://cdn.vendor-a.example/consent.js'] },
  widget: { owner: 'platform', kind: 'react-widget', label: 'Paradox React widget: JobList', evidence: ['inside data-react-component'] },
};
const LONG_SELECTOR = 'main#content>section.hero-banner:nth-of-type(2)>div.container>div.row>div.col-md-6:nth-of-type(1)>ul.list-unstyled>li:nth-of-type(7)>a.nav-link.nav-link--secondary[href]';
const LONG_URL = 'https://www.example.test/a/very/long/path/with-many-hyphenated-segments-that-should-wrap-at-boundaries/and/a/query?utm_source=newsletter&utm_medium=email&utm_campaign=autumn-recruiting-2026';
const base = (over) => ({
  ruleId: 'color-contrast', nativeRuleId: 'color-contrast', layer: 'axe', category: 'accessibility', impact: 'serious', verdict: 'confirmed', count: 1, wcagRef: 'WCAG2AA',
  element: { selector: 'a.cta', outerHTML: '<a class="cta" href="/jobs">Search jobs</a>' }, fix: { hint: 'Raise the contrast ratio of the link text to at least 4.5:1.' }, origin: origin.site,
  evidence: { message: 'Element has insufficient color contrast of 2.9 (foreground #777777, background #ffffff, expected 4.5)', proof: { type: 'measured-fact', fact: 'contrast ratio 2.9:1, required 4.5:1 (foreground #777777 on #ffffff)' } },
  source: { mode: 'url', file: 'src/partials/layout/footer.liquid', line: 17, snippet: '    16 | <ul>\n>   17 |   <li><a class="cta" href="/jobs">Search jobs</a></li>\n    18 | </ul>', method: 'instrumentation-manifest', confidence: 'high' },
  ...over,
});
const page = (url, violations, extra = {}) => ({ name: url === '/' ? 'homepage' : url.slice(1), page: url, url: `https://example.test${url}`, status: 'ok', violations, scannerRuns: runs, lighthouseScores: {}, ...extra });
const lh = (p) => ({ lighthouse: { mobile: { device: 'mobile', viewport: { width: 412, height: 823 }, scores: { performance: p, accessibility: 96, bestPractices: 100, seo: 90 }, metrics: { 'largest-contentful-paint': { label: 'Largest Contentful Paint', displayValue: '3.1 s', rating: 'average' }, 'cumulative-layout-shift': { label: 'Cumulative Layout Shift', displayValue: '0.010', rating: 'good' } } }, desktop: { device: 'desktop', viewport: { width: 1350, height: 940 }, scores: { performance: 88, accessibility: 96, bestPractices: 100, seo: 90 }, metrics: {} } } });

/** The finding records a rendered report embeds for its client, decoded (inverse of ui/render.js#pack). */
export function unpackData(html) {
  const raw = JSON.parse(/<script type="application\/json" id="report-data">([\s\S]*?)<\/script>/.exec(html)[1]);
  const unpack = (x) => (typeof x === 'string' ? (x[0] === '~' ? (x[1] === '~' ? x.slice(1) : raw.t[+x.slice(1)]) : x) : Array.isArray(x) ? x.map(unpack) : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, unpack(v)])) : x);
  return unpack(raw.d);
}

export function buildFixtureReport() {
  const shared = (ruleId = 'button-name') => base({ ruleId, nativeRuleId: ruleId, impact: 'critical', element: { selector: 'button.icon', outerHTML: '<button class="icon"></button>' }, fix: { hint: 'Give the button an accessible name.' }, evidence: { message: 'Buttons must have discernible text', proof: { type: 'measured-fact', fact: 'the button has no text, aria-label or title' } } });
  const pages = [
    page('/', [
      base({}),
      shared(),
      base({ ruleId: 'target-size', nativeRuleId: 'target-size', impact: 'moderate', verdict: 'likely', element: { selector: LONG_SELECTOR, outerHTML: `<a class="nav-link nav-link--secondary" href="${LONG_URL}">${'A long link label '.repeat(8)}</a>` }, source: { mode: 'url', file: null, line: null, snippet: null, method: 'unresolved', confidence: 'none' } }),
      base({ ruleId: 'label', nativeRuleId: 'label', verdict: 'needs-review', origin: origin.unbound, element: { selector: 'input.pdk', outerHTML: '<input class="pdk" data-pdk-for="x">' }, evidence: { message: 'Form elements must have labels' } }),
      base({ ruleId: 'aria-allowed-attr', nativeRuleId: 'aria-allowed-attr', verdict: 'needs-review', origin: origin.unknown, element: { selector: 'div.late', outerHTML: '<div class="late" aria-x="1"></div>' }, evidence: { message: 'Elements must only use allowed ARIA attributes' } }),
      base({ ruleId: 'region', nativeRuleId: 'region', impact: 'moderate', verdict: 'needs-review', origin: origin.vendor, element: { selector: '.va-window', outerHTML: '<div class="va-window"></div>' }, source: { mode: 'url', file: null, line: null, snippet: null, method: 'third-party', confidence: 'none' }, evidence: { message: 'All page content should be contained by landmarks' } }),
      base({ ruleId: 'link-name', nativeRuleId: 'link-name', verdict: 'needs-review', origin: origin.widget, element: { selector: '[data-react-component="JobList"] a', outerHTML: '<a href="/jobs/1"></a>' }, source: { mode: 'url', file: null, line: null, snippet: null, method: 'unresolved', confidence: 'none' }, evidence: { message: 'Links must have discernible text' } }),
      base({ ruleId: 'dead-link-unreachable', nativeRuleId: 'dead-link-unreachable', layer: 'links', verdict: 'needs-review', element: { selector: 'a.ext', outerHTML: `<a class="ext" href="${LONG_URL}">Read more</a>` }, linkTarget: { url: LONG_URL, status: 403, reason: 'blocked-unverifiable' }, evidence: { message: 'HTTP 403', proof: { type: 'http-status', fact: `HTTP 403. Redirect chain: HEAD: ${LONG_URL} (403); GET: ${LONG_URL} (301) -> https://www.example.test/login (200).` } } }),
    ], { lighthouseScores: { homepage: lh(72) } }),
    page('/about', [shared(), base({ ruleId: 'image-alt', nativeRuleId: 'image-alt', impact: 'critical', element: { selector: 'img.hero', outerHTML: '<img class="hero" src="/h.png">' }, fix: { hint: 'Add an alt attribute.' }, evidence: { message: 'Images must have alternative text', proof: { type: 'measured-fact', fact: 'the img has no alt attribute' } } })], { lighthouseScores: { about: lh(64) } }),
    page('/jobs', []),
    { ...page('/broken', []), status: 'failed', failure: { reason: 'http-status', message: 'HTTP 500' } },
    { ...page('/empty', []), status: 'skipped-empty', skipped: { reason: 'empty-page', note: 'empty template, platform-managed?' } },
  ];
  const prelim = buildScanReportV2(pages, ctx);
  const gate = evaluateGate(pages.slice(0, 3).map((p, i) => ({ ...p, findings: prelim.pages[i].findings })), undefined);
  return buildScanReportV2(pages, { ...ctx, thresholds: gate, discovery: { partial: false, pages: [], droppedRoutes: [{ route: '/pages/ghost', source: 'dist', status: 404 }] } });
}
