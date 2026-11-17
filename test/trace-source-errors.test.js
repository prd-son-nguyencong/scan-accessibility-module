import './helpers/hermetic-env.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evalRows, loadRows, traceRow } from '../scripts/lib/trace-eval.js';

const FIX = fileURLToPath(new URL('./fixtures/trace-eval/', import.meta.url));
const SITE = join(FIX, 'site-A');
const temps = [];
after(() => temps.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** A scratch copy of the fixture site with some files replaced. */
function variant(files = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ada-trace-err-'));
  temps.push(root);
  cpSync(SITE, root, { recursive: true });
  for (const [rel, body] of Object.entries(files)) { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), body); }
  return root;
}
const row = (rows, id) => rows.find((r) => r.id === id);
const at = (v) => `${v.source.file}:${v.source.line}`;

test('labelled rows: the traced source is the location a developer must edit (>= 85% strict, here all)', async () => {
  const rows = loadRows(join(FIX, 'rows.json'));
  const report = await evalRows(rows, { 'site-A': SITE });
  const wrong = report.rows.filter((r) => !r.strict).map((r) => `${r.id} ${r.rule} ${r.got}`);
  assert.deepEqual(wrong, []);
  assert.ok(report.strict / report.total >= 0.85);
  assert.ok(report.rows.filter((r) => r.rule === 'multiple-navs-missing-labels').every((r) => r.alsoOk), 'the second unlabelled nav is listed as a candidate');
});

test('class 1: a nested <main> blames the inner partial; a single <main> keeps the page anchor (paired)', async () => {
  const rows = loadRows(join(FIX, 'rows.json'));
  const nested = await traceRow(row(rows, 'r01'), SITE);
  assert.equal(at(nested), 'src/partials/jobs/list.liquid:1');
  assert.equal(nested.source.confidence, 'medium');
  const single = variant({ 'src/partials/jobs/list.liquid': '<section class="jobs-page">\n<h1>Open roles</h1>\n</section>\n' });
  const v = await traceRow(row(rows, 'r03'), single);
  assert.equal(at(v), 'src/pages/index.liquid:3');
  assert.equal(v.source.method, 'page-level-anchor');
});

test('class 1: unlabelled navs are blamed on the partial that writes them; labelled navs keep the page anchor (paired)', async () => {
  const rows = loadRows(join(FIX, 'rows.json'));
  const v = await traceRow(row(rows, 'r08'), SITE);
  assert.equal(at(v), 'src/partials/layout/header.liquid:2');
  assert.deepEqual(v.sourceCandidates.map((c) => `${c.file}:${c.line}`), ['src/partials/layout/header.liquid:5']);
  const labelled = variant({ 'src/partials/layout/header.liquid': '<header>\n<nav aria-label="Main"><a href="/a">A</a></nav>\n<nav aria-labelledby="m"><a href="/b">B</a></nav>\n</header>\n' });
  const w = await traceRow(row(rows, 'r08'), labelled);
  assert.equal(w.source.method, 'page-level-anchor');
  assert.ok(!w.source.file.includes('header.liquid'));
});

test('class 2: a role only a script sets is blamed on the script line, the markup stays as templateSource; a role the template writes is not (paired)', async () => {
  const rows = loadRows(join(FIX, 'rows.json'));
  const v = await traceRow(row(rows, 'r14'), SITE);
  assert.equal(at(v), 'src/scripts/team-slides.js:6');
  assert.equal(v.source.method, 'script-sets-attribute');
  assert.deepEqual(v.source.templateSource, { file: 'src/partials/team/slides.liquid', line: 3 });
  const authored = variant({ 'src/partials/team/slides.liquid': '<section id="team">\n  {% for s in slides %}\n  <article class="team-slide" data-slide role="button" aria-label="Show slide">\n    <p>{{ s.title }}</p>\n  </article>\n  {% endfor %}\n</section>\n' });
  const w = await traceRow(row(rows, 'r14'), authored);
  assert.notEqual(w.source.method, 'script-sets-attribute');
  assert.equal(w.source.file, 'src/partials/team/slides.liquid');
});

test('class 2: a contrast failure names the template line and the token that declares the colour; a colour with no token gets none (paired)', async () => {
  const rows = loadRows(join(FIX, 'rows.json'));
  const v = await traceRow(row(rows, 'r17'), SITE);
  assert.equal(at(v), 'src/pages/detail.liquid:6');
  assert.deepEqual(v.source.tokenSource, { file: 'src/styles/tailwind.css', line: 3, token: '--color-muted' });
  assert.ok(v.sourceCandidates.some((c) => c.method === 'css-token' && c.line === 3));
  const none = variant({ 'src/styles/tailwind.css': '@theme {\n  --color-surface: #ffffff;\n}\n' });
  const w = await traceRow(row(rows, 'r17'), none);
  assert.equal(at(w), 'src/pages/detail.liquid:6');
  assert.equal(w.source.tokenSource, undefined);
});

test('class 3: look-alike markup elsewhere is not chosen: a colour utility the other tag lacks and the selector ancestry decide; an unresolvable tie lists candidates (paired)', async () => {
  const rows = loadRows(join(FIX, 'rows.json'));
  assert.equal(at(await traceRow(row(rows, 'r19'), SITE)), 'src/partials/journey/intro.liquid:2');
  const hero = await traceRow(row(rows, 'r20'), SITE);
  assert.equal(at(hero), 'src/partials/home/hero.liquid:3');
  assert.equal(hero.source.method, 'liquid-tag-index+ancestry');
  // Both partials now carry the same markup under the same ancestry: nothing proves one, so neither is claimed.
  const twin = variant({ 'src/partials/journey/early.liquid': '<section id="early" class="relative">\n  <p class="text-button font-bold text-white">Working at Acme</p>\n</section>\n' });
  const tie = await traceRow(row(rows, 'r19'), twin);
  assert.equal(tie.source.confidence, 'low');
  assert.equal(tie.source.traceConfidence, 'ambiguous');
  assert.deepEqual(tie.sourceCandidates.map((c) => `${c.file}:${c.line}`).sort(), ['src/partials/journey/early.liquid:2', 'src/partials/journey/intro.liquid:2']);
});

test('class 3: a partial the page does not render is never a candidate', async () => {
  const rows = loadRows(join(FIX, 'rows.json'));
  const stray = variant({ 'src/partials/journey/unused.liquid': '<section id="intro">\n  <p class="text-button font-bold text-white">Working at Acme</p>\n</section>\n' });
  assert.equal(at(await traceRow(row(rows, 'r19'), stray)), 'src/partials/journey/intro.liquid:2');
});

test('class 2: an image without alt goes to the partial that omits alt, not to the sibling with alt=""', async () => {
  const rows = loadRows(join(FIX, 'rows.json'));
  const v = await traceRow(row(rows, 'r22'), SITE);
  assert.equal(at(v), 'src/partials/cards/finding.liquid:4');
  const sibling = variant({ 'src/partials/cards/finding.liquid': '<section>\n{% for item in cards %}\n<a href="{{ item.link }}">\n<img src="{{ item.image }}" alt="">\n</a>\n{% endfor %}\n</section>\n' });
  const w = await traceRow(row(rows, 'r21'), sibling);
  assert.equal(w.source.method, 'page-level-anchor', 'no alt-less image in the tree: only the page anchor remains');
});

test('class 4: data values live in the sidecar line; same-file duplicates point at the first line, never null', async () => {
  const rows = loadRows(join(FIX, 'rows.json'));
  const img = await traceRow(row(rows, 'r23'), SITE);
  assert.equal(img.source.dataFile, 'src/partials/cards/finding.liquid.json');
  assert.equal(img.source.dataLine, 4);
  const link = await traceRow(row(rows, 'r24'), SITE);
  assert.equal(at(link), 'src/pages/links.liquid:4');
  assert.equal(link.source.confidence, 'low');
  assert.deepEqual(link.sourceCandidates.map((c) => c.line), [4, 5]);
  const alt = variant({
    'src/partials/cards/finding.liquid': '<section>\n{% for item in cards %}\n<img src="{{ item.image }}" alt="{{ item.alt }}" aria-label="{{ item.label }}">\n{% endfor %}\n</section>\n',
    'src/partials/cards/finding.liquid.json': '{\n  "cards": [\n    { "image": "/a.webp", "alt": "Team at work", "label": "Open team photo" }\n  ]\n}\n',
  });
  const hit = await traceRow({ id: 'x', route: '/cards', rule: 'image-alt', html: '<img src="/a.webp" alt="Team at work" aria-label="Open team photo">' }, alt);
  assert.equal(hit.source.dataFile, 'src/partials/cards/finding.liquid.json');
  assert.equal(hit.source.dataLine, 3);
});

test('class 4: a render-call element is told apart by its stamped arguments (the sibling call with another link is ruled out)', async () => {
  const rows = loadRows(join(FIX, 'rows.json'));
  const v = await traceRow(row(rows, 'r25'), SITE);
  assert.equal(at(v), 'src/partials/rewards/offer.liquid:4');
  const other = variant({ 'src/partials/rewards/offer.liquid': "<section>\n{% render 'button', type: 'secondary', text: 'Total Rewards', link: '/else' %}\n</section>\n" });
  const w = await traceRow(row(rows, 'r25'), other);
  assert.notEqual(w.source.file, 'src/partials/rewards/offer.liquid');
});

test('modal without focus trap is blamed on the dialog its trigger controls', async () => {
  const rows = loadRows(join(FIX, 'rows.json'));
  assert.equal(at(await traceRow(row(rows, 'r26'), SITE)), 'src/partials/awards/overlay.liquid:5');
});
