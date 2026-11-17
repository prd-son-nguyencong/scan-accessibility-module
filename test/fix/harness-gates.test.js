// Live gate tests on the neutral harness-site fixture: each bad change must fail its gate, each good change must pass all of them.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { requireBrowser } from '../helpers/require-browser.js';
import { HARNESS_SITE_SRC, renderHarnessSite, serveDir } from '../helpers/harness-site.mjs';
import { captureSnapshot, runGates, VIEWPORTS } from '../../src/fix/harness/index.js';
import { closeBrowser } from '../../src/scanner/browser.js';

const work = mkdtempSync(join(tmpdir(), 'harness-gates-'));
after(async () => { await closeBrowser(); rmSync(work, { recursive: true, force: true }); });

const ROUTES = ['/', '/about'];
const VPS = [VIEWPORTS[0], VIEWPORTS[2]];
const HEADER = 'partials/header.liquid', CSS = 'styles/site.css', JS = 'scripts/menu.js';

/** Copies the fixture, applies mutate(dir), renders, serves and snapshots it. Returns { src, snap }. */
async function variant(name, mutate = () => {}, { perf = false } = {}) {
  const src = join(work, name, 'src');
  cpSync(HARNESS_SITE_SRC, src, { recursive: true });
  mutate(src);
  const out = join(work, name, 'out');
  renderHarnessSite(src, out);
  const server = await serveDir(out);
  try {
    const snap = await captureSnapshot({ baseUrl: server.url, routes: ROUTES, viewports: VPS, dir: join(work, name, 'shots'), perfRuns: perf ? 3 : 0, perfRoutes: ['/'], timeBudgetMs: 120000 });
    return { src, snap };
  } finally { await server.close(); }
}
const edit = (file, from, to) => (dir) => {
  const p = join(dir, file);
  const t = readFileSync(p, 'utf8');
  assert.ok(t.includes(from), `fixture drift: ${from}`);
  writeFileSync(p, t.replace(from, to));
};
const gate = (res, id) => res.gates.find((g) => g.gate === id);
const compare = (base, after_, extra = {}) => runGates({ before: base.snap, after: after_.snap, beforeTree: base.src, afterTree: after_.src, only: ['G2', 'G3', 'G4', 'G5', 'G6'], ...extra });

let base;
test('baseline snapshot is complete and deterministic', async (t) => {
  if (!(await requireBrowser(t))) return;
  base = await variant('base', () => {}, { perf: true });
  const again = await variant('base2');
  assert.equal(base.snap.truncated, false);
  for (const route of ROUTES) for (const vp of ['375x812', '1280x800']) {
    const c = base.snap.routes[route][vp];
    assert.ok(!c.error, c.error);
    assert.ok(Object.keys(c.layout).length > 8 && c.tabOrder.length >= 2 && c.a11yTree && c.links.length >= 2);
    assert.equal(c.console.length, 0);
  }
  assert.equal(base.snap.perf['/'].runs.length, 3);
  assert.ok(base.snap.perf['/'].runs[0].fcp > 0 && base.snap.perf['/'].runs[0].transfer > 0);
  const same = runGates({ before: base.snap, after: again.snap, beforeTree: base.src, afterTree: again.src, only: ['G2', 'G3', 'G4', 'G5', 'G6'] });
  assert.equal(same.pass, true, JSON.stringify(same.gates.filter((g) => !g.pass)));
  assert.deepEqual(base.snap.routes['/']['1280x800'].layout, again.snap.routes['/']['1280x800'].layout);
});

test('good change: aria-label on the icon button plus an sr-only skip link passes G2..G7', async (t) => {
  if (!base) return t.skip('no browser');
  const good = await variant('good', (d) => {
    edit(HEADER, '<button class="menu-btn"', '<button class="menu-btn" aria-label="Menu"')(d);
    edit(HEADER, '<header class="site-header"', '<a class="skip-link" href="#main">Skip to content</a>\n<header class="site-header"')(d);
    writeFileSync(join(d, 'styles/site.css'), `${readFileSync(join(d, 'styles/site.css'), 'utf8')}.skip-link { position: absolute; left: -9999px; }\n.skip-link:focus { left: 0; }\n`);
  }, { perf: true });
  const skipKey = 'html:nth(1) > body:nth(1) > a:nth(1)';
  assert.ok(good.snap.routes['/']['1280x800'].layout[skipKey]?.hid, 'skip link present in layout and visually hidden');
  const res = runGates({ before: base.snap, after: good.snap, beforeTree: base.src, afterTree: good.src, allowlist: [{ file: HEADER }, { file: CSS }], documented: [skipKey], only: ['G2', 'G3', 'G4', 'G5', 'G6', 'G7'] });
  assert.equal(res.pass, true, JSON.stringify(res.gates.filter((g) => !g.pass), null, 1));
});

test('bad change: padding shifts layout (G3, G4, G5 fail)', async (t) => {
  if (!base) return t.skip('no browser');
  const bad = await variant('pad', edit(CSS, 'padding: 12px 24px', 'padding: 28px 24px'));
  const res = compare(base, bad, { allowlist: [{ file: CSS }] });
  assert.deepEqual(res.failed, ['G3', 'G4', 'G5']);
  assert.ok(gate(res, 'G3').regions.length > 0);
});

test('bad change: colour change (G2 design lock, G4, G5 fail; layout intact)', async (t) => {
  if (!base) return t.skip('no browser');
  const bad = await variant('colour', edit(CSS, '.hero h1 { margin: 0 0 8px; color: #222;', '.hero h1 { margin: 0 0 8px; color: #b00020;'));
  const res = compare(base, bad, { allowlist: [{ file: CSS }] });
  assert.deepEqual(res.failed, ['G2', 'G4', 'G5']);
  assert.equal(compare(base, bad, { allowlist: [{ file: CSS }], designLock: false }).failed.includes('G2'), false);
});

test('bad change: removed data-pdk attribute (G2 fails, rendering identical)', async (t) => {
  if (!base) return t.skip('no browser');
  const bad = await variant('pdk', edit(HEADER, ' data-pdk-region="header"', ''));
  const res = compare(base, bad, { allowlist: [{ file: HEADER }] });
  assert.deepEqual(res.failed, ['G2']);
  assert.ok(gate(res, 'G2').evidence.some((e) => e.kind === 'BACKEND_TOKEN_REMOVED_OR_EDITED'));
});

test('bad change: added console error (G6 fails)', async (t) => {
  if (!base) return t.skip('no browser');
  const bad = await variant('console', (d) => writeFileSync(join(d, 'scripts/menu.js'), `${readFileSync(join(d, 'scripts/menu.js'), 'utf8')}console.error('seeded failure');\n`));
  const res = compare(base, bad, { allowlist: [{ file: JS }] });
  assert.deepEqual(res.failed, ['G6']);
  assert.ok(gate(res, 'G6').evidence.some((e) => e.kind === 'NEW_CONSOLE_ERROR'));
});

test('bad change: slower script (G7 fails on TBT)', async (t) => {
  if (!base) return t.skip('no browser');
  const slow = await variant('slow', (d) => writeFileSync(join(d, 'scripts/menu.js'), `${readFileSync(join(d, 'scripts/menu.js'), 'utf8')}window.addEventListener('load', () => setTimeout(() => { const e = Date.now() + 400; while (Date.now() < e); }, 20));\n`), { perf: true });
  const res = runGates({ before: base.snap, after: slow.snap, only: ['G3', 'G5', 'G6', 'G7'] });
  assert.deepEqual(res.failed, ['G7']);
  assert.ok(gate(res, 'G7').evidence.some((e) => e.metric === 'tbt'));
});

test('missing evidence fails closed', () => {
  const res = runGates({ only: ['G1', 'G2', 'G3', 'G7', 'G8'] });
  assert.equal(res.pass, false);
  assert.deepEqual(res.failed, ['G1', 'G2', 'G3', 'G7', 'G8']);
});
