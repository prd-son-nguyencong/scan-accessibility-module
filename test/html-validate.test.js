import './helpers/hermetic-env.mjs';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { scanHtmlValidate, validateHtml, dropW3cDuplicates, DEFAULT_HTML_VALIDATE_RULES, HTML_VALIDATE_IMPACT, htmlValidateImpact } from '../src/scanner/html-validate.js';
import { evaluateGate } from '../src/utils/thresholds.js';
import { DEFAULT_CONFIG, validateConfig } from '../src/utils/config.js';

const doc = (body) => `<!DOCTYPE html>\n<html lang="en"><head><meta charset="utf-8"><title>t</title></head><body>\n${body}\n</body></html>`;
const fakePage = (html) => ({ content: async () => html });
const scan = (body, config = {}) => scanHtmlValidate('http://localhost/x', config, { page: fakePage(doc(body)) });
const byRule = (r, rule) => r.violations.filter((v) => v.rule === `html-validate:${rule}`);

test('offline validator detects duplicate id, missing alt, unclosed element and bad nesting', async () => {
  const r = await scan('<div id="a">x</div>\n<div id="a">y</div>\n<img src="x.png">\n<ul><li>ok</li><div>no</div></ul>\n<span>unclosed');
  const dup = byRule(r, 'no-dup-id')[0];
  assert.equal(dup.description, 'Duplicate ID "a"');
  assert.equal(dup.impact, 'serious');
  assert.equal(dup.type, 'error');
  assert.equal(dup.wcagCriteria, '4.1.1');
  assert.equal(dup.line, 4); // serialized html: doctype, <html>, then body lines
  assert.match(dup.selector, /div/);
  assert.equal(dup.layer, 'htmlValidate');
  assert.equal(byRule(r, 'wcag/h37').length, 0); // axe image-alt covers it
  assert.ok(byRule(r, 'element-permitted-content').length === 1);
  assert.ok(byRule(r, 'close-order').some((v) => /Unclosed element '<span>'/.test(v.description)));
  assert.deepEqual(r.passes, []);
});

test('a clean document has no errors; warnings map to minor; config overrides rules', async () => {
  const clean = await scan('<main><h1>Hi</h1><p>text</p></main>');
  assert.deepEqual(clean.violations.filter((v) => v.type === 'error'), []);
  assert.equal(clean.passes.length, 1);

  const warn = await scan('<main><input type="text" /></main>');
  assert.equal(byRule(warn, 'void-style')[0].impact, 'minor');
  const off = await scan('<main><input type="text" /></main>', { html: { validate: { rules: { 'void-style': 'off' } } } });
  assert.equal(byRule(off, 'void-style').length, 0);
});

test('thresholds count offline findings as w3c errors and warnings', async () => {
  const r = await scan('<div id="a"></div><div id="a"></div><main><input /></main>');
  const gate = evaluateGate([{ name: 'p', url: 'u', violations: r.violations }], undefined, { layers: { w3c: false, htmlValidate: true } });
  const m = (id) => gate.pages[0].metrics.find((x) => x.id === id);
  assert.equal(m('w3c.errors').status, 'fail');
  assert.equal(m('w3c.errors').actual, r.violations.filter((v) => v.impact !== 'minor').length);
  assert.equal(m('w3c.warnings').status, 'report');
  const likely = evaluateGate([{ name: 'p', url: 'u', violations: [{ layer: 'htmlValidate', impact: 'minor', verdict: 'likely' }] }], undefined, { layers: { w3c: false, htmlValidate: true } });
  assert.equal(likely.pages[0].metrics.find((x) => x.id === 'w3c.warnings').actual, 1); // heuristic warnings still count as warnings
  const off = evaluateGate([{ name: 'p', url: 'u', violations: [] }], undefined, { layers: { w3c: false, htmlValidate: false } });
  assert.equal(off.pages[0].metrics.find((x) => x.id === 'w3c.errors').status, 'skipped');
});

test('findings Nu already reported are dropped, others kept', () => {
  const hv = [
    { fix: { hint: 'Duplicate ID "a"' }, element: { selector: 'html > body > div' } },
    { fix: { hint: 'Unclosed element' }, element: { selector: 'span' } },
  ];
  const nu = [{ fix: { hint: 'Duplicate ID “a”.' }, element: { selector: '' } }];
  assert.deepEqual(dropW3cDuplicates(hv, nu), [hv[1]]);
});

test('html.validate.rules config is validated and the layer is on by default', () => {
  assert.equal(DEFAULT_CONFIG.layers.htmlValidate, true);
  assert.deepEqual(validateConfig({ html: { validate: { rules: { 'void-style': 'off' } } } }), []);
  assert.match(validateConfig({ html: { validate: { rules: 'off' } } })[0], /html\.validate\.rules/);
  assert.equal(typeof validateHtml, 'function');
});

test('conventions are warnings, not errors; digit-first and punctuated ids are valid, whitespace is not', async () => {
  const r = await scan('<script type="text/javascript"></script><div role="button" id="606bad6c-keyword:1">x</div><div id="a b"></div><input type="text"><button>go</button>');
  assert.equal(byRule(r, 'script-type')[0].type, 'warning');
  assert.equal(byRule(r, 'prefer-native-element')[0].type, 'warning');
  assert.deepEqual(byRule(r, 'valid-id').map((v) => v.description), ['element id "a b" must not contain whitespace']);
  assert.equal(byRule(r, 'no-implicit-button-type').length + byRule(r, 'no-implicit-input-type').length, 0);
});

test('docs/html-validate-rules.md lists every preset rule with its severity', () => {
  const rows = Object.fromEntries(readFileSync(new URL('../docs/html-validate-rules.md', import.meta.url), 'utf8')
    .split('\n').map((l) => l.match(/^\| `([^`]+)` \| (error|warn|off) \|/)).filter(Boolean).map((m) => [m[1], m[2]]));
  const preset = Object.fromEntries(Object.entries(DEFAULT_HTML_VALIDATE_RULES).map(([k, v]) => [k, [].concat(v)[0]]));
  assert.deepEqual(rows, preset);
});

test('aria-label on a heading is legal (ARIA 1.2); on a generic span it is still reported; carousel region and anchor button are convention warnings', async () => {
  const ok = await scan('<main><h2 aria-label="Open roles">Roles</h2></main>');
  assert.equal(byRule(ok, 'aria-label-misuse').length, 0);
  const withId = await scan('<main><h2 id="roles" aria-label="Open roles">Roles</h2></main>');
  assert.equal(byRule(withId, 'aria-label-misuse').length, 0);
  const bad = await scan('<main><span aria-label="x">text</span></main>');
  assert.equal(byRule(bad, 'aria-label-misuse').length, 1);
  const conv = await scan('<main><a href="/x" role="button">go</a><div role="region" aria-roledescription="carousel" aria-label="c">s</div></main>');
  const prefer = byRule(conv, 'prefer-native-element');
  assert.ok(prefer.length >= 1 && prefer.every((v) => v.type === 'warning' && v.impact === 'minor'));
  assert.equal(conv.violations.filter((v) => v.type === 'error').length, 0);
});

test('docs impact table matches HTML_VALIDATE_IMPACT; every mapped rule is an error-level preset rule', () => {
  const rows = Object.fromEntries(readFileSync(new URL('../docs/html-validate-rules.md', import.meta.url), 'utf8')
    .split('\n').map((l) => l.match(/^\| `([^`]+)` \| (serious|moderate|minor) \|/)).filter(Boolean).map((m) => [m[1], m[2]]));
  assert.deepEqual(rows, HTML_VALIDATE_IMPACT);
  for (const rule of Object.keys(HTML_VALIDATE_IMPACT)) assert.equal([].concat(DEFAULT_HTML_VALIDATE_RULES[rule])[0], 'error', rule);
});

test('table-driven: an error rule reports its mapped impact, a warning is always minor, an unmapped error stays serious', () => {
  for (const [rule, impact] of Object.entries(HTML_VALIDATE_IMPACT)) assert.equal(htmlValidateImpact(rule, true), impact, rule);
  assert.equal(htmlValidateImpact('no-dup-class', false), 'minor');
  assert.equal(htmlValidateImpact('some-new-rule', true), 'serious');
});

test('bad/good: frameborder on an iframe is minor, a duplicate id is serious', async () => {
  const r = await scan('<iframe src="/x" title="t" frameborder="0"></iframe><label for="a">a</label><input id="a"><div id="a"></div>');
  assert.equal(byRule(r, 'no-deprecated-attr')[0].impact, 'minor');
  assert.ok(byRule(r, 'no-dup-id').length >= 1 && byRule(r, 'no-dup-id').every((v) => v.impact === 'serious'));
});
