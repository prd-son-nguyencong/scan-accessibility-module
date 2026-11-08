import './helpers/hermetic-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { traceToPartials, markSourcesUnavailable } from '../src/index.js';
import { disableBuiltOutput } from '../src/tracer/resolve-source.js';
import { narrowBySelectorChain } from '../src/tracer/structural-source.js';
import { buildScanReportV2, hasTracedSource } from '../src/reporter/report-v2.js';
import { buildTaskSet, writeTaskSet } from '../src/fix/export/tasks.js';
import { evaluateTargeted } from '../src/fix/harness/gates.js';

// Three carousels with the same button markup: two partials of one page, plus a desktop grid and a mobile carousel in one file.
const DOTS = (wrap) => `<section class="carousel">\n  <div class="${wrap}">\n    <button class="carousel--next size-3 rounded-full"><svg><use href="#i-next"></use></svg></button>\n  </div>\n</section>\n`;
const GRID = [
  '<section id="roles">',
  '  <div class="hidden lg:flex">',
  '    <div class="w-29 gap-[1rem] flex-col">',
  '      <div class="rounded-[0.8rem] border border-neutral-300" aria-label="{{ role.label }}"></div>',
  '    </div>',
  '  </div>',
  '  <div class="lg:hidden">',
  '    <div class="shrink-0 md:w-[calc(33.333%-1.34rem)] mx-[0.67rem]">',
  '      <div class="rounded-[0.8rem] border border-neutral-300" aria-label="{{ role.label }}"></div>',
  '    </div>',
  '  </div>',
  '</section>',
  '',
].join('\n');
const FILES = {
  'src/layouts/layout.liquid': '<!doctype html>\n<html lang="en">\n<head><title>t</title></head>\n<body>\n{% block content %}{% endblock %}\n</body></html>\n',
  'src/pages/index.liquid': '{% layout "layout" %}\n{% block content %}\n<main>\n{% render "index/explore" %}\n{% render "index/awards" %}\n{% render "index/roles" %}\n</main>\n{% endblock %}\n',
  'src/partials/index/explore.liquid': DOTS('flex flex-row justify-start gap-3'),
  'src/partials/index/awards.liquid': DOTS('flex flex-row justify-center gap-3 lg:hidden'),
  'src/partials/index/roles.liquid': GRID,
};

async function withSite(fn) {
  const root = mkdtempSync(join(tmpdir(), 'ada-untraced-'));
  try {
    for (const [rel, body] of Object.entries(FILES)) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), body);
    }
    return await fn(root);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

const live = (rule, outerHTML, selector) => ({ rule, ruleId: rule, element: { outerHTML, selector }, source: { mode: 'url', method: 'unavailable' } });
const at = (v) => `${v.source.file}:${v.source.line}`;
const NEXT = '<button class="carousel--next size-3 rounded-full"><svg>…</svg></button>';
const ROLE = '<div class="rounded-[0.8rem] border border-neutral-300" aria-label="Watch">';

test('identical markup in two partials of one page is told apart by the classes of the selector chain', async () => {
  await withSite(async (root) => {
    const a = live('button-name', NEXT, '.justify-start>.carousel--next.rounded-full');
    const b = live('button-name', NEXT, '.lg\\:hidden.gap-3.justify-center>.carousel--next.rounded-full');
    await traceToPartials([a, b], 'http://127.0.0.1:1/', root);
    assert.equal(at(a), 'src/partials/index/explore.liquid:3');
    assert.equal(at(b), 'src/partials/index/awards.liquid:3');
    assert.ok(['medium', 'high'].includes(a.source.confidence) && ['medium', 'high'].includes(b.source.confidence));
  });
});

test('a desktop grid and a mobile carousel in one file resolve by the escaped utility classes of the parent', async () => {
  await withSite(async (root) => {
    const desktop = live('aria-prohibited-attr', ROLE, '.w-29.gap-\\[1rem\\].flex-col:nth-child(7)>.rounded-\\[0\\.8rem\\].border.border-neutral-300');
    const mobile = live('aria-prohibited-attr', ROLE, '.md\\:w-\\[calc\\(33\\.333\\%-1\\.34rem\\)\\].mx-\\[0\\.67rem\\]:nth-child(4)>.rounded-\\[0\\.8rem\\].border.border-neutral-300');
    await traceToPartials([desktop, mobile], 'http://127.0.0.1:1/', root);
    assert.equal(at(desktop), 'src/partials/index/roles.liquid:4');
    assert.equal(at(mobile), 'src/partials/index/roles.liquid:9');
    assert.notEqual(desktop.source.confidence, 'low');
    assert.notEqual(mobile.source.confidence, 'low');
  });
});

test('a selector that does not tell the partials apart stays ambiguous: candidates listed, no guessed line', async () => {
  await withSite(async (root) => {
    const v = live('button-name', NEXT, '.carousel--next:nth-child(3)');
    await traceToPartials([v], 'http://127.0.0.1:1/', root);
    assert.equal(v.source.confidence, 'low');
    assert.equal(v.source.line ?? null, null);
    assert.equal(v.source.traceReason, 'multiple-candidates');
    assert.deepEqual((v.sourceCandidates || []).map((c) => `${c.file}:${c.line}`).sort(), ['src/partials/index/awards.liquid:3', 'src/partials/index/explore.liquid:3']);
  });
});

test('a utility-only class list written by exactly one tag of the page resolves there, not to a look-alike class hint elsewhere', async () => {
  await withSite(async (root) => {
    mkdirSync(join(root, 'src/partials/about'), { recursive: true });
    writeFileSync(join(root, 'src/pages/about.liquid'), '{% layout "layout" %}\n{% block content %}\n<main>\n{% render "about/culture" %}\n{% render "about/dots" %}\n</main>\n{% endblock %}\n');
    // look-alike: another tag that merely carries the `group` utility class
    writeFileSync(join(root, 'src/partials/about/culture.liquid'), '<section>\n  <a href="/v" class="popup-button--link relative block group" aria-label="Play">x</a>\n  <button class="btn-x">Go</button>\n</section>\n');
    writeFileSync(join(root, 'src/partials/about/dots.liquid'), '<div class="carousel--dots">\n  <button class="group">\n    <span class="size-1 rounded-full"></span>\n  </button>\n</div>\n');
    const v = live('button-name', '<button class="group"><span class="size-1 rounded-full"></span></button>', '.group:nth-child(3)');
    await traceToPartials([v], 'http://127.0.0.1:1/about', root);
    assert.equal(at(v), 'src/partials/about/dots.liquid:2');
    assert.ok(['medium', 'high'].includes(v.source.confidence));
  });
});

test('the whole literal class list ranks tags: a dot with a script-added `current` is not the nav button that merely names `current`', async () => {
  await withSite(async (root) => {
    mkdirSync(join(root, 'src/partials/areas'), { recursive: true });
    writeFileSync(join(root, 'src/pages/areas.liquid'), '{% layout "layout" %}\n{% block content %}\n<main>\n{% render "areas/paths" %}\n</main>\n{% endblock %}\n');
    writeFileSync(join(root, 'src/partials/areas/paths.liquid'), [
      '<nav id="path-navigation">',
      '  <button class="button-font current:text-azure hocus:text-azure current py-1 transition-colors">Laboratory</button>',
      '  <button class="button-font current:text-azure hocus:text-azure py-1 transition-colors">Corporate</button>',
      '</nav>',
      '<div class="carousel--dots">',
      '  <button',
      '    class="border-azure current:bg-azure hocus:bg-azure size-1 rounded-full border-[0.1rem] border-solid bg-white transition-colors"></button>',
      '</div>',
      '',
    ].join('\n'));
    // the live dot carries the template's classes plus `current`, which a script adds to the active one
    const dot = live('target-size', '<button class="border-azure current:bg-azure hocus:bg-azure size-1 rounded-full border-[0.1rem] border-solid bg-white transition-colors current"></button>', '.carousel--dots>.border-azure:nth-child(1)');
    await traceToPartials([dot], 'http://127.0.0.1:1/areas', root);
    assert.equal(at(dot), 'src/partials/areas/paths.liquid:6');
    assert.notEqual(dot.source.confidence, 'low');
  });
});

test('narrowBySelectorChain: a class a script adds decides nothing, and a shallow candidate with no evidence does not win by having fewer levels', async () => {
  await withSite(async (root) => {
    mkdirSync(join(root, 'src/components'), { recursive: true });
    writeFileSync(join(root, 'src/components/link.liquid'), '<a href="{{ link }}" class="{{ klass }}">{{ text }}</a>\n');
    const cands = [
      { file: 'src/partials/index/roles.liquid', line: 4 },
      { file: 'src/partials/index/roles.liquid', line: 9 },
      { file: 'src/components/link.liquid', line: 1 },
    ];
    // `.current` is written by no template: it must not count against the mobile slide (line 9) that matches everything else.
    const kept = narrowBySelectorChain(cands.slice(0, 2), '.current.md\\:w-\\[calc\\(33\\.333\\%-1\\.34rem\\)\\].mx-\\[0\\.67rem\\]>.rounded-\\[0\\.8rem\\].border', root);
    assert.deepEqual(kept.map((c) => c.line), [9]);
    // a tag whose class is all Liquid could render any class: the classes the live element has beyond it are no miss
    const opaque = narrowBySelectorChain([cands[1], { file: 'src/components/link.liquid', line: 1 }], '.md\\:w-\\[calc\\(33\\.333\\%-1\\.34rem\\)\\].mx-\\[0\\.67rem\\]>.rounded-\\[0\\.8rem\\].border.border-neutral-300', root);
    assert.deepEqual(opaque.map((c) => c.file), ['src/partials/index/roles.liquid']);
    // the component root has no ancestors in its file: zero levels checked is not a better fit than six matching ones
    const withShallow = narrowBySelectorChain([cands[1], cands[2]], '.md\\:w-\\[calc\\(33\\.333\\%-1\\.34rem\\)\\].mx-\\[0\\.67rem\\]>.rounded-\\[0\\.8rem\\].border.border-neutral-300', root);
    assert.deepEqual(withShallow.map((c) => c.file), ['src/partials/index/roles.liquid']);
  });
});

test('identical menu buttons in one nav are told apart by :nth-of-type, but not across a loop or condition', async () => {
  await withSite(async (root) => {
    mkdirSync(join(root, 'src/partials/layout'), { recursive: true });
    const menu = '<div class="sub-menu">\n  <button class="toggle">Menu</button>\n</div>\n';
    writeFileSync(join(root, 'src/partials/layout/header.liquid'), `<nav id="main-nav">\n${menu}${menu}</nav>\n<nav id="looped-nav">\n{% for m in menus %}\n${menu}{% endfor %}\n</nav>\n`);
    writeFileSync(join(root, 'src/pages/index.liquid'), '{% layout "layout" %}\n{% block content %}\n{% render "layout/header" %}\n{% endblock %}\n');
    const html = '<button class="toggle">Menu</button>';
    const first = live('disclosure-missing-aria-expanded', html, '#main-nav>div:nth-of-type(1)>button:nth-of-type(1)');
    const second = live('disclosure-missing-aria-expanded', html, '#main-nav>div:nth-of-type(2)>button:nth-of-type(1)');
    await traceToPartials([first, second], 'http://127.0.0.1:1/', root);
    assert.equal(at(first), 'src/partials/layout/header.liquid:3');
    assert.equal(at(second), 'src/partials/layout/header.liquid:6');
    // inside a loop the template cannot say which instance is the seventh, so that tag is never ruled out; a tag with a fixed position that differs is
    const cands = [{ file: 'src/partials/layout/header.liquid', line: 12 }, { file: 'src/partials/layout/header.liquid', line: 3 }];
    assert.deepEqual(narrowBySelectorChain(cands, 'div:nth-of-type(7)>button:nth-of-type(1)', root).map((c) => c.line), [12]);
    assert.deepEqual(narrowBySelectorChain(cands, 'div:nth-of-type(1)>button:nth-of-type(1)', root).map((c) => c.line), [3]); // a position that is certain and matches beats one the loop leaves open
  });
});

test('built output is not consulted when the build is unavailable: a stale manifest cannot name the owner', async () => {
  await withSite(async (root) => {
    mkdirSync(join(root, 'dist/partials/index'), { recursive: true });
    // stale build: the button is recorded as living in roles.liquid line 1
    writeFileSync(join(root, 'dist/partials/index/explore.html'), '<button class="carousel--next size-3 rounded-full"><svg><use href="#i-next"></use></svg></button>');
    writeFileSync(join(root, 'dist/scan-manifest.json'), JSON.stringify({ 'dist/partials/index/explore.html': 'src/partials/index/roles.liquid' }));
    disableBuiltOutput(true);
    try {
      const v = live('button-name', NEXT, '.justify-start>.carousel--next.rounded-full');
      await traceToPartials([v], 'http://127.0.0.1:1/', root);
      assert.equal(at(v), 'src/partials/index/explore.liquid:3');
      assert.notEqual(v.source.method, 'instrumentation-manifest');
    } finally { disableBuiltOutput(false); }
  });
});

test('markSourcesUnavailable keeps a statically traced source and marks only the rest unavailable', () => {
  const traced = { source: { mode: 'url', file: 'src/partials/a.liquid', line: 3, confidence: 'medium', method: 'liquid-tag-index' }, sourceCandidates: [{ file: 'x', line: 1 }] };
  const bare = { source: { mode: 'url', file: 'unknown', method: 'unresolved' }, sourceCandidates: [{ file: 'y', line: 2 }] };
  markSourcesUnavailable([{ violations: [traced, bare] }]);
  assert.equal(traced.source.file, 'src/partials/a.liquid');
  assert.equal(traced.sourceCandidates.length, 1);
  assert.deepEqual(bare.source, { mode: 'url', method: 'unavailable' });
  assert.equal(bare.sourceCandidates, undefined);
});

// ── the product rule ─────────────────────────────────────────────────────────

const CTX = (requireSource) => ({
  generatedAt: '2026-10-30T00:00:00.000Z', producer: { name: 'ada-scan', version: '1.1.0' },
  target: { mode: 'local-only', url: 'http://127.0.0.1:1/' }, sourceTracing: { framework: 'paradox-liquid', ...(requireSource ? { requireSource: true } : {}) },
});
const RUNS = [{ layer: 'axe', engine: { name: 'axe-core', version: '4.12.1' }, status: 'complete' }];
const v = (ruleId, selector, outerHTML, source, extra = {}) => ({
  ruleId, nativeRuleId: ruleId, layer: 'axe', impact: 'serious', count: 1, verdict: 'confirmed',
  evidence: { proof: { type: 'measured-fact', fact: 'name is "" (0 chars)' } },
  element: { selector, outerHTML }, source, ...extra,
});
const build = (violations, requireSource = true) => buildScanReportV2([{ page: 'home', url: 'http://127.0.0.1:1/', scannerRuns: RUNS, violations }], CTX(requireSource));
const byRule = (r) => Object.fromEntries(r.pages[0].findings.map((f) => [f.nativeRuleId, f]));
const UNTRACED = { mode: 'url', method: 'unavailable' };

const violations = () => [
  v('button-name', 'button.a', '<button class="a"></button>', { file: 'src/partials/a.liquid', line: 4, confidence: 'medium', method: 'liquid-tag-index' }),
  v('image-alt', 'img.b', '<img class="b" src="b.png">', UNTRACED),
  v('link-name', 'a.c', '<a class="c" href="/c"></a>', { file: 'src/pages/index.liquid', line: null, confidence: 'low', method: 'url-fallback', traceReason: 'multiple-candidates' }),
  v('label', 'input.d', '<input class="d">', { file: 'src/partials/d.liquid', line: 9, confidence: 'low', method: 'liquid-tag-index', traceReason: 'multiple-candidates' }),
];

test('a confirmed finding with no source of at least medium confidence is likely, untraced, with a traceReason', () => {
  const r = build(violations());
  const f = byRule(r);
  assert.deepEqual([f['button-name'].verdict, f['button-name'].untraced], ['confirmed', undefined]);
  for (const rule of ['image-alt', 'link-name', 'label']) {
    assert.equal(f[rule].verdict, 'likely', rule);
    assert.equal(f[rule].untraced, true, rule);
    assert.equal(f[rule].verdictBeforeAgreement, 'confirmed', rule);
  }
  assert.equal(f['image-alt'].source.traceReason, 'unresolved');
  assert.equal(f['link-name'].source.traceReason, 'multiple-candidates');
  assert.equal(f.label.source.traceReason, 'multiple-candidates');
  // the gate and the summary count only what is traced
  assert.equal(r.summary.verdictCounts.confirmed, 1);
  assert.equal(r.summary.verdictCounts.likely, 3);
  // kept in the report with its element and candidates
  assert.equal(f['image-alt'].element.selector, 'img.b');
});

test('the rule needs a source adapter: a scan with no local source tracing leaves verdicts alone', () => {
  const f = byRule(build(violations(), false));
  assert.deepEqual(['button-name', 'image-alt', 'link-name', 'label'].map((r) => f[r].verdict), ['confirmed', 'confirmed', 'confirmed', 'confirmed']);
  assert.equal(f['image-alt'].untraced, undefined);
});

test('vendor and platform findings are not site findings: never confirmed, never marked untraced', () => {
  const r = build([
    v('image-alt', '#vendor-banner img', '<img src="a.png">', UNTRACED, { origin: { owner: 'third-party', kind: 'vendor-script', label: 'Vendor banner', vendor: 'acme', evidence: [] } }),
    v('link-name', '[data-react-component="JobList"] a', '<a href="/jobs"></a>', UNTRACED),
  ]);
  const f = byRule(r);
  assert.equal(f['image-alt'].verdict, 'needs-review');
  assert.equal(f['link-name'].ownership, 'platform');
  for (const finding of r.pages[0].findings) assert.equal(finding.untraced, undefined);
});

test('hasTracedSource: file and line with medium or high; the anchor of an absence finding counts', () => {
  assert.equal(hasTracedSource({ file: 'a.liquid', line: 3, confidence: 'medium' }), true);
  assert.equal(hasTracedSource({ file: 'a.liquid', line: 3, confidence: 'high' }), true);
  assert.equal(hasTracedSource({ file: 'a.liquid', line: 3, confidence: 'low' }), false);
  assert.equal(hasTracedSource({ file: 'a.liquid', line: null, confidence: 'medium' }), false);
  assert.equal(hasTracedSource({ file: null, line: null, confidence: 'none' }), false);
  assert.equal(hasTracedSource({ file: 'src/pages/a.liquid', line: 2, confidence: 'low', method: 'page-level-anchor' }), true);
});

// ── export and harness keep untraced rows usable ─────────────────────────────

test('the fix export keeps an untraced likely row as a task marked "untraced: locate manually"', () => {
  const r = build(violations());
  const set = buildTaskSet(r, {});
  const task = set.tasks.find((t) => t.rule === 'image-alt');
  assert.ok(task, 'the untraced row is still a task');
  assert.equal(task.verdict, 'likely');
  assert.equal(task.untraced, true);
  assert.equal(task.source, null);
  assert.equal(set.tasks.find((t) => t.rule === 'button-name').untraced, undefined);
  const dir = mkdtempSync(join(tmpdir(), 'ada-untraced-out-'));
  try {
    const { dir: out } = writeTaskSet(set, dir);
    const md = [...set.tasks].filter((t) => t.untraced).map((t) => t.fileBase);
    assert.ok(md.length >= 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('harness G1: a new untraced finding (confirmed before the trace rule) still blocks an edit', () => {
  const before = [{ id: 'a', route: '/', rule: 'x', selector: 'a', tier: 'confirmed', rootCauseKey: 'x|a' }];
  const fresh = { id: 'b', route: '/', rule: 'button-name', selector: 'b', rootCauseKey: 'bn|b' };
  const ok = evaluateTargeted({ targetFindingIds: ['a'], affectedRoutes: ['/'], before, after: [{ ...fresh, tier: 'likely' }] });
  assert.equal(ok.pass, true);
  const blocked = evaluateTargeted({ targetFindingIds: ['a'], affectedRoutes: ['/'], before, after: [{ ...fresh, tier: 'likely', untraced: true }] });
  assert.equal(blocked.pass, false);
  assert.equal(blocked.evidence[0].kind, 'NEW_FINDING');
});
