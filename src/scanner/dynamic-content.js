import { acquirePage } from './session.js';
import { mapDescriptionToSource } from '../tracer/partial-map.js';
import { blockedScriptsOf } from './blocked-scripts.js';
import { scanDisclosures, scanNewTabNotices } from './disclosure.js';
import { scanBehaviorChecks } from './behavior-checks.js';


/**
 * Layer 2: Dynamic Content Accessibility Scanner
 *
 * Tests accessibility of interactive components after user interaction:
 * 1. Accordion: aria-expanded / aria-controls present + updates on toggle (live click test)
 * 2. Carousel (Embla): arrow buttons have aria-label + prev/next click verifies state change
 * 3. Dropdown/navigation menus: aria-expanded on trigger, role="menu" on container
 * 4. Form validation: submit empty required form → check aria-invalid + aria-describedby on errors
 * 5. Tab panels: aria-selected, aria-controls on tabs
 */
export async function scanDynamicContent(pageUrl, opts = {}) {
  const { page, close } = await acquirePage(pageUrl, opts);
  const violations = [];
  const passes = [];

  try {
    // Each test is isolated: one failure (e.g. a click timeout) never drops the other results.
    for (const run of [testAccordions, testCarousels, testCarouselInteraction, testDropdownMenus, testBehaviorChecks, testTabPanels, testFormFields, testFormValidationState]) {
      try {
        await run(page, violations, passes);
      } catch {
        // skip this test, keep sibling results
      }
    }
  } finally {
    await close();
  }

  const source = await mapDescriptionToSource(pageUrl);
  return { url: pageUrl, violations: violations.map((v) => ({ ...v, layer: 'dynamicContent', source })), passes, blockedScripts: blockedScriptsOf(page), timestamp: new Date().toISOString() };
}

async function testAccordions(page, violations, passes) {
  const accordions = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('[data-accordion], .accordion, [class*="accordion"]'))
      .slice(0, 5)
      .map((el) => ({
        id: el.id,
        hasButtons: el.querySelectorAll('button').length > 0,
        buttons: Array.from(el.querySelectorAll('button')).slice(0, 3).map((btn) => ({
          text: (btn.textContent || '').trim().slice(0, 60),
          hasAriaExpanded: btn.hasAttribute('aria-expanded'),
          hasAriaControls: btn.hasAttribute('aria-controls'),
        })),
      }));
  });

  for (const accordion of accordions) {
    for (const btn of accordion.buttons) {
      if (!btn.hasAriaExpanded) {
        violations.push({
          rule: 'accordion-missing-aria-expanded',
          description: `Accordion button "${btn.text}" is missing aria-expanded attribute`,
          impact: 'serious',
          wcagCriteria: '4.1.2',
          element: { text: btn.text },
        });
      }
      if (!btn.hasAriaControls) {
        violations.push({
          rule: 'accordion-missing-aria-controls',
          description: `Accordion button "${btn.text}" is missing aria-controls attribute`,
          impact: 'moderate',
          wcagCriteria: '4.1.2',
          element: { text: btn.text },
        });
      }
    }
  }

  // Click first accordion button and verify aria-expanded changes
  const firstAccordionBtn = page.locator('.accordion button, [data-accordion] button').first();
  if (await firstAccordionBtn.count() > 0) {
    const beforeExpanded = await firstAccordionBtn.getAttribute('aria-expanded');
    await firstAccordionBtn.click({ timeout: 3000 });
    await page.waitForTimeout(300);
    const afterExpanded = await firstAccordionBtn.getAttribute('aria-expanded');

    if (beforeExpanded === afterExpanded && beforeExpanded !== null) {
      violations.push({
        rule: 'accordion-aria-expanded-not-updated',
        description: 'Accordion button aria-expanded did not change after click',
        impact: 'serious',
        wcagCriteria: '4.1.2',
        element: null,
      });
    } else if (afterExpanded !== null) {
      passes.push('Accordion aria-expanded updates correctly on toggle');
    }
  }
}

async function testCarousels(page, violations, passes) {
  const carouselData = await page.evaluate(() => {
    const sel = '.embla, [data-embla], [class*="carousel"]';
    // One widget is one carousel: its own "carousel-slides" / "carousel-slide" parts also match the selector, only the outermost match counts.
    const carousels = Array.from(document.querySelectorAll(sel)).filter((el) => !el.parentElement?.closest(sel));
    return carousels.slice(0, 3).map((el) => {
      const prevBtn = el.querySelector('[class*="prev"], [aria-label*="previous" i], [aria-label*="prev" i]');
      const nextBtn = el.querySelector('[class*="next"], [aria-label*="next" i]');
      // A slide is an element whose class token IS "slide" (slide, swiper-slide, card__slide), not any class that contains the letters:
      // "carousel-slides" is the wrapper and "slide-dots" a control. Only the outermost match counts, a label on a slide's inner wrapper is not its name.
      const isSlide = (n) => [...n.classList].some((c) => /(^|[-_])slide$/i.test(c)) || (n.getAttribute('role') === 'group' && /^slide$/i.test(n.getAttribute('aria-roledescription') || ''));
      const hasSlideAncestor = (n) => { for (let p = n.parentElement; p && p !== el; p = p.parentElement) if (isSlide(p)) return true; return false; };
      const slides = Array.from(el.querySelectorAll('*')).filter((n) => isSlide(n) && !hasSlideAncestor(n));

      return {
        prevBtnHasLabel: prevBtn ? (prevBtn.getAttribute('aria-label') || '').length > 0 : null,
        nextBtnHasLabel: nextBtn ? (nextBtn.getAttribute('aria-label') || '').length > 0 : null,
        slidesCount: slides.length,
        slidesHaveRole: Array.from(slides).every((s) => s.getAttribute('role') === 'group'),
        slidesHaveLabel: Array.from(slides).every((s) => s.getAttribute('aria-label') || s.getAttribute('aria-labelledby')), // aria-roledescription says "slide", it does not name which one
        hasAriaLabel: el.getAttribute('aria-label') || el.getAttribute('aria-roledescription'),
      };
    });
  });

  for (const carousel of carouselData) {
    if (carousel.prevBtnHasLabel === false) {
      violations.push({
        rule: 'carousel-prev-button-no-label',
        description: 'Carousel previous button is missing an accessible aria-label',
        impact: 'serious',
        wcagCriteria: '1.1.1',
        element: null,
      });
    }
    if (carousel.nextBtnHasLabel === false) {
      violations.push({
        rule: 'carousel-next-button-no-label',
        description: 'Carousel next button is missing an accessible aria-label',
        impact: 'serious',
        wcagCriteria: '1.1.1',
        element: null,
      });
    }
    if (!carousel.hasAriaLabel && carousel.slidesCount > 0) {
      violations.push({
        rule: 'carousel-missing-label',
        description: 'Carousel container is missing aria-label or aria-roledescription',
        impact: 'moderate',
        wcagCriteria: '4.1.2',
        element: null,
      });
    }
    if (carousel.slidesCount > 0 && !carousel.slidesHaveLabel) {
      violations.push({
        rule: 'carousel-slides-missing-labels',
        description: 'Carousel slides are missing aria-label (e.g., "Slide 1 of 5")',
        impact: 'moderate',
        wcagCriteria: '4.1.2',
        element: null,
      });
    }
    if (carousel.prevBtnHasLabel && carousel.nextBtnHasLabel) {
      passes.push('Carousel navigation buttons have accessible labels');
    }
  }
}

// Controls that open and close content without aria-expanded, measured by activating them (src/scanner/disclosure.js).
async function testDropdownMenus(page, violations) {
  violations.push(...await scanDisclosures(page));
  violations.push(...await scanNewTabNotices(page));
}

// Measured on the live page: reflow at 320px, focus return after Escape, role=button operated by keyboard (src/scanner/behavior-checks.js).
async function testBehaviorChecks(page, violations) {
  violations.push(...await scanBehaviorChecks(page));
}

async function testTabPanels(page, violations, passes) {
  const tabData = await page.evaluate(() => {
    const tabLists = document.querySelectorAll('[role="tablist"]');
    return Array.from(tabLists).slice(0, 3).map((list) => {
      const tabs = list.querySelectorAll('[role="tab"]');
      return {
        tabCount: tabs.length,
        // 4.1.2 fails when the selected state is not exposed: no tab says aria-selected="true" although one is marked selected visually.
        tabsHaveAriaSelected: Array.from(tabs).some((t) => t.getAttribute('aria-selected') === 'true'),
        looksSelected: Array.from(tabs).some((t) => t.getAttribute('aria-selected') !== 'true' && (t.hasAttribute('aria-current') || (t.getAttribute('aria-pressed') === 'true') || /(^|[\s_-])(active|selected|current)($|[\s_-])/i.test(typeof t.className === 'string' ? t.className : ''))),
        tabsHaveAriaControls: Array.from(tabs).every((t) => t.hasAttribute('aria-controls')),
        hasAriaLabel: list.getAttribute('aria-label') || list.getAttribute('aria-labelledby'),
      };
    });
  });

  for (const tabSet of tabData) {
    if (!tabSet.tabsHaveAriaSelected) {
      violations.push({
        rule: 'tabs-missing-aria-selected',
        description: `${tabSet.tabCount} tab(s) in a tablist and none has aria-selected="true"${tabSet.looksSelected ? ' although one is marked selected by class or aria-current' : ''}`,
        impact: 'serious',
        wcagCriteria: '4.1.2',
        element: null,
        // Without a visually selected tab we cannot tell a missing state from a tablist with nothing selected: a question.
        ...(tabSet.looksSelected
          ? { evidence: { proof: { type: 'measured-fact', fact: `0 of ${tabSet.tabCount} tabs have aria-selected="true"; a tab carries an active/selected class or aria-current` } } }
          : { verdict: 'needs-review', evidence: { reviewReason: 'no tab has aria-selected="true" and none is visibly marked selected' } }),
      });
    }
    if (!tabSet.tabsHaveAriaControls) {
      violations.push({
        rule: 'tabs-missing-aria-controls',
        description: 'Tab elements are missing aria-controls pointing to tabpanel',
        impact: 'moderate',
        wcagCriteria: '4.1.2',
        element: null,
      });
    }
    if (tabSet.tabsHaveAriaSelected && tabSet.tabsHaveAriaControls) {
      passes.push(`Tab set (${tabSet.tabCount} tabs) has proper ARIA attributes`);
    }
  }
}

async function testFormFields(page, violations, passes) {
  const formIssues = await page.evaluate(() => {
    const issues = [];

    // Check required fields have aria-required or required
    const inputs = document.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="image"]), textarea, select');
    for (const input of inputs) {
      const isRequired = input.hasAttribute('required') || input.getAttribute('aria-required') === 'true';
      const label = input.labels?.[0] || (input.id ? document.querySelector(`[for="${CSS.escape(input.id)}"]`) : null);
      const ariaLabel = input.getAttribute('aria-label') || input.getAttribute('aria-labelledby') || input.getAttribute('title');
      const placeholder = input.getAttribute('placeholder');

      // A field with a placeholder has an accessible name (accname), so it is placeholder-only (3.3.2 judgement), never "no label"; one with neither is no-label.
      if (!label && !ariaLabel && input.id && !placeholder) {
        issues.push({
          rule: 'form-field-no-label',
          description: `Form field #${input.id} has no associated label or aria-label`,
          impact: 'critical',
          wcagCriteria: '1.3.1',
          element: { id: input.id },
        });
      }

      // Check placeholder-only labels
      if (!label && !ariaLabel && placeholder) {
        issues.push({
          rule: 'form-field-placeholder-only',
          description: `Form field${input.id ? ` #${input.id}` : ''} with placeholder "${placeholder}" uses placeholder as only label — disappears when user types`,
          impact: 'serious',
          wcagCriteria: '3.3.2',
          element: { ...(input.id ? { id: input.id } : {}), placeholder },
        });
      }
    }
    return issues;
  });

  violations.push(...formIssues);

  if (formIssues.length === 0) {
    const formCount = await page.evaluate(() => document.querySelectorAll('form').length);
    if (formCount > 0) passes.push(`${formCount} form(s) — all visible fields appear labeled`);
  }
}

// ─── Live interaction tests (NEW) ─────────────────────────────────────────────

/**
 * Clicks carousel next/prev buttons and verifies:
 * - The active slide index changes (slide transition happened)
 * - Navigation dots (if present) update their aria-label or aria-current
 */
async function testCarouselInteraction(page, violations, passes) {
  const carouselCount = await page.evaluate(() =>
    document.querySelectorAll('.embla, [data-embla], [class*="carousel"]').length
  );
  if (carouselCount === 0) return;

  // Find and click the "next" button on the first carousel
  const nextBtn = page.locator('.embla [class*="next"], [class*="carousel"] [aria-label*="next" i], [class*="carousel"] [class*="next"]').first();
  const prevBtn = page.locator('.embla [class*="prev"], [class*="carousel"] [aria-label*="prev" i], [class*="carousel"] [class*="prev"]').first();

  if ((await nextBtn.count()) === 0) return;

  // Snapshot active slide before click
  const before = await page.evaluate(() => {
    const embla = document.querySelector('.embla__container, [class*="carousel-track"]');
    if (!embla) return null;
    // Grab translate value as proxy for current slide position
    return window.getComputedStyle(embla).transform;
  });

  try {
    await nextBtn.click({ timeout: 3000 });
    await page.waitForTimeout(600); // allow transition to complete

    const after = await page.evaluate(() => {
      const embla = document.querySelector('.embla__container, [class*="carousel-track"]');
      return embla ? window.getComputedStyle(embla).transform : null;
    });

    if (before !== null && after !== null && before === after) {
      violations.push({
        rule: 'carousel-next-not-functional',
        description: 'Carousel "next" button click produced no slide movement — button may be broken or not keyboard/pointer accessible',
        impact: 'serious',
        wcagCriteria: '2.1.1',
        element: null,
      });
    } else {
      passes.push('Carousel next button triggers slide transition');
    }

    // Check that navigation dots update aria state after transition
    const dotState = await page.evaluate(() => {
      const dots = document.querySelectorAll('[class*="dot"], [class*="pagination"] button');
      if (dots.length === 0) return { hasDots: false };
      const activeDot = Array.from(dots).find(
        (d) =>
          d.getAttribute('aria-current') === 'true' ||
          d.getAttribute('aria-selected') === 'true' ||
          d.classList.contains('is-selected') ||
          d.classList.contains('active')
      );
      return { hasDots: true, hasActiveDot: !!activeDot };
    });

    if (dotState.hasDots && !dotState.hasActiveDot) {
      violations.push({
        rule: 'carousel-dots-missing-active-state',
        description: 'Carousel navigation dots exist but none have aria-current="true" or aria-selected="true" — screen reader cannot determine current slide',
        impact: 'moderate',
        wcagCriteria: '4.1.2',
        element: null,
      });
    }

    // Restore to first slide (click prev if available)
    if ((await prevBtn.count()) > 0) {
      await prevBtn.click({ timeout: 3000 }).catch(() => {});
    }
  } catch {
    // Navigation buttons not interactable (e.g., carousel not yet initialised) — skip
  }
}

/**
 * Submits a form with empty required fields and checks that:
 * - aria-invalid="true" is set on the invalid fields
 * - aria-describedby points to a visible error message element
 * - The error message container has role="alert" or aria-live
 */
async function testFormValidationState(page, violations, passes) {
  const forms = await page.evaluate(() =>
    Array.from(document.querySelectorAll('form')).map((f, i) => ({
      index: i,
      hasRequiredFields: f.querySelectorAll('[required], [aria-required="true"]').length > 0,
      hasSubmitBtn: f.querySelectorAll('[type="submit"], button:not([type="button"])').length > 0,
    }))
  );

  const formToTest = forms.find((f) => f.hasRequiredFields && f.hasSubmitBtn);
  if (!formToTest) return;

  // Click submit without filling in any fields
  try {
    const submitBtn = page.locator(`form >> nth=${formToTest.index} >> [type="submit"], form >> nth=${formToTest.index} >> button:not([type="button"])`).first();
    if ((await submitBtn.count()) === 0) return;

    await submitBtn.click({ timeout: 3000 });
    await page.waitForTimeout(700);

    const validationState = await page.evaluate(() => {
      const invalidFields = Array.from(document.querySelectorAll('[aria-invalid="true"]'));
      const errorsWithDescribedBy = invalidFields.filter((f) => f.getAttribute('aria-describedby'));
      const errorContainers = Array.from(
        document.querySelectorAll('[role="alert"], [aria-live="assertive"], [aria-live="polite"]')
      ).filter((el) => (el.textContent || '').trim().length > 0);

      return {
        invalidFieldCount: invalidFields.length,
        fieldsWithDescribedBy: errorsWithDescribedBy.length,
        liveErrorContainers: errorContainers.length,
        examples: invalidFields.slice(0, 3).map((f) => ({
          id: f.id,
          describedBy: f.getAttribute('aria-describedby'),
        })),
      };
    });

    if (validationState.invalidFieldCount === 0) {
      violations.push({
        rule: 'form-validation-no-aria-invalid',
        description: 'Form submitted with empty required fields but no aria-invalid="true" was set — screen reader users receive no programmatic error notification',
        impact: 'serious',
        wcagCriteria: '3.3.1',
        element: null,
      });
    } else {
      passes.push(`Form validation: ${validationState.invalidFieldCount} field(s) correctly marked aria-invalid`);

      if (validationState.fieldsWithDescribedBy < validationState.invalidFieldCount) {
        violations.push({
          rule: 'form-error-missing-aria-describedby',
          description: `${validationState.invalidFieldCount - validationState.fieldsWithDescribedBy} invalid field(s) are missing aria-describedby — screen readers cannot associate the error message with the field`,
          impact: 'serious',
          wcagCriteria: '3.3.1',
          element: { examples: validationState.examples },
        });
      }

      if (validationState.liveErrorContainers === 0) {
        violations.push({
          rule: 'form-error-no-live-region',
          description: 'Form validation errors appear but no aria-live region announces them — screen reader users may not know the form failed',
          impact: 'moderate',
          wcagCriteria: '4.1.3',
          element: null,
        });
      } else {
        passes.push(`Form error messages announced via ${validationState.liveErrorContainers} live region(s)`);
      }
    }
  } catch {
    // Form submit test failed non-critically — skip
  }
}
