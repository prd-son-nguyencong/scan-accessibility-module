import './helpers/hermetic-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildRenderIndex,
  buildTagIndex,
  collectRenderTree,
  findLineForHref,
  findLineForRenderTag,
  findLineForRenderedHtml,
  findLineForTagText,
  findPageLevelAnchor,
  parseRenderedTag,
} from '../src/tracer/liquid-tag-index.js';

// Line numbers below were counted by hand against test/fixtures/paradox-site/src.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/paradox-site');

function withTempRoot(files, fn) {
  const root = mkdtempSync(join(tmpdir(), 'ada-tag-index-'));
  try {
    for (const [rel, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), content);
    }
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('buildTagIndex lists open tags with their start lines', () => {
  const tags = buildTagIndex('src/partials/header.liquid', ROOT);
  assert.deepEqual(tags.map((t) => [t.tagName, t.line]), [
    ['header', 1], ['a', 2], ['nav', 3], ['a', 4], ['a', 5], ['a', 6],
  ]);
  assert.equal(tags[4].staticAttrs.href, '/benefits');
  assert.deepEqual(tags[0].staticClasses, ['site-header']);
});

test('buildTagIndex survives a bare > inside Liquid, keeps lines across comments, drops utility classes', () => {
  withTempRoot({
    'src/partials/x.liquid': [
      '{% comment %}',
      '<a id="hidden">ignored</a>',
      '{% endcomment %}',
      '<a href="{% if a > b %}/x{% endif %}" class="flex p-4 promo-link">go</a>',
      '<img src="{{ img }}-large.png" alt="">',
    ].join('\n'),
  }, (root) => {
    const tags = buildTagIndex('src/partials/x.liquid', root);
    assert.deepEqual(tags.map((t) => [t.tagName, t.line]), [['a', 4], ['img', 5]]);
    assert.deepEqual(tags[0].staticClasses, ['promo-link']);
    assert.ok(tags[0].dynamicAttrs.href.test('/x'));
    assert.ok(tags[1].dynamicAttrs.src.test('hero-large.png'));
    assert.equal(tags[1].selfClosing, true);
  });
});

test('buildTagIndex returns nothing for a missing or escaping path', () => {
  assert.deepEqual(buildTagIndex('src/partials/nope.liquid', ROOT), []);
  assert.deepEqual(buildTagIndex('../outside.liquid', ROOT), []);
});

test('buildRenderIndex records render call sites and their arguments', () => {
  const calls = buildRenderIndex('src/pages/index.liquid', ROOT);
  assert.deepEqual(calls.map((c) => [c.name, c.line, c.params.label]), [['cta', 15, '"Apply"'], ['cta', 16, '"Apply"']]);
  assert.deepEqual(buildRenderIndex('src/layouts/layout.liquid', ROOT).map((c) => [c.name, c.line]), [['header', 10], ['footer', 12]]);
});

test('parseRenderedTag reads the first real tag out of a window of html', () => {
  const parsed = parseRenderedTag('--> <a class="x y" href="/a?b=1&amp;c=2">t</a>');
  assert.equal(parsed.tagName, 'a');
  assert.deepEqual(parsed.classes, ['x', 'y']);
  assert.equal(parsed.attrs.href, '/a?b=1&amp;c=2');
  assert.equal(parseRenderedTag('plain text'), null);
});

test('findLineForRenderTag ties identical call sites and separates different arguments', () => {
  const tied = findLineForRenderTag('src/pages/index.liquid', parseRenderedTag('<div data-pdk-render="cta" data-pdk-param-label="&quot;Apply&quot;">'), ROOT);
  assert.deepEqual(tied.lines, [15, 16]);
  assert.equal(tied.ambiguous, true);
  assert.equal(tied.confidence, 'medium');

  withTempRoot({
    'src/pages/p.liquid': '{% render "cta", label: "Apply" %}\n{% render "cta", label: "Save" %}\n',
  }, (root) => {
    const hit = findLineForRenderTag('src/pages/p.liquid', parseRenderedTag('<div data-pdk-render="cta" data-pdk-param-label="&quot;Save&quot;">'), root);
    assert.equal(hit.line, 2);
    assert.equal(hit.confidence, 'high');
    assert.equal(hit.ambiguous, false);
  });
  assert.equal(findLineForRenderTag('src/pages/index.liquid', parseRenderedTag('<div>'), ROOT), null);
});

test('findLineForRenderedHtml is decisive on a distinctive tag and refuses to pick between look-alikes', () => {
  const decisive = findLineForRenderedHtml('src/pages/index.liquid', '<button class="defect-icon-button" type="button"><svg></svg></button>', ROOT);
  assert.equal(decisive.line, 9);
  assert.equal(decisive.confidence, 'high');
  assert.equal(decisive.ambiguous, false);

  const twin = findLineForRenderedHtml('src/pages/index.liquid', '<a class="defect-small-target tw-small-target" href="/jobs" aria-label="Jobs shortcut"></a>', ROOT);
  assert.equal(twin.line, 13);
  assert.equal(twin.confidence, 'high');

  // Header and footer both link /benefits: two tags in one file would tie, here each file has one.
  assert.equal(findLineForRenderedHtml('src/partials/footer.liquid', '<a href="/benefits">x</a>', ROOT).line, 3);

  // A class the source tag never has must reject it rather than weakly match.
  assert.equal(findLineForRenderedHtml('src/pages/index.liquid', '<button class="other-button">', ROOT), null);
  assert.equal(findLineForRenderedHtml('src/partials/header.liquid', '<table></table>', ROOT), null);
});

test('findLineForRenderedHtml reports every tied line', () => {
  withTempRoot({
    'src/partials/t.liquid': '<a href="/same">one</a>\n<p>x</p>\n<a href="/same">two</a>\n',
  }, (root) => {
    const hit = findLineForRenderedHtml('src/partials/t.liquid', '<a href="/same">', root);
    assert.deepEqual(hit.lines, [1, 3]);
    assert.equal(hit.ambiguous, true);
    assert.equal(hit.confidence, 'medium');
  });
});

test('a root-relative authored href matches its dev-server form but never the same path on an external host (a script that appends the route to another site\'s URL)', () => {
  withTempRoot({
    'src/partials/header.liquid': '<a href="/restaurant-jobs">Search Restaurant Jobs</a>\n',
    'src/partials/footer.liquid': '<a href="https://emplois.example.ca/">FR</a>\n',
  }, (root) => {
    // FALSE positive of round 5: the footer FR link (href rewritten to https://emplois.example.ca/restaurant-jobs) was traced to the header link of the same path
    const external = findLineForRenderedHtml('src/partials/header.liquid', '<a href="https://emplois.example.ca/restaurant-jobs">FR</a>', root, { local: true });
    assert.equal(external, null, 'a link to another host is not the root-relative header link');
    // TRUE: the same link on the dev server still resolves to the authored root-relative href
    for (const host of ['http://127.0.0.1:6215', 'http://localhost:1234', 'http://dev.localhost:3000']) {
      const hit = findLineForRenderedHtml('src/partials/header.liquid', `<a href="${host}/restaurant-jobs">Search Restaurant Jobs</a>`, root, { local: true });
      assert.equal(hit?.line, 1, host);
    }
    // TRUE: a dev host with any name (container, LAN) resolves it when the caller knows the scanned page's host; with no host given the single-label and .internal names still do
    const named = (host, opts) => findLineForRenderedHtml('src/partials/header.liquid', `<a href="http://${host}/restaurant-jobs">Search Restaurant Jobs</a>`, root, opts);
    assert.equal(named('dev.myco.com:3000', { local: 'dev.myco.com' })?.line, 1);
    assert.equal(named('web:3000', { local: true })?.line, 1);
    assert.equal(named('host.docker.internal:3000', { local: true })?.line, 1);
    // FALSE: with the scanned host known, another host is another site's link
    assert.equal(named('emplois.example.ca', { local: 'dev.myco.com' }), null);
    // TRUE: a script appends the route to the authored absolute link (href += path): the footer link is still found, and the confident match is the footer line, not the header link
    const appended = findLineForRenderedHtml('src/partials/footer.liquid', '<a href="https://emplois.example.ca/restaurant-jobs">FR</a>', root);
    assert.equal(appended?.line, 1);
    assert.equal(appended?.ambiguous, false); // a prefix is weak evidence: found, not stated as decisive
    // an authored URL that is only a string prefix of the rendered one (root vs path, /careers vs /careers-fr) never ties with the exact link
    const sib = mkdtempSync(join(tmpdir(), 'ltag-'));
    mkdirSync(join(sib, 'src/partials'), { recursive: true });
    writeFileSync(join(sib, 'src/partials/footer.liquid'), '<a class="f" href="https://www.example.com/">Home</a>\n<a class="f" href="https://www.example.com/careers">Careers</a>\n<a class="f" href="https://www.example.com/careers-fr">Careers FR</a>\n');
    try {
      for (const [path, line] of [['careers', 2], ['careers-fr', 3], ['', 1]]) {
        const hit = findLineForRenderedHtml('src/partials/footer.liquid', `<a class="f" href="https://www.example.com/${path}">x</a>`, sib, { local: false });
        assert.equal(hit?.line, line, path);
        assert.equal(hit?.ambiguous, false, path);
        assert.equal(hit?.confidence, 'high', path);
      }
    } finally { rmSync(sib, { recursive: true, force: true }); }
    // a bare origin link (Home) is a prefix of every link on the host: it never outranks a root-relative link or a looped link with a dynamic href
    const mix = mkdtempSync(join(tmpdir(), 'ltag-'));
    mkdirSync(join(mix, 'src/partials'), { recursive: true });
    try {
      writeFileSync(join(mix, 'src/partials/footer.liquid'), '<a href="https://www.example.com/">Home</a>\n<a href="/careers">Careers</a>\n<a href="/jobs">Jobs</a>\n');
      for (const [path, line] of [['careers', 2], ['jobs', 3], ['', 1]]) {
        const hit = findLineForRenderedHtml('src/partials/footer.liquid', `<a href="https://www.example.com/${path}">x</a>`, mix, { local: false });
        assert.equal(hit?.line, line, `root-relative ${path}`);
        assert.equal(hit?.ambiguous, false, `root-relative ${path}`);
      }
      writeFileSync(join(mix, 'src/partials/footer2.liquid'), '<a class="f" href="https://www.example.com/">Home</a>\n{% for l in links %}\n<a class="f" href="{{ l.url }}">{{ l.title }}</a>\n{% endfor %}\n');
      const loop = findLineForRenderedHtml('src/partials/footer2.liquid', '<a class="f" href="https://www.example.com/careers">Careers</a>', mix, { local: false });
      assert.equal(loop?.line, 3);
      assert.equal(loop?.confidence, 'high');
      assert.equal(loop?.ambiguous, false);
    } finally { rmSync(mix, { recursive: true, force: true }); }
    // a deployed (preview or remote) page serializes its own host: the root-relative link is still that tag
    assert.equal(findLineForRenderedHtml('src/partials/header.liquid', '<a href="https://careers.example.com/restaurant-jobs">Search Restaurant Jobs</a>', root)?.line, 1);
  });
});

test('findLineForHref distinguishes exact, repeated and interpolated hrefs', () => {
  assert.deepEqual(findLineForHref('src/partials/header.liquid', '/jobs', ROOT), { line: 6, confidence: 'high', method: 'liquid-href-exact', ambiguous: false });
  assert.equal(findLineForHref('src/partials/header.liquid', '/missing', ROOT), null);
  assert.equal(findLineForHref('src/partials/header.liquid', '', ROOT), null);
  withTempRoot({
    'src/partials/h.liquid': '<a href="/a">1</a>\n<a href="/a">2</a>\n<a href="/job/{{ id }}">3</a>\n',
  }, (root) => {
    const dup = findLineForHref('src/partials/h.liquid', '/a', root);
    assert.equal(dup.ambiguous, true);
    assert.equal(dup.confidence, 'medium');
    const loose = findLineForHref('src/partials/h.liquid', '/job/42', root);
    assert.deepEqual([loose.line, loose.method], [3, 'liquid-href-pattern']);
  });
});

test('findLineForTagText anchors on authored text, else on a unique tag', () => {
  assert.equal(findLineForTagText('src/partials/footer.liquid', 'p', 'Acme Corp. All rights reserved.', ROOT).line, 2);
  assert.equal(findLineForTagText('src/partials/footer.liquid', 'footer', 'zzz-not-there', ROOT).method, 'liquid-unique-tag');
  assert.equal(findLineForTagText('src/partials/header.liquid', 'a', 'zzz-not-there', ROOT), null);
});

test('collectRenderTree walks the page, its layout and what they render, breadth first', () => {
  assert.deepEqual(collectRenderTree('src/pages/index.liquid', 3, ROOT), [
    'src/pages/index.liquid',
    'src/layouts/layout.liquid',
    'src/partials/cta.liquid',
    'src/partials/header.liquid',
    'src/partials/footer.liquid',
  ]);
});

test('findPageLevelAnchor points where missing markup would go, at low confidence', () => {
  const h1 = findPageLevelAnchor('src/pages/index.liquid', 'missing-h1', ROOT);
  assert.deepEqual([h1.file, h1.line, h1.confidence, h1.method], ['src/pages/index.liquid', 5, 'low', 'page-level-anchor']);
  const main = findPageLevelAnchor('src/pages/index.liquid', 'no-landmark-main', ROOT);
  assert.deepEqual([main.file, main.line], ['src/pages/index.liquid', 4]);
});

test('findPageLevelAnchor on a stub page with no <main> still returns a line: first element, else the layout include', () => {
  withTempRoot({ 'src/layouts/layout.liquid': '<body>{{ content }}</body>', 'src/pages/stub.liquid': "{% layout 'layout' %}\n\n<section><h2>Gone</h2></section>\n", 'src/pages/bare.liquid': "{% layout 'layout' %}\n" }, (root) => {
    assert.equal(findPageLevelAnchor('src/pages/stub.liquid', 'skip-link', root).line, 3);
    assert.equal(findPageLevelAnchor('src/pages/bare.liquid', 'skip-link', root).line, 1);
  });
});

test('a class assembled by Liquid ("banner--{{ kind }}") is matched as a pattern: it picks the tag that can produce the rendered class, even when it is duplicated', () => {
  withTempRoot({ 'src/pages/p.liquid': '<section class="banner banner-note--{{ kind }}">\n</section>\n<section class="banner banner--{{ kind }}">\n</section>\n' }, (root) => {
    const hit = findLineForRenderedHtml('src/pages/p.liquid', '<section class="banner banner--career banner--career">', root);
    assert.equal(hit.line, 3);
    const other = findLineForRenderedHtml('src/pages/p.liquid', '<section class="banner banner-note--career">', root);
    assert.equal(other.line, 1);
  });
});
