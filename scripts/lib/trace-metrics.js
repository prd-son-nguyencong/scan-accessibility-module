import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { traceElement } from '../../src/tracer/trace-element.js';
import { hashSourceFiles } from '../../src/tracer/preimage.js';

const fixture = (name) => fileURLToPath(new URL(`../../test/fixtures/${name}/`, import.meta.url)).replace(/\/$/, '');
const LIQUID = fixture('paradox-site');
const SITE = fixture('trace-liquid');
const HTML = fixture('trace-html');
const REACT = fixture('trace-react');
const PAGE = 'src/pages/index.liquid';
const LIQUID_HTML = readFileSync(`${LIQUID}/pages/index.html`, 'utf8'); // local build: keeps <!-- snippets/x.html --> markers
const wrap = (name, inner) => `<!-- snippets/${name}.html -->${inner}<!-- /snippets/${name}.html -->`;
const PREVIEW = { mode: 'preview', attestation: { ok: true } };
const link = '<a href="/benefits">Benefits</a>';
const SITE_HTML = readFileSync(`${SITE}/pages/index.html`, 'utf8');

// [name, element, expected confidence, truth]. Truth lines are hand-counted in the fixture files; truth [] means the
// element is not in the source (or is platform-owned), so the only right answer is `untraceable`.
const liquid = (mode) => {
  const base = { root: LIQUID, pageFile: PAGE, pageHtml: LIQUID_HTML, mode };
  if (mode === 'local') {
    return [
      ['header link in its marker region', { outerHTML: link }, 'high', ['src/partials/header.liquid:5']],
      ['footer link in its marker region', { outerHTML: '<a href="/benefits">Benefits overview</a>' }, 'high', ['src/partials/footer.liquid:3']],
      ['page-level button, no marker owner', { outerHTML: '<button class="defect-icon-button" type="button"><svg></svg></button>' }, 'medium', [`${PAGE}:9`]],
      ['viewport meta in the layout', { outerHTML: '<meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no">' }, 'medium', ['src/layouts/layout.liquid:6']],
      ['title in the layout', { outerHTML: '<title></title>' }, 'medium', ['src/layouts/layout.liquid:5']],
      ['lazy-load data-src is not a source reference', { outerHTML: '<img class="defect-img" data-src="/pixel.svg" src="/pixel.svg" width="40" height="40">' }, 'medium', [`${PAGE}:10`]],
      ['bogus data-src on the cta link', { outerHTML: '<a class="cta-button" href="/apply" data-src="src/partials/footer.liquid:2">Apply</a>' }, 'medium', ['src/partials/cta.liquid:1']],
      ['snippet rendered twice with the same arguments', { outerHTML: '<div data-pdk-render="cta" data-pdk-param-label="&quot;Apply&quot;"></div>' }, 'ambiguous', [`${PAGE}:15`, `${PAGE}:16`]],
      // Footer source says "Benefits overview", so only the header tag can have produced this text: resolved, never `high`.
      ['same link in two marker regions, text only the header source has', { outerHTML: link, pageHtml: wrap('header', link) + wrap('footer', link) }, 'medium', ['src/partials/header.liquid:5']],
      ['class the source tag cannot produce', { outerHTML: '<p class="unrelated-class">x</p>' }, 'untraceable', []],
      ['marker names footer but no footer tag matches', { outerHTML: '<h3 class="nope">x</h3>', pageHtml: wrap('footer', '<h3 class="nope">x</h3>') }, 'untraceable', []],
      ['new section absent from source', { outerHTML: '<section class="brand-new-section"></section>' }, 'untraceable', []],
      ['platform widget', { outerHTML: '<div data-react-component="JobList"><a href="/jobs">x</a></div>' }, 'untraceable', []],
    ].map(([name, el, ...rest]) => [name, { ...base, ...el }, ...rest]);
  }
  return [
    ['nav link, selector gives the landmark', { outerHTML: link, selector: 'header.site-header > nav > a:nth-child(2)' }, 'high', ['src/partials/header.liquid:5']],
    ['footer link in a Studio wrapper with a deploy-hash class', { outerHTML: '<a class="css-1a9f3c" href="/benefits">Benefits overview</a>', selector: 'div.ps-snippet-wrap > footer.site-footer > a:nth-child(2)' }, 'high', ['src/partials/footer.liquid:3']],
    ['footer link by text alone', { outerHTML: '<a href="/benefits">Benefits overview</a>' }, 'medium', ['src/partials/footer.liquid:3']],
    ['page-level button', { outerHTML: '<button type="button" class="defect-icon-button"><svg></svg></button>' }, 'medium', [`${PAGE}:9`]],
    ['title rewritten by Studio', { outerHTML: '<title>Careers</title>', selector: 'html > head > title:nth-child(2)' }, 'medium', ['src/layouts/layout.liquid:5']],
    ['same link in two snippets', { outerHTML: link, pageHtml: wrap('header', `<header>${link}</header>`) + wrap('footer', `<footer>${link}</footer>`) }, 'ambiguous', ['src/partials/header.liquid:5', 'src/partials/footer.liquid:3']],
    ['lookalike href with its own classes', { outerHTML: '<a href="/benefits" class="nav-link hover-underline">Benefits</a>' }, 'untraceable', []],
    ['element absent from the reference', { outerHTML: '<p class="unrelated-class">x</p>' }, 'untraceable', []],
    ['selector contradicts the only text match', { outerHTML: link, selector: 'footer.site-footer > a:nth-child(2)' }, 'untraceable', []],
  ].map(([name, el, ...rest]) => [name, { ...base, ...PREVIEW, ...el }, ...rest]);
};

// Real-site structure categories (test/fixtures/trace-liquid). Truth lines were counted by opening each file under src/.
const H = 'src/partials/header.liquid';
const F = 'src/partials/footer.liquid';
const siteCases = (mode) => {
  const base = { root: SITE, pageFile: PAGE, pageHtml: SITE_HTML, mode };
  const card = (h) => `<a class="card-link" href="/jobs">${h}</a>`;
  const rows = [
    // header nav links: same class, told apart by href
    ['header logo link', '<a class="logo-link" href="/"><img class="logo-img" src="/logo.svg" width="120" height="32"></a>', 'header > a.logo-link', 'high', [`${H}:2`], 'medium'],
    ['header logo image', '<img class="logo-img" src="/logo.svg" width="120" height="32">', 'header > a > img', 'high', [`${H}:2`]],
    ['header nav landmark', '<nav class="main-nav" aria-label="Primary">\n    <a class="nav-link" href="/jobs">Jobs</a>\n    <a class="nav-link" href="/teams">Teams</a>\n    <a class="nav-link" href="/benefits">Benefits</a>\n    <a class="nav-link" href="/locations">Locations</a>\n  </nav>', 'header > nav', 'high', [`${H}:3`], 'medium'],
    ['nav link Jobs', '<a class="nav-link" href="/jobs">Jobs</a>', 'nav > a:nth-child(1)', 'high', [`${H}:4`]],
    ['nav link Teams', '<a class="nav-link" href="/teams">Teams</a>', 'nav > a:nth-child(2)', 'high', [`${H}:5`]],
    ['nav link Benefits', '<a class="nav-link" href="/benefits">Benefits</a>', 'nav > a:nth-child(3)', 'high', [`${H}:6`]],
    ['nav link Locations', '<a class="nav-link" href="/locations">Locations</a>', 'nav > a:nth-child(4)', 'high', [`${H}:7`]],
    ['header search icon button', '<button class="search-toggle" type="button"><svg width="16" height="16" aria-hidden="true"></svg></button>', 'header > button', 'high', [`${H}:9`], 'medium'],
    // footer link lists: bare links, no class, told apart by href
    ['footer Privacy link', '<a href="/privacy">Privacy</a>', 'footer > ul > li:nth-child(1) > a', 'high', [`${F}:3`], 'medium'],
    ['footer Terms link', '<a href="/terms">Terms</a>', 'footer > ul > li:nth-child(2) > a', 'high', [`${F}:4`], 'medium'],
    ['footer Cookies link', '<a href="/cookies">Cookies</a>', 'footer > ul > li:nth-child(3) > a', 'high', [`${F}:5`], 'medium'],
    ['footer LinkedIn icon link', '<a class="social-icon" href="https://example.com/linkedin"><svg width="20" height="20" aria-hidden="true"></svg></a>', 'ul.social-links > li > a', 'high', [`${F}:8`], 'medium'],
    ['footer Instagram icon link', '<a class="social-icon" href="https://example.com/instagram"><svg width="20" height="20" aria-hidden="true"></svg></a>', 'ul.social-links > li > a', 'high', [`${F}:9`], 'medium'],
    ['footer legal paragraph', '<p class="legal">Copyright Acme Corp.</p>', 'footer > p', 'high', [`${F}:11`]],
    // hero
    ['hero heading', '<h1 class="hero-title">Build your career at Acme</h1>', 'section.hero > h1', 'medium', [`${PAGE}:5`]],
    ['hero image', '<img class="hero-image" src="/hero.jpg" width="1200" height="480">', 'section.hero > img', 'medium', [`${PAGE}:6`]],
    ['hero call to action', '<a class="hero-cta" href="/jobs">Search jobs</a>', 'section.hero > a', 'medium', [`${PAGE}:7`]],
    // card grid: identical markup, distinct text
    ['card title Store Associate', '<h3 class="card-title">Store Associate</h3>', 'article:nth-child(1) > h3', 'medium', [`${PAGE}:11`]],
    ['card title Delivery Driver', '<h3 class="card-title">Delivery Driver</h3>', 'article:nth-child(2) > h3', 'medium', [`${PAGE}:15`]],
    ['card title Kitchen Crew', '<h3 class="card-title">Kitchen Crew</h3>', 'article:nth-child(3) > h3', 'medium', [`${PAGE}:19`]],
    ['card link, store', card('Explore store roles'), 'article:nth-child(1) > a', 'medium', [`${PAGE}:12`]],
    ['card link, driving', card('Explore driving roles'), 'article:nth-child(2) > a', 'medium', [`${PAGE}:16`]],
    ['card link, kitchen', card('Explore kitchen roles'), 'article:nth-child(3) > a', 'medium', [`${PAGE}:20`]],
    // form inputs
    ['form label', '<label for="keyword">Keyword</label>', 'form > label', 'medium', [`${PAGE}:24`]],
    ['keyword input', '<input id="keyword" class="search-input" type="text" name="q">', 'input#keyword', 'medium', [`${PAGE}:25`]],
    ['location input', '<input id="location" class="search-input" type="text" name="location">', 'input#location', 'medium', [`${PAGE}:26`]],
    ['radius select', '<select id="radius" class="search-select" name="radius"><option value="10">10 miles</option></select>', 'select#radius', 'medium', [`${PAGE}:27`]],
    ['submit button', '<button class="search-submit" type="submit">Search</button>', 'form > button', 'medium', [`${PAGE}:28`]],
    // repeated icon buttons
    ['carousel previous icon button', '<button class="carousel-prev" type="button"><svg width="16" height="16" aria-hidden="true"></svg></button>', 'div.carousel > button:nth-child(1)', 'medium', [`${PAGE}:31`]],
    ['carousel next icon button', '<button class="carousel-next" type="button"><svg width="16" height="16" aria-hidden="true"></svg></button>', 'div.carousel > button:nth-child(4)', 'medium', [`${PAGE}:34`]],
    ['two byte-identical dot buttons', '<button class="carousel-dot" type="button"></button>', 'div.carousel > button:nth-child(2)', 'ambiguous', [`${PAGE}:32`, `${PAGE}:33`]],
    // text can only exclude a tie whose every member has authored text: line 37 is filled by Liquid, so it could be this element
    ['stat paragraph, one tie member filled by Liquid', '<p class="stat">Updated daily</p>', 'main > p:nth-child(6)', 'ambiguous', [`${PAGE}:37`, `${PAGE}:38`]],
    // layout head
    ['layout title', '<title>Careers</title>', 'head > title', 'medium', ['src/layouts/layout.liquid:5']],
    ['layout meta description', '<meta name="description" content="Careers at Acme">', 'head > meta:nth-child(3)', 'medium', ['src/layouts/layout.liquid:6']],
    // not in source
    ['jobs widget placeholder (platform-owned)', '<div class="jobs-widget" data-react-component="JobList"></div>', 'div.jobs-widget', 'untraceable', []],
    ['banner injected by the platform', '<aside class="cookie-banner">We use cookies</aside>', 'body > aside', 'untraceable', []],
  ];
  return rows
    // Optional 6th column: preview confidence when it differs. The probe's short hand-written selector scores below FINGERPRINT.HIGH_SCORE (asserted in the regression test).
    .map(([name, outerHTML, selector, expect, truth, previewExpect]) => [name, { ...base, ...(mode === 'preview' ? { ...PREVIEW, selector } : {}), outerHTML },
      mode === 'preview' ? previewExpect ?? expect : expect, truth]);
};

const htmlCases = (mode) => [
  ['h1 by id', 'index.html', '<h1 id="page-title">Careers at Acme</h1>', 'main > h1#page-title', 'high', ['index.html:18']],
  ['nav by id', 'index.html', '<nav id="main-nav" aria-label="Main"><ul><li><a href="/about.html">About</a></li><li><a href="/contact.html">Contact</a></li></ul></nav>', 'nav#main-nav', 'high', ['index.html:11']],
  ['two identical card links', 'index.html', '<a href="/jobs/1.html" class="card-link">Read more</a>', 'section.cards > div.card > a', 'ambiguous', ['index.html:21', 'index.html:22']],
  ['third card link differs by href', 'index.html', '<a href="/jobs/2.html" class="card-link">Read more</a>', 'section.cards > div.card > a', 'high', ['index.html:23']],
  ['button in the inner of nested tables', 'index.html', '<button type="button" class="apply">Apply now</button>', 'main > table.outer > tbody > tr > td > table.inner > tbody > tr > td > button.apply', 'high', ['index.html:27']],
  ['script src after an inline script', 'index.html', '<script src="/app.js"></script>', 'body > script:nth-child(5)', 'high', ['index.html:33']],
  ['nav link with a JS class', 'index.html', '<a href="/about.html" class="active">About</a>', 'nav > ul > li > a', 'medium', ['index.html:13']],
  ['input by id', 'about.html', '<input type="email" id="email" name="email">', 'form > input#email', 'high', ['about.html:18']],
  ['footer', 'about.html', '<footer><p>Copyright Acme</p></footer>', 'footer', 'high', ['about.html:21']],
  ['paragraph with a JS class', 'contact.html', '<p class="note">Write to us.</p>', 'main > p.note', 'medium', ['contact.html:16']],
  ['markup that only exists in an inline script string', 'index.html', '<div id="fake">not an element</div>', 'div#fake', 'untraceable', []],
  ['element injected by the platform', 'index.html', '<aside class="promo">Join now</aside>', 'body > aside', 'untraceable', []],
].map(([name, pageFile, outerHTML, selector, ...rest]) => [name, { root: HTML, mode, pageFile, outerHTML, selector, ...(mode === 'preview' ? PREVIEW : {}) }, ...rest]);

// Rendered HTML is what react-dom/server prints for the transformed fixture (react itself is not installed here).
const reactCases = (mode, manifest) => [
  ['App h1', '<h1 data-ada-src="src/App.jsx:11" id="title">Careers Count: few</h1>', 'src/App.jsx:11'],
  ['App img', '<img data-ada-src="src/App.jsx:12" src="/hero.png" alt="">', 'src/App.jsx:12'],
  ['App button', '<button data-ada-src="src/App.jsx:16" type="button">Don\'t click fragment</button>', 'src/App.jsx:16'],
  ['Card h2', '<h2 data-ada-src="src/Card.jsx:4">One</h2>', 'src/Card.jsx:4'],
  ['Card link', '<a data-ada-src="src/Card.jsx:5" href="/apply">Apply</a>', 'src/Card.jsx:5'],
].map(([name, outerHTML, at]) => [name, { outerHTML }, mode === 'local' ? 'high' : 'medium', [at]])
  .concat([
    ['markup the platform added (no data-ada-src)', { outerHTML: '<h1 id="title">Careers</h1>' }, 'untraceable', []],
    ['attribute names the wrong tag for that line', { outerHTML: '<h2 data-ada-src="src/App.jsx:11">x</h2>' }, 'untraceable', []],
    ['platform widget', { outerHTML: '<div data-react-component="jobs" data-ada-src="src/App.jsx:10"></div>' }, 'untraceable', []],
  ]).map(([name, el, ...rest]) => [name, { root: REACT, mode, reactManifest: manifest, ...(mode === 'preview' ? PREVIEW : {}), ...el }, ...rest]);

/** One of correct | ambiguous | untraceable | wrong, and whether the answer was a wrong `high`. */
function verdict(result, expect, truth) {
  const got = result.candidates.map((c) => `${c.file}:${c.line}`);
  const right = (verdictName) => ({ verdict: verdictName, wrongHigh: false });
  const wrong = { verdict: 'wrong', wrongHigh: result.confidence === 'high' };
  if (result.confidence === 'untraceable') return truth.length === 0 ? right('absent-ok') : right('untraceable');
  if (truth.length === 0) return wrong;
  if (result.confidence === 'ambiguous') return truth.every((t) => got.includes(t)) ? right('ambiguous') : wrong;
  if (result.confidence === 'high' || result.confidence === 'medium') return got.length === 1 && got[0] === truth[0] ? right('correct') : wrong;
  return wrong; // `low` is not part of the target set: a guess with no evidence
}

/** Runs every case through traceElement; one row per case with the adapter and scan mode it exercises. */
export function collectTraceRows() {
  const tmp = mkdtempSync(join(tmpdir(), 'ada-trace-metrics-'));
  try {
    const manifest = join(tmp, 'ada-react-src.json');
    writeFileSync(manifest, JSON.stringify({ sourceHashes: hashSourceFiles(REACT, ['src/App.jsx', 'src/Card.jsx']) }));
    const suites = [
      ['paradox-liquid', 'local', liquid('local')],
      ['paradox-liquid', 'preview', liquid('preview')],
      ['paradox-liquid', 'local', siteCases('local')],
      ['paradox-liquid', 'preview', siteCases('preview')],
      ['html', 'local', htmlCases('local')],
      ['html', 'preview', htmlCases('preview')],
      ['react', 'local', reactCases('local', manifest)],
      ['react', 'preview', reactCases('preview', undefined)],
    ];
    return suites.flatMap(([adapter, mode, cases]) => cases.map(([name, el, expect, truth]) => {
      const result = traceElement(el);
      return { adapter, mode, name, expect, truth, confidence: result.confidence, evidence: result.candidates[0]?.evidence ?? [], reason: result.reason, ...verdict(result, expect, truth) };
    }));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Per adapter and mode counts; "traceable" = elements that exist in source (truth not empty). */
export function summarizeTraceRows(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.adapter}|${row.mode}`;
    const g = groups.get(key) || { adapter: row.adapter, mode: row.mode, traceable: 0, correct: 0, ambiguous: 0, untraceable: 0, wrong: 0, wrongHigh: 0, absentOk: 0 };
    if (row.truth.length > 0) g.traceable += 1;
    if (row.verdict === 'absent-ok') g.absentOk += 1;
    else g[row.verdict] += 1;
    g.wrongHigh += row.wrongHigh ? 1 : 0;
    groups.set(key, g);
  }
  return [...groups.values()];
}

export function renderTraceMetrics() {
  const pct = (g) => `${Math.round((100 * g.correct) / g.traceable)}%`;
  const rows = summarizeTraceRows(collectTraceRows()).map((g) => `| ${g.adapter} | ${g.mode} | ${g.traceable} | ${g.correct} | ${g.ambiguous} | ${g.untraceable} | ${g.wrong} | ${g.wrongHigh} | ${pct(g)} | ${g.absentOk} |`);
  return [
    '# Trace metrics',
    '',
    '<!-- GENERATED by `npm run trace:metrics` from test/fixtures. Do not edit by hand. -->',
    '',
    'Every case runs through `traceElement` against a fixture with hand-counted lines. Traceable = the element exists in source.',
    'Correct = `high` or `medium` with the right single file:line; ambiguous = `ambiguous` listing the right lines; wrong = any other path, a `high` that is wrong counts in "Wrong high" too.',
    'Absent handled = elements not in source (or platform-owned) correctly reported `untraceable`. Gate 3: 0 wrong high, at least 80% correct.',
    '',
    '| Adapter | Mode | Traceable | Correct | Ambiguous | Untraceable | Wrong | Wrong high | Correct % | Absent handled |',
    '|---|---|---|---|---|---|---|---|---|---|',
    ...rows,
    '',
  ].join('\n');
}
