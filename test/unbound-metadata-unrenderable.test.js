import './helpers/hermetic-env.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { classifyOrigin } from '../src/tracer/ownership.js';
import { downgradeErrorPage, isEmptyPageTemplate } from '../src/scanner/origin.js';
import { scanOnePage } from '../src/index.js';
import { closeBrowser } from '../src/scanner/browser.js';
import { requireBrowser } from './helpers/require-browser.js';

after(() => closeBrowser());

const kind = (el, opts) => classifyOrigin(el, opts).kind;
const head = (inner, htmlTag = '<html lang="en">') => `<!doctype html>${htmlTag}<head>${inner}</head><body></body></html>`;

test('head metadata whose served value is a backend tag is unbound; the same finding on a static empty value stays confirmed', () => {
  const title = { ruleId: 'PageTitleValid', outerHTML: '<title />', selector: 'html>head>title' };
  assert.equal(kind(title, { servedHtml: head('<title>{{attribute:og_title}}</title>') }), 'unbound-data');
  assert.equal(kind(title, { servedHtml: head('<title></title>') }), 'site-source', 'static empty title is a real defect');
  assert.equal(kind(title, { servedHtml: head('<title>Careers</title>') }), 'site-source');
  assert.equal(kind({ ruleId: 'document-title', outerHTML: '<html lang="en">', selector: 'html' }, { servedHtml: head('<title>{{data:page.title}}</title>') }), 'unbound-data');
  const desc = { ruleId: 'MetaDescription', outerHTML: '<meta name="description" content="">', selector: 'meta' };
  assert.equal(kind(desc, { servedHtml: head('<meta name="description" content="{{attribute:og_description}}">') }), 'unbound-data');
  assert.equal(kind(desc, { servedHtml: head('<meta name="description" content="">') }), 'site-source');
  assert.equal(kind(desc, { servedHtml: head('<meta name="keywords" content="{{attribute:k}}"><meta name="description" content="">') }), 'site-source', 'another meta is not the subject');
  const lang = { ruleId: 'html-has-lang', outerHTML: '<html>', selector: 'html' };
  assert.equal(kind(lang, { servedHtml: head('<title>t</title>', '<html lang="{{data:locale}}">') }), 'unbound-data');
  assert.equal(kind(lang, { servedHtml: head('<title>t</title>', '<html>') }), 'site-source');
  const canon = { ruleId: 'canonical', outerHTML: '<link rel="canonical" href="">', selector: 'link' };
  assert.equal(kind(canon, { servedHtml: head('<link rel="canonical" href="{{data:dynamic.current_page_url}}">') }), 'unbound-data');
  assert.equal(kind(canon, { servedHtml: head('<link rel="canonical" href="">') }), 'site-source');
});

test('a list whose items sit in a runtime {% if data:.. %} block, and text that is a raw {{component:..}} placeholder, are unbound; static ones are not', () => {
  const chain = [node('ul')];
  const live = (hints) => ({ chain, ...hints });
  const list = { ruleId: 'list', outerHTML: '<ul class="x">', selector: 'ul.x' };
  assert.equal(kind(list, { hints: live({ ownText: '\n {% if data:job.salary_min %} ', subtreeText: ' {% if data:job.salary_min %} {{data:job.a}}' }) }), 'unbound-data');
  assert.equal(kind(list, { hints: live({ ownText: ' stray text ', subtreeText: ' stray text Item' }) }), 'site-source', 'static list with bad children');
  const contrast = { ruleId: 'color-contrast', outerHTML: '<div class="c-hero-jobs">', selector: 'div.c-hero-jobs' };
  assert.equal(kind(contrast, { hints: live({ ownText: '{{component:7d443d56-57e1-4030-88de-465e1f8e466e}}', subtreeText: '' }) }), 'unbound-data');
  assert.equal(kind(contrast, { hints: live({ ownText: 'Find your job', subtreeText: 'Find your job' }) }), 'site-source', 'static low-contrast text');
});
const node = (tag, attrs = {}) => ({ tag, attrs });

test('bare layout shell and error pages: page structure and footer geometry need review; other defects and normal pages stay confirmed', () => {
  const mk = () => ['missing-main-landmark', 'FocusNotObscuredFooter', 'image-alt'].map((ruleId) => ({ ruleId, verdict: 'confirmed' }));
  const verdicts = (vs) => vs.map((v) => v.verdict);
  assert.deepEqual(verdicts(downgradeErrorPage(mk(), 'http://127.0.0.1:1/job-details', [], { bareShell: true })), ['needs-review', 'needs-review', 'confirmed']);
  assert.deepEqual(verdicts(downgradeErrorPage(mk(), 'http://127.0.0.1:1/careers', [], { bareShell: false })), ['confirmed', 'confirmed', 'confirmed']);
  assert.deepEqual(verdicts(downgradeErrorPage(mk(), 'http://127.0.0.1:1/500', ['/404', '/500'])), ['needs-review', 'needs-review', 'confirmed']);
});

test('isEmptyPageTemplate: only layout/block/comment tags is empty; real content or a missing file is not', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ada-tpl-'));
  try {
    mkdirSync(path.join(dir, 'sub'));
    writeFileSync(path.join(dir, 'stub.liquid'), '{% layout "layout" %}\n{% block content %}\n<!-- later -->\n{% endblock %}\n');
    writeFileSync(path.join(dir, 'full.liquid'), '{% layout "layout" %}{% block content %}<main><h1>Hi</h1></main>{% endblock %}');
    writeFileSync(path.join(dir, 'sub', 'index.liquid'), '');
    assert.equal(isEmptyPageTemplate(dir, 'http://127.0.0.1:1/stub'), true);
    assert.equal(isEmptyPageTemplate(dir, 'http://127.0.0.1:1/sub'), true);
    assert.equal(isEmptyPageTemplate(dir, 'http://127.0.0.1:1/full'), false);
    assert.equal(isEmptyPageTemplate(dir, 'http://127.0.0.1:1/nope'), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('local page that 500s is skipped (unrenderable-locally), not failed; a 200 page with the dev error overlay is failed (see render-artefacts.test.js); remote and scan.strict keep it a failure', async (t) => {
  if (!await requireBrowser(t)) return;
  const server = http.createServer((req, res) => {
    if (req.url === '/overlay') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end('<!doctype html><html lang="en"><title>x</title><body><script type="module">document.body.appendChild(document.createElement("vite-error-overlay"));</script></body></html>');
    }
    res.writeHead(500, { 'content-type': 'text/html' });
    res.end('<!doctype html><html><body><script type="module">import { ErrorOverlay } from "/@vite/client"; document.body.appendChild(new ErrorOverlay({message:"data missing"}))</script></body></html>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const scan = (route, config = { layers: {} }, options = {}) => scanOnePage({ name: 'p', url: `${base}${route}` }, config, options);
  try {
    const r = await scan('/job-details');
    assert.equal(r.status, 'skipped-empty');
    assert.equal(r.skipped.reason, 'unrenderable-locally');
    assert.match(r.skipped.note, /unrenderable locally/);
    assert.equal(r.scanFailed, false);
    assert.equal((await scan('/overlay')).status, 'failed');
    const strict = await scan('/job-details', { layers: {}, scan: { strict: true } });
    assert.equal(strict.status, 'failed');
    assert.equal(strict.failure.httpStatus, 500);
    const remote = await scan('/job-details', { layers: {} }, { isUrlMode: true });
    assert.equal(remote.status, 'failed');
  } finally {
    server.close();
    server.closeAllConnections?.();
  }
});

test('head metadata whose own SOURCE line holds a backend tag is unbound-data even when the served HTML was not seen; a literal line stays site-source', async () => {
  const { unboundFromSource } = await import('../src/tracer/ownership.js');
  const dir = mkdtempSync(path.join(tmpdir(), 'ada-src-'));
  try {
    mkdirSync(path.join(dir, 'src/partials/layout'), { recursive: true });
    writeFileSync(path.join(dir, 'src/partials/layout/head.liquid'), '<title>{{attribute:og_title}}</title>\n<title>Careers</title>\n<meta name="description"\n  content="{{data:job.summary}}">\n<link rel="canonical" href="/a">\n');
    const row = (tagHtml, line, rule = 'PageTitleValid') => ({ ruleId: rule, element: { outerHTML: tagHtml, selector: 'x' }, source: { file: 'src/partials/layout/head.liquid', line }, origin: { owner: 'site', kind: 'site-source', label: 'Site source', evidence: [] } });
    const rows = [row('<title />', 1), row('<title />', 2), row('<meta name="description" content="">', 3, 'MetaDescription'), row('<link rel="canonical" href="/a">', 5, 'canonical'), row('<div class="x">', 1, 'region')];
    assert.equal(unboundFromSource(rows, dir), 2);
    assert.deepEqual(rows.map((r) => r.origin.kind), ['unbound-data', 'site-source', 'unbound-data', 'site-source', 'site-source']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the native header-obscuration rule id (StickyHeaderObscuresFocus) is downgraded on shells and on default status routes; a normal page keeps it', () => {
  const mk = () => ['StickyHeaderObscuresFocus', 'FocusNotObscuredFooter', 'image-alt'].map((ruleId) => ({ ruleId, verdict: 'confirmed' }));
  const verdicts = (vs) => vs.map((v) => v.verdict);
  assert.deepEqual(verdicts(downgradeErrorPage(mk(), 'http://127.0.0.1:1/404', ['/404', '/500', '/job-details'])), ['needs-review', 'needs-review', 'confirmed']);
  assert.deepEqual(verdicts(downgradeErrorPage(mk(), 'http://127.0.0.1:1/job-details', ['/404', '/500', '/job-details'])), ['needs-review', 'needs-review', 'confirmed']);
  const shell = downgradeErrorPage(mk(), 'http://127.0.0.1:1/other', [], { bareShell: true });
  assert.deepEqual(verdicts(shell), ['needs-review', 'needs-review', 'confirmed']);
  assert.match(shell[0].fix.hint, /empty template shell/);
  assert.deepEqual(verdicts(downgradeErrorPage(mk(), 'http://127.0.0.1:1/careers', ['/404'])), ['confirmed', 'confirmed', 'confirmed']);
});

test('live shell probe: chrome only is a shell; a main, a heading or body text is not', async (t) => {
  if (!await requireBrowser(t)) return;
  const { liveShellProbe } = await import('../src/scanner/origin.js');
  const { getBrowser } = await import('../src/scanner/browser.js');
  const page = await (await (await getBrowser()).newContext()).newPage();
  try {
    const probe = async (body) => { await page.setContent(`<!doctype html><html lang="en"><body>${body}</body></html>`); return page.evaluate(liveShellProbe); };
    const chrome = '<header><a href="/">Home</a><nav>A long navigation with many words in it so the chrome alone is far above the threshold</nav></header><footer>Footer text of the site, long enough to exceed eighty characters on its own for sure</footer>';
    assert.equal(await probe(chrome), true);
    assert.equal(await probe(`${chrome}<main></main>`), false);
    assert.equal(await probe(`${chrome}<div><h2>Oops</h2></div>`), false);
    assert.equal(await probe(`${chrome}<div>${'We could not find the page you asked for. '.repeat(3)}</div>`), false);
  } finally { await page.context().close(); }
});

test('dead links keep their verdict on a bare shell and on /job-details; on /404 they are the mirrored-path question', () => {
  const mk = () => [{ ruleId: 'dead-link-404', layer: 'links', verdict: 'confirmed' }];
  assert.equal(downgradeErrorPage(mk(), 'http://127.0.0.1:1/other', [], { bareShell: true })[0].verdict, 'confirmed');
  assert.equal(downgradeErrorPage(mk(), 'http://127.0.0.1:1/job-details', ['/404', '/job-details'])[0].verdict, 'confirmed');
  assert.equal(downgradeErrorPage(mk(), 'http://127.0.0.1:1/404', ['/404', '/job-details'])[0].verdict, 'needs-review');
});
