import './helpers/hermetic-env.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { applyRenderArtefacts, leakNearSelectors, probeLiquidLeak } from '../src/scanner/unresolved-text.js';
import { DEV_OVERLAY_REASON, dropDevOverlayFindings, hasDevOverlay } from '../src/scanner/page-health.js';
import { computeExitCode, scanOnePage } from '../src/index.js';
import { closeBrowser, getBrowser } from '../src/scanner/browser.js';
import { requireBrowser } from './helpers/require-browser.js';

after(() => closeBrowser());

const row = (ruleId, html, extra = {}) => ({ ruleId, layer: 'axe', verdict: 'confirmed', element: { selector: 'x', outerHTML: html }, evidence: { proof: { type: 'x', fact: 'x' } }, ...extra });

test('findings inside a dev overlay (any shadow-hosted one) are dropped; site findings stay', () => {
  const inOverlay = [
    row('color-contrast', '<span>x</span>', { element: { selector: 'vite-error-overlay .window .message', outerHTML: '<span class="message">x</span>' } }),
    row('color-contrast', '<span>x</span>', { element: { selector: '.m', shadowPath: ['vite-error-overlay'], outerHTML: '<span>x</span>' } }),
    row('region', '<div>', { element: { selector: 'nextjs-portal', outerHTML: '<nextjs-portal></nextjs-portal>' } }),
  ];
  const site = row('color-contrast', '<p class="low">Hi</p>', { element: { selector: 'p.low', outerHTML: '<p class="low">Hi</p>' } });
  assert.deepEqual(dropDevOverlayFindings([...inOverlay, site]), [site]);
});

test('a page with the dev error overlay is failed with a clear reason and the run exits 2; a clean page has no overlay', async (t) => {
  if (!await requireBrowser(t)) return;
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(req.url === '/clean'
      ? '<!doctype html><html lang="en"><title>x</title><body><main><h1>Hi</h1></main></body></html>'
      : '<!doctype html><html lang="en"><title>x</title><body><main><h1>Hi</h1></main><script type="module">const o=document.createElement("vite-error-overlay");o.attachShadow({mode:"open"}).innerHTML="<p style=\\"color:#ccc;background:#fff\\">boom</p>";document.body.appendChild(o);</script></body></html>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const bad = await scanOnePage({ name: 'p', url: `${base}/overlay` }, { layers: { axe: true } }, {});
    assert.equal(bad.status, 'failed');
    assert.equal(bad.scanFailed, true);
    assert.equal(bad.failure.message, DEV_OVERLAY_REASON);
    assert.deepEqual(bad.violations, []);
    assert.equal(computeExitCode({ pagesFailed: 1 }), 2);
    const page = await (await getBrowser()).newPage();
    await page.goto(`${base}/clean`);
    assert.equal(await hasDevOverlay(page), false);
    await page.close();
    const ok = await scanOnePage({ name: 'p', url: `${base}/clean` }, { layers: {} }, {});
    assert.notEqual(ok.status, 'failed');
  } finally { server.close(); server.closeAllConnections?.(); }
});

test('Next dev: a healthy page with the always-present nextjs-portal host passes; one whose portal shadow root holds an error dialog fails', async (t) => {
  if (!await requireBrowser(t)) return;
  const portal = (inner) => `<!doctype html><html lang="en"><title>x</title><body><main><h1>Hi</h1></main><script>const o=document.createElement("nextjs-portal");o.attachShadow({mode:"open"}).innerHTML=${JSON.stringify(inner)};document.body.appendChild(o);</script></body></html>`;
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(req.url === '/healthy' ? '<!doctype html><html lang="en"><title>x</title><body><main><h1>Hi</h1></main><nextjs-portal></nextjs-portal></body></html>'
      : req.url === '/toast' ? portal('<div data-nextjs-toast>1 issue</div>') : portal('<div data-nextjs-dialog-overlay><div data-nextjs-dialog>Build Error</div></div>'));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const p of ['healthy', 'toast']) {
      const ok = await scanOnePage({ name: p, url: `${base}/${p}` }, { layers: {} }, {});
      assert.notEqual(ok.status, 'failed', p);
    }
    const bad = await scanOnePage({ name: 'e', url: `${base}/error` }, { layers: {} }, {});
    assert.equal(bad.status, 'failed');
    assert.equal(bad.failure.message, DEV_OVERLAY_REASON);
  } finally { server.close(); server.closeAllConnections?.(); }
});

test('raw Liquid text in the body: pixel-measured contrast becomes needs-review "local render artefact"; solid-backdrop contrast, other rules and clean pages keep their verdict', () => {
  const pixel = () => row('color-contrast', '<a>Career Areas</a>', { evidence: { proof: { type: 'computed-ratio', fact: '1' }, pixelContrast: { min: 1 } } });
  const solid = row('color-contrast', '<p>Low</p>', { evidence: { proof: { type: 'measured-fact', fact: 'contrast of 2.1' } } });
  const other = row('image-alt', '<img src="a.png">');
  const leaked = [pixel(), solid, other];
  assert.equal(applyRenderArtefacts(leaked, { liquidLeak: '{% for l in langs %}' }), 1);
  assert.equal(leaked[0].verdict, 'needs-review');
  assert.match(leaked[0].reason, /^local render artefact: /);
  assert.equal(leaked[0].evidence.proof, undefined);
  assert.deepEqual([solid.verdict, other.verdict], ['confirmed', 'confirmed']);
  const clean = [pixel()];
  assert.equal(applyRenderArtefacts(clean, { liquidLeak: null }), 0);
  assert.equal(clean[0].verdict, 'confirmed', 'a pixel-measured failure on a page without a leak is a real defect');
});

test('probeLiquidLeak finds raw Liquid in visible text only, not backend tags, scripts or clean text', async (t) => {
  if (!await requireBrowser(t)) return;
  const page = await (await getBrowser()).newPage();
  try {
    const probe = async (body) => { await page.setContent(`<!doctype html><html><body>${body}</body></html>`); return probeLiquidLeak(page); };
    assert.match(await probe('{% for l in langs %}<link rel="x">{% endfor %}<main>Hi</main>'), /\{% for l in langs %\}/);
    assert.match(await probe('<p>{{ page.title }}</p>'), /page\.title/);
    assert.equal(await probe('<p>{{data:job.title}} {{attribute:x}} {{component:y}}</p>'), null);
    assert.equal(await probe('<script>var a="{% x %}"</script><main>Hello</main>'), null);
  } finally { await page.close(); }
});

test('empty heading whose template is a _translate token is needs-review "local render artefact"; a literal empty heading and other tags stay confirmed', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ada-art-'));
  try {
    mkdirSync(path.join(root, 'src/pages'), { recursive: true });
    writeFileSync(path.join(root, 'src/pages/tok.liquid'), '<main>\n<h1 class="hd-lg">_translate("CORPORATE CAREERS")</h1>\n<h2></h2>\n</main>\n');
    writeFileSync(path.join(root, 'src/pages/real.liquid'), '<h1></h1>\n<h1>_translate("X")</h1>\n');
    writeFileSync(path.join(root, 'src/pages/line.liquid'), '<h1>_translate("X")</h1>\n<h1></h1>\n');
    const mk = (file, line, html) => row('empty-heading', html, { source: { file, line } });
    const tokenNoLine = mk('src/pages/tok.liquid', null, '<h1 class="hd-lg"></h1>');
    const tokenLine = mk('src/pages/tok.liquid', 2, '<h1 class="hd-lg"></h1>');
    const literalH2 = mk('src/pages/tok.liquid', null, '<h2></h2>');
    const realNoLine = mk('src/pages/real.liquid', null, '<h1></h1>');
    const realLine = mk('src/pages/line.liquid', 2, '<h1></h1>');
    const escape = mk('../outside.liquid', null, '<h1></h1>');
    const rows = [tokenNoLine, tokenLine, literalH2, realNoLine, realLine, escape];
    assert.equal(applyRenderArtefacts(rows, { root }), 2);
    assert.deepEqual(rows.map((r) => r.verdict), ['needs-review', 'needs-review', 'confirmed', 'confirmed', 'confirmed', 'confirmed']);
    assert.match(tokenNoLine.reason, /^local render artefact: .*_translate/);
    assert.equal(applyRenderArtefacts([mk('src/pages/tok.liquid', null, '<h1></h1>')], { root: null }), 0, 'no root, no source read');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a leak elsewhere on the page does not downgrade contrast: only a leak inside the element region does (leakNear)', () => {
  const pixel = (selector) => row('color-contrast', '<h1>Hero</h1>', { element: { selector, outerHTML: '<h1>Hero</h1>' }, evidence: { proof: { type: 'computed-ratio', fact: '1' }, pixelContrast: { min: 1 } } });
  const rows = [pixel('#hero h1'), pixel('#promo h2')];
  assert.equal(applyRenderArtefacts(rows, { liquidLeak: '{% for %}', leakNear: new Set(['#promo h2']) }), 1);
  assert.deepEqual(rows.map((r) => r.verdict), ['confirmed', 'needs-review']);
});

test('leakNearSelectors: a footer leak is not near the hero; a leak in the same section is', async (t) => {
  if (!await requireBrowser(t)) return;
  const page = await (await getBrowser()).newPage();
  try {
    await page.setContent('<!doctype html><body><main><section id="hero"><h1>Hero</h1></section><section id="promo"><h2>Promo</h2><p>{% for x in y %}</p></section></main><footer><p>{{ page.title }}</p><a class="f">x</a></footer></body>');
    assert.deepEqual(await leakNearSelectors(page, ['#hero h1', '#promo h2', 'footer a.f', '.gone']), ['#promo h2', 'footer a.f', '.gone']);
  } finally { await page.close(); }
});

test('a correct page that only quotes new ErrorOverlay( in text is scanned, remote or local; a real overlay script still fails locally', async (t) => {
  if (!await requireBrowser(t)) return;
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(req.url === '/doc'
      ? '<!doctype html><html lang="en"><head><title>Vite internals</title></head><body><main><h1>Overlay</h1><pre><code>document.body.appendChild(new ErrorOverlay(err))</code></pre></main></body></html>'
      : '<!doctype html><html lang="en"><title>x</title><body><main><h1>Hi</h1></main><script>if (0) new ErrorOverlay(err)</script></body></html>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const o of [{ isUrlMode: true }, {}]) assert.notEqual((await scanOnePage({ name: 'p', url: `${base}/doc` }, { layers: {} }, o)).status, 'failed', JSON.stringify(o));
    assert.equal((await scanOnePage({ name: 'p', url: `${base}/script` }, { layers: {} }, {})).status, 'failed');
    assert.notEqual((await scanOnePage({ name: 'p', url: `${base}/script` }, { layers: {} }, { isUrlMode: true })).status, 'failed');
  } finally { server.close(); server.closeAllConnections?.(); }
});
