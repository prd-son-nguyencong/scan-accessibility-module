import './helpers/hermetic-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { applyColorOrigin, collectColorChains, groupByColorOrigin } from '../src/tracer/color-origin.js';
import { closeBrowser } from '../src/scanner/browser.js';
import { requireBrowser } from './helpers/require-browser.js';

const TOKENS = ':root {\n  --color-ink: #111111;\n  --color-primary: #009e77;\n}\n';
const BUTTON = '.btn {\n  padding: 1px;\n}\n\n.btn--primary {\n  background-color: var(--color-primary);\n  color: #fff;\n}\n';
const BUNDLE = '/* Synced from Paradox platform - do not edit manually */\n.c-language a.selected {\n  color: #ffbc0d;\n  background: #db0007;\n}\n';
const PAGE_CSS = `a { color: inherit; }\n${TOKENS}${BUTTON}.text-primary { color: var(--color-primary); }\n${BUNDLE.split('\n').slice(1).join('\n')}`;

async function withSite(t, html, fn, files = {}) {
  const browser = await requireBrowser(t);
  if (!browser) return;
  t.after(closeBrowser);
  const root = mkdtempSync(join(tmpdir(), 'ada-color-origin-'));
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  try {
    for (const [rel, body] of Object.entries({ 'src/styles/exported-token.css': TOKENS, 'src/components/button.css': BUTTON, 'src/styles/app-bundle.css': BUNDLE, ...files })) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), body);
    }
    await page.setContent(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>t</title><style>${PAGE_CSS}</style></head><body>${html}</body></html>`);
    await fn(page, root);
  } finally { await page.context().close(); rmSync(root, { recursive: true, force: true }); }
}
const finding = (selector, extra = {}) => ({ ruleId: 'color-contrast', rule: 'color-contrast', layer: 'axe', verdict: 'confirmed', element: { outerHTML: '<a>', selector }, evidence: { proof: { type: 'measured-fact', fact: 'contrast 3.41' } }, source: { mode: 'url', file: 'src/partials/footer.liquid', line: 92, confidence: 'low', method: 'liquid-tag-index' }, ...extra });
const resolve = async (page, root, v) => { [v.colorChain] = await collectColorChains(page, [v.element.selector]); return applyColorOrigin(v, root); };

test('a colour inherited from an ancestor utility class resolves through var() to the token declaration; markup stays as markupLine (paired)', async (t) => {
  await withSite(t, '<ul class="text-primary"><li><a id="a" href="/x" class="hover:text-primary">Link</a></li></ul>', async (page, root) => {
    const v = finding('#a');
    assert.equal(await resolve(page, root, v), true);
    assert.equal(`${v.source.file}:${v.source.line}`, 'src/styles/exported-token.css:3');
    assert.equal(v.source.method, 'css-token');
    assert.equal(v.source.markupLine, 92);
    assert.match(v.evidence.proof.fact, /color #[0-9a-f]{6} from var\(--color-primary\) -> #009e77 declared at src\/styles\/exported-token\.css:3/);
    // A colour no authored file declares leaves the existing trace alone.
    const plain = finding('#b');
    await page.evaluate(() => { document.body.insertAdjacentHTML('beforeend', '<p id="b" style="color:#777">x</p>'); });
    assert.equal(await resolve(page, root, plain), false);
    assert.equal(plain.source.method, 'liquid-tag-index');
  });
});

test('white text on a token background blames the background token; the winning rule is a candidate (paired with a literal rule)', async (t) => {
  await withSite(t, '<a id="b" class="btn btn--primary" href="/jobs">Explore</a><div class="c-language"><a id="l" class="selected" href="/">FR</a></div>', async (page, root) => {
    const v = finding('#b');
    assert.equal(await resolve(page, root, v), true);
    assert.equal(`${v.source.file}:${v.source.line}`, 'src/styles/exported-token.css:3');
    assert.ok(v.sourceCandidates.some((c) => c.file === 'src/components/button.css' && c.line === 6), JSON.stringify(v.sourceCandidates));
    assert.equal(v.evidence.colorOrigin.role, 'background');
    // A literal colour in a synced bundle: the declaring rule line, no token.
    const l = finding('#l');
    assert.equal(await resolve(page, root, l), true);
    assert.equal(`${l.source.file}:${l.source.line}`, 'src/styles/app-bundle.css:3');
    assert.equal(l.source.method, 'css-rule');
    assert.ok(l.sourceCandidates.some((c) => c.line === 4), 'the background declaration is a candidate');
  });
});

test('findings sharing one declaration collapse into one with the occurrence count; a different declaration stays (paired)', async (t) => {
  await withSite(t, '<a id="a1" class="btn btn--primary" href="/1">A</a><a id="a2" class="btn btn--primary" href="/2">B</a><div class="c-language"><a id="l" class="selected" href="/">FR</a></div>', async (page, root) => {
    const vs = [finding('#a1'), finding('#a2'), finding('#l')];
    for (const v of vs) await resolve(page, root, v);
    const grouped = groupByColorOrigin(vs);
    assert.equal(grouped.length, 2);
    assert.equal(grouped[0].evidence.occurrences.count, 2);
    assert.deepEqual(grouped[0].evidence.occurrences.selectors, ['#a1', '#a2']);
    assert.equal(grouped[1].evidence.occurrences, undefined);
  });
});
