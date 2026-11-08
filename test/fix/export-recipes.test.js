import '../helpers/hermetic-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildScanReportV2 } from '../../src/reporter/report-v2.js';
import { buildTaskSet, writeTaskSet } from '../../src/fix/export/tasks.js';
import { accessibleColor, addAttrToLine, fillRecipe, isDesignLocked, ratioOf, recipeFor } from '../../src/fix/export/recipes.js';
import { renderRules } from '../../src/fix/export/rules.js';

const ctx = { generatedAt: '2026-10-27T00:00:00.000Z', producer: { name: 'ada-scan', version: '1.0.1' }, target: { mode: 'url-only', url: 'https://site-001.example.test/' } };
const run = { layer: 'axe', engine: { name: 'axe-core', version: '4.12.1' }, status: 'complete' };
const at = (file, line) => ({ file, line, confidence: 'high', mode: 'local', method: 'marker' });
const v = (ruleId, html, selector, source, over = {}) => ({
  ruleId, layer: 'axe', impact: 'serious', verdict: 'confirmed', wcagRef: 'wcag2a, wcag412', element: { selector, outerHTML: html },
  fix: { hint: `Help text for ${ruleId}` }, source, evidence: { failureSummary: `Fix any of the following: measured for ${ruleId}` }, ...over,
});

const HEADER = 'src/partials/layout/header.liquid';
const files = {
  [HEADER]: ['<header>', '  <div class="bar">', '    <nav id="footer-navigation" class="links">', '      <a href="/jobs">Jobs</a>', '    </nav>',
    '    <button class="hamburger"><span class="bar"></span></button>', '    <button type="button" class="sub-menu-toggle" aria-label="Toggle Products submenu">', '    <a href="https://www.linkedin.com/company/x"><svg aria-hidden="true"></svg></a>', '  </div>', '</header>'],
  'src/partials/layout/head.liquid': ['<head>', '  <title>Site</title>', '  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">', '</head>'],
  'src/partials/cards/card.liquid': ['<ul>', '{% for card in cards %}', '  <li><div id="panel" class="p">{{ card.text }}</div></li>', '{% endfor %}', '</ul>'],
  'src/partials/cards/cta.liquid': ['<p>x</p>', '<a class="btn" aria-label="Submit your application">Apply</a>', '<span class="chip text-muted">Hello</span>', '<a class="tiny" href="/x">i</a>'],
  'src/layouts/base.liquid': ['<!doctype html>', '<html lang="en">', '<body>', '  {% render "layout/header" %}', '  <main>{% block content %}{% endblock %}</main>', '</body>', '</html>'],
};
const root = mkdtempSync(path.join(tmpdir(), 'ada-recipes-src-'));
for (const [f, lines] of Object.entries(files)) { mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); writeFileSync(path.join(root, f), lines.join('\n')); }

const proofDisclosure = { proof: { type: 'measured-fact', fact: 'activating the control changed div: before not visible, after visible; the click handler lives in src/scripts/menu.js' } };
const pages = ['/', '/about', '/jobs'];
const mk = (route) => ({
  name: route, page: route, url: `https://site-001.example.test${route}`, scannerRuns: [run],
  violations: [
    v('button-name', '<button class="hamburger"><span class="bar"></span></button>', '.hamburger', at(HEADER, 6), { impact: 'critical' }),
    v('multiple-navs-missing-labels', '<nav id="footer-navigation" class="links"><a href="/jobs">Jobs</a></nav>', '#footer-navigation', at(HEADER, 3)),
    v('disclosure-missing-aria-expanded', '<button type="button" class="sub-menu-toggle" aria-label="Toggle Products submenu"></button>', 'li:nth-of-type(3)>button', at(HEADER, 7), { evidence: proofDisclosure }),
    v('link-name', '<a href="https://www.linkedin.com/company/x"><svg aria-hidden="true"></svg></a>', 'a.social', at(HEADER, 8)),
    v('meta-viewport', '<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">', 'meta', at('src/partials/layout/head.liquid', 3), { impact: 'critical' }),
    v('duplicate-id-referenced', '<div id="panel" class="p">x</div>', '#panel', at('src/partials/cards/card.liquid', 3)),
    v('label-content-name-mismatch', '<a class="btn" aria-label="Submit your application">Apply</a>', 'a.btn', at('src/partials/cards/cta.liquid', 2), { evidence: { visibleText: 'Apply', accessibleName: 'Submit your application' } }),
    v('color-contrast', '<span class="chip text-muted">Hello</span>', 'span.chip', at('src/partials/cards/cta.liquid', 3), { evidence: { failureSummary: 'Element has insufficient color contrast of 2.85:1 (foreground color: #999999, background color: #ffffff, font size: 12pt). Expected contrast ratio of 4.5:1' } }),
    v('TargetSize', '<a class="tiny" href="/x">i</a>', 'a.tiny', at('src/partials/cards/cta.liquid', 4), { evidence: { proof: { type: 'measured-fact', fact: '20 x 18 at viewport 1280x800, nearest neighbour distance 4px' } } }),
    v('skip-link-missing', '', '', { file: null, line: null, confidence: 'none', mode: 'local', method: 'none' }, { impact: 'moderate', evidence: { message: 'No skip navigation link among the first 10 focusable elements', proof: { type: 'measured-fact', fact: '5 header/nav stops come before the content' } } }),
    v('zz-unknown-widget-rule', '<div class="w"></div>', '.w', at('src/partials/cards/cta.liquid', 1), { fix: { hint: 'Widgets need a name' }, evidence: { message: 'Widget has no name' } }),
  ],
});
const report = buildScanReportV2(pages.map(mk), ctx);
const taskOf = (set, rule) => set.tasks.find((t) => t.rule === rule);
const out = () => mkdtempSync(path.join(tmpdir(), 'ada-recipes-out-'));
const render = (set, rule, opts) => readFileSync(path.join(writeTaskSet(set, out(), opts).dir, `${taskOf(set, rule).fileBase}.md`), 'utf8');

test('every generated text is free of em and en dashes and has the five sections', () => {
  const set = buildTaskSet(report, { sourceRoot: root });
  const dir = writeTaskSet(set, out()).dir;
  for (const name of readdirSync(dir)) {
    const text = readFileSync(path.join(dir, name), 'utf8');
    assert.doesNotMatch(text, /[\u2013\u2014]/, name);
    if (name !== 'INDEX.md' && name.endsWith('.md')) for (const h of ['## Where', '## Evidence', name.startsWith('color-contrast') ? '## For the design owner' : '## Fix', '## Do not', '## Verify']) assert.ok(text.includes(h), `${name} has ${h}`);
  }
});

test('button-name: filled recipe and a proposed diff on the real line, not the generic Close dialog example', () => {
  const set = buildTaskSet(report, { sourceRoot: root });
  const md = render(set, 'button-name');
  assert.match(md, /aria-label="Menu"/);
  assert.doesNotMatch(md, /Close dialog/);
  assert.match(md, /### Proposed change|## Fix[\s\S]*Proposed change/);
  assert.match(md, /^-    <button class="hamburger"><span class="bar"><\/span><\/button>$/m);
  assert.match(md, /^\+    <button class="hamburger" aria-label="Menu"><span class="bar"><\/span><\/button>$/m);
  assert.match(md, /Rule `button-name`|rule `button-name` no longer reported on pages \/, \/about, \/jobs for selector pattern `\.hamburger`/);
  assert.match(md, /ids listed in the `button-name-sha256-[0-9a-f]+\.json` sidecar/);
});

test('acceptance criteria are compact: no sha256 id is repeated in the markdown, ids stay in the JSON', () => {
  const set = buildTaskSet(report, { sourceRoot: root });
  const dir = writeTaskSet(set, out()).dir;
  const t = taskOf(set, 'button-name');
  const md = readFileSync(path.join(dir, `${t.fileBase}.md`), 'utf8');
  assert.equal((md.match(/sha256:[0-9a-f]{64}/g) || []).length, 1);
  assert.equal(JSON.parse(readFileSync(path.join(dir, `${t.fileBase}.json`), 'utf8')).ids.length, 3);
});

test('meta-viewport: removes user-scalable=no and maximum-scale below 5 on the head line', () => {
  const md = render(buildTaskSet(report, { sourceRoot: root }), 'meta-viewport');
  assert.match(md, /^\+  <meta name="viewport" content="width=device-width, initial-scale=1">$/m);
  assert.match(md, /Let users zoom: remove `user-scalable=no` and any `maximum-scale` below 5/);
});

test('disclosure: aria-expanded added, the toggle script named from the proof', () => {
  const md = render(buildTaskSet(report, { sourceRoot: root }), 'disclosure-missing-aria-expanded');
  assert.match(md, /aria-expanded="false" aria-controls="<panel id>"/);
  assert.match(md, /edit `src\/scripts\/menu\.js`/);
  assert.match(md, /^\+    <button type="button" class="sub-menu-toggle" aria-label="Toggle Products submenu" aria-expanded="false" aria-controls="<panel id>">$/m);
  assert.doesNotMatch(md, /^## Fix\n\n.*opens and closes content but has no aria-expanded/m);
});

test('multiple navs: label from the nav id (advisory, so only with includeNeedsReview); link-name: label from the social host', () => {
  const set = buildTaskSet(report, { sourceRoot: root, includeNeedsReview: true });
  assert.match(render(set, 'multiple-navs-missing-labels'), /aria-label="Footer"/);
  assert.match(render(set, 'link-name'), /aria-label="LinkedIn"/);
});

test('an unlabeled-navs finding is advisory: not an exported task by default', () => {
  assert.equal(buildTaskSet(report, { sourceRoot: root }).tasks.some((t) => t.rule === 'multiple-navs-missing-labels'), false);
});

test('duplicate id in a for-loop: forloop.index and the sidecar caution', () => {
  const md = render(buildTaskSet(report, { sourceRoot: root }), 'duplicate-id-referenced');
  assert.match(md, /id="panel-\{\{ forloop\.index \}\}"/);
  assert.match(md, /\{% for card in cards %\}/);
  assert.match(md, /src\/partials\/cards\/card\.liquid\.json/);
  assert.match(md, /Never hard-code an id inside a loop/);
});

test('label in name: the label starts with the visible text', () => {
  const md = render(buildTaskSet(report, { sourceRoot: root }), 'label-content-name-mismatch');
  assert.match(md, /aria-label="Apply: Submit your application"/);
  assert.match(md, /start with the visible text "Apply"/);
});

test('color contrast is a design decision: no colour edit, no diff, own INDEX section, nearest colour for information only', () => {
  const set = buildTaskSet(report, { sourceRoot: root });
  const t = taskOf(set, 'color-contrast');
  assert.equal(t.requiresDesignDecision, true);
  assert.equal(t.proposedChange, null);
  assert.equal(t.fix.before, null);
  const md = render(set, 'color-contrast');
  assert.match(md, /## For the design owner/);
  assert.match(md, /Current ratio: 2\.85:1/);
  assert.match(md, /Required ratio: 4\.5:1/);
  assert.match(md, /For information only, nearest passing colour in the same hue: #757575 \(4\.61:1 on #ffffff\); not applied, design decision/);
  assert.match(md, /Could this text be set as large text in the design/);
  assert.match(md, /Never change colour values, tokens, utility colour classes, opacity or background images/);
  assert.doesNotMatch(md, /## Fix|### Proposed change|## Proposed change|```diff/);
  assert.doesNotMatch(md, /text-\[#|Replace `text-|set that token|Change token/);
  const index = readFileSync(path.join(writeTaskSet(set, out()).dir, 'INDEX.md'), 'utf8');
  const [work, design] = index.split('## Design decisions (do not change colours)');
  assert.ok(!work.split('## Tasks')[1].includes('color-contrast'));
  assert.match(design.split('## By file')[0], /`color-contrast`/);
  assert.ok(!design.split('## By file')[1].includes('color-contrast'));
  assert.match(index, /Tasks under "Design decisions \(do not change colours\)" are not yours to fix/);
  assert.match(index, /Never change colour values, tokens, utility colour classes, opacity or background images to fix a contrast finding/);
  assert.equal(isDesignLocked('focus-indicator-low-contrast') && isDesignLocked('pixel-contrast') && !isDesignLocked('button-name'), true);
  assert.equal(isDesignLocked('some-rule', { tokens: { fg: { token: 'brand-primary' } } }), true);
  assert.equal(recipeFor('focus-indicator-low-contrast') === recipeFor('color-contrast'), true);
});

test('design-locked tasks stay out of --group-by-file combined files', () => {
  const set = buildTaskSet(report, { sourceRoot: root });
  const dir = writeTaskSet(set, out(), { groupByFile: true }).dir;
  const g = set.byFile.find((x) => x.file === 'src/partials/cards/cta.liquid');
  assert.ok(!g.tasks.some((t) => t.rule === 'color-contrast'));
  assert.ok(readdirSync(dir).some((n) => n.startsWith('color-contrast-')));
});

test('TargetSize: measured size, px utilities, spacing caution', () => {
  const md = render(buildTaskSet(report, { sourceRoot: root }), 'TargetSize');
  assert.match(md, /now 20 x 18 CSS px at viewport 1280x800; measure it at 1280x800, other widths may pass/);
  assert.match(md, /min-h-\[24px\] min-w-\[24px\]/);
  assert.match(md, /depend on the project `--spacing`/);
});

test('skip-link-missing: no source still gets the layout location by role and a complete patch', () => {
  const set = buildTaskSet(report, { sourceRoot: root });
  const t = taskOf(set, 'skip-link-missing');
  assert.equal(t.source, null);
  const md = render(set, 'skip-link-missing');
  assert.match(md, /`src\/layouts\/base\.liquid:3` \(layout: has <body>/);
  assert.match(md, /href="#main-content" class="sr-only focus:not-sr-only/);
  assert.match(md, /<main id="main-content" tabindex="-1">/);
  assert.match(md, /5 header\/nav stops come before the content/);
});

test('a rule without a recipe is marked, keeps the help text and never repeats the problem as the fix', () => {
  const md = render(buildTaskSet(report, { sourceRoot: root, includeNeedsReview: true }), 'zz-unknown-widget-rule');
  assert.match(md, /No recipe: use judgement\. Read the Evidence lines/);
  assert.doesNotMatch(md.split('## Fix')[1].split('## Do not')[0], /Widgets need a name/);
  assert.match(fillRecipe({ rule: 'zz-none', html: '', attrs: {}, evidence: [], problem: 'Bad', hint: 'Use a name', pattern: 'p' }).intent, /^No recipe: use judgement\. Rule help: Use a name$/);
  const none = fillRecipe({ rule: 'zz-none', html: '', attrs: {}, evidence: [], problem: 'Same text', hint: 'Same text', pattern: 'p' });
  assert.equal(none.recipe, false);
  assert.doesNotMatch(none.intent, /Same text/);
  assert.equal(recipeFor('TargetSize') !== null && recipeFor('VisibleTextPartOfAccessibleName') !== null && recipeFor('TabpanelLabelledBy') !== null, true);
});

test('Do not section carries the Liquid and Paradox rules', () => {
  const text = render(buildTaskSet(report, { sourceRoot: root }), 'button-name');
  for (const k of ['edit a shared partial or layout once', '.liquid.json', '{{data:..}}', 'data-pdk-*', 'Tailwind utility classes already used']) assert.ok(text.includes(k), k);
});

test('addAttrToLine refuses ambiguous or unclosed lines', () => {
  assert.equal(addAttrToLine('<button class="a">', 'button', 'x="1"'), '<button class="a" x="1">');
  assert.equal(addAttrToLine('<button><button>', 'button', 'x="1"'), null);
  assert.equal(addAttrToLine('<button class="a"', 'button', 'x="1"'), null);
  assert.equal(addAttrToLine('<img src="a.png" />', 'img', 'alt=""'), '<img src="a.png" alt="" />');
});

test('INDEX.md: summary table, By file bottom-up, prompt; deterministic output', () => {
  const set = buildTaskSet(report, { sourceRoot: root, includeNeedsReview: true });
  const o = out();
  const a = writeTaskSet(set, o).dir;
  const index = readFileSync(path.join(a, 'INDEX.md'), 'utf8');
  assert.match(index, /\| Severity \| Rule \| File \| Pages \| Occurrences \| Task \|/);
  assert.match(index, /\| critical \| `button-name` \| `src\/partials\/layout\/header\.liquid:6` \| 3: \/, \/about, \/jobs \| 3 \|/);
  assert.match(index, /## By file/);
  const section = index.slice(index.indexOf(`### \`${HEADER}\``));
  const order = [...section.slice(0, section.indexOf('###', 5) > 0 ? section.indexOf('###', 5) : undefined).matchAll(/line (\d+):/g)].map((m) => Number(m[1]));
  assert.deepEqual(order, [...order].sort((x, y) => y - x));
  assert.ok(order.length >= 4);
  const snap = () => Object.fromEntries(readdirSync(a).map((n) => [n, readFileSync(path.join(a, n), 'utf8')]));
  const first = snap();
  writeTaskSet(buildTaskSet(report, { sourceRoot: root, includeNeedsReview: true }), o);
  assert.deepEqual(snap(), first);
});

test('--group-by-file writes one combined task per source file, bottom-up, and the untraced task stays separate', () => {
  const set = buildTaskSet(report, { sourceRoot: root, includeNeedsReview: true });
  const dir = writeTaskSet(set, out(), { groupByFile: true }).dir;
  const names = readdirSync(dir);
  const g = set.byFile.find((x) => x.file === HEADER);
  assert.ok(names.includes(`${g.fileBase}.md`) && names.includes(`${g.fileBase}.json`));
  assert.ok(!names.some((n) => n.startsWith('button-name-')));
  assert.ok(names.some((n) => n.startsWith('skip-link-missing-')));
  const md = readFileSync(path.join(dir, `${g.fileBase}.md`), 'utf8');
  const lines = [...md.matchAll(/^## \d+\. Line (\d+):/gm)].map((m) => Number(m[1]));
  assert.deepEqual(lines, [8, 7, 6, 3]);
  assert.match(md, /Apply the changes in the order below \(highest line first\)/);
  assert.equal(JSON.parse(readFileSync(path.join(dir, `${g.fileBase}.json`), 'utf8')).tasks.length, 4);
  assert.match(readFileSync(path.join(dir, 'INDEX.md'), 'utf8'), new RegExp(`\\[${g.fileBase}\\.md\\]`));
});

test('rules file: project-relative path inside the project, absolute with a note outside, Liquid rules present', () => {
  const inside = renderRules('cursor', { tasksDir: '.ada-scan/tasks', url: 'https://site-001.example.test/' });
  assert.match(inside, /Read `\.ada-scan\/tasks\/INDEX\.md`\. Use "By file"/);
  assert.doesNotMatch(inside, /an absolute path on purpose/);
  assert.match(inside, /forloop\.index/);
  assert.match(inside, /Never change colour values, tokens, utility colour classes, opacity or background images to fix a contrast finding/);
  const outside = renderRules('cursor', { tasksDir: '/var/tmp/example/tasks', url: null });
  assert.match(outside, /`\/var\/tmp\/example\/tasks\/INDEX\.md` \(an absolute path on purpose/);
  assert.doesNotMatch(`${inside}${outside}`, /[\u2013\u2014]/);
});

// ---- generators: likely locations per rule, loop claims only for the element's own line, the real rescan command
const mkRoot = (fs) => { const r = mkdtempSync(path.join(tmpdir(), 'ada-gen-src-')); for (const [f, lines] of Object.entries(fs)) { mkdirSync(path.dirname(path.join(r, f)), { recursive: true }); writeFileSync(path.join(r, f), lines.join('\n')); } return r; };
const pgOf = (route, violations) => ({ name: route, page: route, url: `https://site-001.example.test${route}`, scannerRuns: [run], violations });
const mdOf = (set, ruleSlug) => { const d = mkdtempSync(path.join(tmpdir(), 'ada-gen-out-')); const { dir } = writeTaskSet(set, d); return readFileSync(path.join(dir, readdirSync(dir).find((f) => f.startsWith(ruleSlug) && f.endsWith('.md'))), 'utf8'); };

test('page-wide tasks list the role files of their own rule and every page template; the h1 task never talks about a skip link', () => {
  const r = mkRoot({
    'src/layouts/base.liquid': ['<!doctype html>', '<html lang="en">', '<body>', '<main>{% block content %}{% endblock %}</main>', '</body>', '</html>'],
    'src/pages/index.liquid': ['{% layout "base" %}', '<h2>Hi</h2>'], 'src/pages/about.liquid': ['<h2>About</h2>'], 'src/pages/contact.liquid': ['<h2>C</h2>'], 'src/pages/jobs/index.liquid': ['<h2>J</h2>'],
  });
  const routes = ['/', '/about', '/contact', '/jobs'];
  const report = buildScanReportV2(routes.map((rt) => pgOf(rt, [v('page-has-heading-one', '<html lang="en">', 'html', undefined), v('skip-link-missing', '<body>', 'body', undefined)])), ctx);
  const set = buildTaskSet(report, { sourceRoot: r });
  const h1 = set.tasks.find((t) => t.rule === 'page-has-heading-one'), skip = set.tasks.find((t) => t.rule === 'skip-link-missing');
  assert.deepEqual(h1.locateManually.likely.map((l) => l.file).sort(), ['src/pages/about.liquid', 'src/pages/contact.liquid', 'src/pages/index.liquid', 'src/pages/jobs/index.liquid']);
  assert.ok(skip.locateManually.likely.some((l) => l.file === 'src/layouts/base.liquid' && /skip link directly after it/.test(l.role)));
  assert.ok(skip.locateManually.likely.every((l) => !l.file.startsWith('src/pages/') || /<main>/.test(readFileSync(path.join(r, l.file), 'utf8'))), 'page templates only where they play a role');
  assert.doesNotMatch(mdOf(set, 'page-has-heading-one'), /skip link/);
  assert.match(mdOf(set, 'skip-link-missing'), /skip link directly after it/);
});

test('loop claims: only when the traced line holds the element; a loop opened after the element on the same line does not count', () => {
  const r = mkRoot({ 'src/partials/n.liquid': ['<nav id="mobile-navigation" aria-hidden="true">', '{% for l in links %}', '  <a id="lnk" href="{{ l.url }}">x</a>', '{% endfor %}', '</nav>', '<ul id="u">{% for i in xs %}<li id="li">{{ i }}</li>{% endfor %}</ul>'] });
  const dup = (selector, html, line) => v('duplicate-id', html, selector, at('src/partials/n.liquid', line));
  const sets = (selector, html, line) => buildTaskSet(buildScanReportV2([pgOf('/', [dup(selector, html, line)])], ctx), { sourceRoot: r });
  // the report points at the <a> line (3) but the element is the nav: no loop claim, and the task says the trace may be off
  const off = sets('#mobile-navigation', '<nav id="mobile-navigation" aria-hidden="true">', 3);
  assert.doesNotMatch(mdOf(off, 'duplicate-id'), /sits inside/);
  assert.equal(off.tasks[0].source.elementOnLine, false);
  // the element itself is in the loop (real shape): still claimed
  assert.match(mdOf(sets('#lnk', '<a id="lnk" href="x">', 3), 'duplicate-id'), /sits inside `\{% for l in \.\.\. %\}`/);
  // <ul> on the same line as a later loop is not inside it, the <li> after the for is
  assert.doesNotMatch(mdOf(sets('#u', '<ul id="u">', 6), 'duplicate-id'), /sits inside/);
  assert.match(mdOf(sets('#li', '<li id="li">', 6), 'duplicate-id'), /sits inside `\{% for i in \.\.\. %\}`/);
});

test('exported rescan commands use a real flag', () => {
  const rules = renderRules('claude', { tasksDir: '.ada-scan/tasks', url: 'https://site-001.example.test/' });
  const md = mdOf(buildTaskSet(buildScanReportV2([pgOf('/', [v('image-alt', '<img>', 'img', at(HEADER, 3))])], ctx), { sourceRoot: root }), 'image-alt');
  for (const text of [rules, md]) { assert.doesNotMatch(text, /--baseline-compare/); assert.match(text, /ada-scan --url https:\/\/site-001\.example\.test\//); }
});
