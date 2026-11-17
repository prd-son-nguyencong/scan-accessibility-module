import './helpers/hermetic-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAdapter, resolveAdapter } from '../src/tracer/adapters/index.js';
import { traceElement } from '../src/tracer/trace-element.js';
import { parseHtml } from '../src/tracer/html-source-index.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/trace-html');
const adapter = getAdapter('html');
const locate = (el) => adapter.locate({ root: ROOT, ...el });
const where = (r) => r.candidates.map((c) => `${c.file}:${c.line}`);

// Expected lines are read off test/fixtures/trace-html/*.html by hand (`truth` = [] means the element is not in source).
// Every case names its page, as a local-URL scan does; the DOM serialisation adds <tbody> to tables.
const CASES = [
  ['h1 by id', 'index.html', '<h1 id="page-title">Careers at Acme</h1>', 'main > h1#page-title', 'high', ['index.html:18']],
  ['nav by id', 'index.html', '<nav id="main-nav" aria-label="Main"><ul><li><a href="/about.html">About</a></li><li><a href="/contact.html">Contact</a></li></ul></nav>', 'nav#main-nav', 'high', ['index.html:11']],
  ['two identical card links', 'index.html', '<a href="/jobs/1.html" class="card-link">Read more</a>', 'section.cards > div.card > a', 'ambiguous', ['index.html:21', 'index.html:22']],
  ['third card link differs by href', 'index.html', '<a href="/jobs/2.html" class="card-link">Read more</a>', 'section.cards > div.card > a', 'high', ['index.html:23']],
  ['button in the inner of nested tables', 'index.html', '<button type="button" class="apply">Apply now</button>', 'main > table.outer > tbody > tr > td > table.inner > tbody > tr > td > button.apply', 'high', ['index.html:27']],
  ['outer of nested tables (tbody added)', 'index.html', '<table class="outer"><tbody><tr><td><table class="inner"><tbody><tr><td><button type="button" class="apply">Apply now</button></td></tr></tbody></table></td></tr></tbody></table>', 'main > table.outer', 'medium', ['index.html:25']],
  ['script src after an inline script', 'index.html', '<script src="/app.js"></script>', 'body > script:nth-child(5)', 'high', ['index.html:33']],
  ['button filled and restyled by JS', 'index.html', '<button type="button" id="dyn" class="busy">Loading</button>', 'main > button#dyn', 'high', ['index.html:30']],
  ['nav link with a JS class', 'index.html', '<a href="/about.html" class="active">About</a>', 'nav > ul > li > a', 'medium', ['index.html:13']],
  ['input by id', 'about.html', '<input type="email" id="email" name="email">', 'form > input#email', 'high', ['about.html:18']],
  ['footer', 'about.html', '<footer><p>Copyright Acme</p></footer>', 'footer', 'high', ['about.html:21']],
  ['h1 without id', 'contact.html', '<h1>Contact</h1>', 'main > h1', 'high', ['contact.html:15']],
  ['image', 'index.html', '<img src="/img/hero.png" class="hero" alt="">', 'main > img.hero', 'high', ['index.html:19']],
  ['paragraph with a JS class', 'contact.html', '<p class="note">Write to us.</p>', 'main > p.note', 'medium', ['contact.html:16']],
  ['markup that only exists inside an inline script string', 'index.html', '<div id="fake">not an element</div>', 'div#fake', 'untraceable', []],
  ['element injected by the platform', 'index.html', '<aside class="promo">Join now</aside>', 'body > aside', 'untraceable', []],
];

for (const [name, pageFile, outerHTML, selector, confidence, truth] of CASES) {
  test(`html adapter: ${name} is ${confidence}`, () => {
    const result = locate({ pageFile, outerHTML, selector });
    assert.equal(result.confidence, confidence);
    assert.deepEqual(where(result), truth);
    assert.equal(result.reason, { ambiguous: 'multiple-candidates', untraceable: 'no-match' }[confidence] ?? null);
  });
}

test('fixture tally: 14 traceable elements -> 13 correct, 1 ambiguous, 0 untraceable, 0 wrong; 2 absent elements stay untraceable', () => {
  const tally = { correct: 0, ambiguous: 0, untraceable: 0, wrong: 0, absentOk: 0 };
  for (const [, pageFile, outerHTML, selector, , truth] of CASES) {
    const r = locate({ pageFile, outerHTML, selector });
    if (truth.length === 0) { r.confidence === 'untraceable' ? tally.absentOk++ : tally.wrong++; continue; }
    if (r.confidence === 'untraceable') tally.untraceable++;
    else if (r.confidence === 'ambiguous') truth.every((t) => where(r).includes(t)) ? tally.ambiguous++ : tally.wrong++;
    else (where(r)[0] === truth[0] ? tally.correct++ : tally.wrong++);
  }
  assert.deepEqual(tally, { correct: 13, ambiguous: 1, untraceable: 0, wrong: 0, absentOk: 2 });
});

test('start tags report 1-based line and column', () => {
  const r = locate({ pageFile: 'index.html', outerHTML: '<h1 id="page-title">Careers at Acme</h1>' });
  assert.deepEqual([r.candidates[0].line, r.candidates[0].col, r.candidates[0].method], [18, 5, 'html-id']);
  const card = locate({ pageFile: 'index.html', outerHTML: '<a href="/jobs/1.html" class="card-link">Read more</a>' });
  assert.deepEqual(card.candidates.map((c) => c.col), [25, 25]);
});

test('without a page, identical markup on several pages is ambiguous with every candidate', () => {
  const nav = locate({ outerHTML: '<nav id="main-nav" aria-label="Main"><ul><li><a href="/about.html">About</a></li><li><a href="/contact.html">Contact</a></li></ul></nav>' });
  assert.equal(nav.confidence, 'ambiguous');
  assert.deepEqual(where(nav), ['about.html:8', 'contact.html:8', 'index.html:11']);
  const apply = locate({ outerHTML: '<button type="button" class="apply">Apply now</button>' });
  assert.deepEqual([apply.confidence, ...where(apply)], ['ambiguous', 'contact.html:17', 'index.html:27']);
  // the same id on two pages is not unique either
  assert.deepEqual(where(locate({ outerHTML: '<h1 id="page-title"></h1>' })), ['about.html:15', 'index.html:18']);
});

test('without a page, a unique id or text still resolves to one page', () => {
  const email = locate({ outerHTML: '<input type="email" id="email" name="email">' });
  assert.deepEqual([email.confidence, ...where(email)], ['high', 'about.html:18']);
  const h1 = locate({ outerHTML: '<h1 id="page-title">Careers at Acme</h1>' });
  assert.deepEqual([h1.confidence, ...where(h1)], ['high', 'index.html:18']);
});

test('el.text and the scan selector refine a bare tag', () => {
  const r = locate({ pageFile: 'index.html', outerHTML: '<a href="/about.html" class="active"></a>', text: 'About', selector: 'nav > ul > li > a' });
  assert.deepEqual([r.confidence, ...where(r)], ['medium', 'index.html:13']);
});

test('inline script bodies are not parsed as elements', () => {
  const { elements } = parseHtml('<script>var a = "<div id=x>";</script><p>hi</p>');
  assert.deepEqual(elements.map((e) => e.tag), ['script', 'p']);
  assert.ok(!adapter.index(ROOT).some((e) => e.file === 'index.html' && e.line === 7));
});

test('implied end tags, attribute values with ">", and comments keep lines straight', () => {
  const { elements } = parseHtml('<ul>\n<li>a\n<li title="1 > 0">b\n<!-- <li>no</li> -->\n</ul>\n<p>c');
  assert.deepEqual(elements.map((e) => [e.tag, e.line]), [['ul', 1], ['li', 2], ['li', 3], ['p', 6]]);
  assert.equal(elements[2].parent, elements[0]);
});

test('index lists every element with its line', () => {
  const idx = adapter.index(ROOT);
  assert.deepEqual(idx.find((e) => e.file === 'about.html' && e.tagName === 'input'), { file: 'about.html', line: 18, tagName: 'input' });
  assert.deepEqual([...new Set(idx.map((e) => e.file))], ['about.html', 'contact.html', 'index.html']);
});

test('untraceable reasons: platform-owned, no element, page source missing', () => {
  assert.equal(locate({ pageFile: 'index.html', outerHTML: '<div data-react-component="Jobs"></div>' }).reason, 'platform-owned');
  assert.equal(locate({ pageFile: 'index.html', outerHTML: 'plain text' }).reason, 'no-element');
  assert.equal(locate({ pageFile: 'gone.html', outerHTML: '<p>x</p>' }).reason, 'page-source-missing');
});

test('traceElement reaches the html adapter for a folder of html files, in local and preview (--source) mode', () => {
  assert.equal(resolveAdapter(ROOT).id, 'html');
  const el = { root: ROOT, pageFile: 'about.html', outerHTML: '<input type="email" id="email" name="email">' };
  assert.deepEqual(where(traceElement({ ...el, mode: 'local' })), ['about.html:18']);
  assert.deepEqual(where(traceElement({ ...el, mode: 'preview', attestation: { ok: true } })), ['about.html:18']);
  assert.equal(traceElement({ ...el, mode: 'preview' }).reason, 'preview-without-reference');
});
