import './helpers/hermetic-env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeBrowser } from '../src/scanner/browser.js';
import { scanBehaviorChecks, judgeEscapeDismiss, judgeEscapeInsidePanel, judgeExpandedUpdated, judgeLinksReachable, scanMenuKeyboard } from '../src/scanner/behavior-checks.js';
import { requireBrowser } from './helpers/require-browser.js';

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/menu-keyboard');

async function rulesFor(t, name) {
  const browser = await requireBrowser(t);
  if (!browser) return null;
  t.after(closeBrowser);
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  try {
    await page.setContent(fs.readFileSync(path.join(DIR, name), 'utf8'));
    return (await scanMenuKeyboard(page)).map((r) => r.rule);
  } finally { await page.context().close(); }
}

test('menu keyboard judgements are pure and paired with the correct case', () => {
  assert.equal(judgeLinksReachable({ newLinks: [{ label: 'One', tabindex: '-1' }], reached: false }).verdict, 'confirmed');
  assert.equal(judgeLinksReachable({ newLinks: [{ label: 'One' }], reached: true }), null);
  assert.equal(judgeLinksReachable({ newLinks: [], reached: false }), null, 'nothing appeared: nothing measured');
  assert.equal(judgeEscapeInsidePanel({ focusedInside: true, closed: true, activeIsTrigger: false, activeTag: 'BODY' }).verdict, 'likely', 'body alone: the Tab landing decides (test/focus-recall.test.js)');
  assert.equal(judgeEscapeInsidePanel({ focusedInside: true, closed: true, activeIsTrigger: true, activeTag: 'BUTTON' }), null);
  assert.equal(judgeEscapeInsidePanel({ focusedInside: true, closed: false, activeIsTrigger: false, activeTag: 'A' }), null);
  assert.equal(judgeEscapeDismiss({ openedOnFocus: true, openAfterEscape: true }).verdict, 'confirmed');
  assert.equal(judgeEscapeDismiss({ openedOnFocus: true, openAfterEscape: true, openAfterEscapeInside: false }), null, 'closes with Escape inside the panel');
  assert.equal(judgeEscapeDismiss({ openedOnFocus: true, openAfterEscape: false }), null);
  assert.equal(judgeExpandedUpdated({ hadAttr: true, before: 'false', after: 'false', opened: true }).verdict, 'confirmed');
  assert.equal(judgeExpandedUpdated({ hadAttr: true, before: 'false', after: 'true', opened: true }), null);
  assert.equal(judgeExpandedUpdated({ hadAttr: false, before: null, after: null, opened: true }), null, 'missing attribute is the disclosure rule');
});

test('menu keyboard: a correct menu, a roving-tabindex menu and a hover menu with a keyboard alternative raise nothing', async (t) => {
  for (const f of ['correct-menu.html', 'roving-menu.html', 'hover-with-keyboard.html', 'focus-menu-escape.html', 'scroll-link-correct.html', 'far-panel-correct.html', 'aria-hidden-nav-correct.html']) {
    const rules = await rulesFor(t, f);
    if (rules) assert.deepEqual(rules, [], f);
  }
});

test('menu keyboard: each broken widget is confirmed by its own rule from real key presses', async (t) => {
  const cases = {
    'escape-focus-lost.html': ['focus-lost-after-escape'],
    // aria-hidden on a visible nav is its own defect: the keyboard behaviour must still be measured
    'aria-hidden-nav-focus-lost.html': ['focus-lost-after-escape'],
    'links-unreachable.html': ['menu-links-unreachable-by-keyboard'],
    'focus-menu-no-escape.html': ['dropdown-not-dismissible-with-escape'],
    'expanded-static.html': ['aria-expanded-not-updated'],
    // a scroll-triggered back-to-top link must not hide a real defect of the same family
    'scroll-link-focus-menu-no-escape.html': ['dropdown-not-dismissible-with-escape'],
    'scroll-link-links-unreachable.html': ['menu-links-unreachable-by-keyboard'],
  };
  for (const [f, want] of Object.entries(cases)) {
    const rules = await rulesFor(t, f);
    if (rules) assert.deepEqual(rules, want, f);
  }
});

test('a hamburger that only exists at mobile width is driven at the mobile width; the page viewport is restored', async (t) => {
  const browser = await requireBrowser(t);
  if (!browser) return;
  t.after(closeBrowser);
  for (const [f, want] of [['mobile-hamburger-focus-lost.html', ['focus-lost-after-escape']], ['mobile-hamburger-correct.html', []]]) {
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    try {
      await page.setContent(fs.readFileSync(path.join(DIR, f), 'utf8'));
      const rows = await scanBehaviorChecks(page);
      assert.deepEqual([...new Set(rows.filter((r) => r.rule !== 'reflow-horizontal-scroll').map((r) => r.rule))], want, f);
      assert.deepEqual(page.viewportSize(), { width: 1280, height: 900 });
    } finally { await page.context().close(); }
  }
});

// ---- l3: behaviour false positives (round 5) ----

test('links reachability: a link in the tab order ahead of the trigger is reachable; only links outside the tab order are confirmed', () => {
  const before = { label: 'Explore', tabindex: null, tabbable: true, before: true };
  const later = { label: 'Explore', tabindex: null, tabbable: true, before: false };
  const roving = { label: 'One', tabindex: '-1', tabbable: false, before: false };
  assert.equal(judgeLinksReachable({ newLinks: [before], reached: false }), null, 'FP: Tab from the previous stop reaches it');
  const near = { label: 'Two', tabindex: null, tabbable: true, before: false, stops: 2 };
  const far = { ...later, stops: 14 };
  assert.equal(judgeLinksReachable({ newLinks: [later], reached: false }).verdict, 'needs-review', 'distance unknown: undecidable');
  assert.equal(judgeLinksReachable({ newLinks: [far], reached: false }).verdict, 'needs-review', 'in the tab order but beyond the walk: undecidable');
  assert.equal(judgeLinksReachable({ newLinks: [near], reached: false }).verdict, 'confirmed', 'TRUE defect: within the walk and still not reached (Tab swallowed)');
  assert.equal(judgeLinksReachable({ newLinks: [before, roving], reached: false }).verdict, 'confirmed', 'TRUE defect: a tabbable link ahead of the trigger does not hide the tabindex -1 links');
  assert.equal(judgeLinksReachable({ newLinks: [roving], reached: false }).verdict, 'confirmed', 'true defect: tabindex -1');
  assert.equal(judgeLinksReachable({ newLinks: [roving, later], reached: false }).verdict, 'confirmed', 'TRUE defect: tabindex -1 links are unreachable whatever the far tabbable link does');
  assert.equal(judgeLinksReachable({ newLinks: [roving, far], reached: false }).verdict, 'confirmed');
  assert.equal(judgeLinksReachable({ newLinks: [near, far], reached: false }).verdict, 'confirmed', 'TRUE defect: a near tabbable link not reached is confirmed even with a far one beside it (mega menu)');
  assert.match(judgeLinksReachable({ newLinks: [near, far], reached: false }).fact, /1 link\(s\)/, 'the fact lists only the near link');
  assert.equal(judgeLinksReachable({ newLinks: [far, near], reached: false }).verdict, 'confirmed', 'order does not matter');
  assert.match(judgeLinksReachable({ newLinks: [roving, far], reached: false }).fact, /1 link\(s\)/, 'the fact lists only the links outside the tab order');
});

test('menu keyboard: a card CTA that becomes visible before the trigger is not reported; tabindex -1 links still are', async (t) => {
  assert.deepEqual(await rulesFor(t, 'link-before-trigger.html') ?? [], []);
  assert.deepEqual(await rulesFor(t, 'megamenu-correct.html') ?? [], [], 'control: a 14-link mega menu where nothing is swallowed has no finding');
  const rules = await rulesFor(t, 'links-unreachable.html');
  if (rules) assert.deepEqual(rules, ['menu-links-unreachable-by-keyboard']);
  // TRUE defects (round 5 review): a Close button before the trigger must not hide tabindex -1 panel links; a Tab-swallowing handler with links 2 stops away confirms
  for (const f of ['links-unreachable-with-close-before.html', 'links-unreachable-tab-trap.html', 'links-unreachable-mixed-far-after.html', 'links-unreachable-megamenu-tab-trap.html']) {
    const r = await rulesFor(t, f);
    if (r) assert.deepEqual(r, ['menu-links-unreachable-by-keyboard'], f);
  }
});

test('menu keyboard: the confirmed verdict holds for all four true-defect fixtures', async (t) => {
  const browser = await requireBrowser(t);
  if (!browser) return;
  t.after(closeBrowser);
  for (const f of ['links-unreachable-with-close-before.html', 'links-unreachable-tab-trap.html', 'links-unreachable-mixed-far-after.html', 'links-unreachable-megamenu-tab-trap.html']) {
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    try {
      await page.setContent(fs.readFileSync(path.join(DIR, f), 'utf8'));
      assert.deepEqual((await scanMenuKeyboard(page)).map((r) => r.verdict), ['confirmed'], f);
    } finally { await page.context().close(); }
  }
});

test('focus-open escape check: confirmed at the loaded viewport; a resized viewport is needs-review', async (t) => {
  assert.equal(judgeEscapeDismiss({ openedOnFocus: true, openAfterEscape: true, resized: false }).verdict, 'confirmed');
  assert.equal(judgeEscapeDismiss({ openedOnFocus: true, openAfterEscape: true, resized: true }).verdict, 'needs-review');
  const browser = await requireBrowser(t);
  if (!browser) return;
  t.after(closeBrowser);
  const run = async (f) => {
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    try {
      await page.setContent(fs.readFileSync(path.join(DIR, f), 'utf8'));
      return (await scanBehaviorChecks(page)).filter((r) => r.rule === 'dropdown-not-dismissible-with-escape').map((r) => r.verdict);
    } finally { await page.context().close(); }
  };
  // FP: the toggle only exists below 600px, the page bound its focus handler at load width 1280, the scan then resized to 390
  assert.deepEqual(await run('mobile-focus-open-width-bound.html'), ['needs-review']);
  // TRUE defect: a focus menu at the loaded viewport still confirms
  assert.deepEqual(await run('focus-menu-no-escape.html'), ['confirmed']);
  // policy: a CSS-only :focus-within menu whose toggle exists only at mobile width is measured after the resize, so it is needs-review (undecidable), not hidden
  assert.deepEqual(await run('css-mobile-focus-within.html'), ['needs-review']);
});
