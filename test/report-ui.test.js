import './helpers/hermetic-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildHtml } from '../src/reporter/html.js';
import { projectReportV1 } from '../src/reporter/report-v2.js';
import { buildModel } from '../src/reporter/ui/model.js';
import { pack, safeJson, wbr, inline } from '../src/reporter/ui/render.js';
import { buildFixtureReport, unpackData } from './helpers/report-ui-fixture.mjs';

const report = buildFixtureReport();
const html = buildHtml(report);
const data = () => unpackData(html);

test('document skeleton: language, title, skip link first, landmarks, one h1', () => {
  assert.match(html, /^<!DOCTYPE html>\s*<html lang="en">/);
  assert.match(html, /<title>Scan report: example\.test/);
  assert.ok(html.indexOf('class="skip"') < html.indexOf('<header'));
  assert.match(html, /<header class="top">[\s\S]*<nav class="nav" aria-label="Report sections">/);
  assert.match(html, /<main id="main" tabindex="-1">/);
  assert.match(html, /<footer class="foot">/);
  assert.equal((html.match(/<h1[ >]/g) || []).length, 1);
  assert.match(html, /<meta name="viewport" content="width=device-width,initial-scale=1">/);
});

test('CSP hash matches the one inline script; no inline handlers, remote loads or web fonts', () => {
  const policy = /Content-Security-Policy" content="([^"]+)"/.exec(html)[1];
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.equal(scripts.length, 2);
  for (const body of scripts) assert.ok(policy.includes(`'sha256-${createHash('sha256').update(body).digest('base64')}'`));
  const script = scripts[1];
  const markup = html.replace(/<script[^>]*>[\s\S]*?<\/script>/g, '').replace(/<style>[\s\S]*?<\/style>/g, '');
  assert.doesNotMatch(markup.replace(/="[^"]*"/g, '=""'), /<[^>]*\son[a-z]+\s*=/i);
  assert.doesNotMatch(html, /https?:\/\/(?!www\.w3\.org|example\.test|cdn\.vendor-a)[^"'\s<)]*\.(?:woff2?|ttf|otf|css|js)\b/i);
  assert.doesNotMatch(html.match(/<style>([\s\S]*?)<\/style>/)[1], /@import|url\(\s*["']?https?:|@font-face/);
  assert.doesNotMatch(script, /innerHTML|insertAdjacentHTML|eval\(|new Function|document\.write/);
});

test('overview: verdict, why the gate failed, the three-way split and the fix-first list', () => {
  assert.match(html, /class="state state-fail">Quality gate failed</);
  assert.match(html, /Only confirmed findings fail the gate/);
  assert.match(html, /Why it failed:/);
  const m = buildModel(report);
  assert.equal(m.counts.fix + m.counts.review + m.counts.theirs, m.counts.total);
  assert.deepEqual([m.counts.fix, m.counts.review, m.counts.theirs], [5, 3, 2]);
  // a critical shared root cause (button-name on two pages) ranks before the serious contrast finding
  assert.equal(m.fixFirst[0].rule, 'button-name');
  assert.equal(m.fixFirst[0].occ, 2);
  assert.match(html, /<ol class="rank">/);
  assert.match(html, /data-view="b=review"/);
});

test('every finding is in the embedded data with source, selector, proof and owner', () => {
  const d = data();
  assert.equal(d.f.length, report.pages.reduce((n, p) => n + p.findings.length, 0));
  const contrast = d.f.find((f) => f.r === 'color-contrast');
  assert.deepEqual([contrast.s.f, contrast.s.l, contrast.o, contrast.v], ['src/partials/layout/footer.liquid', 17, 'site', 'confirmed']);
  assert.match(contrast.pr[0].fact, /contrast ratio 2\.9:1/);
  const unresolved = d.f.find((f) => f.r === 'target-size');
  assert.ok(!unresolved.s || !unresolved.s.f, 'unresolved source stays empty so the UI says "locate manually"');
  assert.deepEqual(d.f.filter((f) => f.o !== 'site').map((f) => f.o).sort(), ['platform', 'third-party', 'unbound', 'unknown']);
  assert.ok(d.f.some((f) => f.lk && f.lk.st === 403));
  assert.equal(d.p.length, report.pages.length);
});

test('sections: not your code per vendor, coverage reasons, links grouped by target, performance, run details', () => {
  assert.match(html, /<h2 id="h-nyc"><svg[^>]*>.*?<\/svg> Not your code \(2\)<\/h2>/);
  assert.match(html, /Third party: vendor-a/);
  assert.match(html, /Paradox React widget: JobList/);
  assert.match(html, /Failed \(1\)[\s\S]*not scanned \(HTTP 500\)/);
  assert.match(html, /Skipped \(1\)[\s\S]*empty template, platform-managed\?/);
  assert.match(html, /Dropped routes \(1\)[\s\S]*ghost[\s\S]*HTTP 404/);
  assert.match(html, /Incomplete scan\.<\/strong> A clean total is not a pass/);
  assert.match(html, /id="h-links">Links<[\s\S]*blocked-unverifiable/);
  assert.match(html, /Redirect chain/);
  assert.match(html, /<h3 class="sub">Mobile <span class="muted">412x823<\/span>/);
  assert.match(html, /Largest Contentful Paint|LCP/);
  assert.match(html, /id="h-run">Run details/);
  assert.match(html, /ada-scan 1\.0\.1/);
});

test('toolbar controls are labelled, the list is a live region target and shortcuts are documented', () => {
  assert.match(html, /<label class="sr" for="q">/);
  for (const id of ['f-v', 'f-o', 'f-i', 'f-L', 'f-r', 'f-p', 'f-s', 'f-g', 'f-src']) assert.match(html, new RegExp(`<label[^>]*>(?:<span>[^<]*</span>)?<select id="${id}"|<input type="checkbox" id="${id}"`));
  assert.match(html, /id="live" role="status" aria-live="polite"/);
  assert.match(html, /<dialog id="help" aria-labelledby="help-h">/);
  assert.match(html, /<kbd>j<\/kbd> <kbd>k<\/kbd>/);
  assert.match(html, /<noscript>/);
});

test('small: the fixture report stays far below the size budget', () => {
  assert.ok(Buffer.byteLength(html) < 120 * 1024, `${Buffer.byteLength(html)} bytes`);
});

test('pack / safeJson round-trip, escape "~" literals and never emit a script terminator', () => {
  const sample = { a: ['repeated string value', 'repeated string value', 'repeated string value'], b: '~tilde first', c: '</script><!-- <script>', d: "x');alert(1);('" };
  const { t, d } = pack(sample);
  assert.ok(t.includes('repeated string value'));
  const json = safeJson({ t, d });
  assert.doesNotMatch(json, /<\/script|<!--|<script/i);
  assert.ok(!json.includes("x');"));
  const back = JSON.parse(json);
  assert.equal(back.d.c, '</script><!-- <script>');
  assert.equal(back.d.b, '~~tilde first');
});

test('wbr only adds break opportunities after path punctuation and camelCase boundaries', () => {
  assert.equal(wbr('src/a-b.liquid'), 'src/<wbr>a-<wbr>b.<wbr>liquid');
  assert.equal(wbr('LinkOpensNewWindow'), 'Link<wbr>Opens<wbr>New<wbr>Window');
  assert.equal(wbr('a<b'), 'a&lt;b');
});

test('the legacy projection (older callers) renders the same findings', () => {
  const legacy = projectReportV1(report);
  const a = buildModel(legacy); const b = buildModel(report);
  assert.equal(a.findings.length, b.findings.length);
  assert.deepEqual(a.counts, b.counts);
  assert.match(buildHtml({ ...legacy, lighthouse: {} }), /Quality gate failed/);
  assert.equal(buildModel({ ...legacy, v2: report }).findings.length, b.findings.length);
});

test('an empty scan says so without claiming a pass', () => {
  const empty = buildHtml({ timestamp: '2026-10-28T00:00:00.000Z', pages: [{ name: 'p', url: 'http://x.test/', violations: [] }], lighthouse: {} });
  assert.match(empty, /No automated issues found\. Manual review is still required\./);
  assert.doesNotMatch(empty, /Great job|All clear/);
});

const css = html.match(/<style>([\s\S]*?)<\/style>/)[1];
const block = (re) => Object.fromEntries([...css.match(re)[1].matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)].map(([, k, v]) => [k, v.trim()]));
const light = block(/:root, :root\[data-theme="light"\] \{([\s\S]*?)\n\}/);
const dark = block(/\n:root\[data-theme="dark"\] \{([\s\S]*?)\n\}/);
const common = block(/^:root \{([\s\S]*?)\n\}/m); // band colours are the same in both themes
Object.assign(light, common); Object.assign(dark, common);
const rgb = (v) => { if (v.startsWith('#')) { const n = parseInt(v.slice(1), 16); return [n >> 16, (n >> 8) & 255, n & 255, 1]; } const m = /rgba\((\d+), (\d+), (\d+), ([\d.]+)\)/.exec(v); return [+m[1], +m[2], +m[3], +m[4]]; };
const over = (top, bottom) => { const [r, g, b, a] = rgb(top); const bg = rgb(bottom); return [0, 1, 2].map((i) => [r, g, b][i] * a + bg[i] * (1 - a)); };
const channel = (v) => (v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
const lumOf = ([r, g, b]) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
/** WCAG contrast of text colour `fg` on surface `bg` (a token value; a translucent one is blended over `under`). */
const ratio = (fg, bg, under) => { const surface = bg.startsWith('rgba') ? over(bg, under) : rgb(bg).slice(0, 3); const [x, y] = [lumOf(rgb(fg).slice(0, 3)), lumOf(surface)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

test('design tokens: the Notion palette in light, the navy family in dark, both follow the system when nothing is saved', () => {
  for (const [token, value] of Object.entries({ bg: '#ffffff', surface: '#f6f5f4', 'surface-2': '#fafaf9', hair: '#e5e3df', 'hair-soft': '#ede9e4', 'btn-border': '#c8c4be', ink: '#1a1a1a', text: '#37352f', muted: '#5d5b54', primary: '#5645d4', 'primary-hover': '#4534b3', 't-peach': '#ffe8d4', 't-yellow': '#fef7d6', 't-sky': '#dcecfa', 't-mint': '#d9f3e1', 't-lav': '#e6e0f5', 't-rose': '#fde0ec', 't-gray': '#f0eeec', err: '#e03131', ok: '#1aae39', warn: '#dd5b00' })) assert.equal(light[token], value, `light ${token}`);
  for (const [token, value] of Object.entries({ bg: '#070f24', card: '#0a1530', surface: '#1a2a52', ink: '#ffffff', muted: '#a4a097' })) assert.equal(dark[token], value, `dark ${token}`);
  for (const token of Object.keys(light)) assert.ok(token in dark, `dark defines --${token}`);
  assert.match(css, /--band: #0a1530; --band-deep: #070f24; --band-mid: #1a2a52;/);
  assert.match(css, /@media \(prefers-color-scheme: dark\) \{\s*:root:not\(\[data-theme\]\)/);
  assert.match(css, /"Notion Sans", Inter, -apple-system, system-ui/);
  assert.notEqual(dark.bg, '#000000');
  assert.match(css, /--r-btn: 8px; --r-card: 12px;/);
});

test('contrast: every text pair reaches 4.5:1 and control borders 3:1 in both themes', () => {
  for (const [name, t] of [['light', light], ['dark', dark]]) {
    const check = (fg, bg, min = 4.5, under = t.card) => assert.ok(ratio(t[fg], t[bg], t[under] || under) >= min, `${name}: ${fg} on ${bg} = ${ratio(t[fg], t[bg], t[under] || under).toFixed(2)} (need ${min})`);
    for (const surface of ['bg', 'card', 'surface', 'surface-2']) for (const fg of ['ink', 'text', 'muted', 'link']) check(fg, surface);
    for (const surface of ['bg', 'card', 'surface']) { check('control', surface, 3); check('focus', surface, 3); }
    check('on-primary', 'primary'); check('on-primary', 'primary-hover');
    check('band-ink', 'band'); check('band-muted', 'band'); check('band-muted', 'band-mid');
    for (const tint of ['peach', 'yellow', 'sky', 'mint', 'lav', 'rose', 'gray']) { check('on-tint', `t-${tint}`); check(`i-${tint}`, `t-${tint}`); }
    check('err-ink', 't-rose'); check('err-ink', 'card'); check('err-ink', 'surface-2');
    check('ok-ink', 't-mint'); check('ok-ink', 'card'); check('warn-ink', 't-peach'); check('warn-ink', 'card');
    check('pill-ink', 'pill-bg');
    check('muted', 't-yellow', 4.5); check('i-gray', 'card');
  }
});

test('no em or en dash in the rendered reports, and no white page or card pretending to be dark', () => {
  for (const out of [html, buildHtml(projectReportV1(report))]) assert.doesNotMatch(out, /[–—]|&mdash;|&ndash;/);
  assert.doesNotMatch(css, /[–—]|\\2013|\\2014/);
  assert.ok(css.indexOf('--bg: #ffffff') < css.indexOf('--bg: #070f24'), 'light is the default, dark is the alternative');
});

test('theme toggle: a labelled button, a pre-paint script, a guarded storage access', () => {
  assert.match(html, /<button type="button" class="theme-toggle" id="theme-toggle" aria-label="Theme: light, switch to dark">/);
  assert.match(html, /<script>\(function\(\)\{var t;try\{t=localStorage\.getItem\('ada-report-theme'\)\}catch\(e\)\{\}/);
  assert.ok(html.indexOf("setAttribute('data-theme'") < html.indexOf('<header'), 'theme is set before the first content');
  const script = /<script>([\s\S]*?)<\/script>/g;
  for (const [, body] of html.matchAll(script)) assert.doesNotMatch(body.replace(/try\s*\{[^}]*\}\s*catch/g, ''), /localStorage/, 'every storage access sits in try/catch');
});

test('scanner text with `backticks` is shown as code, escaped, without the backticks', () => {
  const out = inline('`[user-scalable="no"]` is used in <meta>');
  assert.match(out, /^<code>\[<wbr>user-<wbr>scalable.*&quot;(?:<wbr>)?no&quot;.*<\/code> is used in &lt;meta&gt;$/);
  assert.doesNotMatch(out, /`/);
  assert.equal(inline('no code here'), 'no code here');
});
