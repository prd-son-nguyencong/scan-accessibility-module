import './helpers/hermetic-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closeBrowser } from '../src/scanner/browser.js';
import { judgeFocusReturn, judgeReflow, judgeRoleButton, scanFocusReturn, scanReflow, scanRoleButtons } from '../src/scanner/behavior-checks.js';
import { requireBrowser } from './helpers/require-browser.js';

async function withPage(t, html, fn) {
  const browser = await requireBrowser(t);
  if (!browser) return;
  t.after(closeBrowser);
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  try {
    await page.setContent(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>t</title><style>body{margin:0}</style></head><body>${html}</body></html>`);
    await fn(page);
  } finally { await page.context().close(); }
}

test('judgements: reflow needs a visible offender, focus return needs the panel to close, role=button needs a click listener (paired)', () => {
  assert.equal(judgeReflow({ scrollWidth: 320, clientWidth: 320, offenders: [], exempt: 0 }), null);
  assert.equal(judgeReflow({ scrollWidth: 900, clientWidth: 320, offenders: [], exempt: 2 }), null, 'only exempt content sticks out');
  assert.equal(judgeReflow({ scrollWidth: 900, clientWidth: 320, offenders: [{ selector: 'div.x', right: 900, width: 880 }], exempt: 0 }).verdict, 'confirmed');
  assert.equal(judgeReflow({ scrollWidth: 900, clientWidth: 320, offenders: [{ selector: 'div.x', right: 900, width: 880 }], exempt: 0, clippedByOverflowHidden: true }).verdict, 'needs-review');
  assert.equal(judgeFocusReturn({ focused: true, opened: true, closed: true, activeIsTrigger: false, activeTag: 'BODY' }).verdict, 'likely', 'body alone: the Tab landing decides (test/focus-recall.test.js)');
  assert.equal(judgeFocusReturn({ focused: true, opened: true, closed: true, activeIsTrigger: true, activeTag: 'BUTTON' }).verdict, 'pass');
  assert.equal(judgeFocusReturn({ focused: true, opened: true, closed: false, activeTag: 'BODY' }), null, 'Escape does not close it: another rule');
  assert.equal(judgeRoleButton({ hasClickListener: false, focusable: false }), null);
  assert.equal(judgeRoleButton({ hasClickListener: true, hasKeyListener: false, focusable: true, enterClicks: 1, spaceClicks: 1 }), null);
  assert.equal(judgeRoleButton({ hasClickListener: true, hasKeyListener: false, focusable: true, enterClicks: 0, spaceClicks: 1 }).verdict, 'confirmed');
  assert.equal(judgeRoleButton({ hasClickListener: true, hasKeyListener: true, focusable: true, enterClicks: 0, spaceClicks: 0 }).verdict, 'needs-review');
});

test('reflow: a fixed-width block makes the document scroll at 320px and is confirmed with scrollWidth vs 320; the viewport is restored', async (t) => {
  await withPage(t, '<main><div class="wide" style="width:800px;height:40px">Wide content that does not wrap</div><p>ok</p></main>', async (page) => {
    const [row] = await scanReflow(page);
    assert.equal(row.verdict, 'confirmed');
    assert.match(row.evidence.proof.fact, /document scrollWidth 800 vs 320 \(viewport 320 x 568\); widest: div\.wide \(right edge 800px, width 800px\)/);
    assert.deepEqual(page.viewportSize(), { width: 1280, height: 900 });
  });
});

test('reflow: a responsive page, a table or image in its own scroll, and exempt tables raise nothing (paired)', async (t) => {
  await withPage(t, '<main style="max-width:100%"><div style="overflow-x:auto;width:100%"><table style="width:900px"><tr><td>a</td></tr></table></div><p>text that wraps inside the viewport</p></main>', async (page) => {
    assert.deepEqual(await scanReflow(page), []);
  });
  await withPage(t, '<main><table style="width:900px"><tr><td>a</td></tr></table></main>', async (page) => {
    assert.deepEqual(await scanReflow(page), [], 'a data table may scroll in two dimensions');
  });
});

const MENU = (handler) => `<button id="m" type="button" aria-expanded="false" aria-controls="p">Menu</button><div id="p" hidden><a href="#x">One</a></div>
<script>
const b = document.getElementById('m'), p = document.getElementById('p');
b.addEventListener('click', () => { p.hidden = !p.hidden; b.setAttribute('aria-expanded', String(!p.hidden)); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !p.hidden) { p.hidden = true; b.setAttribute('aria-expanded', 'false'); ${handler} } });
</script>`;

test('focus return: Escape that closes the panel and leaves focus on body is likely (the next Tab continues near the trigger); one that returns focus to the trigger passes (paired)', async (t) => {
  await withPage(t, MENU('document.activeElement.blur();'), async (page) => {
    const [row] = await scanFocusReturn(page);
    assert.equal(row.rule, 'focus-lost-after-escape');
    assert.equal(row.verdict, 'likely');
    assert.match(row.description, /Escape closed it and document\.activeElement is <body>/);
  });
  await withPage(t, MENU('b.focus();'), async (page) => {
    assert.deepEqual(await scanFocusReturn(page), []);
  });
});

test('focus return: a panel that Escape does not close is not this rule (paired)', async (t) => {
  await withPage(t, '<button id="m" type="button" aria-expanded="false" aria-controls="p">Menu</button><div id="p" hidden>x</div><script>m.onclick=()=>{p.hidden=false;m.setAttribute("aria-expanded","true")}</script>', async (page) => {
    assert.deepEqual(await scanFocusReturn(page), []);
  });
});

test('role=button: an anchor without href cannot be focused; a div with tabindex but no key handler gets no click from Enter or Space; a keyboard-wired one passes (paired)', async (t) => {
  const html = `<a id="a1" role="button">Open</a><div id="d1" role="button" tabindex="0">Send</div><div id="d2" role="button" tabindex="0">Ok</div><button id="n1">Native</button>
  <script>
  for (const id of ['a1', 'd1', 'd2']) document.getElementById(id).addEventListener('click', () => {});
  document.getElementById('d2').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.currentTarget.click(); } });
  </script>`;
  await withPage(t, html, async (page) => {
    const rows = await scanRoleButtons(page);
    const byId = Object.fromEntries(rows.map((r) => [r.element.selector, r]));
    assert.deepEqual(Object.keys(byId).sort(), ['#a1', '#d1'], JSON.stringify(rows.map((r) => r.element.selector)));
    assert.match(byId['#a1'].evidence.proof.fact, /cannot take keyboard focus/);
    assert.match(byId['#d1'].evidence.proof.fact, /Enter 0, Space 0/);
  });
});

test('role=button with no click listener at all is not reported (paired)', async (t) => {
  await withPage(t, '<a id="a1" role="button">Open</a>', async (page) => {
    assert.deepEqual(await scanRoleButtons(page), []);
  });
});
