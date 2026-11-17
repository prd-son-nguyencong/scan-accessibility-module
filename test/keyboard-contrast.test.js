import './helpers/hermetic-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeBrowser } from '../src/scanner/browser.js';
import { scanKeyboardNavigation, parseBoxShadows, ringCandidates } from '../src/scanner/keyboard.js';
import { scanPageWithAxe } from '../src/scanner/axe.js';
import { contrastRatio, classifyGlyphSamples, ringContrast, isLargeText } from '../src/scanner/pixel-contrast.js';
import { kindForRule, verdictFor } from '../src/utils/verdict.js';
import { buildScanReportV2 } from '../src/reporter/report-v2.js';
import { requireBrowser } from './helpers/require-browser.js';
import { startParadoxSite } from './helpers/paradox-site-server.js';

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/keyboard-contrast');
const VIEWPORT = { name: 'desktop', width: 1000, height: 700 };

async function withSite(t, fn, extra = {}) {
  const browser = await requireBrowser(t);
  if (!browser) return;
  t.after(closeBrowser);
  const site = await startParadoxSite({ dir: DIR, ...extra });
  try {
    await fn(site.url);
  } finally {
    await site.close();
  }
}

// ─── pure maths: expected values come from the WCAG definition, not from the code under test ─────────

test('WCAG ratio: black on white is 21, #767676 on white is about 4.54', () => {
  assert.equal(contrastRatio([0, 0, 0], [255, 255, 255]).toFixed(2), '21.00');
  assert.equal(contrastRatio([118, 118, 118], [255, 255, 255]).toFixed(2), '4.54');
});

test('glyph verdict: confirmed from 40% failing pixels, needs-review from 10%, else pass', () => {
  const mk = (failing, total) => Array.from({ length: total }, (_, i) => ({ ratio: i < failing ? 1.5 : 9, threshold: 4.5 }));
  assert.equal(classifyGlyphSamples(mk(40, 100)).verdict, 'confirmed');
  assert.equal(classifyGlyphSamples(mk(39, 100)).verdict, 'needs-review');
  assert.equal(classifyGlyphSamples(mk(10, 100)).verdict, 'needs-review');
  assert.equal(classifyGlyphSamples(mk(9, 100)).verdict, 'pass');
  const m = classifyGlyphSamples(mk(50, 100));
  assert.equal(m.min, 1.5);
  assert.equal(m.median, 5.25);
  assert.equal(classifyGlyphSamples([]), null);
});

test('large text starts at 24px, or 18.66px when bold', () => {
  assert.ok(isLargeText(24, 400) && isLargeText(18.66, 700));
  assert.ok(!isLargeText(18.66, 400) && !isLargeText(23.9, 700 - 1));
});

test('ring contrast: outside only when not overlapping; an overlapping ring fails only if it fails both sides', () => {
  const white = [255, 255, 255];
  const black = [0, 0, 0];
  assert.equal(ringContrast({ ring: [242, 242, 242], outside: [white] }).pass, false);
  assert.equal(ringContrast({ ring: [11, 87, 208], outside: [white] }).pass, true);
  assert.equal(ringContrast({ ring: white, outside: [white], inside: [black] }).pass, true);
  assert.equal(ringContrast({ ring: white, outside: [white], inside: [[250, 250, 250]] }).pass, false);
  assert.equal(ringContrast({ ring: white, outside: [] }), null);
  // wholly inside the border box: only the inside neighbour counts
  assert.equal(ringContrast({ ring: [17, 17, 17], outside: [white], inside: [[17, 17, 17]], insideOnly: true }).pass, false);
  assert.equal(ringContrast({ ring: white, outside: [white], inside: [[17, 17, 17]], insideOnly: true }).pass, true);
});

test('computed box-shadow parsing: only new solid rings are candidates', () => {
  const [s] = parseBoxShadows('rgb(11, 87, 208) 0px 0px 0px 3px');
  assert.deepEqual([s.dx, s.dy, s.blur, s.spread, s.inset], [0, 0, 0, 3, false]);
  const fd = (over) => ({ hasOutline: false, outline: { style: 'none', width: 0, offset: 0, color: '' }, baselineBoxShadow: 'none', boxShadow: 'none', ...over });
  assert.equal(ringCandidates(fd({ boxShadow: 'rgb(11, 87, 208) 0px 0px 0px 3px' })).length, 1);
  assert.equal(ringCandidates(fd({ boxShadow: 'rgb(11, 87, 208) 0px 0px 0px 3px', baselineBoxShadow: 'rgb(11, 87, 208) 0px 0px 0px 3px' })).length, 0, 'static shadow');
  assert.equal(ringCandidates(fd({ boxShadow: 'rgba(0, 0, 0, 0.3) 0px 4px 8px 0px' })).length, 0, 'drop shadow');
});

test('verdict kinds: skip-link-target-missing is deterministic, the focus questions are needs-review', () => {
  assert.equal(verdictFor({ kind: kindForRule('keyboard', 'skip-link-target-missing') }), 'confirmed');
  for (const rule of ['focus-indicator-clipped', 'focus-in-cross-origin-frame', 'focus-indicator-low-contrast', 'focus-obscured-by-sticky']) {
    assert.equal(verdictFor({ kind: kindForRule('keyboard', rule) }), 'needs-review', rule);
  }
});

test('report: the new keyboard rules are confirmed with their description as proof only when the scanner says so; a rule with no instance verdict is still a question', () => {
  const run = { layer: 'keyboard', engine: { name: 'keyboard', version: '1' }, status: 'complete' };
  const v = (ruleId, verdict, extra = {}) => ({ ruleId, layer: 'keyboard', impact: 'moderate', verdict, element: { selector: '', outerHTML: '' }, fix: { hint: `${ruleId}: first 5 focusable stops: a "Acme" -> /` }, evidence: { proof: { type: 'measured-fact', fact: `${ruleId}: first 5 focusable stops: a "Acme" -> /` } }, ...extra });
  const f = (violations) => buildScanReportV2([{ page: 'p', url: 'https://example.test/', scannerRuns: [run], violations }], { producer: { version: '0.0.0' }, agreementPolicy: 'off' }).pages[0].findings;
  assert.equal(f([v('skip-link-missing', 'confirmed')])[0].verdict, 'confirmed');
  assert.equal(f([v('skip-link-missing', 'likely')])[0].verdict, 'likely');
  assert.equal(f([v('skip-link-missing', 'needs-review')])[0].verdict, 'needs-review');
  assert.equal(f([v('focus-invisible-stop', 'confirmed')])[0].verdict, 'confirmed');
  assert.equal(f([v('focus-order-illogical', 'confirmed')])[0].verdict, 'needs-review', 'a heuristic rule is never confirmed');
});

// ─── focus ring contrast ─────────────────────────────────────────────────────

test('focus ring is compared with the pixels next to it: fill-coloured offset rings pass, a faint ring fails', async (t) => {
  await withSite(t, async (url) => {
    const { violations } = await scanKeyboardNavigation(`${url}/focus-rings`);
    const low = violations.filter((v) => v.rule === 'focus-indicator-low-contrast').map((v) => v.element.text);
    // true positive that must still fire
    assert.deepEqual(low, ['Faint ring', 'Same fill ring', 'Near fill ring']);
    const msg = violations.find((v) => v.rule === 'focus-indicator-low-contrast').description;
    assert.match(msg, /1\.\d\d:1 contrast against the pixels next to the ring/);
    // false positives: ring equal to the element fill (offset), white ring over a dark fill, shadow ring, UA ring, dark fill + dark ring
    for (const label of ['Offset ring', 'Inset ring', 'Shadow ring', 'UA ring', 'Dark fill ring']) {
      assert.ok(!low.includes(label), `${label} must not be flagged`);
    }
    assert.deepEqual(violations.filter((v) => v.rule === 'focus-not-visible'), []);
  });
});

test('a ring cut by an overflow ancestor is a low-severity clipped note, not a contrast failure', async (t) => {
  await withSite(t, async (url) => {
    const { violations } = await scanKeyboardNavigation(`${url}/focus-clipped`);
    const clipped = violations.filter((v) => v.rule === 'focus-indicator-clipped');
    assert.equal(clipped.length, 1);
    assert.equal(clipped[0].impact, 'minor');
    assert.deepEqual(violations.filter((v) => v.rule === 'focus-indicator-low-contrast'), []);
  });
});

// ─── focus obscured ──────────────────────────────────────────────────────────

test('focus-obscured-by-sticky follows what is painted on top: covered by the header fails, raised above it passes', async (t) => {
  await withSite(t, async (url) => {
    const { violations } = await scanKeyboardNavigation(`${url}/focus-obscured`);
    const obscured = violations.filter((v) => v.rule === 'focus-obscured-by-sticky');
    assert.equal(obscured.length, 1);
    assert.match(obscured[0].description, /"Under header" is covered by fixed <header>/);
    assert.ok(!obscured.some((v) => /Over header/.test(v.description)));
  });
});

// ─── skip link ───────────────────────────────────────────────────────────────

test('skip-link-target-missing: #main-content with no such id fails, with it passes, and keeps the skip-link canonical id', async (t) => {
  await withSite(t, async (url) => {
    const bad = await scanKeyboardNavigation(`${url}/skip-target-missing`);
    const v = bad.violations.find((x) => x.rule === 'skip-link-target-missing');
    assert.ok(v, 'missing target must be reported');
    assert.equal(v.canonicalRuleId, 'skip-link');
    assert.equal(v.impact, 'serious');
    assert.ok(!bad.violations.some((x) => x.rule === 'skip-link-missing'));
    const good = await scanKeyboardNavigation(`${url}/skip-target-present`);
    assert.deepEqual(good.violations.filter((x) => x.rule.startsWith('skip-link')), []);
    assert.ok(good.passes.includes('Skip navigation link present'));
  });
});

test('skip link behind a consent banner: found (no skip-link-missing); dead target reported; none among the first stops still reported; page without <main> reported', async (t) => {
  await withSite(t, async (url) => {
    const ok = await scanKeyboardNavigation(`${url}/skip-after-banner`);
    assert.deepEqual(ok.violations.filter((x) => x.rule.startsWith('skip-link')), []); // banner links do not hide the real skip link
    assert.ok(ok.passes.includes('Skip navigation link present'));
    const dead = await scanKeyboardNavigation(`${url}/skip-after-banner-dead`);
    assert.deepEqual(dead.violations.filter((x) => x.rule.startsWith('skip-link')).map((x) => x.rule), ['skip-link-target-missing']);
    assert.equal(dead.violations.find((x) => x.rule === 'skip-link-target-missing').pageLevel, true);
    const absent = await scanKeyboardNavigation(`${url}/skip-absent`);
    assert.deepEqual(absent.violations.filter((x) => x.rule.startsWith('skip-link')).map((x) => x.rule), ['skip-link-missing']);
    // a nav link named "Main menu" (href="#") is not a skip link, so the missing skip link still shows
    const lookalike = await scanKeyboardNavigation(`${url}/skip-nav-lookalike`);
    assert.deepEqual(lookalike.violations.filter((x) => x.rule.startsWith('skip-link')).map((x) => x.rule), ['skip-link-missing']);
    const noMain = await scanKeyboardNavigation(`${url}/skip-no-main`);
    assert.deepEqual(noMain.violations.filter((x) => x.rule.startsWith('skip-link')).map((x) => x.rule), ['skip-link-target-missing']);
  });
});

test('skip-link-missing: confirmed only when no bypass mechanism exists (no main, no headings, 3+ repeated stops); a main landmark or headings make it likely; small chrome is a question (paired)', async (t) => {
  await withSite(t, async (url) => {
    const get = async (route) => (await scanKeyboardNavigation(`${url}${route}`)).violations.find((x) => x.rule === 'skip-link-missing');
    // Landmark navigation is a sufficient technique (ARIA11): a main landmark with 5 repeated stops is a recommendation, with the first 5 stops listed.
    const withMain = await get('/skip-absent-nav');
    assert.equal(withMain.verdict, 'likely');
    assert.match(withMain.description, /First 5 focusable stops: a "Acme" -> \/; a "Jobs" -> \/jobs; a "Teams" -> \/teams; a "About" -> \/about; a "Contact" -> \/contact/);
    assert.match(withMain.description, /5 header\/nav stops come before the content; a main landmark or heading is there to skip to/);
    // Headings are a bypass technique too (H69).
    assert.equal((await get('/skip-absent-heading-only')).verdict, 'likely');
    // Real defect: 5 repeated stops, no main landmark, no heading and no skip link is the failure 2.4.1 describes.
    assert.equal((await get('/skip-absent-no-target')).verdict, 'confirmed');
    // The same page with a visible skip link: nothing reported.
    assert.equal(await get('/skip-target-present'), undefined);
    // Only 2 header links (small chrome): a question.
    assert.equal((await get('/skip-absent')).verdict, 'needs-review');
  });
});

test('focus-invisible-stop: focus landing on an opacity-0 menu link is confirmed with the count and first stops; display:none, visibility:hidden, aria-hidden and a skip link shown on focus are silent; a custom checkbox or a stop past the Tab window is a question (paired)', async (t) => {
  await withSite(t, async (url) => {
    const get = async (route) => (await scanKeyboardNavigation(`${url}${route}`)).violations.find((x) => x.rule === 'focus-invisible-stop');
    const bad = await get('/invisible-menu-bad');
    assert.equal(bad.verdict, 'confirmed');
    assert.match(bad.description, /3 tabbable elements are not visible .*first: a#?.*\(opacity 0\)/);
    assert.match(bad.description, /Focus landed on 3 invisible elements in the first 40 Tab presses/);
    assert.equal(bad.wcagCriteria, '2.4.7');
    assert.equal(await get('/invisible-menu-good'), undefined);
    // 17 links of one closed menu (opacity 0, pointer-events none): one finding, the count and the container named.
    const many = (await scanKeyboardNavigation(`${url}/invisible-menu-17`)).violations.filter((x) => x.rule === 'focus-invisible-stop');
    assert.equal(many.length, 1);
    assert.equal(many[0].verdict, 'confirmed');
    assert.match(many[0].description, /^17 tabbable elements are not visible .*in ul#site-menu \(17\)\. Focus landed on 17 invisible elements/);
    const checkbox = await get('/invisible-checkbox');
    assert.equal(checkbox.verdict, 'needs-review');
    const late = await get('/invisible-after-window');
    assert.equal(late.verdict, 'needs-review');
    assert.match(late.description, /Focus landed on 0 invisible elements/);
  });
});

test('an empty page gets no keyboard findings (no skip-link-missing)', async (t) => {
  const browser = await requireBrowser(t);
  if (!browser) return;
  t.after(closeBrowser);
  const site = await startParadoxSite({
    routes: { '/': (req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><html lang="en"><head><title>t</title></head><body><script>1</script></body></html>') },
  });
  try {
    const { violations } = await scanKeyboardNavigation(`${site.url}/`);
    assert.deepEqual(violations, []);
  } finally {
    await site.close();
  }
});

// ─── cross-origin iframe ─────────────────────────────────────────────────────

test('a cross-origin iframe without a ring is a needs-review question labelled with its title, not focus-not-visible', async (t) => {
  const browser = await requireBrowser(t);
  if (!browser) return;
  t.after(closeBrowser);
  const other = http.createServer((req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>f</title><button>Play</button>'));
  await new Promise((r) => other.listen(0, '127.0.0.1', r));
  const frameSrc = `http://127.0.0.1:${other.address().port}/`;
  const page = (await readFile(path.join(DIR, 'cross-origin-frame.html'), 'utf8')).replace('__FRAME_SRC__', frameSrc);
  const site = await startParadoxSite({ routes: { '/': (req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(page) } });
  try {
    const { violations } = await scanKeyboardNavigation(`${site.url}/`);
    const frame = violations.find((v) => v.rule === 'focus-in-cross-origin-frame');
    assert.ok(frame, violations.map((v) => v.rule).join(','));
    assert.match(frame.description, /cross-origin/);
    assert.match(frame.description, /"Intro video player"/);
    assert.equal(kindForRule('keyboard', frame.rule), 'heuristic');
    assert.deepEqual(violations.filter((v) => v.rule === 'focus-not-visible'), []);
  } finally {
    await site.close();
    await new Promise((r) => other.close(r));
  }
});

// ─── colour contrast over image backdrops ────────────────────────────────────

const axeOn = (url) => scanPageWithAxe(url, { axe: { viewports: [VIEWPORT] } });
const contrastNodes = (list) => (list || []).filter((v) => v.id === 'color-contrast').flatMap((v) => v.nodes);

test('white text over a bright image is confirmed from pixel sampling, with the measured numbers', async (t) => {
  await withSite(t, async (url) => {
    const res = await axeOn(`${url}/contrast-bright-image`);
    const nodes = contrastNodes(res.violations);
    assert.ok(nodes.length >= 1, 'bright image must fail');
    const px = nodes[0].pixelContrast;
    assert.equal(px.verdict, 'confirmed');
    assert.ok(px.failFraction >= 0.4 && px.min < 1.5, JSON.stringify(px));
    assert.match(px.message, /lowest \d\.\d\d:1, median \d\.\d\d:1; \d+% of \d+ glyph pixels are below/);
    assert.equal(contrastNodes(res.incomplete).filter((n) => n.pixelContrast?.verdict === 'confirmed').length, 0);
  });
});

test('white text over a dark image passes: no violation and no leftover incomplete node', async (t) => {
  await withSite(t, async (url) => {
    const res = await axeOn(`${url}/contrast-dark-image`);
    assert.deepEqual(contrastNodes(res.violations), []);
    assert.deepEqual(contrastNodes(res.incomplete), []);
  });
});

test('a dark text-shadow rescues white text over a bright image: measured with the shadow, it passes', async (t) => {
  await withSite(t, async (url) => {
    const res = await axeOn(`${url}/contrast-text-shadow`);
    assert.deepEqual(contrastNodes(res.violations), []);
    assert.deepEqual(contrastNodes(res.incomplete), []);
    // same text and image without the shadow is the bright-image failure above
    assert.ok(contrastNodes((await axeOn(`${url}/contrast-bright-image`)).violations).length >= 1);
  });
});

test('text that fails over a fifth of its glyph pixels is needs-review with the numbers, not confirmed', async (t) => {
  await withSite(t, async (url) => {
    const res = await axeOn(`${url}/contrast-borderline`);
    assert.deepEqual(contrastNodes(res.violations), []);
    const node = contrastNodes(res.incomplete).find((n) => n.pixelContrast);
    assert.ok(node, 'must stay incomplete with measured numbers');
    assert.equal(node.pixelContrast.verdict, 'needs-review');
    assert.ok(node.pixelContrast.failFraction >= 0.1 && node.pixelContrast.failFraction < 0.4, JSON.stringify(node.pixelContrast));
    assert.match(node.pixelContrast.message, /\d+% of \d+ glyph pixels are below 3:1/);
  });
});

test('text painted by background-clip:text or a transparent fill is never confirmed from pixels: it stays needs-review with the reason (paired with the bright-image failure above)', async (t) => {
  await withSite(t, async (url) => {
    const res = await axeOn(`${url}/contrast-clip-text`);
    assert.deepEqual(contrastNodes(res.violations), [], 'a clip or fill artefact (1.00:1) is not a failure');
    const reasoned = contrastNodes(res.incomplete).filter((n) => n.pixelContrast?.verdict === 'needs-review');
    assert.ok(reasoned.length >= 1, 'measurable-looking nodes stay incomplete with a reason');
    assert.ok(reasoned.every((n) => /background-clip:text|transparent/.test(n.pixelContrast.message) && n.pixelContrast.min === undefined));
    assert.ok(contrastNodes((await axeOn(`${url}/contrast-bright-image`)).violations).length >= 1, 'a real image backdrop still confirms');
  });
});

test('active nav link (red on a charcoal bar that fades in) is still a real 2.9:1 failure (true positive that must keep firing)', async (t) => {
  await withSite(t, async (url) => {
    const res = await axeOn(`${url}/contrast-nav-transition`);
    const nodes = contrastNodes(res.violations);
    assert.equal(nodes.length, 1, JSON.stringify(nodes.map((n) => n.html)));
    assert.match(nodes[0].html, /Careers/);
    // #e41e26 on #2f2f2f: WCAG ratio 2.88 (independent value)
    assert.equal(contrastRatio([228, 30, 38], [47, 47, 47]).toFixed(2), '2.88');
    assert.match(nodes[0].any[0].message, /contrast of 2\.8[78] /);
  });
});

test('a ring seen after a smooth scroll is measured where it is painted: good ring passes, faint ring fails with its true ratio', async (t) => {
  await withSite(t, async (url) => {
    const { violations } = await scanKeyboardNavigation(`${url}/focus-smooth-scroll`);
    const low = violations.filter((v) => v.rule === 'focus-indicator-low-contrast');
    assert.deepEqual(low.map((v) => v.element.text), ['Far faint']);
    const ratio = contrastRatio([242, 242, 242], [255, 255, 255]);
    assert.equal(low[0].element.contrastRatio, ratio.toFixed(2));
  });
});

test('white nav text on a bar that is still fading dark is measured at rest: no false failure (animation freeze)', async (t) => {
  await withSite(t, async (url) => {
    const res = await axeOn(`${url}/contrast-nav-fade`);
    assert.deepEqual(contrastNodes(res.violations), []);
    assert.deepEqual(contrastNodes(res.incomplete), []);
  });
});

test('a link that blurs itself after focus is not sampled at another element: its good ring must not fire a low-contrast finding', async (t) => {
  await withSite(t, async (url) => {
    const { violations } = await scanKeyboardNavigation(`${url}/focus-blur-after`);
    assert.deepEqual(violations.filter((v) => ['focus-indicator-low-contrast', 'focus-indicator-unverified'].includes(v.rule)), []);
  });
});

test('a ring that is not where its styles say (painted under an overlay) is unverified, never a ratio such as 1.00:1', async (t) => {
  await withSite(t, async (url) => {
    const { violations } = await scanKeyboardNavigation(`${url}/focus-ring-hidden`);
    assert.deepEqual(violations.filter((v) => v.rule === 'focus-indicator-low-contrast'), []);
    const un = violations.filter((v) => v.rule === 'focus-indicator-unverified');
    assert.equal(un.length, 1);
    assert.equal(un[0].element.text, 'Covered ring');
    assert.equal(verdictFor({ kind: kindForRule('keyboard', 'focus-indicator-unverified') }), 'needs-review');
  });
});

// ─── focus indicator removed by a reset ──────────────────────────────────────

test('a reset that removes the ring with no replacement is confirmed with pixel proof; replaced, wrapper and child cues are not', async (t) => {
  await withSite(t, async (url) => {
    const { violations } = await scanKeyboardNavigation(`${url}/focus-reset`);
    const nv = Object.fromEntries(violations.filter((v) => v.rule === 'focus-not-visible').map((v) => [v.element.text, v]));
    // real defects: button{outline:0}, a:focus{outline:none}, outline:0 !important
    for (const label of ['Plain reset', 'Anchor reset', 'Important reset']) {
      assert.equal(nv[label]?.verdict, 'confirmed', label);
      assert.match(nv[label].description, /pixels around the element are identical focused and blurred/);
    }
    // not a failure: replacement ring, strong fill change, UA ring kept for keyboard
    for (const label of ['Ring replaced', 'Fill replaced', 'Mouse only', 'Weak fill']) assert.ok(!nv[label], `${label} must not be focus-not-visible`);
    // the cue is somewhere the control's own styles do not show: a question, never confirmed
    assert.equal(nv['Child cue']?.verdict, 'needs-review');
    assert.equal(nv['']?.verdict, 'needs-review', 'wrapper cue (:focus-within border) is a question, never confirmed');
    assert.match(nv[''].description, /wrapper or a sibling changes on focus/);
    // a fill change of about 1.1:1 is the only cue: measured low contrast, not "no indicator"
    const weak = violations.filter((v) => v.rule === 'focus-indicator-low-contrast');
    assert.deepEqual(weak.map((v) => v.element.text), ['Weak fill']);
    assert.match(weak[0].description, /background change .* 1\.\d\d:1/);
  });
});

test('a transparent resting background is flattened onto its backdrop: a faint fill-only cue is measured, a strong one passes', async (t) => {
  await withSite(t, async (url) => {
    const { violations } = await scanKeyboardNavigation(`${url}/focus-fill-transparent`);
    const weak = violations.filter((v) => v.rule === 'focus-indicator-low-contrast');
    assert.deepEqual(weak.map((v) => v.element.text), ['Transparent weak']);
    assert.match(weak[0].description, /background change rgb\(245, 245, 243\) to rgb\(235, 235, 230\), 1\.\d\d:1/);
    assert.deepEqual(violations.filter((v) => v.rule === 'focus-not-visible').map((v) => v.element.text), []);
  });
});

test('text in a menu drawer that is not rendered at load is measured after the trigger opens it, and the drawer is closed again', async (t) => {
  await withSite(t, async (url) => {
    const res = await axeOn(`${url}/drawer-contrast`);
    const nodes = contrastNodes(res.violations);
    assert.deepEqual(nodes.map((n) => n.html.match(/>([^<]+)</)[1]), ['Pale drawer link']);
  });
});

test('a large reset element is never confirmed from a clipped screenshot: a child cue outside the clip stays needs-review', async (t) => {
  await withSite(t, async (url) => {
    const { violations } = await scanKeyboardNavigation(`${url}/focus-reset-big`);
    const nv = Object.fromEntries(violations.filter((v) => v.rule === 'focus-not-visible').map((v) => [v.element.text, v]));
    assert.equal(nv['Read moreBig card']?.verdict, 'needs-review');
    // real defect of the same family: a small control with no cue is still confirmed
    assert.equal(nv['Plain small']?.verdict, 'confirmed');
  });
});

test('focus-not-visible is deterministic: the scanner decides confirmed or needs-review per instance', () => {
  assert.equal(kindForRule('keyboard', 'focus-not-visible'), 'deterministic');
});
