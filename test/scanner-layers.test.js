import './helpers/hermetic-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { closeBrowser } from '../src/scanner/browser.js';
import { scanFocusTraps } from '../src/scanner/focus-trap.js';
import { scanKeyboardNavigation } from '../src/scanner/keyboard.js';
import { scanScreenReaderAccessibility } from '../src/scanner/screen-reader.js';
import { scanDeadLinks, createLinkChecker } from '../src/scanner/links.js';
import { requireBrowser } from './helpers/require-browser.js';
import { startParadoxSite } from './helpers/paradox-site-server.js';

const html = (body) => (req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html><html lang="en"><head><title>t</title></head><body>${body}</body></html>`);

async function withPage(t, body, fn) {
  const browser = await requireBrowser(t);
  if (!browser) return;
  t.after(closeBrowser);
  const site = await startParadoxSite({ routes: { '/': html(body) } });
  try {
    await fn(`${site.url}/`);
  } finally {
    await site.close();
  }
}

// Four triggers, each opening its own position:fixed dialog; B and D ignore Escape.
const dialogs = ['A', 'B', 'C', 'D'].map((n) => `
  <button aria-haspopup="dialog" onclick="const d=document.getElementById('d${n}');d.hidden=false;d.querySelector('button').focus()">Open ${n}</button>
  <div role="dialog" aria-modal="true" aria-label="${n}" id="d${n}" hidden data-esc="${n === 'A' || n === 'C'}" style="position:fixed;top:20px;left:20px;background:#fff"><button>Inside ${n}</button></div>`).join('');
const escScript = `<script>document.addEventListener('keydown',(e)=>{if(e.key==='Escape')document.querySelectorAll('[data-esc=true]').forEach((d)=>{d.hidden=true})})</script>`;

test('focus-trap tests every trigger and its Escape check is not vacuous for fixed dialogs', async (t) => {
  await withPage(t, dialogs + escScript, async (url) => {
    const { violations, passes } = await scanFocusTraps(url);
    const escape = violations.filter((v) => v.rule === 'modal-escape-key-not-working').map((v) => v.description);
    assert.equal(escape.length, 2);
    assert.ok(escape.some((d) => d.includes('"Open B"')) && escape.some((d) => d.includes('"Open D"')), escape.join('|'));
    assert.ok(passes.includes('Escape key closes modal "Open A"'));
    assert.ok(passes.includes('Escape key closes modal "Open C"'));
  });
});

test('focus-trap reads aria-modal once and reloads only between trigger tests, not after the last', async (t) => {
  const browser = await requireBrowser(t);
  if (!browser) return;
  t.after(closeBrowser);
  let loads = 0;
  const page = (req, res) => { loads++; html(`<button aria-haspopup="dialog" onclick="document.getElementById('dX').hidden=false">One</button><button aria-haspopup="dialog">Two</button><div role="dialog" aria-label="X" id="dX" hidden>x</div>`)(req, res); };
  const site = await startParadoxSite({ routes: { '/': page } });
  try {
    const { violations } = await scanFocusTraps(`${site.url}/`);
    assert.equal(loads, 2, 'initial load plus one reload between the two tests');
    assert.deepEqual(violations.filter((v) => v.rule === 'dialog-missing-aria-modal').map((v) => v.description), ['1 dialog element(s) missing aria-modal="true": dX']);
  } finally {
    await site.close();
  }
});

test('keyboard layer: static border is not a focus indicator, low contrast maps to 1.4.11, tabindex reordering is flagged', async (t) => {
  const body = `<style>body{background:#fff}a{margin:8px;display:inline-block}
    a.static{border:2px solid #000;outline:none}
    a.good:focus-visible{outline:3px solid #0000ff}
    a.low:focus-visible{outline:3px solid #f8f8f8}</style>
    <a href="#a" class="static">static</a> <a href="#b" class="good">good</a> <a href="#c" class="low">low</a>
    <a href="#t4" tabindex="4">p4</a><a href="#t3" tabindex="3">p3</a><a href="#t2" tabindex="2">p2</a><a href="#t1" tabindex="1">p1</a>`;
  await withPage(t, body, async (url) => {
    const { violations } = await scanKeyboardNavigation(url);
    const notVisible = violations.filter((v) => v.rule === 'focus-not-visible').map((v) => v.element.text);
    assert.ok(notVisible.includes('static'), notVisible.join('|'));
    assert.ok(!notVisible.includes('good'));
    const low = violations.find((v) => v.rule === 'focus-indicator-low-contrast');
    assert.equal(low?.wcagCriteria, '1.4.11');
    assert.ok(violations.some((v) => v.rule === 'focus-order-illogical'));
  });
});

test('keyboard layer: a long page in DOM order has no focus-order finding', async (t) => {
  const body = `<style>a{display:block;height:120px}a:focus-visible{outline:3px solid #00f}</style>${Array.from({ length: 30 }, (_, i) => `<a href="#x${i}">link ${i}</a>`).join('')}`;
  await withPage(t, body, async (url) => {
    const { violations } = await scanKeyboardNavigation(url);
    assert.deepEqual(violations.filter((v) => v.rule === 'focus-order-illogical' || v.rule === 'focus-not-visible'), []);
  });
});

test('screen-reader layer reads the real accessibility tree and ignores skip links, hidden SVGs and layout tables', async (t) => {
  const body = `<a href="#main" style="position:absolute;left:-9999px">Skip to content</a>
    <div style="position:absolute;left:-9999px">off-screen text</div>
    <svg style="display:none"><symbol id="s"></symbol></svg>
    <svg width="0" height="0"><symbol id="v"></symbol></svg>
    <h1 hidden>Hidden title</h1><h2>Visible</h2>
    <table role="presentation"><tr><td>layout</td></tr></table>
    <a href="/x"><img alt="" src="/a.png"></a><img alt="hero.jpg" src="/h.jpg"><main id="main"></main>`;
  await withPage(t, body, async (url) => {
    const { violations } = await scanScreenReaderAccessibility(url);
    const byRule = Object.fromEntries(violations.map((v) => [v.rule, v]));
    assert.ok(byRule['missing-h1'], 'hidden h1 must not count');
    assert.match(byRule['off-screen-content-exposed'].description, /^1 element/, 'only the non-focusable div');
    assert.match(byRule['svg-sprite-not-hidden'].description, /^1 SVG/, 'display:none svg is not exposed');
    assert.ok(!byRule['table-no-headers'] && !byRule['table-no-caption'] && !byRule['table-th-no-scope']);
    assert.ok(byRule['image-alt-not-descriptive']);
  });
});

test('semantic-emphasis-missing flags bold only in running text, not heading-like or numeric badges', async (t) => {
  const bold = 'font-weight:700';
  const bad = `<main><h1>T</h1><p>Please <span style="${bold}">read this notice</span> first.</p></main>`;
  const good = `<main><h1>T</h1><div><span style="${bold}">Benefits and growth</span></div><div><span style="${bold}">01</span></div><p><span style="${bold};display:block">Label</span></p></main>`;
  await withPage(t, bad, async (url) => {
    const { violations } = await scanScreenReaderAccessibility(url);
    assert.ok(violations.some((v) => v.rule === 'semantic-emphasis-missing'));
  });
  await withPage(t, good, async (url) => {
    const { violations } = await scanScreenReaderAccessibility(url);
    assert.ok(!violations.some((v) => v.rule === 'semantic-emphasis-missing'));
  });
});

test('screen-reader layer counts only visible main and nav landmarks', async (t) => {
  const body = `<main>a</main><main hidden>b</main><nav>x</nav><nav style="display:none">m</nav><nav aria-hidden="true">n</nav>`;
  await withPage(t, body, async (url) => {
    const rules = (await scanScreenReaderAccessibility(url)).violations.map((v) => v.rule);
    assert.ok(!rules.includes('multiple-main-landmarks'));
    assert.ok(!rules.includes('multiple-navs-missing-labels'));
  });
  await withPage(t, '<main>a</main><main>b</main><nav>x</nav><nav>y</nav>', async (url) => {
    const rules = (await scanScreenReaderAccessibility(url)).violations.map((v) => v.rule);
    assert.ok(rules.includes('multiple-main-landmarks') && rules.includes('multiple-navs-missing-labels'));
  });
});

async function linkServer() {
  const seen = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const server = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    if (req.url === '/loop') return res.writeHead(302, { location: '/loop' }).end();
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    setTimeout(() => { inFlight--; res.writeHead(200).end('ok'); }, 40);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, seen, max: () => maxInFlight, close: () => { server.close(); server.closeAllConnections?.(); } };
}
const fake = (links) => ({ $$eval: async (sel) => (sel.startsWith('a[href], link') ? links.map((u) => ({ tag: 'a', url: u, text: 't', html: '<a>', selector: 'a', linkRel: '' })) : []) });

test('links layer: per-host concurrency cap, redirect loop is bounded, public pages cannot probe private hosts', async () => {
  const site = await linkServer();
  try {
    await scanDeadLinks(fake(Array.from({ length: 8 }, (_, i) => `${site.url}/p${i}`)), `${site.url}/`);
    assert.ok(site.max() <= 2, `max in flight ${site.max()}`);

    site.seen.length = 0;
    const loop = await scanDeadLinks(fake([`${site.url}/loop`]), `${site.url}/`);
    assert.deepEqual(loop.map((v) => v.ruleId), ['dead-link-unreachable']);
    assert.equal(site.seen.length, 6, 'initial request plus 5 redirects');

    site.seen.length = 0;
    const blocked = await scanDeadLinks(fake([`${site.url}/ok`]), 'https://careers.example.com/');
    assert.deepEqual(blocked, []);
    assert.deepEqual(site.seen, [], 'loopback target was never requested');
  } finally {
    site.close();
  }
});

test('links layer: a re-run with selectors probes only those links', async () => {
  const site = await linkServer();
  try {
    const links = ['a', 'b', 'c'].map((n) => ({ tag: 'a', url: `${site.url}/${n}`, text: n, html: `<a>${n}</a>`, selector: `#${n}`, linkRel: '' }));
    const page = { $$eval: async (sel) => (sel.startsWith('a[href], link') ? links : []) };
    await scanDeadLinks(page, `${site.url}/`, { selectors: new Set(['#b']) });
    assert.deepEqual(site.seen, ['HEAD /b']);
  } finally {
    site.close();
  }
});

test('links layer: one checker probes each URL once across pages (hash ignored); a re-run probes again', async () => {
  const site = await linkServer();
  try {
    const checker = createLinkChecker();
    const urls = [`${site.url}/a`, `${site.url}/a#top`, `${site.url}/b`];
    await scanDeadLinks(fake(urls), `${site.url}/`, { checker });
    await scanDeadLinks(fake([`${site.url}/b`, `${site.url}/c`]), `${site.url}/p2`, { checker });
    assert.deepEqual([...site.seen].sort(), ['HEAD /a', 'HEAD /b', 'HEAD /c'], 'a, a#top, b and the second page\'s b each probed once');
    site.seen.length = 0;
    await scanDeadLinks(fake([`${site.url}/b`]), `${site.url}/p2`, { checker, selectors: new Set(['a']) });
    assert.deepEqual(site.seen, ['HEAD /b'], 'a re-run bypasses the cache');
  } finally {
    site.close();
  }
});

test('links layer: a network error is retried once before the link is reported unreachable', async () => {
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits++;
    if (req.url === '/flaky' && hits === 1) return req.socket.destroy();
    if (req.url === '/down') return req.socket.destroy();
    res.writeHead(200).end('ok');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.deepEqual(await scanDeadLinks(fake([`${base}/flaky`]), `${base}/`), []);
    hits = 0;
    const down = await scanDeadLinks(fake([`${base}/down`]), `${base}/`);
    assert.deepEqual(down.map((v) => v.ruleId), ['dead-link-unreachable']);
    assert.equal(hits, 2, 'one try plus one retry');
  } finally {
    server.close();
    server.closeAllConnections?.();
  }
});

test('links layer never fetches mailto, tel, javascript or same-page anchors', async (t) => {
  const browser = await requireBrowser(t);
  if (!browser) return;
  t.after(closeBrowser);
  const site = await linkServer();
  const page = await browser.newPage();
  try {
    await page.goto(`${site.url}/seed`);
    await page.setContent(`<a href="#top">top</a><a href="mailto:a@b.c">m</a><a href="tel:123">t</a><a href="javascript:void(0)">j</a><a href="${site.url}/real">r</a>`);
    site.seen.length = 0;
    await scanDeadLinks(page, `${site.url}/seed`);
    assert.deepEqual(site.seen, ['HEAD /real']);
  } finally {
    await page.close();
    site.close();
  }
});
