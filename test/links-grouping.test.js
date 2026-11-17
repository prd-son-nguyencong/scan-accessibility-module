import './helpers/hermetic-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { scanDeadLinks, createLinkChecker, loadProjectRoutes } from '../src/scanner/links.js';
import { traceToPartials, scanOnePage } from '../src/index.js';
import { buildReportBundle } from '../src/reporter/scan-report.js';
import { closeBrowser } from '../src/scanner/browser.js';
import { requireBrowser } from './helpers/require-browser.js';
import { buildScanReportV2, validateScanReportV2 } from '../src/reporter/report-v2.js';
import { buildTaskSet } from '../src/fix/export/tasks.js';
import { buildSarif } from '../src/reporter/sarif.js';
import { buildFixUnits } from '../src/fix/canonical/fix-unit.js';

const STATUS = { '/blocked': 403, '/gone': 404, '/missing-page': 404 };
async function mock() {
  const server = http.createServer((req, res) => res.writeHead(STATUS[req.url.split('#')[0]] || 200).end('ok'));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => { server.close(); server.closeAllConnections?.(); } };
}
const fake = (urls) => ({ $$eval: async (sel) => (sel.startsWith('a[href], link') ? urls.map((u, i) => ({ tag: 'a', url: u, rawHref: '', text: `l${i}`, html: `<a class="f" href="${u}">l${i}</a>`, selector: `footer a:nth-of-type(${i + 1})`, linkRel: '' })) : []) });

// Footer partial rendered on every page; the href lives on line 4 of its sidecar (hand-counted).
const FOOTER = (base) => ({
  'dist/scan-manifest.json': '{}',
  'src/layouts/layout.liquid': '<!doctype html>\n<html lang="en">\n<body>\n{% block content %}{% endblock %}\n{% render "layout/footer" %}\n</body></html>\n',
  'src/pages/index.liquid': '{% layout "layout" %}\n{% block content %}\n<main id="main">a</main>\n{% endblock %}\n',
  'src/pages/about.liquid': '{% layout "layout" %}\n{% block content %}\n<main id="main">b</main>\n{% endblock %}\n',
  'src/partials/layout/footer.liquid': '<footer>\n{% for l in links %}\n<a class="f" href="{{ l.href }}">{{ l.label }}</a>\n{% endfor %}\n</footer>\n',
  'src/partials/layout/footer.liquid.json': `{\n "links": [\n  {\n   "href": "${base}/gone#cookies",\n   "label": "Privacy"\n  }\n ]\n}\n`,
});

test('unbound backend-tag hrefs are not probed or reported; a fragment is kept and the probe ignores it', async () => {
  const site = await mock();
  try {
    const unbound = await scanDeadLinks(fake([`${site.base}/%7B%7Bdata:footer.url%7D%7D`, `${site.base}/{{ link.href }}`]), `${site.base}/`);
    assert.deepEqual(unbound, []);
    const [v] = await scanDeadLinks(fake([`${site.base}/gone#cookies`]), `${site.base}/`);
    assert.deepEqual(v.linkTarget, { url: `${site.base}/gone`, fragment: '#cookies', status: 404, reason: null });
    assert.match(v.fix.hint, /gone#cookies/);
  } finally { site.close(); }
});

test('report: one dead-link finding per target across pages, sourced to the footer data line; distinct targets stay separate', async () => {
  const site = await mock();
  const root = mkdtempSync(join(tmpdir(), 'ada-links-'));
  try {
    for (const [rel, body] of Object.entries(FOOTER(site.base))) { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), body); }
    const checker = createLinkChecker();
    const results = [];
    for (const [name, route, extra] of [['home', '/', []], ['about', '/about', [`${site.base}/gone#careers`, `${site.base}/blocked`]]]) {
      const vs = await scanDeadLinks(fake([`${site.base}/gone#cookies`, ...extra]), `${site.base}${route}`, { checker });
      await traceToPartials(vs, `http://127.0.0.1:1${route}`, root);
      results.push({ page: name, url: `${site.base}${route}`, violations: vs, scannerRuns: [{ layer: 'links', engine: { name: 'ada-links', version: '1' }, status: 'complete' }] });
    }
    const report = buildScanReportV2(results, { generatedAt: '2026-10-27T00:00:00.000Z', producer: { name: 'ada-scan', version: '1.0.1' }, target: { mode: 'url-only', url: `${site.base}/` } });
    validateScanReportV2(report);
    const all = report.pages.flatMap((p) => p.findings);
    const gone = all.filter((f) => f.link?.url === `${site.base}/gone`);
    assert.equal(gone.length, 1, 'same target on two pages is one finding');
    const [g] = gone;
    assert.deepEqual(g.pages, ['/', '/about']);
    assert.equal(g.count, 3); // home 1 + about 2 (two fragments)
    assert.deepEqual(g.link.fragments, ['#careers', '#cookies']);
    // Primary source is where the href is authored (sidecar line); the template line is secondary.
    assert.deepEqual([g.source.file, g.source.line], ['src/partials/layout/footer.liquid.json', 4]);
    assert.equal(g.source.dataFile, 'src/partials/layout/footer.liquid.json');
    assert.equal(g.source.templateSource.file, 'src/partials/layout/footer.liquid');
    assert.ok(g.source.preimageSha256, 'preimage belongs to the data line');
    const sarifLoc = buildSarif(report).runs[0].results.find((r) => r.message.text.includes('/gone')).locations[0].physicalLocation;
    assert.deepEqual([sarifLoc.artifactLocation.uri, sarifLoc.region?.startLine], ['src/partials/layout/footer.liquid.json', 4]);
    assert.equal(g.verdict, 'confirmed');
    // Paired: a different target and a different kind (403 = blocked, needs-review) are their own findings.
    const blocked = all.filter((f) => f.link?.url === `${site.base}/blocked`);
    assert.deepEqual(blocked.map((f) => [f.verdict, f.link.reason, f.pages]), [['needs-review', 'blocked-unverifiable', ['/about']]]);
    assert.equal(all.length, 2);
    const task = buildTaskSet(report).tasks.find((t) => t.rule === 'dead-link-404');
    assert.deepEqual([task.source.file, task.source.line], ['src/partials/layout/footer.liquid.json', 4]);
    // Fix tasks: one unit, and it lists both pages.
    const units = buildFixUnits(all.filter((f) => f.verdict === 'confirmed'));
    assert.deepEqual(units.map((u) => u.affectedRoutes), [['/', '/about']]);
  } finally { site.close(); rmSync(root, { recursive: true, force: true }); }
});

test('same-origin route the project does not define is route-not-served-locally in the grouped finding', async () => {
  const site = await mock();
  try {
    const vs = await scanDeadLinks(fake([`${site.base}/missing-page#x`]), `${site.base}/`, { knownRoutes: new Set(['/']) });
    const report = buildScanReportV2([{ page: 'home', url: `${site.base}/`, violations: vs, scannerRuns: [{ layer: 'links', engine: { name: 'ada-links', version: '1' }, status: 'complete' }] }],
      { generatedAt: '2026-10-27T00:00:00.000Z', producer: { name: 'ada-scan', version: '1.0.1' }, target: { mode: 'url-only', url: `${site.base}/` } });
    const [f] = report.pages[0].findings;
    assert.deepEqual([f.verdict, f.link.reason, f.link.fragments], ['needs-review', 'route-not-served-locally', ['#x']]);
  } finally { site.close(); }
});

// Crawl-found rows (pageConfig.brokenLinks) take the same path as probed rows: grouped per target, traced to the authored footer
// data line even in a plain build (no scan-manifest.json), and an undefined same-origin route is needs-review.
test('crawl-found broken links: one finding per target across pages, sourced to the footer data line, undefined route is route-not-served-locally', async (t) => {
  if (!await requireBrowser(t)) return;
  const html = (extra) => `<!doctype html><html lang="en"><body><main id="main"><h1>t</h1></main><footer><p>links hidden from the page DOM: only the crawl knows them</p></footer></body></html>${extra}`;
  const server = http.createServer((req, res) => (['/', '/about'].includes(req.url) ? res.writeHead(200, { 'content-type': 'text/html' }).end(html('')) : res.writeHead(404).end('x')));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const root = mkdtempSync(join(tmpdir(), 'ada-crawl-links-'));
  try {
    const files = {
      'src/layouts/layout.liquid': '<!doctype html>\n<html lang="en">\n<body>\n{% block content %}{% endblock %}\n{% render "layout/footer" %}\n</body></html>\n',
      'src/pages/index.liquid': '{% layout "layout" %}\n{% block content %}\n<main id="main">a</main>\n{% endblock %}\n',
      'src/pages/about.liquid': '{% layout "layout" %}\n{% block content %}\n<main id="main">b</main>\n{% endblock %}\n',
      'src/pages/gone.liquid': '{% layout "layout" %}\n{% block content %}\n<main id="main">c</main>\n{% endblock %}\n',
      'src/partials/layout/footer.liquid': '<footer>\n{% for l in links %}\n<a class="f" href="{{ l.href }}">{{ l.label }}</a>\n{% endfor %}\n</footer>\n',
      'src/partials/layout/footer.liquid.json': '{\n "links": [\n  {\n   "href": "/gone",\n   "label": "Gone"\n  },\n  {\n   "href": "/platform-only",\n   "label": "Platform"\n  }\n ]\n}\n',
    };
    for (const [rel, body] of Object.entries(files)) { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), body); }
    const knownRoutes = loadProjectRoutes(root);
    assert.deepEqual([...knownRoutes].sort(), ['/', '/about', '/gone']);
    const results = [];
    for (const [name, path_] of [['home', '/'], ['about', '/about']]) {
      const brokenLinks = [{ route: '/gone', url: `${base}/gone`, status: 404, href: '/gone' }, { route: '/platform-only', url: `${base}/platform-only`, status: 404, href: '/platform-only' }];
      const res = await scanOnePage({ name, path: path_, url: `${base}${path_}`, brokenLinks }, { layers: { links: true } }, { localRoot: root, knownRoutes });
      results.push({ ...res, page: res.name });
    }
    const { report } = buildReportBundle(results, { producer: { name: 'ada-scan', version: '0.0.0-test' } });
    const all = report.pages.flatMap((p) => p.findings).filter((f) => f.nativeRuleId === 'broken-link');
    assert.equal(all.length, 2, 'two targets, each reported once across two pages');
    const gone = all.find((f) => f.link.url === `${base}/gone`);
    assert.deepEqual([gone.verdict, gone.pages, gone.count], ['confirmed', ['/', '/about'], 2]); // defined in the project, answers 404: real
    assert.equal(gone.source.dataFile, 'src/partials/layout/footer.liquid.json');
    assert.equal(gone.source.dataLine, 4);
    const platform = all.find((f) => f.link.url === `${base}/platform-only`);
    assert.deepEqual([platform.verdict, platform.link.reason, platform.pages], ['needs-review', 'route-not-served-locally', ['/', '/about']]);
    assert.equal(platform.source.dataLine, 8);
  } finally { server.close(); server.closeAllConnections?.(); rmSync(root, { recursive: true, force: true }); await closeBrowser(); }
});
