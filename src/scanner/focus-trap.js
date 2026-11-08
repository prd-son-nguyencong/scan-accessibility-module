import { resilientGoto } from './browser.js';
import { acquirePage } from './session.js';
import { mapDescriptionToSource } from '../tracer/partial-map.js';
import { getThirdPartyConfig } from '../utils/third-party.js';
import { blockedScriptsOf } from './blocked-scripts.js';

const PAGE_TIMEOUT_MS = 60000;
const TAB_CYCLES_TO_CHECK = 15;
const MAX_TRIGGERS = 25; // safety cap; every detected trigger is tested up to this
const TRIGGER_ATTR = 'data-ada-ft-trigger';
const DIALOG_ATTR = 'data-ada-ft-dialog';
const DIALOG_SELECTOR = '[role="dialog"], dialog[open]';

/**
 * Layer 2: Focus Trap Scanner
 *
 * Tests modal/dialog elements for proper focus management:
 * 1. Opening a modal moves focus inside it
 * 2. Tab key cycles focus within the modal (does not escape)
 * 3. Shift+Tab reverse-cycles within the modal
 * 4. Escape key closes the modal
 *
 * Specifically tests: .oliviaButton (Paradox chatbot), [role="dialog"],
 * dialog[open], and common modal trigger patterns.
 */
export async function scanFocusTraps(pageUrl, opts = {}) {
  const { page, close } = await acquirePage(pageUrl, opts);
  const violations = [];
  const passes = [];

  try {
    // Find all elements that trigger modals/dialogs. The chatbot trigger is
    // config-driven (config.thirdParty.chatbotSelector) instead of hardcoded.
    const chatbotSelector = getThirdPartyConfig().chatbotSelector;
    const triggers = await collectTriggers(page, chatbotSelector);

    // Find static open dialogs (already in DOM with open or role=dialog)
    const staticDialogs = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('[role="dialog"], dialog')).map((el) => ({
        id: el.id,
        ariaLabel: el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.getAttribute('title') || '',
        // Only an open dialog is exposed to assistive technology: a closed one (hidden, display:none, a <dialog> without open) has no name to judge.
        isVisible: el.isConnected && el.checkVisibility({ checkVisibilityCSS: true }),
      }));
    });

    // Check static dialogs for required ARIA attributes
    for (const dialog of staticDialogs) {
      if (dialog.isVisible && !dialog.ariaLabel) {
        violations.push({
          rule: 'dialog-no-label',
          description: `Open dialog element${dialog.id ? ` #${dialog.id}` : ''} is missing an accessible name (aria-label, aria-labelledby or title); advisory (axe aria-dialog-name, best practice)`,
          impact: 'moderate',
          wcagCriteria: null,
          element: { selector: dialog.id ? `#${dialog.id}` : '[role="dialog"]' },
        });
      }
    }

    // Read before the trigger tests dirty the page (they used to read it after their last reload).
    const missingAriaModal = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('[role="dialog"]'))
        .filter((el) => el.getAttribute('aria-modal') !== 'true')
        .map((el) => el.id || el.getAttribute('class') || '[role=dialog]');
    });

    // Test focus trap behavior for each trigger
    const tested = Math.min(triggers.length, MAX_TRIGGERS);
    for (let i = 0; i < tested; i++) {
      try {
        // Re-tag after every reload so index i always means the same element.
        const current = i === 0 ? triggers : await collectTriggers(page, chatbotSelector);
        if (current[i]?.key !== triggers[i].key) continue;
        await testModalFocusTrap(page, triggers[i], violations, passes);
      } catch {
        // Modal test failed — don't block overall scan
      }
      // Reload to reset state between modal tests, even after a failed one; nothing reads the page after the last
      if (i < tested - 1) await resilientGoto(page, pageUrl, { timeout: PAGE_TIMEOUT_MS }).catch(() => {});
    }

    if (missingAriaModal.length > 0) {
      violations.push({
        rule: 'dialog-missing-aria-modal',
        description: `${missingAriaModal.length} dialog element(s) missing aria-modal="true": ${missingAriaModal.slice(0, 3).join(', ')}`,
        impact: 'moderate',
        wcagCriteria: '4.1.2',
        element: null,
      });
    }
  } finally {
    await close();
  }

  const source = await mapDescriptionToSource(pageUrl);
  return { url: pageUrl, violations: violations.map((v) => ({ ...v, layer: 'focusTrap', source })), passes, blockedScripts: blockedScriptsOf(page), timestamp: new Date().toISOString() };
}

/**
 * Every distinct trigger element in DOM order (an element matching several selectors is
 * listed once). Each one is tagged with its index so it can be clicked exactly.
 */
async function collectTriggers(page, chatbot) {
  return page.evaluate(({ chatbot, attr }) => {
    const selectors = ['[aria-haspopup="dialog"]', '[data-modal-trigger]', '[data-toggle="modal"]', 'button[aria-controls]', ...(chatbot ? [chatbot] : [])];
    const els = [...new Set(selectors.flatMap((sel) => Array.from(document.querySelectorAll(sel))))];
    document.querySelectorAll(`[${attr}]`).forEach((e) => e.removeAttribute(attr));
    return els.map((el, i) => {
      el.setAttribute(attr, String(i));
      return {
        index: i,
        selector: selectors.find((sel) => el.matches(sel)),
        text: (el.textContent || '').trim().slice(0, 60),
        ariaLabel: el.getAttribute('aria-label') || '',
        ariaControls: el.getAttribute('aria-controls') || '',
        key: `${el.tagName}|${(el.textContent || '').trim().slice(0, 60)}|${el.getAttribute('aria-controls') || ''}`,
      };
    });
  }, { chatbot, attr: TRIGGER_ATTR });
}

async function testModalFocusTrap(page, trigger, violations, passes) {
  const label = trigger.text || trigger.ariaLabel;
  const triggerLocator = page.locator(`[${TRIGGER_ATTR}="${trigger.index}"]`);
  if (!(await triggerLocator.isVisible())) return;

  // Dialogs already open before the click are not what this trigger opens.
  await page.evaluate(({ sel, attr }) => {
    // checkVisibility, not offsetParent: that is null for position:fixed so it cannot tell open from closed.
    const isShown = (d) => d.isConnected && d.checkVisibility({ checkVisibilityCSS: true });
    document.querySelectorAll(sel).forEach((d) => { if (isShown(d)) d.setAttribute(attr, 'before'); });
  }, { sel: DIALOG_SELECTOR, attr: DIALOG_ATTR });

  await triggerLocator.click({ timeout: 3000 });
  await page.waitForTimeout(500); // Wait for modal animation

  // The dialog that appeared because of the click (not tagged 'before' and now shown).
  const dialogOpened = await page.evaluate(({ sel, attr }) => {
    // checkVisibility, not offsetParent: that is null for position:fixed so it cannot tell open from closed.
    const isShown = (d) => d.isConnected && d.checkVisibility({ checkVisibilityCSS: true });
    const opened = Array.from(document.querySelectorAll(sel)).find((d) => d.getAttribute(attr) !== 'before' && isShown(d));
    if (opened) opened.setAttribute(attr, 'opened');
    return !!opened;
  }, { sel: DIALOG_SELECTOR, attr: DIALOG_ATTR });

  if (!dialogOpened) return;

  // A confirmed trap failure needs a modal the scanner opened (role=dialog + aria-modal=true, or a native modal <dialog>) and every script of the page loaded.
  const opened = await page.evaluate((attr) => {
    const d = document.querySelector(`[${attr}="opened"]`);
    if (!d) return { modal: false, role: '' };
    const modal = d.getAttribute('aria-modal') === 'true' || (d.matches('dialog') && d.matches(':modal'));
    return { modal, role: d.getAttribute('role') || d.tagName.toLowerCase() };
  }, DIALOG_ATTR);
  const blocked = blockedScriptsOf(page);
  const viewport = page.viewportSize();
  const measured = (fact) => {
    const base = { proof: { type: 'measured-fact', fact: `${fact}; dialog ${opened.role}${opened.modal ? ' aria-modal=true' : ' without aria-modal=true'} opened by "${label}"${viewport ? `, viewport ${viewport.width}x${viewport.height}px` : ''}` } };
    const why = !opened.modal
      ? 'dialog not opened as a modal (a non-modal popup may leave focus free)'
      : blocked.length ? `behaviour script not loaded during the scan (${blocked.length}: ${blocked.slice(0, 3).map((b) => b.url).join(', ')}): its focus trap was not present` : '';
    return why ? { verdict: 'needs-review', impact: 'moderate', evidence: { ...base, reason: `dialog not opened / behaviour script not loaded: ${why}`, ...(blocked.length ? { blockedScripts: blocked } : {}) } } : { evidence: base };
  };

  // Check focus moved inside dialog
  const focusInDialog = await page.evaluate((attr) => {
    const dialog = document.querySelector(`[${attr}="opened"]`);
    return dialog ? dialog.contains(document.activeElement) : false;
  }, DIALOG_ATTR);

  if (!focusInDialog) {
    violations.push({
      rule: 'modal-focus-not-trapped',
      description: `Opening modal triggered by "${label}" did not move focus inside the dialog`,
      impact: 'serious',
      wcagCriteria: '2.4.3',
      element: { selector: trigger.selector },
      ...measured('focus stayed outside the dialog after it opened'),
    });
  } else {
    passes.push(`Modal "${label}" receives focus on open`);
  }

  // Tab and Shift+Tab through the page and verify focus stays in the dialog
  let escapeCount = 0;
  for (let i = 0; i < TAB_CYCLES_TO_CHECK * 2; i++) {
    await page.keyboard.press(i < TAB_CYCLES_TO_CHECK ? 'Tab' : 'Shift+Tab');
    const escapedDialog = await page.evaluate(({ attr, trig }) => {
      const active = document.activeElement;
      const dialog = document.querySelector(`[${attr}="opened"]`);
      if (!dialog || dialog.contains(active) || active === document.body) return false;
      // A control drawn as part of the same overlay (a close button rendered beside the dialog inside its fixed backdrop wrapper) is not an escape;
      // a page control behind or beside it is. The wrapper is the nearest position:fixed ancestor within 3 levels, and it is no wrapper when it also holds the trigger
      // (a fixed app shell around the whole page).
      let wrapper = null;
      for (let n = dialog.parentElement, depth = 0; n && n !== document.body && depth < 3; n = n.parentElement, depth++) {
        if (getComputedStyle(n).position === 'fixed') { wrapper = n; break; }
      }
      if (!wrapper || !wrapper.contains(active) || wrapper.querySelector(`[${trig}]`)) return true;
      // A real overlay wrapper holds only a few controls besides the dialog (a close button); a shell full of page links is not an overlay.
      const outside = [...wrapper.querySelectorAll('a[href],button,input,select,textarea,[tabindex]')].filter((e) => !dialog.contains(e) && e.tabIndex >= 0);
      return outside.length > 3;
    }, { attr: DIALOG_ATTR, trig: TRIGGER_ATTR });
    if (escapedDialog) escapeCount++;
  }

  if (escapeCount > 0) {
    violations.push({
      rule: 'modal-focus-escapes',
      description: `Focus escaped the modal dialog ${escapeCount} time(s) during keyboard navigation`,
      impact: 'serious',
      wcagCriteria: '2.4.3',
      element: { selector: trigger.selector },
      ...measured(`focus left the dialog on ${escapeCount} of ${TAB_CYCLES_TO_CHECK * 2} Tab/Shift+Tab presses`),
    });
  } else if (focusInDialog) {
    passes.push(`Modal "${label}" properly traps focus`);
  }

  // Test Escape key closes the dialog that this trigger opened
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  const modalClosed = await page.evaluate(({ attr }) => {
    // checkVisibility, not offsetParent: that is null for position:fixed so it cannot tell open from closed.
    const isShown = (d) => d.isConnected && d.checkVisibility({ checkVisibilityCSS: true });
    const dialog = document.querySelector(`[${attr}="opened"]`);
    return !dialog || !isShown(dialog);
  }, { attr: DIALOG_ATTR });

  if (!modalClosed) {
    violations.push({
      rule: 'modal-escape-key-not-working',
      description: `Escape key did not close modal triggered by "${label}"`,
      impact: 'serious',
      wcagCriteria: '2.1.2',
      element: { selector: trigger.selector },
    });
  } else {
    passes.push(`Escape key closes modal "${label}"`);
  }
}
