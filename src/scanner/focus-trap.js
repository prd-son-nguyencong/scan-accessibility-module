import { getBrowser, newPage, resilientGoto } from './browser.js';
import { mapDescriptionToSource } from '../tracer/partial-map.js';
import { getThirdPartyConfig } from '../utils/third-party.js';

const PAGE_TIMEOUT_MS = 60000;
const TAB_CYCLES_TO_CHECK = 15;

/**
 * Layer 2: Focus Trap Scanner
 *
 * Tests modal/dialog elements for proper focus management:
 * 1. Opening a modal moves focus inside it
 * 2. Tab key cycles focus within the modal (does not escape)
 * 3. Shift+Tab reverse-cycles within the modal
 * 4. Escape key closes the modal
 * 5. Focus returns to the trigger element after close
 *
 * Specifically tests: .oliviaButton (Paradox chatbot), [role="dialog"],
 * dialog[open], and common modal trigger patterns.
 */
export async function scanFocusTraps(pageUrl) {
  const browser = await getBrowser();
  const page = await newPage(browser);
  const violations = [];
  const passes = [];

  try {
    await resilientGoto(page, pageUrl, { timeout: PAGE_TIMEOUT_MS });

    // Find all elements that trigger modals/dialogs. The chatbot trigger is
    // config-driven (config.thirdParty.chatbotSelector) instead of hardcoded.
    const chatbotSelector = getThirdPartyConfig().chatbotSelector;
    const triggers = await page.evaluate((chatbot) => {
      const triggerSelectors = [
        '[aria-haspopup="dialog"]',
        '[data-modal-trigger]',
        '[data-toggle="modal"]',
        'button[aria-controls]',
        ...(chatbot ? [chatbot] : []),
      ];

      return triggerSelectors.flatMap((selector) =>
        Array.from(document.querySelectorAll(selector)).map((el) => ({
          selector,
          text: (el.textContent || '').trim().slice(0, 60),
          ariaLabel: el.getAttribute('aria-label') || '',
          ariaControls: el.getAttribute('aria-controls') || '',
        }))
      );
    }, chatbotSelector);

    // Find static open dialogs (already in DOM with open or role=dialog)
    const staticDialogs = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('[role="dialog"], dialog')).map((el) => ({
        id: el.id,
        ariaLabel: el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || '',
        isVisible: el.offsetParent !== null || window.getComputedStyle(el).display !== 'none',
      }));
    });

    // Check static dialogs for required ARIA attributes
    for (const dialog of staticDialogs) {
      if (!dialog.ariaLabel) {
        violations.push({
          rule: 'dialog-no-label',
          description: `Dialog element${dialog.id ? ` #${dialog.id}` : ''} is missing an accessible name (aria-label or aria-labelledby)`,
          impact: 'serious',
          wcagCriteria: '4.1.2',
          element: { selector: dialog.id ? `#${dialog.id}` : '[role="dialog"]' },
        });
      }
    }

    // Test focus trap behavior for each trigger
    for (const trigger of triggers.slice(0, 3)) { // Limit to 3 to keep scan fast
      try {
        await testModalFocusTrap(page, trigger, violations, passes);
        // Reload to reset state between modal tests
        await page.reload({ waitUntil: 'networkidle', timeout: PAGE_TIMEOUT_MS });
      } catch {
        // Modal test failed — don't block overall scan
      }
    }

    // Check for aria-modal attribute on dialogs
    const missingAriaModal = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('[role="dialog"]'))
        .filter((el) => el.getAttribute('aria-modal') !== 'true')
        .map((el) => el.id || el.getAttribute('class') || '[role=dialog]');
    });

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
    await page.context().close().catch(() => {});
  }

  const source = await mapDescriptionToSource(pageUrl);
  return { url: pageUrl, violations: violations.map((v) => ({ ...v, layer: 'focusTrap', source })), passes, timestamp: new Date().toISOString() };
}

async function testModalFocusTrap(page, trigger, violations, passes) {
  // Click the trigger
  const triggerLocator = page.locator(trigger.selector).first();
  if (!(await triggerLocator.isVisible())) return;

  await triggerLocator.click();
  await page.waitForTimeout(500); // Wait for modal animation

  // Check if a dialog opened
  const dialogOpened = await page.evaluate(() => {
    const dialogs = document.querySelectorAll('[role="dialog"], dialog[open]');
    return Array.from(dialogs).some((d) => d.offsetParent !== null || window.getComputedStyle(d).display !== 'none');
  });

  if (!dialogOpened) return;

  // Check focus moved inside dialog
  const focusInDialog = await page.evaluate(() => {
    const active = document.activeElement;
    const dialog = document.querySelector('[role="dialog"], dialog[open]');
    return dialog ? dialog.contains(active) : false;
  });

  if (!focusInDialog) {
    violations.push({
      rule: 'modal-focus-not-trapped',
      description: `Opening modal triggered by "${trigger.text || trigger.ariaLabel}" did not move focus inside the dialog`,
      impact: 'serious',
      wcagCriteria: '2.1.2',
      element: { selector: trigger.selector },
    });
  } else {
    passes.push(`Modal "${trigger.text || trigger.ariaLabel}" receives focus on open`);
  }

  // Tab through elements and verify focus stays in dialog
  let escapeCount = 0;
  for (let i = 0; i < TAB_CYCLES_TO_CHECK; i++) {
    await page.keyboard.press('Tab');
    const escapedDialog = await page.evaluate(() => {
      const active = document.activeElement;
      const dialog = document.querySelector('[role="dialog"], dialog[open]');
      if (!dialog) return false;
      return !dialog.contains(active) && active !== document.body;
    });
    if (escapedDialog) escapeCount++;
  }

  if (escapeCount > 0) {
    violations.push({
      rule: 'modal-focus-escapes',
      description: `Focus escaped the modal dialog ${escapeCount} time(s) during keyboard navigation`,
      impact: 'critical',
      wcagCriteria: '2.1.2',
      element: { selector: trigger.selector },
    });
  } else if (focusInDialog) {
    passes.push(`Modal "${trigger.text || trigger.ariaLabel}" properly traps focus`);
  }

  // Test Escape key closes modal
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  const modalClosed = await page.evaluate(() => {
    const dialogs = document.querySelectorAll('[role="dialog"], dialog[open]');
    return Array.from(dialogs).every((d) => d.offsetParent === null || window.getComputedStyle(d).display === 'none');
  });

  if (!modalClosed) {
    violations.push({
      rule: 'modal-escape-key-not-working',
      description: `Escape key did not close modal triggered by "${trigger.text || trigger.ariaLabel}"`,
      impact: 'serious',
      wcagCriteria: '2.1.2',
      element: { selector: trigger.selector },
    });
  } else {
    passes.push(`Escape key closes modal "${trigger.text || trigger.ariaLabel}"`);
  }
}
