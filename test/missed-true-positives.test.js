import './helpers/hermetic-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { closeBrowser } from '../src/scanner/browser.js';
import { scanScreenReaderAccessibility } from '../src/scanner/screen-reader.js';
import { scanDynamicContent } from '../src/scanner/dynamic-content.js';
import { validateHtml } from '../src/scanner/html-validate.js';
import { traceToPartials } from '../src/index.js';
import { requireBrowser } from './helpers/require-browser.js';
import { startParadoxSite } from './helpers/paradox-site-server.js';

const page = (body) => (req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html><html lang="en"><head><title>t</title></head><body><main><h1>Page</h1>${body}</main></body></html>`);

async function scan(t, body, fn) {
  const browser = await requireBrowser(t);
  if (!browser) return;
  t.after(closeBrowser);
  const site = await startParadoxSite({ routes: { '/': page(body) } });
  try { await fn(`${site.url}/`); } finally { await site.close(); }
}

// What a Liquid for-loop renders when the author hard-codes the id: four cards, every card points at "card-title".
const card = (n, id = 'card-title') => `<li role="group" aria-labelledby="${id}"><h3 id="${id}">Role ${n}</h3></li>`;
const loopList = (ids) => `<ul class="cards">${[1, 2, 3, 4].map((n) => card(n, ids(n))).join('')}</ul>`;

test('(a) hard-coded id in a loop, referenced by aria-labelledby: one confirmed finding with the occurrence count and the wrong resolutions', async (t) => {
  await scan(t, loopList(() => 'card-title'), async (url) => {
    const { violations } = await scanScreenReaderAccessibility(url);
    const dup = violations.filter((v) => v.rule === 'duplicate-id-referenced');
    assert.equal(dup.length, 1);
    assert.equal(dup[0].count, 4);
    assert.equal(dup[0].impact, 'serious');
    assert.equal(dup[0].evidence.misresolved, 3); // cards 2-4 are named by card 1's heading
    assert.deepEqual(dup[0].evidence.referrers.map((r) => r.intendedIndex), [1, 2, 3, 4]);
    assert.match(dup[0].element.html, /^<h3 id="card-title"/);
  });
});

test('(a) paired good: ids unique per item, or a duplicated id nothing references, stay silent here', async (t) => {
  await scan(t, loopList((n) => `card-title-${n}`), async (url) => {
    assert.deepEqual((await scanScreenReaderAccessibility(url)).violations.filter((v) => v.rule === 'duplicate-id-referenced'), []);
  });
  await scan(t, '<ul><li><h3 id="x">a</h3></li><li><h3 id="x">b</h3></li></ul><label for="y">y</label><input id="y">', async (url) => {
    assert.deepEqual((await scanScreenReaderAccessibility(url)).violations.filter((v) => v.rule === 'duplicate-id-referenced'), []);
  });
});

test('(a) label[for] and aria-describedby resolve through the first duplicate too', async (t) => {
  await scan(t, '<form><label for="n">Name</label><input id="n"><label for="n">Other</label><input id="n"><p id="h">hint</p><p id="h">hint 2</p><input aria-describedby="h" id="z"></form>', async (url) => {
    const dup = (await scanScreenReaderAccessibility(url)).violations.filter((v) => v.rule === 'duplicate-id-referenced');
    assert.deepEqual(dup.map((d) => d.evidence.id).sort(), ['h', 'n']);
  });
});

test('(a) source: the line that DEFINES the hard-coded id in the loop template, not the first line that references it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ada-loop-'));
  try {
    const files = {
      'dist/scan-manifest.json': '{}',
      'src/layouts/layout.liquid': '<!doctype html>\n<html lang="en"><head><title>t</title></head><body>\n{% block content %}{% endblock %}\n</body></html>\n',
      'src/pages/index.liquid': '{% layout "layout" %}\n{% block content %}\n<main id="main">\n<ul class="cards">\n{% for card in cards %}\n  <li role="group" aria-labelledby="card-title">\n    <h3 id="card-title">{{ card.title }}</h3>\n  </li>\n{% endfor %}\n</ul>\n</main>\n{% endblock %}\n',
    };
    for (const [rel, body] of Object.entries(files)) { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), body); }
    const v = { rule: 'duplicate-id-referenced', element: { outerHTML: '<h3 id="card-title">Role 1</h3>', selector: '#card-title' }, source: { mode: 'url', confidence: 'low' } };
    await traceToPartials([v], 'http://127.0.0.1:1/', root);
    assert.equal(`${v.source.file}:${v.source.line}`, 'src/pages/index.liquid:7');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('(b) every slide announces the same hard-coded name: repeated-accessible-name-in-loop with the count; distinct, aria-hidden clones and lone items stay silent', async (t) => {
  const slides = (label) => `<div class="carousel" aria-roledescription="carousel" aria-label="Jobs"><div class="carousel-slides">${[1, 2, 3].map(() => `<div class="carousel-slide" role="group" aria-roledescription="slide" aria-label="${label(0)}">x</div>`).join('')}</div></div>`;
  await scan(t, slides(() => 'Slide 1 of 3: Call Center'), async (url) => {
    const rep = (await scanScreenReaderAccessibility(url)).violations.filter((v) => v.rule === 'repeated-accessible-name-in-loop');
    assert.equal(rep.length, 1);
    assert.equal(rep[0].count, 3);
    assert.match(rep[0].description, /Slide 1 of 3: Call Center/);
  });
  const distinct = `<div class="carousel"><div class="carousel-slides">${[1, 2, 3].map((n) => `<div class="carousel-slide" role="group" aria-label="Slide ${n} of 3: Role ${n}">x</div>`).join('')}</div></div>`;
  const clones = `<div class="carousel"><div role="group" aria-label="Slide 1 of 1">a</div><div role="group" aria-label="Slide 1 of 1" aria-hidden="true">clone</div></div>`;
  await scan(t, distinct + clones, async (url) => {
    assert.deepEqual((await scanScreenReaderAccessibility(url)).violations.filter((v) => v.rule === 'repeated-accessible-name-in-loop'), []);
  });
});

test('(b) carousel-slides-missing-labels: labelled slides inside a "carousel-slides" wrapper with a "slide-dots" control pass; an unlabelled slide still fires', async (t) => {
  const labelled = '<div class="carousel" aria-label="Jobs"><div class="carousel-slides"><div class="carousel-slide" role="group" aria-label="Slide 1 of 2: A"><div class="slide-inner">a</div></div><div class="carousel-slide" role="group" aria-label="Slide 2 of 2: B">b</div></div><div class="slide-dots"><button aria-label="Previous slide" class="prev">p</button><button aria-label="Next slide" class="next">n</button></div></div>';
  await scan(t, labelled, async (url) => {
    assert.deepEqual((await scanDynamicContent(url)).violations.filter((v) => v.rule === 'carousel-slides-missing-labels'), []);
  });
  await scan(t, labelled.replace(' aria-label="Slide 2 of 2: B"', ''), async (url) => {
    assert.equal((await scanDynamicContent(url)).violations.filter((v) => v.rule === 'carousel-slides-missing-labels').length, 1);
  });
});

test('(b) a slide named only by aria-roledescription is unnamed; with an aria-label it passes', async (t) => {
  const slides = (attr) => `<div class="carousel" aria-label="Jobs"><div role="group" aria-roledescription="slide" ${attr}>a</div><div role="group" aria-roledescription="slide" ${attr}>b</div></div>`;
  await scan(t, slides(''), async (url) => {
    assert.equal((await scanDynamicContent(url)).violations.filter((v) => v.rule === 'carousel-slides-missing-labels').length, 1);
  });
  await scan(t, slides('aria-label="Slide"'), async (url) => {
    assert.deepEqual((await scanDynamicContent(url)).violations.filter((v) => v.rule === 'carousel-slides-missing-labels'), []);
  });
});

test('(e) a duplicated class is reported on the element that carries it, not on the whole serialized line; clean markup is silent', async () => {
  const dom = '<!DOCTYPE html>\n<html lang="en"><head><title>t</title></head><body><main><section class="hero hero--a"><h1>x</h1></section><section class="hero-banner hero-banner"><h1>y</h1></section></main></body></html>';
  const dup = (await validateHtml(dom)).filter((v) => v.rule === 'html-validate:no-dup-class');
  assert.equal(dup.length, 1);
  assert.equal(dup[0].html, '<section class="hero-banner hero-banner">');
  assert.equal(dup[0].impact, 'minor');
  assert.deepEqual((await validateHtml(dom.replace('hero-banner hero-banner', 'hero-banner'))).filter((v) => v.rule === 'html-validate:no-dup-class'), []);
});
