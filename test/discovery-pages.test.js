import './helpers/hermetic-env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { gzipSync } from 'node:zlib';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolvePages, discoverScanPages } from '../src/discovery/pages.js';
import { buildScanReportV2 } from '../src/reporter/report-v2.js';
import { isUrlWithinDeploymentScope } from '../src/tracer/deployment-url.js';
import { startParadoxSite } from './helpers/paradox-site-server.js';

const urlset = (...locs) => `<?xml version="1.0"?><urlset>${locs.map((l) => `<url><loc>${l}</loc></url>`).join('')}</urlset>`;

// A local dev server stand-in on a free port: answers 200 everywhere (the probe keeps routes the server serves).
async function serveOk() {
  const server = http.createServer((req, res) => res.writeHead(200).end('ok'));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

async function serve(routes) {
  const server = http.createServer((req, res) => {
    const r = routes[new URL(req.url, 'http://x').pathname];
    if (!r) return res.writeHead(404).end('nf');
    res.writeHead(r.status ?? 200, { 'content-type': r.type ?? 'application/xml' }).end(r.body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, close: () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections?.(); }) };
}

test('sitemap urlset becomes pages with source and ignores cross-origin urls', async () => {
  const routes = {};
  const real = await serve(routes);
  routes['/sitemap.xml'] = { body: urlset(`${real.url}/`, `${real.url}/about?x=1&amp;y=2`, 'http://example.com/evil') };
  try {
    const { pages, warnings } = await resolvePages({ args: { url: real.url }, baseUrl: real.url });
    assert.deepEqual(pages.map((p) => p.route), ['/', '/about?x=1&y=2']);
    assert.ok(pages.every((p) => p.source === 'sitemap'));
    assert.equal(pages[0].name, 'homepage');
    assert.ok(warnings.some((w) => w.includes('example.com')));
  } finally { await real.close(); }
});

test('sitemap index and gzip are followed', async () => {
  const routes = {};
  const site = await serve(routes);
  routes['/sitemap.xml'] = { body: `<sitemapindex><sitemap><loc>${site.url}/a.xml</loc></sitemap><sitemap><loc>${site.url}/b.xml.gz</loc></sitemap></sitemapindex>` };
  routes['/a.xml'] = { body: urlset(`${site.url}/one`) };
  routes['/b.xml.gz'] = { type: 'application/gzip', body: gzipSync(urlset(`${site.url}/two`)) };
  try {
    const { pages } = await resolvePages({ args: { url: site.url }, baseUrl: site.url });
    assert.deepEqual(pages.map((p) => p.route), ['/one', '/two']);
  } finally { await site.close(); }
});

test('sitemap 403 warns and falls back to a crawl of the fixture site', async () => {
  const fixture = await startParadoxSite();
  const routes = { '/sitemap.xml': { status: 403, body: 'no' } };
  const proxy = http.createServer(async (req, res) => {
    const r = routes[req.url];
    if (r) return res.writeHead(r.status).end(r.body);
    const up = await fetch(fixture.url + req.url);
    res.writeHead(up.status, { 'content-type': up.headers.get('content-type') }).end(Buffer.from(await up.arrayBuffer()));
  });
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${proxy.address().port}`;
  try {
    const { pages, warnings } = await resolvePages({ args: { url }, baseUrl: url });
    assert.ok(warnings.some((w) => w.includes('HTTP 403')));
    assert.ok(pages.length >= 3 && pages.every((p) => p.source === 'crawl'));
    assert.ok(pages.some((p) => p.route === '/benefits'));
    const capped = await resolvePages({ args: { url, maxPages: 2 }, baseUrl: url });
    assert.equal(capped.pages.length, 2);
  } finally {
    await new Promise((resolve) => { proxy.close(resolve); proxy.closeAllConnections?.(); });
    await fixture.close();
  }
});

test('max-pages caps a sitemap and warns', async () => {
  const routes = {};
  const site = await serve(routes);
  routes['/sitemap.xml'] = { body: urlset(...['a', 'b', 'c'].map((n) => `${site.url}/${n}`)) };
  try {
    const { pages, warnings } = await resolvePages({ args: { url: site.url, maxPages: 2 }, baseUrl: site.url });
    assert.equal(pages.length, 2);
    assert.ok(warnings.some((w) => w.includes('capped')));
  } finally { await site.close(); }
});

test('explicit --page wins and local dist / liquid are mapped', async () => {
  const site = await serveOk();
  const root = mkdtempSync(path.join(tmpdir(), 'ada-pages-'));
  try {
    mkdirSync(path.join(root, 'dist/jobs'), { recursive: true });
    mkdirSync(path.join(root, 'dist/partials'), { recursive: true });
    for (const f of ['index.html', '404.html', 'about.html', 'jobs/index.html', 'partials/x.html']) writeFileSync(path.join(root, 'dist', f), '');
    const base = site.url;
    const dist = await resolvePages({ config: { baseUrl: base }, projectRoot: root });
    assert.deepEqual(dist.pages.map((p) => p.route), ['/', '/404', '/about', '/jobs']);
    assert.equal(dist.pages[2].url, `${base}/about`);
    assert.equal(dist.pages[0].source, 'dist');

    rmSync(path.join(root, 'dist'), { recursive: true });
    mkdirSync(path.join(root, 'src/pages'), { recursive: true });
    for (const f of ['index.liquid', 'about.liquid', 'secret.liquid']) writeFileSync(path.join(root, 'src/pages', f), '');
    const liquid = await resolvePages({ config: { baseUrl: base, excludedPages: ['secret'] }, projectRoot: root });
    assert.deepEqual(liquid.pages.map((p) => [p.route, p.source]), [['/', 'liquid'], ['/about', 'liquid']]);

    const explicit = await resolvePages({ config: { baseUrl: base }, args: { page: 'about, /jobs' }, projectRoot: root });
    assert.deepEqual(explicit.pages.map((p) => [p.route, p.source]), [['/about', 'page-flag'], ['/jobs', 'page-flag']]);
  } finally { await site.close(); rmSync(root, { recursive: true, force: true }); }
});

test('discoverScanPages: bare-origin --url stays single-page unless --sitemap/--crawl', async () => {
  const routes = {};
  const site = await serve(routes);
  routes['/sitemap.xml'] = { body: urlset(`${site.url}/a`) };
  const root = mkdtempSync(path.join(tmpdir(), 'ada-pages-'));
  const quiet = (fn) => { const l = console.log, w = console.warn; console.log = console.warn = () => {}; return fn().finally(() => { console.log = l; console.warn = w; }); };
  try {
    const single = await discoverScanPages({ rawArgs: ['--url', `${site.url}/`], config: {}, baseUrl: `${site.url}/`, projectRoot: root, urlMode: true });
    assert.deepEqual(single.map((p) => [p.url, p.source, p.partial]), [[`${site.url}/`, 'page-flag', undefined]]);

    const found = await quiet(() => discoverScanPages({ rawArgs: ['--url', site.url, '--sitemap', `${site.url}/sitemap.xml`], config: {}, baseUrl: site.url, projectRoot: root, urlMode: true }));
    assert.ok(found.every((p) => p.source === 'sitemap' && p.partial === true));
  } finally { await site.close(); rmSync(root, { recursive: true, force: true }); }
});

test('discoverScanPages: a capped local discovery is marked partial, an uncapped dist one is not', async () => {
  const site = await serveOk();
  const root = mkdtempSync(path.join(tmpdir(), 'ada-pages-'));
  try {
    mkdirSync(path.join(root, 'dist'), { recursive: true });
    for (const f of ['index.html', 'a.html', 'b.html']) writeFileSync(path.join(root, 'dist', f), '');
    const run = (extra) => { const l = console.log, w = console.warn; console.log = console.warn = () => {};
      return discoverScanPages({ rawArgs: extra, config: {}, baseUrl: site.url, projectRoot: root, urlMode: false }).finally(() => { console.log = l; console.warn = w; }); };
    assert.ok((await run([])).every((p) => p.source === 'dist' && !p.partial));
    const capped = await run(['--max-pages', '2']);
    assert.equal(capped.length, 2);
    assert.ok(capped.every((p) => p.partial));
  } finally { await site.close(); rmSync(root, { recursive: true, force: true }); }
});

test('report records the discovery source per page', () => {
  const report = buildScanReportV2([{ page: 'a', url: 'http://localhost/a', violations: [], scannerRuns: [{ layer: 'axe', engine: { name: 'axe', version: '1' },
    viewport: { name: 'desktop', width: 1280, height: 900 }, pageState: 'initial', status: 'complete',
    evidence: { ruleGroups: 0, findingOccurrences: 0, fixUnits: 0, errorCode: null } }] }], { producer: { version: '0.0.0' }, discovery: { partial: true, pages: [{ route: '/a', source: 'crawl' }] } });
  assert.deepEqual(report.runMetadata.discovery, { partial: true, pages: [{ route: '/a', source: 'crawl' }] });
});

test('a public base fetches its sitemap through the injected fetch', async () => {
  const seen = [];
  const fetchImpl = async (u) => { seen.push(u); return new Response(urlset('http://example.com/p'), { status: 200 }); };
  const { pages } = await resolvePages({ args: { url: 'http://example.com' }, baseUrl: 'http://example.com', fetchImpl });
  assert.deepEqual(seen, ['http://example.com/sitemap.xml']);
  assert.deepEqual(pages.map((p) => p.route), ['/p']);
});

test('routes normalize hash, trailing slash and index.html but keep query and locale', async () => {
  const routes = {};
  const site = await serve(routes);
  routes['/sitemap.xml'] = { body: urlset(`${site.url}/a/`, `${site.url}/a#top`, `${site.url}/a/index.html`, `${site.url}/a?x=1`, `${site.url}/a?x=2`, `${site.url}/es/a`) };
  try {
    const { pages } = await resolvePages({ args: { url: site.url }, baseUrl: site.url });
    assert.deepEqual(pages.map((p) => p.route), ['/a', '/a?x=1', '/a?x=2', '/es/a']);
    assert.equal(new Set(pages.map((p) => p.name)).size, 4);
  } finally { await site.close(); }
});

test('same path with different queries builds a report without a run id collision', () => {
  const run = { layer: 'axe', engine: { name: 'axe', version: '1' }, viewport: { name: 'desktop', width: 1280, height: 900 }, pageState: 'initial',
    status: 'complete', evidence: { ruleGroups: 0, findingOccurrences: 0, fixUnits: 0, errorCode: null } };
  const page = (q) => ({ page: `a-${q}`, url: `http://localhost/a?x=${q}#h`, violations: [], scannerRuns: [{ ...run }] });
  const report = buildScanReportV2([page(1), page(2)], { producer: { version: '0.0.0' } });
  assert.deepEqual(report.pages.map((p) => p.route), ['/a?x=r-6b86b273', '/a?x=r-d4735e3a']); // query values are masked by default (E8.4): first 8 hex of sha256('1') and sha256('2')
});

test('deployment scope accepts query/hash but still rejects credentials and other origins', () => {
  assert.equal(isUrlWithinDeploymentScope('https://example.test/careers/jobs?x=1#top', 'https://example.test/careers'), true);
  assert.equal(isUrlWithinDeploymentScope('https://u:p@example.test/careers/jobs?x=1', 'https://example.test/careers'), false);
  assert.equal(isUrlWithinDeploymentScope('https://other.test/careers/jobs?x=1', 'https://example.test/careers'), false);
});

test('pages found by one source but not another are warned about, never dropped', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ada-pages-'));
  try {
    mkdirSync(path.join(root, 'dist'), { recursive: true });
    mkdirSync(path.join(root, 'src/pages'), { recursive: true });
    for (const f of ['index.html', 'built-only.html', 'secret.html']) writeFileSync(path.join(root, 'dist', f), '');
    for (const f of ['index.liquid', 'liquid-only.liquid', 'secret.liquid']) writeFileSync(path.join(root, 'src/pages', f), '');
    const { pages, warnings } = await resolvePages({ config: { excludedPages: ['secret'] }, projectRoot: root });
    assert.deepEqual(pages.map((p) => p.route), ['/', '/built-only', '/secret']);
    assert.ok(warnings.some((w) => w.includes('in dist but not in liquid') && w.includes('/built-only') && !w.includes('/secret')));
    assert.ok(warnings.some((w) => w.includes('in liquid but not in dist') && w.includes('/liquid-only')));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('parseDiscoveryArgs: strict parser accepts discovery flags and rejects a bad --max-pages', async () => {
  const { parseDiscoveryArgs } = await import('../src/discovery/pages.js');
  assert.deepEqual(parseDiscoveryArgs(['--crawl', '--max-pages', '5', '--sitemap=s.xml']), { sitemap: 's.xml', crawl: true, maxPages: 5 });
  assert.throws(() => parseDiscoveryArgs(['--max-pages', 'abc']), /positive integer/);
});

test('routeTemplate: IDs, slugs before /job/, pagination and query values collapse; plain pages stay', async () => {
  const { routeTemplate } = await import('../src/discovery/pages.js');
  assert.equal(routeTemplate('/crew/job/P3-ABC123'), '/:slug/job/:id');
  assert.equal(routeTemplate('/jobs/98765'), '/jobs/:id');
  assert.equal(routeTemplate('/page/3'), '/page/:id');
  assert.equal(routeTemplate('/job/123e4567-e89b-12d3-a456-426614174000'), '/job/:id');
  assert.equal(routeTemplate('/search?q=a&page=2'), '/search?page=*&q=*');
  assert.equal(routeTemplate('/demo-1'), '/demo-1');
  assert.equal(routeTemplate('/privacy'), '/privacy');
});

test('crawl: with a small --max-pages every unique page is visited and job/pagination routes are capped per template', async () => {
  const link = (h) => `<a href="${h}">x</a>`;
  const page = (body) => (req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(`<html><body>${body}</body></html>`);
  const jobs = Array.from({ length: 8 }, (_, i) => link(`/crew/job/P3-AB${1000 + i}`)).join('');
  const paging = [1, 2, 3, 4].map((n) => link(`/page/${n}`)).join('');
  const routes = {
    // Body links come first on purpose: navigation links must still win.
    '/': page(`<main>${jobs}${paging}${link('/unique-body')}</main><footer>${link('/privacy')}</footer><nav>${link('/about')}${link('/demo-1')}</nav>`),
    '/about': page(''), '/demo-1': page(''), '/privacy': page(''), '/unique-body': page(''),
  };
  for (let i = 0; i < 8; i++) routes[`/crew/job/P3-AB${1000 + i}`] = page('');
  for (let n = 1; n <= 4; n++) routes[`/page/${n}`] = page('');
  const site = await startParadoxSite({ routes });
  try {
    const small = await resolvePages({ args: { url: site.url, crawl: true, maxPages: 7 }, baseUrl: site.url });
    const r = small.pages.map((p) => p.route);
    for (const u of ['/', '/about', '/demo-1', '/privacy', '/unique-body']) assert.ok(r.includes(u), `${u} in ${r}`);
    assert.equal(r.filter((x) => x.startsWith('/crew/job/')).length, 1);
    assert.equal(r.filter((x) => x.startsWith('/page/')).length, 1);

    const wide = await resolvePages({ args: { url: site.url, crawl: true, maxPages: 50 }, baseUrl: site.url });
    const w = wide.pages.map((p) => p.route);
    assert.equal(w.filter((x) => x.startsWith('/crew/job/')).length, 2);
    assert.equal(w.filter((x) => x.startsWith('/page/')).length, 2);
    assert.equal(wide.skippedDuplicates, 6 + 2);
    assert.equal(wide.pages.find((p) => p.route === '/about').template, '/about');
    assert.deepEqual(wide.templates.find((t) => t.template === '/:slug/job/:id'), { template: '/:slug/job/:id', samples: 2 });

    const one = await resolvePages({ args: { url: site.url, crawl: true, crawlPerTemplate: 1 }, baseUrl: site.url });
    assert.equal(one.pages.filter((p) => p.route.startsWith('/crew/job/')).length, 1);
    assert.deepEqual(w, (await resolvePages({ args: { url: site.url, crawl: true, maxPages: 50 }, baseUrl: site.url })).pages.map((p) => p.route));
  } finally { await site.close(); }
});

test('parseDiscoveryArgs: --crawl-per-template is validated', async () => {
  const { parseDiscoveryArgs } = await import('../src/discovery/pages.js');
  assert.equal(parseDiscoveryArgs(['--crawl', '--crawl-per-template', '3']).crawlPerTemplate, 3);
  assert.throws(() => parseDiscoveryArgs(['--crawl-per-template', '0']), /positive integer/);
});

test('crawl: a linked 404 is dropped and recorded as a broken link; explicit and sitemap 404s stay pages', async () => {
  const page = (body) => (req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(`<html><body>${body}</body></html>`);
  const site = await startParadoxSite({ routes: {
    '/': page('<a href="/about">a</a><a href="/gone">g</a>'),
    '/about': page('<a href="/gone">g</a>'),
  } });
  try {
    const crawl = await resolvePages({ args: { url: site.url, crawl: true }, baseUrl: site.url });
    assert.ok(!crawl.pages.some((p) => p.route === '/gone'));
    assert.deepEqual(crawl.brokenLinks, [{ route: '/gone', status: 404, href: '/gone', referrers: ['/', '/about'] }]);

    const scan = await discoverScanPages({ rawArgs: ['--crawl'], config: {}, baseUrl: site.url, urlMode: true });
    assert.deepEqual(scan.find((p) => p.path === '/about').brokenLinks, [{ route: '/gone', url: `${site.url}/gone`, status: 404, href: '/gone' }]);
    assert.ok(scan.every((p) => p.path !== '/gone'));

    const explicit = await resolvePages({ args: { url: site.url, page: '/gone' }, baseUrl: site.url });
    assert.deepEqual(explicit.pages.map((p) => p.route), ['/gone']);
    const listed = await resolvePages({ args: { url: site.url, sitemap: `${site.url}/sitemap.xml` }, baseUrl: site.url, fetchImpl: async (u, o) => (u.endsWith('/sitemap.xml')
      ? new Response(urlset(`${site.url}/gone`)) : fetch(u, o)) });
    assert.deepEqual(listed.pages.map((p) => p.route), ['/gone']);
  } finally { await site.close(); }
});

test('crawl: referrers of a linked 404 include pages crawled after it', async () => {
  const page = (body) => (req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(`<html><body>${body}</body></html>`);
  const site = await startParadoxSite({ routes: {
    '/': page('<a href="/gone">g</a><a href="/about">a</a>'),
    '/about': page('<a href="/gone">g</a>'),
  } });
  try {
    const crawl = await resolvePages({ args: { url: site.url, crawl: true }, baseUrl: site.url });
    assert.deepEqual(crawl.brokenLinks, [{ route: '/gone', status: 404, href: '/gone', referrers: ['/', '/about'] }]);
  } finally { await site.close(); }
});

const touch = (root, files) => files.forEach((f) => { mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); writeFileSync(path.join(root, f), ''); });
const live = (ok) => serve(Object.fromEntries(ok.map((r) => [r, { type: 'text/html', body: '<p>ok</p>' }])));

test('host-like tree: dist/pages shells are not routes; liquid wins on a dev server, exactly the 9 template routes', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ada-pages-'));
  const names = ['index', 'about', 'benefits', 'careers', 'demo-1', 'our-story', 'service-technicians', '404', '500'];
  const routes = names.map((n) => (n === 'index' ? '/' : `/${n}`));
  const site = await live(routes);
  try {
    touch(root, names.map((n) => `src/pages/${n}.liquid`));
    mkdirSync(path.join(root, 'src/pages/xx-empty'), { recursive: true });
    touch(root, ['dist/index.html', 'dist/404.html', ...names.filter((n) => n !== 'index').map((n) => `dist/pages/${n}.html`), 'dist/partials/p.html']);
    const r = await resolvePages({ config: { baseUrl: site.url }, projectRoot: root });
    assert.deepEqual(r.pages.map((p) => p.route).sort(), [...routes].sort());
    assert.equal(r.pages.length, 9);
    assert.ok(r.pages.every((p) => !p.route.startsWith('/pages/')));
    assert.deepEqual(r.pages.filter((p) => p.errorPage).map((p) => [p.route, p.allowStatus]).sort(), [['/404', [404]], ['/500', [500]]]);
    assert.equal(r.pages.find((p) => p.route === '/about').source, 'liquid');
    assert.equal(r.droppedRoutes, undefined);
  } finally { await site.close(); rmSync(root, { recursive: true, force: true }); }
});

test('dist-only routes: a 404 at probe time is dropped and recorded, a 200 one stays (paired)', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ada-pages-'));
  const site = await live(['/', '/real', '/built-live']);
  try {
    touch(root, ['src/pages/index.liquid', 'src/pages/real.liquid', 'src/pages/liquid-404.liquid', 'dist/index.html', 'dist/built-live.html', 'dist/built-gone.html']);
    const r = await resolvePages({ config: { baseUrl: site.url }, projectRoot: root });
    assert.deepEqual(r.pages.map((p) => [p.route, p.source]), [['/', 'liquid'], ['/liquid-404', 'liquid'], ['/real', 'liquid'], ['/built-live', 'dist']]);
    assert.deepEqual(r.droppedRoutes, [{ route: '/built-gone', source: 'dist', status: 404 }]);
    // dist as the only source: probed too
    rmSync(path.join(root, 'src'), { recursive: true });
    const d = await resolvePages({ config: { baseUrl: site.url }, projectRoot: root });
    assert.deepEqual(d.pages.map((p) => p.route), ['/', '/built-live']);
    assert.deepEqual(d.droppedRoutes.map((x) => x.route), ['/built-gone']);
    // the CLI entry passes the metadata through
    let meta;
    const quiet = (fn) => { const l = console.log, w = console.warn; console.log = console.warn = () => {}; return fn().finally(() => { console.log = l; console.warn = w; }); };
    await quiet(() => discoverScanPages({ rawArgs: [], config: {}, baseUrl: site.url, projectRoot: root, urlMode: false, onWarnings: (_w, m) => { meta = m; } }));
    assert.deepEqual(meta.droppedRoutes.map((x) => x.route), ['/built-gone']);
  } finally { await site.close(); rmSync(root, { recursive: true, force: true }); }
});

test('a custom pages dir name is skipped in dist, and an error page that really answers 404 is kept with its status allowed', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ada-pages-'));
  const site = await serve({ '/': { type: 'text/html', body: 'x' } });
  try {
    touch(root, ['dist/index.html', 'dist/views/about.html', 'dist/404.html']);
    const r = await resolvePages({ config: { baseUrl: site.url, source: { pagesRoot: 'src/views' } }, projectRoot: root });
    assert.deepEqual(r.pages.map((p) => p.route), ['/', '/404']);
    assert.deepEqual(r.pages[1].allowStatus, [404]);
    const scan = await discoverScanPages({ rawArgs: [], config: { source: { pagesRoot: 'src/views' } }, baseUrl: site.url, projectRoot: root, urlMode: false });
    assert.deepEqual(scan.find((p) => p.path === '/404').allowStatus, [404]);
    assert.equal(scan.find((p) => p.path === '/').allowStatus, undefined);
  } finally { await site.close(); rmSync(root, { recursive: true, force: true }); }
});

test('empty directories under the pages dir produce no routes', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ada-pages-'));
  try {
    mkdirSync(path.join(root, 'src/pages/en/deep'), { recursive: true });
    touch(root, ['src/pages/index.liquid']);
    const r = await resolvePages({ config: {}, projectRoot: root });
    assert.deepEqual(r.pages.map((p) => p.route), ['/']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('dead dev server: a failed probe is not evidence of a missing page, so dist-only routes are kept and nothing is dropped', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ada-pages-'));
  const site = await live(['/']);
  const url = site.url;
  await site.close();
  try {
    touch(root, ['src/pages/index.liquid', 'dist/index.html', 'dist/built-only.html']);
    const r = await resolvePages({ config: { baseUrl: url }, projectRoot: root });
    assert.deepEqual(r.pages.map((p) => [p.route, p.source]), [['/', 'liquid'], ['/built-only', 'dist']]);
    assert.equal(r.droppedRoutes, undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
