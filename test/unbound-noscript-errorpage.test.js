import './helpers/hermetic-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateHtml } from '../src/scanner/html-validate.js';
import { downgradeErrorPage, dropStaleEvidence } from '../src/scanner/origin.js';
import { scanScreenReaderAccessibility } from '../src/scanner/screen-reader.js';
import { closeBrowser } from '../src/scanner/browser.js';
import { validateConfig, DEFAULT_CONFIG } from '../src/utils/config.js';
import { requireBrowser } from './helpers/require-browser.js';

const doc = (body) => `<!DOCTYPE html>\n<html lang="en"><head><meta charset="utf-8"><title>t</title></head><body>\n${body}\n</body></html>`;

test('noscript content is text with scripting on: its iframe is not validated; the same iframe in the live DOM still is, with line numbers kept', async () => {
  const quiet = await validateHtml(doc('<noscript>\n<iframe src="https://vendor-a.example/ns"></iframe>\n</noscript>\n<p id="a">x</p><p id="a">y</p>'));
  assert.deepEqual(quiet.filter((v) => v.rule === 'html-validate:element-required-attributes'), []);
  const dup = quiet.find((v) => v.rule === 'html-validate:no-dup-id');
  assert.equal(dup.line, 6, 'blanked noscript keeps the line count');
  const live = await validateHtml(doc('<iframe src="https://vendor-a.example/ns"></iframe>'));
  assert.equal(live.filter((v) => v.rule === 'html-validate:element-required-attributes').length, 1);
});

test('error pages: /404 and /500 alike keep real defects confirmed and only lose page-structure confirmation; other routes are untouched', () => {
  const mk = () => [
    { ruleId: 'missing-main-landmark', verdict: 'confirmed', fix: { hint: 'no main' } },
    { ruleId: 'no-headings', verdict: 'confirmed' },
    { ruleId: 'region', verdict: 'confirmed' },
    { ruleId: 'image-alt', verdict: 'confirmed', fix: { hint: 'alt' } },
  ];
  for (const url of ['http://127.0.0.1:1/404', 'http://127.0.0.1:1/500/']) {
    const [main, headings, region, alt] = downgradeErrorPage(mk(), url, DEFAULT_CONFIG.scan.errorPages);
    assert.equal(main.verdict, 'needs-review');
    assert.match(main.fix.hint, /error\/stub page/);
    assert.equal(headings.verdict, 'needs-review');
    assert.equal(region.verdict, 'needs-review', 'content outside landmarks follows from the missing main');
    assert.equal(alt.verdict, 'confirmed');
  }
  assert.deepEqual(downgradeErrorPage(mk(), 'http://127.0.0.1:1/careers', ['/404', '/500']).map((v) => v.verdict), ['confirmed', 'confirmed', 'confirmed', 'confirmed']);
  assert.equal(downgradeErrorPage(mk(), 'http://127.0.0.1:1/gone', ['/gone'])[0].verdict, 'needs-review', 'configurable');
  assert.deepEqual(validateConfig({ scan: { errorPages: ['/404'] } }), []);
  assert.match(validateConfig({ scan: { errorPages: 'x' } })[0], /scan\.errorPages/);
});

const page = (live) => ({ evaluate: async (fn, sels) => Object.fromEntries(sels.map((s) => [s, live[s] ?? null])) });
const hv = (selector, outerHTML, rule = 'empty-heading') => ({ ruleId: rule, element: { selector, outerHTML } });

test('evidence guard: an emptiness finding whose live node has text is dropped; one whose live node is empty (or gone) stays', async () => {
  const input = [hv('h2.a', '<h2 class="a"></h2>'), hv('h2.b', '<h2 class="b"></h2>'), hv('h2.c', '<h2 class="c"></h2>'), hv('h2.d', '<h2 class="d">Hi</h2>')];
  const kept = await dropStaleEvidence(page({ 'h2.a': true, 'h2.b': false }), input);
  assert.deepEqual(kept.map((v) => v.element.selector), ['h2.b', 'h2.c', 'h2.d']);
});

test('screenReader empty-heading names the empty node; a heading whose text is in the live DOM is not reported', async (t) => {
  const browser = await requireBrowser(t);
  if (!browser) return;
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  try {
    await p.route('http://127.0.0.1:1234/**', (r) => r.fulfill({ contentType: 'text/html', body: doc('<main><h1>Title</h1><h2 class="bound"><span>Has text</span></h2><h2 class="empty"></h2></main>') }));
    await p.goto('http://127.0.0.1:1234/');
    const r = await scanScreenReaderAccessibility('http://127.0.0.1:1234/', { page: p });
    const empties = r.violations.filter((v) => v.rule === 'empty-heading');
    assert.equal(empties.length, 1);
    assert.equal(empties[0].element.outerHTML, '<h2 class="empty"></h2>');
    assert.equal(await p.evaluate((s) => document.querySelector(s)?.className, empties[0].element.selector), 'empty');
  } finally {
    await ctx.close();
    await closeBrowser();
  }
});

test('error pages: a skip link (any layer) is page structure and needs review; the same finding on a normal route stays confirmed', () => {
  const mk = () => ['skip-link', 'skip-link-target-missing', 'bypass'].map((ruleId) => ({ ruleId, verdict: 'confirmed', fix: { hint: 'target' } }));
  assert.ok(downgradeErrorPage(mk(), 'http://127.0.0.1:1/404', ['/404', '/500']).every((v) => v.verdict === 'needs-review' && /error\/stub page/.test(v.fix.hint)));
  assert.ok(downgradeErrorPage(mk(), 'http://127.0.0.1:1/careers', ['/404', '/500']).every((v) => v.verdict === 'confirmed'));
});
