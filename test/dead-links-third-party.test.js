import './helpers/hermetic-env.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scanDeadLinks, createLinkChecker, classifyFetchError, loadProjectRoutes } from '../src/scanner/links.js';
import { evaluateGate } from '../src/utils/thresholds.js';
import { computeExitCode } from '../src/index.js';
import { validateConfig } from '../src/utils/config.js';
import { buildScanReportV2 } from '../src/reporter/report-v2.js';
import { scanPageWithAxe } from '../src/scanner/axe.js';
import { closeBrowser } from '../src/scanner/browser.js';
import { requireBrowser } from './helpers/require-browser.js';

after(() => closeBrowser());

// ---- links: a 127.0.0.1 mock server answers each status ----
const STATUS = { '/blocked': 403, '/auth': 401, '/rate': 429, '/li': 999, '/gone': 404, '/removed': 410, '/boom': 500, '/teapot': 418 };
async function mock() {
  const seen = [];
  const hits = {};
  const server = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url} ${req.headers['user-agent']?.slice(0, 7)}`);
    if (req.url === '/challenge') return res.writeHead(503, { 'cf-mitigated': 'challenge' }).end();
    if (req.url === '/hang') return; // never answers
    // a bot defence that answers 502 in a burst, then 200 (HEAD, the GET and the first retry fail; the second retry gets through)
    if (req.url === '/burst') { hits.burst = (hits.burst || 0) + 1; return res.writeHead(hits.burst <= 3 ? 502 : 200).end('ok'); }
    if (req.url === '/burst-redirect') { hits.br = (hits.br || 0) + 1; return hits.br <= 2 ? res.writeHead(502).end() : res.writeHead(301, { location: '/final' }).end(); }
    if (req.url === '/final') return res.writeHead(200).end('ok');
    if (req.url === '/head-lies') return res.writeHead(req.method === 'HEAD' ? 404 : 200).end('ok');
    if (req.url === '/blocked-head-only') return res.writeHead(req.method === 'HEAD' ? 403 : 200).end('ok');
    res.writeHead(STATUS[req.url] || 200).end('ok');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, seen, close: () => { server.close(); server.closeAllConnections?.(); } };
}
const fake = (urls) => ({ $$eval: async (sel) => (sel.startsWith('a[href], link') ? urls.map((u, i) => ({ tag: 'a', url: u, text: `l${i}`, html: `<a href="${u}">l${i}</a>`, selector: `a:nth-of-type(${i + 1})`, linkRel: '' })) : []) });
const summarize = (vs) => vs.map((v) => [new URL(v.element.outerHTML.match(/href="([^"]+)"/)[1]).pathname, v.ruleId, v.verdict ?? 'confirmed']);

test('external links: blocked statuses and a bot challenge are needs-review, 404/410/5xx stay confirmed', async () => {
  const site = await mock();
  try {
    const paths = ['/blocked', '/auth', '/rate', '/li', '/challenge', '/teapot', '/gone', '/removed', '/boom', '/ok'];
    const out = summarize(await scanDeadLinks(fake(paths.map((p) => site.url + p)), `${site.url}/`));
    assert.deepEqual(out.sort(), [
      ['/auth', 'dead-link-unreachable', 'needs-review'],
      ['/blocked', 'dead-link-unreachable', 'needs-review'],
      ['/boom', 'dead-link-server-error', 'confirmed'],
      ['/challenge', 'dead-link-unreachable', 'needs-review'],
      ['/gone', 'dead-link-404', 'confirmed'],
      ['/li', 'dead-link-unreachable', 'needs-review'],
      ['/rate', 'dead-link-unreachable', 'needs-review'],
      ['/removed', 'dead-link-404', 'confirmed'],
      ['/teapot', 'dead-link-unreachable', 'needs-review'],
    ]);
    const [blocked] = await scanDeadLinks(fake([`${site.url}/blocked`]), `${site.url}/`);
    assert.match(blocked.fix.hint, /HTTP 403 \(blocked-unverifiable/);
  } finally { site.close(); }
});

test('same-origin links: a 5xx that recovers on a backed-off browser retry is no finding; a 404 that persists stays confirmed (paired)', async () => {
  const site = await mock();
  try {
    const checker = createLinkChecker({ retryBackoffMs: [0, 0] });
    assert.deepEqual(await scanDeadLinks(fake([`${site.url}/burst`, `${site.url}/burst-redirect`]), `${site.url}/`, { checker }), [], 'the final status after the retries is 200');
    assert.ok(site.seen.filter((x) => x.startsWith('GET /burst ')).length >= 2, 'the browser GET was repeated');
    const gone = await scanDeadLinks(fake([`${site.url}/gone`, `${site.url}/boom`]), `${site.url}/`, { checker });
    assert.deepEqual(summarize(gone).sort(), [['/boom', 'dead-link-server-error', 'confirmed'], ['/gone', 'dead-link-404', 'confirmed']]);
    assert.equal(site.seen.filter((x) => x.startsWith('GET /gone ')).length, 3, 'one GET plus two retries, all with the browser UA');
    assert.ok(site.seen.filter((x) => x.startsWith('GET /gone ')).every((x) => x.endsWith('Mozilla')));
  } finally { site.close(); }
});

test('external links: a HEAD-only 404 or 403 is retried as a browser-like GET and passes when the GET succeeds', async () => {
  const site = await mock();
  try {
    assert.deepEqual(await scanDeadLinks(fake([`${site.url}/head-lies`, `${site.url}/blocked-head-only`]), `${site.url}/`), []);
    assert.ok(site.seen.some((s) => s.startsWith('GET /head-lies Mozilla')), 'GET retry uses a browser-like user agent');
  } finally { site.close(); }
});

test('external links: timeout and refused connection carry their class and real text, needs-review', async () => {
  const site = await mock();
  const closed = http.createServer();
  await new Promise((r) => closed.listen(0, '127.0.0.1', r));
  const deadUrl = `http://127.0.0.1:${closed.address().port}/x`;
  await new Promise((r) => closed.close(r));
  try {
    const checker = createLinkChecker({ timeoutMs: 150 });
    const [slow, refused] = [
      ...(await scanDeadLinks(fake([`${site.url}/hang`]), `${site.url}/`, { checker })),
      ...(await scanDeadLinks(fake([deadUrl]), `${site.url}/`, { checker })),
    ];
    assert.deepEqual([slow, refused].map((v) => [v.ruleId, v.verdict, v.kind]), Array(2).fill(['dead-link-unreachable', 'needs-review', 'heuristic']));
    assert.match(slow.fix.hint, /could not be reached \(timeout: .*abort/i);
    assert.match(refused.fix.hint, /\(connection: fetch failed: ECONNREFUSED\)/);
    assert.equal(site.seen.filter((s) => s.startsWith('HEAD /hang')).length + site.seen.filter((s) => s.startsWith('GET /hang')).length, 2, 'HEAD then one GET retry');
  } finally { site.close(); }
});

test('classifyFetchError: timeout, dns, tls and connection', () => {
  const e = (name, code) => Object.assign(new Error('fetch failed'), { name, cause: code ? { code } : undefined });
  assert.equal(classifyFetchError(e('AbortError')), 'timeout');
  assert.equal(classifyFetchError(e('TypeError', 'UND_ERR_CONNECT_TIMEOUT')), 'timeout');
  assert.equal(classifyFetchError(e('TypeError', 'ENOTFOUND')), 'dns');
  assert.equal(classifyFetchError(e('TypeError', 'CERT_HAS_EXPIRED')), 'tls');
  assert.equal(classifyFetchError(e('TypeError', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE')), 'tls');
  assert.equal(classifyFetchError(e('TypeError', 'ECONNRESET')), 'connection');
});

// ---- links: local routes ----
test('local scan: unknown-route 404 is route-not-served-locally; platformRoutes silences it; no project means confirmed', async () => {
  const server = http.createServer((req, res) => res.writeHead(404).end());
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const links = ['/jobs', '/job-details/abc', '/about'].map((p) => base + p);
    const known = new Set(['/', '/about']);
    const [jobs, detail, ...rest] = await scanDeadLinks(fake(links), `${base}/`, { knownRoutes: known });
    assert.deepEqual(rest.map((v) => v.element.outerHTML.includes('/about') && [v.ruleId, v.verdict]), [['dead-link-404', undefined]], 'a project page that 404s is a real defect');
    for (const v of [jobs, detail]) {
      assert.deepEqual([v.verdict, v.kind, v.reason], ['needs-review', 'heuristic', 'route-not-served-locally']);
      assert.match(v.fix.hint, /platform route is not served locally/);
    }
    const silenced = await scanDeadLinks(fake(links), `${base}/`, { knownRoutes: known, platformRoutes: ['/jobs', '/job-details/*'] });
    assert.deepEqual(summarize(silenced), [['/about', 'dead-link-404', 'confirmed']]);
    const noProject = await scanDeadLinks(fake([base + '/jobs']), `${base}/`, { knownRoutes: null });
    assert.deepEqual(summarize(noProject), [['/jobs', 'dead-link-404', 'confirmed']]);
  } finally { server.close(); server.closeAllConnections?.(); }
});

test('local scan: a 404 on a static asset or a redirect loop stays confirmed; an extensionless platform route stays needs-review', async () => {
  const server = http.createServer((req, res) => (req.url === '/loop' ? res.writeHead(302, { location: '/loop' }).end() : res.writeHead(404).end()));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const paths = ['/files/missing.pdf', '/assets/app.css', '/jobs', '/loop'];
    const vs = await scanDeadLinks(fake(paths.map((p) => base + p)), `${base}/`, { knownRoutes: new Set(['/', '/about']) });
    assert.deepEqual(summarize(vs).sort(), [
      ['/assets/app.css', 'dead-link-404', 'confirmed'],
      ['/files/missing.pdf', 'dead-link-404', 'confirmed'],
      ['/jobs', 'dead-link-404', 'needs-review'],
      ['/loop', 'dead-link-unreachable', 'confirmed'],
    ]);
    assert.match(vs.find((v) => v.element.outerHTML.includes('/loop')).fix.hint, /redirect/);
  } finally { server.close(); server.closeAllConnections?.(); }
});

test('remote scan: a same-origin 404 stays confirmed even when no project page defines the path', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(null, { status: 404 }); // a public page cannot probe loopback, so the answer is stubbed
  try {
    const vs = await scanDeadLinks(fake(['https://93.184.216.34/jobs']), 'https://93.184.216.34/', { knownRoutes: new Set(['/']) });
    assert.deepEqual(summarize(vs), [['/jobs', 'dead-link-404', 'confirmed']]);
  } finally { globalThis.fetch = realFetch; }
});

test('external links: dns and tls failures are classified end to end and needs-review', async () => {
  const plain = http.createServer((q, s) => s.end());
  await new Promise((r) => plain.listen(0, '127.0.0.1', r));
  try {
    const checker = createLinkChecker({ timeoutMs: 3000 });
    const vs = await scanDeadLinks(fake(['http://no-such-host.invalid/', `https://127.0.0.1:${plain.address().port}/`]), 'http://127.0.0.1:1/', { checker });
    assert.equal(vs.length, 2);
    assert.match(vs[0].fix.hint, /\((dns): /);
    assert.match(vs[1].fix.hint, /\((tls): /); // TLS handshake against a plain-HTTP port
    assert.deepEqual(vs.map((v) => [v.verdict, v.reason]), [['needs-review', 'dns'], ['needs-review', 'tls']]);
  } finally { plain.close(); plain.closeAllConnections?.(); }
});

test('loadProjectRoutes reads src/pages and the Paradox export page elements; null without a project', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ada-routes-'));
  try {
    assert.equal(loadProjectRoutes(root), null);
    mkdirSync(path.join(root, 'src/pages/team'), { recursive: true });
    mkdirSync(path.join(root, 'dist'));
    for (const f of ['index.liquid', 'about.liquid', 'team/lead.liquid', 'about.liquid.json']) writeFileSync(path.join(root, 'src/pages', f), '');
    writeFileSync(path.join(root, 'dist/paradox-export.json'), JSON.stringify({ elements_data: [{ type: 'page', path: 'pages/careers.html' }, { type: 'snippet', path: 'snippets/x.html' }] }));
    assert.deepEqual([...loadProjectRoutes(root)].sort(), ['/', '/about', '/careers', '/team/lead']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('config: links.platformRoutes and gate.countThirdParty are validated', () => {
  assert.deepEqual(validateConfig({ links: { platformRoutes: ['/jobs'] }, gate: { countThirdParty: true } }), []);
  assert.equal(validateConfig({ links: { platformRoutes: '/jobs' } }).length, 1);
  assert.equal(validateConfig({ gate: { countThirdParty: 'yes' } }).length, 1);
});

// ---- third-party gate ----
const finding = (over) => ({ category: 'accessibility', impact: 'critical', verdict: 'confirmed', count: 1, ownership: 'source', ...over });
const gateOf = (findings, opts) => evaluateGate([{ name: 'p', url: 'http://x/', findings }], undefined, opts);
const critical = (g) => g.pages[0].metrics.find((m) => m.id === 'a11y.critical');

test('gate: third-party and platform findings are excluded by default, counted with countThirdParty / countPlatform, source findings always count', () => {
  const tp = [finding({ ownership: 'third-party', count: 3 })];
  assert.deepEqual([critical(gateOf(tp)).actual, gateOf(tp).failed], [0, false]);
  assert.deepEqual([critical(gateOf(tp, { countThirdParty: true })).actual, gateOf(tp, { countThirdParty: true }).failed], [3, true]);
  const mixed = [...tp, finding({ ownership: 'source' }), finding({ ownership: 'platform', count: 2 })];
  assert.equal(critical(gateOf(mixed)).actual, 1, 'only the source finding counts: platform is out by default');
  assert.equal(critical(gateOf(mixed, { countPlatform: true })).actual, 3, 'platform counts with gate.countPlatform');
  assert.equal(gateOf(mixed).failed, true);
});

test('exit code: --fail-on-violations ignores confirmed third-party occurrences unless countThirdParty', () => {
  const summary = { occurrenceCount: 4, verdictCounts: { confirmed: 4, likely: 0, needsReview: 0 }, thirdPartyConfirmed: 4 };
  assert.equal(computeExitCode(summary, { failOnViolations: true }), 0);
  assert.equal(computeExitCode(summary, { failOnViolations: true, countThirdParty: true }), 1);
  assert.equal(computeExitCode({ ...summary, thirdPartyConfirmed: 3 }, { failOnViolations: true }), 1, 'a source finding remains');
});

test('report: third-party finding has no file and traceReason third-party; summary records no confirmed third-party', () => {
  const ctx = { generatedAt: '2026-10-27T00:00:00.000Z', producer: { name: 'ada-scan', version: '1.0.1' }, target: { mode: 'url-only', url: 'https://example.test/' } };
  const runs = [{ layer: 'axe', engine: { name: 'axe-core', version: '4.12.1' }, status: 'complete' }];
  const v = { ruleId: 'button-name', nativeRuleId: 'button-name', layer: 'axe', impact: 'critical', count: 2, verdict: 'confirmed', ownership: 'third-party', evidence: { proof: { type: 'attribute-value', fact: 'button has no accessible name' } }, // third-party needs a measured proof to stay confirmed
    element: { selector: 'button', outerHTML: '<button></button>' }, source: { file: null, line: null, confidence: 'none', method: 'third-party', traceReason: 'third-party' } };
  const r = buildScanReportV2([{ page: 'home', url: 'https://example.test/', scannerRuns: runs, violations: [v] }], ctx);
  const [f] = r.pages[0].findings;
  assert.deepEqual([f.ownership, f.source.file, f.source.traceReason], ['third-party', null, 'third-party: iframe']);
  assert.equal(f.verdict, 'needs-review'); // third-party findings are capped below confirmed
  assert.ok(!r.summary.thirdPartyConfirmed); // omitted when no third-party finding is confirmed
});

test('axe: nodes inside a cross-origin iframe are third-party and never traced to a source file', async (t) => {
  if (!await requireBrowser(t)) return;
  const frame = http.createServer((req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><html lang="en"><title>p</title><body><button class="player-play"></button></body></html>'));
  await new Promise((r) => frame.listen(0, '127.0.0.1', r));
  const fport = frame.address().port;
  const main = http.createServer((req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(
    `<!doctype html><html lang="en"><title>Home</title><main><h1>Hi</h1><button class="own-btn"></button><iframe title="video" src="http://127.0.0.1:${fport}/"></iframe></main></html>`));
  await new Promise((r) => main.listen(0, '127.0.0.1', r));
  try {
    const cfg = { axe: { viewports: [{ name: 'desktop', width: 1280, height: 800 }] } };
    const res = await scanPageWithAxe(`http://127.0.0.1:${main.address().port}/`, cfg, { sourceMode: 'url' });
    const nodes = res.violations.filter((v) => v.id === 'button-name').flatMap((v) => v.nodes);
    const inner = nodes.find((n) => n.html.includes('player-play'));
    const own = nodes.find((n) => n.html.includes('own-btn'));
    assert.equal(inner.ownership, 'third-party');
    assert.deepEqual([inner.source.file, inner.source.traceReason], [null, 'third-party']);
    assert.equal(own.ownership, undefined, 'the page own button stays source-owned');
  } finally {
    frame.close(); main.close();
    frame.closeAllConnections?.(); main.closeAllConnections?.();
  }
});

// ---- links: external judgement = final status after the redirect chain, two agreeing attempts to confirm ----
async function chainMock() {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    const u = req.url;
    if (u === '/to-403') return res.writeHead(301, { location: '/final-403' }).end();
    if (u === '/final-403') return res.writeHead(403).end();
    if (u === '/to-404') return res.writeHead(301, { location: '/final-404' }).end();
    if (u === '/final-404') return res.writeHead(404).end();
    if (u === '/plain-404') return res.writeHead(404).end();
    if (u === '/head-404') return res.writeHead(req.method === 'HEAD' ? 404 : 200).end('ok');
    if (u === '/split-final') return res.writeHead(301, { location: req.method === 'HEAD' ? '/final-404' : '/ok' }).end();
    if (u === '/ua-404') return res.writeHead(/Mozilla/.test(req.headers['user-agent']) ? 403 : 404).end();
    if (u === '/loop') return res.writeHead(302, { location: '/loop' }).end();
    res.writeHead(200).end('ok');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, seen, close: () => { server.close(); server.closeAllConnections?.(); } };
}
const OTHER_PAGE = 'http://127.0.0.1:9/'; // a different origin from the mock: every link is external

test('external links: 301 -> 403 is blocked-unverifiable with the chain, never a confirmed 404', async () => {
  const site = await chainMock();
  try {
    const [v] = await scanDeadLinks(fake([`${site.url}/to-403`]), OTHER_PAGE);
    assert.deepEqual([v.verdict, v.reason, v.linkTarget.status], ['needs-review', 'blocked-unverifiable', 403]);
    assert.match(v.fix.hint, /Redirect chain: HEAD: .*\/to-403 \(301\) -> .*\/final-403 \(403\); GET: .*\/to-403 \(301\) -> .*\/final-403 \(403\)/);
    assert.match(v.evidence.proof.fact, /final-403 \(403\)/);
  } finally { site.close(); }
});

test('external links: 301 -> 404 on both attempts is confirmed; a plain consistent 404 stays confirmed', async () => {
  const site = await chainMock();
  try {
    const out = await scanDeadLinks(fake([`${site.url}/to-404`, `${site.url}/plain-404`]), OTHER_PAGE);
    assert.deepEqual(out.map((v) => [v.ruleId, v.verdict ?? 'confirmed']), [['dead-link-404', 'confirmed'], ['dead-link-404', 'confirmed']]);
    assert.match(out[0].fix.hint, /to-404 \(301\) -> .*final-404 \(404\)/);
  } finally { site.close(); }
});

test('external links: HEAD 404 but GET 200, different final URLs, and a UA-dependent answer are needs-review, not confirmed', async () => {
  const site = await chainMock();
  try {
    const out = await scanDeadLinks(fake(['/head-404', '/split-final', '/ua-404'].map((p) => site.url + p)), OTHER_PAGE);
    const byPath = Object.fromEntries(out.map((v) => [new URL(v.linkTarget.url).pathname, [v.verdict, v.reason]]));
    assert.deepEqual(byPath, {
      '/head-404': ['needs-review', 'inconsistent-status'],
      '/split-final': ['needs-review', 'inconsistent-status'],
      '/ua-404': ['needs-review', 'blocked-unverifiable'],
    });
  } finally { site.close(); }
});

test('external links: an http link whose https variant is unreachable keeps the http answer; a redirect loop stays deterministic', async () => {
  const site = await chainMock();
  try {
    const [dead, loop] = await scanDeadLinks(fake([`${site.url}/plain-404`, `${site.url}/loop`]), OTHER_PAGE);
    assert.equal(dead.verdict ?? 'confirmed', 'confirmed'); // https variant refused the connection: no disagreement
    assert.equal(loop.verdict ?? 'confirmed', 'confirmed');
    assert.match(loop.fix.hint, /more than 5 redirects/);
  } finally { site.close(); }
});

// ---- l3: a script appends the local page path to another host (round 5, careers-home) ----
test('local scan: another origin\'s 404 whose path repeats the local page path is needs-review; a different dead path stays confirmed', async () => {
  const site = await mock();
  try {
    const page = 'http://127.0.0.1:1/careers-home';
    // /gone is the 404 route of the mock; the page path is /gone, so the echo is the same path on the other origin
    const echo = await scanDeadLinks(fake([`${site.url}/gone`]), 'http://127.0.0.1:1/gone');
    assert.deepEqual(echo.map((v) => [v.ruleId, v.verdict, v.reason]), [['dead-link-404', 'needs-review', 'route-echoes-local-page']]);
    assert.match(echo[0].fix.hint, /repeats the path of the local page/);
    // TRUE defect: the dead path is not the page path
    const real = await scanDeadLinks(fake([`${site.url}/gone`]), page);
    assert.deepEqual(real.map((v) => [v.ruleId, v.verdict ?? 'confirmed']), [['dead-link-404', 'confirmed']]);
    // the echo rule is for local pages only: on a public page the path is the real one
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(null, { status: 404 });
    try {
      const pub = await scanDeadLinks(fake(['https://93.184.216.34/gone']), 'https://example.org/gone', { checker: createLinkChecker() });
      assert.deepEqual(pub.map((v) => [v.ruleId, v.verdict ?? 'confirmed']), [['dead-link-404', 'confirmed']]);
    } finally { globalThis.fetch = realFetch; }
  } finally { site.close(); }
});
