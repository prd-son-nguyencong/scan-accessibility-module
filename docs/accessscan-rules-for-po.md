# accessScan — Complete Rule Reference

**For:** Product Owners & Developers
**Total Rules:** 83
**Categories:** 11
**Standard:** WCAG 2.0 / 2.1 / 2.2 (Levels A, AA, AAA + Best Practices)

---

## How to Read This Document

Each rule entry includes:

- **Rule Name** — the identifier used in scan reports (matches `schema.js`)
- **WCAG** — which WCAG version and conformance level applies
- **Impacted Users** — which disability profiles are affected
- **Requirement** — plain-English description of what the rule checks
- **Example** — code snapshots showing fail/pass cases

> Commercial aliases are noted where the internal scanner uses a different name than the accessScan commercial tool.

---

## 1. General (14 rules)

WCAG versions: 2.1 + 2.0

---

### 1.1 AltMisuse

| Property | Value |
|----------|-------|
| **WCAG** | 2.1 — Level A |
| **Impacted Users** | Cognitive Disability |

**Requirement:** The `alt` attribute is used to provide a text alternative for images. It is not meant to be used on elements other than images and therefore will not be read using screen-readers.

**Failing example:**

```html
<div alt="Description text">Content</div>
```

**Passing example:**

```html
<img src="...hardees-logo.webp" alt="Hardee's" class="h-[5.6rem] md:h-[6.7rem] w-auto">
```

---

### 1.2 BreadcrumbsNav

| Property | Value |
|----------|-------|
| **WCAG** | 2.0 — Level A |
| **Impacted Users** | Cognitive Disability |

**Requirement:** Breadcrumb navigation regions are essential for user orientation. If not appropriately tagged, screen reader users will not know that such an option exists on the page and will face more difficulties browsing around.

**Failing example:**

```html
<div class="breadcrumbs">
  <a href="/">Home</a> > <a href="/jobs">Jobs</a>
</div>
```

**Passing example:**

```html
<nav aria-label="Breadcrumb">
  <ol>
    <li><a href="/">Home</a></li>
    <li><a href="/jobs" aria-current="page">Jobs</a></li>
  </ol>
</nav>
```

---

### 1.3 EmphasisMismatch

| Property | Value |
|----------|-------|
| **WCAG** | 2.0 — Level A |
| **Impacted Users** | Blind |

**Requirement:** Elements with emphasis importance should have the emphasis role. If not, screen reader users may not understand the emphasis of the text.

**Failing example:**

```html
<span style="font-style: italic">Important note</span>
```

**Passing example:**

```html
<em>Important note</em>
```

---

### 1.4 IframeDiscernible

| Property | Value |
|----------|-------|
| **WCAG** | 2.0 — Level A |
| **Impacted Users** | Blind |

**Requirement:** An iframe needs a label that describes its purpose to screen reader users.

**Failing example:**

```html
<iframe src="https://example.com/widget"></iframe>
```

**Passing example:**

```html
<iframe src="https://example.com/widget" title="reCAPTCHA verification"></iframe>
```

---

### 1.5 LinkAnchorAmbiguous

| Property | Value |
|----------|-------|
| **WCAG** | 2.0 — Level A |
| **Impacted Users** | Cognitive Disability |

**Requirement:** Ambiguous links like "Learn More", "Shop Now" and "Start Here" are often used as a call to action. However, screen-reader users, while using link navigation, do not interact with content above or below the link and therefore don't have the same context as to what they will learn more about.

**Failing example:**

```html
<a href="/crew-members-and-management">Learn more</a>
```

**Passing example:**

```html
<a href="/crew-members-and-management" aria-label="Learn more about Crew Members & Management">Learn more</a>
```

---

### 1.6 NoRoleApplication

| Property | Value |
|----------|-------|
| **WCAG** | 2.0 — Level A |
| **Impacted Users** | Blind |

**Requirement:** Using `role="application"` is generally discouraged because it disables standard screen reader modes and forces users into an application mode. This removes familiar navigation shortcuts, such as heading or landmark navigation, and requires them to interact in ways they may not expect.

**Failing example:**

```html
<div role="application">
  <p>Regular page content</p>
</div>
```

**Passing example:**

```html
<div>
  <p>Regular page content</p>
</div>
```

---

### 1.7 SalePriceDiscernible

| Property | Value |
|----------|-------|
| **WCAG** | 2.0 — Level A |
| **Impacted Users** | Blind |

**Requirement:** Discounted prices often appear next to the original and distinguished with visual cues like strikethroughs or color changes. Both prices must also be conveyed by screen readers in a way that enables users to differentiate between the values, ensuring they can understand when a discount is applied.

**Failing example:**

```html
<span style="text-decoration: line-through">$29.99</span>
<span>$19.99</span>
```

**Passing example:**

```html
<span aria-label="Original price"><s>$29.99</s></span>
<span aria-label="Sale price">$19.99</span>
```

---

### 1.8 StrongMismatch

| Property | Value |
|----------|-------|
| **WCAG** | 2.0 — Level A |
| **Impacted Users** | Blind |

**Requirement:** Elements with strong importance should have the strong role. If not, screen reader users may not understand the importance of the text.

**Failing example:**

```html
<span class="results-header__content__from">1</span>
```

**Passing example:**

```html
<strong class="text-[1.6rem] font-['Open_Sans'] font-bold">Lead with heart. Serve with purpose.</strong>
```

---

### 1.9 VisibilityMismatch

| Property | Value |
|----------|-------|
| **WCAG** | 2.0 — Level A |
| **Impacted Users** | Blind |

**Requirement:** If content remains visible on the screen but assigned `aria-hidden="true"`, it will be excluded from the accessibility tree. As a result, screen reader users will not have access to the same information as sighted users.

**Failing example:**

```html
<span class="el-avatar" aria-hidden="true" alt="" style="height: 42px; width: 42px;">
  <!-- Visible avatar image hidden from screen readers -->
</span>
```

**Passing example:**

```html
<header id="header" class="top-0 left-0 fixed w-full z-100">
  <a href="/" aria-label="Hardee's Careers Home">
    <img src="...hardees-logo.webp" alt="Hardee's">
  </a>
</header>
```

---

### 1.10 VisibilityMisuse

| Property | Value |
|----------|-------|
| **WCAG** | 2.0 — Level A |
| **Impacted Users** | Blind |

**Requirement:** When elements are visually hidden but still exposed to assistive technology, screen reader users may encounter content that should not be available in the current interface. This can obscure the current state of the page and lead to confusion about what information or controls are available.

**Failing example:**

```html
<div class="shrink-0 rounded-[1.6rem] overflow-hidden" style="width: 33.2rem; height: 31.2rem">
  <img src="...marquee-1.webp" alt="Hardee's team member handing a bag to a customer" class="size-full object-cover">
</div>
```

**Passing example:**

```html
<div class="sub-menu-content hidden" aria-hidden="true">
  <a href="/crew-members" class="nav-link" tabindex="-1">Crew Members</a>
</div>
```

---

### 1.11 AriaDescribedByHasReference

| Property | Value |
|----------|-------|
| **WCAG** | Best Practice |
| **Impacted Users** | Blind |

**Requirement:** If an element's `aria-describedby` attribute points to an id that does not exist or is not valid, assistive technologies will not convey the intended description, causing users to miss important context.

**Failing example:**

```html
<input aria-describedby="missing-id" type="text">
```

**Passing example:**

```html
<input aria-describedby="help-text" type="text">
<span id="help-text">Enter your full name</span>
```

---

### 1.12 AriaLabelledByHasReference

| Property | Value |
|----------|-------|
| **WCAG** | Best Practice |
| **Impacted Users** | Blind |

**Requirement:** Since `aria-labelledby` relies on valid id references, screen readers can only announce the label if the target exists. If the id is missing or invalid, the label will not be conveyed, causing users to miss important context.

**Failing example:**

```html
<input aria-labelledby="nonexistent-id" type="text">
```

**Passing example:**

```html
<input aria-labelledby="keyword-search-label" type="text">
<span id="keyword-search-label">Search by keyword</span>
```

---

### 1.13 FigureDiscernible

| Property | Value |
|----------|-------|
| **WCAG** | Best Practice |
| **Impacted Users** | Cognitive Disability |

**Requirement:** Figure elements are often incorrectly used to display images on the screen. Incorrectly using the figure tag, without providing a proper `<figcaption>`, adds unnecessary clutter to the screen reader user's experience.

**Failing example:**

```html
<figure>
  <img src="photo.jpg" alt="Team photo">
</figure>
```

**Passing example:**

```html
<figure>
  <img src="photo.jpg" alt="Team photo">
  <figcaption>The Hardee's crew at the annual team meeting</figcaption>
</figure>
```

---

### 1.14 NoExtraInformationInTitle

| Property | Value |
|----------|-------|
| **WCAG** | Best Practice |
| **Impacted Users** | Blind |

**Requirement:** The `title` attribute is announced inconsistently across screen readers and browsers, making it unreliable for labeling interactive controls. It should be used to provide extra help text in addition to a valid label, not as the only labeling method.

**Failing example:**

```html
<button title="Submit form"></button>
```

**Passing example:**

```html
<div class="filter-header" role="button" title="Filter by Categories">
  <span class="filter-title">Categories</span>
</div>
```

---

## 2. Interactive Content (18 rules)

WCAG versions: 2.2 + 2.0 + Best Practices

---

### 2.1 FocusNotObscuredFooter

| Property | Value |
|----------|-------|
| **WCAG** | 2.2 — Level AA |
| **Impacted Users** | Motor Impaired |

**Requirement:** A sticky footer remains anchored to the bottom of the screen while the rest of the page content can be scrolled. If it is not offset from interactive elements, it can overlap and obscure the item in focus.

**Failing example:**

```html
<div role="contentinfo" class="d3afa4 _72cec8 _168811">
  <span>Powered by <a target="_blank" href="https://www.paradox.ai/powered-by-paradox">Paradox</a></span>
</div>
```

**Passing example:**

```html
<footer style="position: sticky; bottom: 0;">
  <span>Powered by Paradox</span>
</footer>
<!-- Interactive elements have scroll-padding-bottom to avoid overlap -->
```

---

### 2.2 ButtonDiscernible

| Property | Value |
|----------|-------|
| **WCAG** | 2.0 — Level A |
| **Impacted Users** | Blind |

**Requirement:** Buttons that do not contain visible text should be assigned labels that inform screen reader users of their purpose.

**Failing example:**

```html
<button type="button"><svg>...</svg></button>
```

**Passing example:**

```html
<button type="button" aria-label="Open menu">
  <span class="hamburger-bar"></span>
  <span class="hamburger-bar"></span>
  <span class="hamburger-bar"></span>
</button>
```

---

### 2.3 ButtonMismatch

| Property | Value |
|----------|-------|
| **WCAG** | 2.0 — Level A |
| **Impacted Users** | Blind |

**Requirement:** If interactive elements cannot be identified as buttons, screen reader users may not realize the element is actionable, which can stop them from submitting forms, opening dialogs, or performing other intended actions.

**Failing example:**

```html
<a href="#" class="btn-pill oliviaButton inline-flex gap-[0.4rem] self-start">
  Chat now
  <img src="...starla-chat-arrow.svg" alt="" role="presentation">
</a>
```

**Passing example:**

```html
<button type="button" class="sub-menu-toggle" aria-expanded="false" aria-haspopup="true">
  Career Paths
  <svg aria-hidden="true">...</svg>
</button>
```

---

### 2.4 LinkAnchorDiscernible

| Property | Value |
|----------|-------|
| **WCAG** | 2.0 — Level A |
| **Impacted Users** | Blind |

**Requirement:** Activating anchor links enables users to navigate to a different section within the same page. Anchor links that do not contain visible text or labeled images should be assigned labels that inform screen reader users of their destination.

**Failing example:**

```html
<a href="#section-2"></a>
```

**Passing example:**

```html
<a href="#section-2">Jump to Benefits</a>
```

---

### 2.5 LinkCurrentPage

| Property | Value |
|----------|-------|
| **WCAG** | 2.0 — Level A |
| **Impacted Users** | Blind |

**Requirement:** Visual cues are often used by sighted users to indicate which link represents the current page within a set of links. This information should be made available to screen reader users by assigning `aria-current="page"` to the link.

**Failing example:**

```html
<a href="/" class="nav-link current">Careers Home</a>
```

**Passing example:**

```html
<a href="/" class="nav-link current" aria-current="page">Careers Home</a>
```

---

### 2.6 LinkNavigationAmbiguous

| Property | Value |
|----------|-------|
| **WCAG** | 2.0 — Level A |
| **Impacted Users** | Blind |

**Requirement:** Screen reader users may find it difficult to distinguish between links when the purpose of each link cannot be determined from its text alone or together with its immediate context.

**Failing example:**

```html
<a href="/crew-members-and-management" class="btn-outline">Learn more</a>
```

**Passing example:**

```html
<a href="/" aria-label="Hardee's Careers Home" class="current">
  <img src="...hardees-logo.webp" alt="Hardee's">
</a>
```

---

### 2.7 LinkNavigationDiscernible

| Property | Value |
|----------|-------|
| **WCAG** | 2.0 — Level A |
| **Impacted Users** | Blind |

**Requirement:** Activating navigation links enables users to navigate to a different page within the site. Links that do not contain visible text or labeled images should be assigned labels that inform screen reader users of their destination.

**Failing example:**

```html
<a href="/about"><svg>...</svg></a>
```

**Passing example:**

```html
<a href="/our-story" class="nav-link text-warm-white">Our Story</a>
```

---

### 2.8 LinkOpensNewWindow

| Property | Value |
|----------|-------|
| **WCAG** | 2.0 — Level A |
| **Impacted Users** | Blind, Cognitive Disability |

> *Internal scanner rule — not present in commercial accessScan docs.*

**Requirement:** Links that open in a new window or tab (via `target="_blank"`) must warn users, since opening a new context without notice disorients screen reader and keyboard users.

**Failing example:**

```html
<a href="https://example.com" target="_blank">Visit Example</a>
```

**Passing example:**

```html
<a href="https://example.com" target="_blank" rel="noopener noreferrer" aria-label="Visit Example (opens in new window)">Visit Example</a>
```

---

### 2.9 TargetSize

| Property | Value |
|----------|-------|
| **WCAG** | 2.2 — Level AA (SC 2.5.8) |
| **Impacted Users** | Motor Impaired |

> *Internal scanner rule — not present in commercial accessScan docs.*

**Requirement:** Interactive targets must be at least 24×24 CSS pixels, or qualify for an exception (spacing, inline, user-agent default, essential). Small targets are difficult for users with motor impairments to activate accurately.

**Failing example:**

```html
<button style="width: 16px; height: 16px;"><svg>...</svg></button>
```

**Passing example:**

```html
<button style="min-width: 44px; min-height: 44px; padding: 10px;"><svg>...</svg></button>
```

---

### 2.10 MenuAvoid

| Property | Value |
|----------|-------|
| **WCAG** | 2.0 — Level A |
| **Impacted Users** | Blind |

**Requirement:** In most cases, using `role="menu"` on navigation elements within a web page can negatively impact screen reader users, especially those using JAWS. The attribute should be used for menu types that function like those found in desktop applications.

**Failing example:**

```html
<nav role="menu">
  <a href="/" role="menuitem">Home</a>
  <a href="/about" role="menuitem">About</a>
</nav>
```

**Passing example:**

```html
<nav aria-label="Main navigation">
  <a href="/">Home</a>
  <a href="/about">About</a>
</nav>
```

---

### 2.11 MenuBarAvoid

| Property | Value |
|----------|-------|
| **WCAG** | 2.0 — Level A |
| **Impacted Users** | Blind |

**Requirement:** In most cases, using `role="menubar"` on navigation elements within a web page can negatively impact screen reader users, especially those using JAWS. The attribute should be used for menu types that function like those found in desktop applications.

**Failing example:**

```html
<ul role="menubar">
  <li><a href="/">Home</a></li>
</ul>
```

**Passing example:**

```html
<nav aria-label="Main navigation">
  <ul>
    <li><a href="/">Home</a></li>
  </ul>
</nav>
```

---

### 2.12 MenuItemAvoid

| Property | Value |
|----------|-------|
| **WCAG** | 2.0 — Level A |
| **Impacted Users** | Blind |

**Requirement:** In most cases, using ARIA menu roles within a web page can negatively impact screen reader users, especially those using JAWS. `role="menuitem"` should be used for menu items in menu types that function like those found in desktop applications.

**Failing example:**

```html
<a href="/about" role="menuitem">About</a>
```

**Passing example:**

```html
<a href="/about" class="nav-link">About</a>
```

---

### 2.13 MenuTriggerClickable

| Property | Value |
|----------|-------|
| **WCAG** | 2.0 — Level A |
| **Impacted Users** | Blind |

**Requirement:** Interactive elements that trigger additional content should only have relationship and state ARIA attributes, such as `aria-expanded` and `aria-controls`, if they have interactive roles, such as button, tab, combobox and in rarer cases, link.

**Failing example:**

```html
<div aria-expanded="false" aria-haspopup="true">Career Paths</div>
```

**Passing example:**

```html
<button type="button" aria-expanded="false" aria-haspopup="true">
  Career Paths
  <svg aria-hidden="true">...</svg>
</button>
```

---

### 2.14 NoAutofocus

| Property | Value |
|----------|-------|
| **WCAG** | 2.0 — Level A |
| **Impacted Users** | Blind, Motor Impaired |

**Requirement:** Make sure that no element has an `autofocus` attribute. Autofocus moves keyboard focus away from the user's expected position and can disorient screen reader users.

**Failing example:**

```html
<input type="text" autofocus placeholder="Search">
```

**Passing example:**

```html
<input type="text" placeholder="Search">
```

---

### 2.15 AriaControlsHasReference

| Property | Value |
|----------|-------|
| **WCAG** | Best Practice |
| **Impacted Users** | Blind |

**Requirement:** The element's `aria-controls` points to an id that does not exist, or is not valid, breaking the link between the controlling element and the content it manages.

**Failing example:**

```html
<button aria-controls="nonexistent-panel">Toggle</button>
```

**Passing example:**

```html
<button aria-label="Open menu" aria-expanded="false" aria-controls="mobile-navigation">
  <span class="hamburger-bar"></span>
</button>
<nav id="mobile-navigation">...</nav>
```

---

### 2.16 LinkImageWarning

| Property | Value |
|----------|-------|
| **WCAG** | Best Practice |
| **Impacted Users** | Blind |

**Requirement:** It's good practice to warn users about the expected behavior when activating a link triggers an image to appear.

**Failing example:**

```html
<a href="/photo.jpg">View photo</a>
```

**Passing example:**

```html
<a href="/photo.jpg" aria-label="View photo (opens image)">View photo</a>
```

---

### 2.17 LinkMailtoWarning

| Property | Value |
|----------|-------|
| **WCAG** | Best Practice |
| **Impacted Users** | Blind |

**Requirement:** It's good practice to warn users about the expected behavior when activating a link triggers a mail application.

**Failing example:**

```html
<a href="mailto:hr@example.com">Contact us</a>
```

**Passing example:**

```html
<a href="mailto:hr@example.com" aria-label="Email hr@example.com (opens mail app)">Contact us</a>
```

---

### 2.18 LinkPDFWarning

| Property | Value |
|----------|-------|
| **WCAG** | Best Practice |
| **Impacted Users** | Blind |

**Requirement:** It's good practice to warn users about the expected behavior when activating a link triggers a PDF reader.

**Failing example:**

```html
<a href="/benefits-guide.pdf">Benefits Guide</a>
```

**Passing example:**

```html
<a href="/benefits-guide.pdf" aria-label="Benefits Guide (PDF, opens in new window)">Benefits Guide</a>
```

---

## 3. Forms (6 rules)

WCAG version: 2.0

---

### 3.1 CheckboxDiscernible

| Property | Value |
|----------|-------|
| **WCAG** | 2.0 — Level A |
| **Impacted Users** | Blind |

**Requirement:** Screen readers rely on properly coded and associated labels to announce the purpose of a form field. A checkbox control without an identifiable label may prevent screen reader users from completing the form.

**Failing example:**

```html
<input type="checkbox" value="Agree">
```

**Passing example:**

```html
<input id="filter-option" type="checkbox" aria-labelledby="filter-label filter-count" value="Hardees Test WD">
<span id="filter-label">Hardees Test WD</span>
<span id="filter-count">12</span>
```

---

### 3.2 FormContextChangeWarning

| Property | Value |
|----------|-------|
| **WCAG** | 2.0 — Level A |
| **Impacted Users** | Blind |

**Requirement:** Interacting with form controls shouldn't automatically submit a form or cause any other change in context without notifying the user in advance. Form controls that cause a context change on input can disorient a user, since the behavior is not expected.

**Failing example:**

```html
<select onchange="this.form.submit()">
  <option>Select location</option>
  <option value="nc">North Carolina</option>
</select>
```

**Passing example:**

```html
<select aria-label="Select location">
  <option>Select location</option>
  <option value="nc">North Carolina</option>
</select>
<button type="submit">Apply filter</button>
```

---

### 3.3 FormSubmitButtonMismatch

| Property | Value |
|----------|-------|
| **WCAG** | 2.0 — Level A |
| **Impacted Users** | Blind |

**Requirement:** Adding `type="submit"` to a control that submits a form ensures that screen reader users expect a change of context when they activate the control.

**Failing example:**

```html
<button onclick="submitForm()">Submit</button>
```

**Passing example:**

```html
<button type="submit">Submit Application</button>
```

---

### 3.4 MainNavigationMismatch

| Property | Value |
|----------|-------|
| **WCAG** | 2.0 — Level A |
| **Impacted Users** | Blind |

**Requirement:** Main navigation elements should have role navigation to ensure that screen readers can identify them as navigation regions.

**Failing example:**

```html
<div class="main-nav">
  <a href="/">Home</a>
  <a href="/jobs">Jobs</a>
</div>
```

**Passing example:**

```html
<nav aria-label="Main navigation">
  <a href="/">Home</a>
  <a href="/jobs">Jobs</a>
</nav>
```

---

### 3.5 RadioDiscernible

| Property | Value |
|----------|-------|
| **WCAG** | 2.0 — Level A |
| **Impacted Users** | Blind |

**Requirement:** Screen readers rely on properly coded and associated labels to announce the purpose of a form field. A radio control without an identifiable label may prevent screen reader users from completing the form.

**Failing example:**

```html
<input type="radio" name="shift" value="morning">
```

**Passing example:**

```html
<input type="radio" name="shift" value="morning" id="shift-morning">
<label for="shift-morning">Morning shift</label>
```

---

### 3.6 RequiredFormFieldAriaRequired

| Property | Value |
|----------|-------|
| **WCAG** | 2.0 — Level A |
| **Impacted Users** | Blind |

**Requirement:** If a field is marked as required only through visual cues, but lacks the `required` attribute or `aria-required="true"`, screen readers will not announce it as mandatory. As a result, users may experience unnecessary delays or confusion when trying to submit the form.

**Failing example:**

```html
<label>Email *</label>
<input type="email">
```

**Passing example:**

```html
<label for="email">Email *</label>
<input type="email" id="email" required aria-required="true">
```

---

## 4. Landmarks (10 rules)

WCAG versions: 2.0 + Best Practices

---

### 4.1 ArticleMisuse

| Property | Value |
|----------|-------|
| **WCAG** | 2.0 — Level A |
| **Impacted Users** | Blind |

**Requirement:** Using an `<article>` tag on content that is not self-contained and that cannot stand on its own outside the context of the page, such as a blog post, news story, or forum entry, causes screen readers to announce misleading information about the page structure.

**Failing example:**

```html
<article>
  <nav>Navigation links here</nav>
</article>
```

**Passing example:**

```html
<article>
  <h2>New Crew Member Position Available</h2>
  <p>We're hiring crew members at our Springfield location...</p>
</article>
```

---

### 4.2 BreadcrumbsMismatch

| Property | Value |
|----------|-------|
| **WCAG** | 2.0 — Level A |
| **Impacted Users** | Blind |

**Requirement:** A breadcrumb region presents a trail of links showing the user's current page in relation to higher-level pages on a site. Without a label, it may be announced by screen readers simply as "navigation", making it hard to distinguish from other navigation regions.

**Failing example:**

```html
<nav>
  <a href="/">Home</a> > <a href="/jobs">Jobs</a>
</nav>
```

**Passing example:**

```html
<nav aria-label="Breadcrumb">
  <ol>
    <li><a href="/">Home</a></li>
    <li><a href="/jobs" aria-current="page">Jobs</a></li>
  </ol>
</nav>
```

---

### 4.3 NavigationMisuse

| Property | Value |
|----------|-------|
| **WCAG** | 2.0 — Level A |
| **Impacted Users** | Blind |

**Requirement:** Screen readers rely on accurate tagging and labeling to provide necessary context. If an element that does not contain navigation links is tagged as a navigation landmark, screen reader users may lose orientation and find the page's structure difficult to understand.

**Failing example:**

```html
<nav id="desktop-navigation" aria-label="Main navigation">
  <a href="/">Careers Home</a>
  <!-- Links not wrapped in <ul>/<ol> -->
</nav>
```

**Passing example:**

```html
<nav class="page-links" aria-label="Pagination">
  <ul class="pagination__list">
    <li><a class="page-link" href="/page/1">1</a></li>
  </ul>
</nav>
```

---

### 4.4 RegionMainContentMismatch

| Property | Value |
|----------|-------|
| **WCAG** | 2.0 — Level A |
| **Impacted Users** | Blind |

**Requirement:** The main landmark represents the primary content of a page. It should include only content unique to that page and must remain separate from repeated elements, such as navigation, header, or footer.

**Failing example:**

```html
<body>
  <header>...</header>
  <div class="content">Page content without main landmark</div>
  <footer>...</footer>
</body>
```

**Passing example:**

```html
<main>
  <section id="hero" class="bg-black">...</section>
  <section id="careers">...</section>
</main>
```

---

### 4.5 RegionMainContentMisuse

| Property | Value |
|----------|-------|
| **WCAG** | 2.0 — Level A |
| **Impacted Users** | Blind |

**Requirement:** Incorrectly tagging the main landmark may cause screen reader users to misunderstand where the primary content begins or ends, leading to confusion and inefficient navigation.

**Failing example:**

```html
<main>
  <header>Site header</header>
  <nav>Navigation</nav>
  <div>Content</div>
  <footer>Site footer</footer>
</main>
```

**Passing example:**

```html
<header>...</header>
<main>
  <section id="hero">...</section>
</main>
<footer>...</footer>
```

---

### 4.6 RegionMainContentSingle

| Property | Value |
|----------|-------|
| **WCAG** | 2.0 — Level A |
| **Impacted Users** | Blind |

**Requirement:** A page typically presents one central subject, so a single main landmark establishes the boundaries of the primary content for screen reader users. Multiple main landmarks create uncertainty about the scope, leading to confusion and difficulty navigating.

**Failing example:**

```html
<main>Section 1</main>
<main>Section 2</main>
```

**Passing example:**

```html
<main>
  <section>Section 1</section>
  <section>Section 2</section>
</main>
```

---

### 4.7 SearchFormMismatch

| Property | Value |
|----------|-------|
| **WCAG** | 2.0 — Level A |
| **Impacted Users** | Blind |

**Requirement:** Screen reader users rely on landmarks to quickly access important regions of a page. Defining a form as a search landmark ensures that users can quickly recognize and navigate to the search form.

**Failing example:**

```html
<div class="c-jobs-search-vertical" data-testid="jobs-search_container">
  <input type="text" placeholder="Search jobs">
  <button>Search</button>
</div>
```

**Passing example:**

```html
<form role="search" aria-label="Job search">
  <input type="text" placeholder="Search jobs">
  <button type="submit">Search</button>
</form>
```

---

### 4.8 RegionFooterMismatch

| Property | Value |
|----------|-------|
| **WCAG** | Best Practice |
| **Impacted Users** | Blind |

**Requirement:** The contentinfo region, typically represented by the `<footer>` element, is found at the end of each page and provides screen reader users with information about the website, such as copyright, contact details, legal information, and navigation links.

**Failing example:**

```html
<div class="site-footer">
  <p>&copy; 2026 Company</p>
</div>
```

**Passing example:**

```html
<footer id="footer" class="bg-black overflow-hidden">
  <div class="px-[2.4rem] py-[4.8rem]">
    <p>&copy; 2026 Boddie-Noell Enterprises</p>
  </div>
</footer>
```

---

### 4.9 RegionFooterMisuse

| Property | Value |
|----------|-------|
| **WCAG** | Best Practice |
| **Impacted Users** | Blind |

**Requirement:** When a region without global site information is tagged as a contentinfo landmark, screen reader users may be misled about its purpose and expect website-level details, such as copyright or contact information.

**Failing example:**

```html
<div role="contentinfo" class="d3afa4">
  <span>Powered by <a href="https://www.paradox.ai">Paradox</a></span>
</div>
```

**Passing example:**

```html
<footer id="footer" class="bg-black overflow-hidden">
  <p>&copy; 2026 Boddie-Noell Enterprises</p>
  <nav aria-label="Footer navigation">...</nav>
</footer>
```

---

### 4.10 RegionFooterSingle

| Property | Value |
|----------|-------|
| **WCAG** | Best Practice |
| **Impacted Users** | Blind |

**Requirement:** Each page should normally include only one contentinfo landmark (usually the site footer) to keep landmark navigation simple and predictable. Additional contentinfo landmarks are permitted when clearly justified, but they must each have a unique accessible name.

**Failing example:**

```html
<footer>Site footer</footer>
<div role="contentinfo">Powered by Paradox</div>
<!-- Two contentinfo landmarks without unique names -->
```

**Passing example:**

```html
<footer id="footer" aria-label="Site footer">
  <p>&copy; 2026 Boddie-Noell Enterprises</p>
</footer>
```

---

## 5. Graphics (6 rules)

WCAG version: 2.0

---

### 5.1 BackgroundImageDiscernibleImage

| Property | Value |
|----------|-------|
| **WCAG** | 2.0 — Level A |
| **Impacted Users** | Blind |

**Requirement:** Functional images presented using CSS `background` or `background-image` properties should be marked up using `role="img"` so that they can be identified as images by screen reader users.

**Failing example:**

```html
<div style="background-image: url('logo.png')"></div>
```

**Passing example:**

```html
<div style="background-image: url('logo.png')" role="img" aria-label="Company logo"></div>
```

---

### 5.2 DecorativeGraphicExposed

| Property | Value |
|----------|-------|
| **WCAG** | 2.0 — Level A |
| **Impacted Users** | Blind |

> *Internal scanner rule — not present in commercial accessScan docs.*

**Requirement:** Decorative graphics (icons, dividers, background flourishes) that carry no informational value must be hidden from assistive technology using `aria-hidden="true"` or `role="presentation"`. Exposed decorative graphics create noise for screen reader users.

**Failing example:**

```html
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
  <path d="M12 2L2 12h3v8h6v-6h2v6h6v-8h3z"/>
</svg>
```

**Passing example:**

```html
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" aria-hidden="true">
  <path d="M12 2L2 12h3v8h6v-6h2v6h6v-8h3z"/>
</svg>
```

---

### 5.3 IconDiscernible

| Property | Value |
|----------|-------|
| **WCAG** | 2.0 — Level A |
| **Impacted Users** | Blind |

**Requirement:** Smaller graphics used as decorative or complementary elements, such as icons, and that do not provide additional information will often add unnecessary clutter to a screen reader user's browsing experience.

**Failing example:**

```html
<svg xmlns="http://www.w3.org/2000/svg" width="6" height="10" viewBox="0 0 6 10">
  <path d="M4.191 4.998..." fill="currentColor"/>
</svg>
```

**Passing example:**

```html
<svg class="w-[1.7rem] h-[1.2rem]" viewBox="0 0 17 12" aria-hidden="true">
  <path d="M1.537 2.979..."/>
</svg>
```

---

### 5.4 ImageDiscernible

| Property | Value |
|----------|-------|
| **WCAG** | 2.0 — Level A |
| **Impacted Users** | Blind |

**Requirement:** Images require a text alternative when the image conveys meaningful content or serves a functional purpose. If the image is decorative, it must be hidden from assistive technology.

**Failing example:**

```html
<img src="hero.webp">
```

**Passing example:**

```html
<img src="...hero-header.webp" alt="Hardee's team member proudly serving at the restaurant">
```

---

### 5.5 ImageDiscernibleCorrectly

| Property | Value |
|----------|-------|
| **WCAG** | 2.0 — Level A |
| **Impacted Users** | Blind |

**Requirement:** Text alternatives must provide accurate descriptions of the image. Incorrect text alternatives, such as filenames or other placeholder values, may cause screen reader users to either miss essential information or hear unnecessary content that disrupts their experience.

**Failing example:**

```html
<img src="hero-header.webp" alt="hero-header.webp">
```

**Passing example:**

```html
<img src="...hero-header.webp" alt="Hardee's team member proudly serving at the restaurant">
```

---

### 5.6 ImageMisuse

| Property | Value |
|----------|-------|
| **WCAG** | 2.0 — Level A |
| **Impacted Users** | Blind |

**Requirement:** When non-graphical elements are marked up as images, screen reader users may misunderstand the intended purpose of the content.

**Failing example:**

```html
<div role="img">This is text content, not an image</div>
```

**Passing example:**

```html
<img src="...hardees-logo.webp" alt="Hardee's">
```

---

## 6. Dragging Alternative (1 rule)

WCAG version: 2.2

---

### 6.1 DraggingAlternative

| Property | Value |
|----------|-------|
| **WCAG** | 2.2 — Level AA (SC 2.5.7) |
| **Impacted Users** | Motor Impaired |

> Commercial alias: `NoUiSliderSinglePointer`

**Requirement:** For any action that uses a dragging movement (e.g., sliders, drag-and-drop), a single-pointer alternative must also be provided so that users who cannot perform complex gestures can still complete the action.

**Failing example:**

```html
<div class="slider" ondrag="updateValue(event)">
  <div class="slider-thumb"></div>
</div>
```

**Passing example:**

```html
<div class="slider" role="slider" aria-valuenow="50" aria-valuemin="0" aria-valuemax="100" tabindex="0">
  <div class="slider-thumb"></div>
</div>
<!-- Also operable with arrow keys and click-to-set -->
```

---

## 7. ARIA (2 rules)

WCAG version: 2.1

---

### 7.1 AriaLabelledbyContentMismatch

| Property | Value |
|----------|-------|
| **WCAG** | 2.1 — Level A (SC 2.5.3) |
| **Impacted Users** | Blind, Motor Impaired |

> *Internal scanner rule — not present in commercial accessScan docs.*

**Requirement:** When `aria-labelledby` references an element whose text differs from the control's visible text, speech-input users (e.g., Dragon NaturallySpeaking) cannot activate the control by saying the visible label. The accessible name must contain the visible text.

**Failing example:**

```html
<span id="label-1">Proceed to checkout</span>
<button aria-labelledby="label-1">Buy now</button>
<!-- Visible text "Buy now" is not in accessible name "Proceed to checkout" -->
```

**Passing example:**

```html
<span id="label-1">Buy now</span>
<button aria-labelledby="label-1">Buy now</button>
```

---

### 7.2 VisibleTextPartOfAccessibleName

| Property | Value |
|----------|-------|
| **WCAG** | 2.1 — Level A (SC 2.5.3) |
| **Impacted Users** | Blind |

**Requirement:** ARIA labels should describe elements that don't have proper text, like icons and field labels. It should not be used to override element texts. Screen reader users need to receive the exact text as visually on the screen, with more context if it is ambiguous. An exception applies to landmarks such as `<nav>`.

**Failing example:**

```html
<input type="checkbox" aria-labelledby="filter-label filter-count" value="Hardees Test WD">
<!-- If aria-labelledby text doesn't include visible text -->
```

**Passing example:**

```html
<a class="results-list__item-apply" aria-label="Apply Now, Hardees of Springfield - General Manager" href="...">
  <span class="results-list__item-apply--label">Apply Now</span>
</a>
```

---

## 8. Lists (2 rules)

WCAG versions: 2.2 + 2.0

---

### 8.1 StickyHeaderObscuresFocus

| Property | Value |
|----------|-------|
| **WCAG** | 2.2 — Level AA (SC 2.4.11) |
| **Impacted Users** | Motor Impaired |

> Commercial alias: `FocusNotObscuredHeader`

**Requirement:** A sticky header remains anchored to the top of the screen while the rest of the page content can be scrolled. If it is not offset from interactive elements, it can overlap and obscure the item in focus.

**Failing example:**

```html
<header id="header" class="fixed top-0 w-full z-100">
  <!-- Fixed header without scroll-padding-top on body -->
</header>
```

**Passing example:**

```html
<header id="header" class="fixed top-0 w-full z-100">...</header>
<style>html { scroll-padding-top: 120px; }</style>
```

---

### 8.2 ListEmpty

| Property | Value |
|----------|-------|
| **WCAG** | 2.0 — Level A |
| **Impacted Users** | Blind |

> Commercial alias: `ListNotEmpty`

**Requirement:** An empty list will still be announced by screen readers, which may confuse users, leaving them unsure if the list is empty or an issue prevents the screen reader from announcing the list items.

**Failing example:**

```html
<ul class="jobs-current-searches__tag-list" data-testid="jobs-current-searches_list"></ul>
```

**Passing example:**

```html
<ul class="results-list" data-testid="jobs-list">
  <li class="results-list__item">Crew Member - Springfield</li>
  <li class="results-list__item">Shift Leader - Durham</li>
</ul>
```

---

## 9. Metadata (8 rules)

WCAG versions: 2.0 + Best Practices

---

### 9.1 HtmlLang

| Property | Value |
|----------|-------|
| **WCAG** | 2.0 — Level A |
| **Impacted Users** | Blind |

**Requirement:** Specifying a default page language ensures screen readers apply the correct pronunciation rules, voices, and braille output. Without it, screen readers may guess the language incorrectly, causing mispronunciations, confusion, and reduced comprehension for users.

**Failing example:**

```html
<html>
```

**Passing example:**

```html
<html lang="en">
```

---

### 9.2 HtmlLangValid

| Property | Value |
|----------|-------|
| **WCAG** | Best Practice |
| **Impacted Users** | Blind |

**Requirement:** Assigning a valid ISO language value to the `<html>` `lang` attribute ensures that screen readers use the correct pronunciation rules, browsers apply proper spell-checking and translation, and search engines index the content in the appropriate language.

**Failing example:**

```html
<html lang="english">
```

**Passing example:**

```html
<html lang="en">
```

---

### 9.3 MetaDescription

| Property | Value |
|----------|-------|
| **WCAG** | Best Practice |
| **Impacted Users** | Cognitive Disability |

> *Internal scanner rule — not present in commercial accessScan docs.*

**Requirement:** Every page should include a `<meta name="description">` tag with a concise summary of the page content. This helps search engines index the page correctly and provides context for users with cognitive disabilities who rely on descriptive search results.

**Failing example:**

```html
<head>
  <title>Jobs</title>
  <!-- No meta description -->
</head>
```

**Passing example:**

```html
<head>
  <title>Careers at Hardee's</title>
  <meta name="description" content="Explore crew member, management, and service technician positions at Hardee's restaurants.">
</head>
```

---

### 9.4 MetaRefresh

| Property | Value |
|----------|-------|
| **WCAG** | 2.0 — Level A |
| **Impacted Users** | Blind, Cognitive Disability, Motor Impaired, Vision Impaired |

**Requirement:** A `<meta>` element with `http-equiv="refresh"` is sometimes used to automatically redirect users after a time delay. These timed changes can interrupt and disorient users who rely on assistive technology.

**Failing example:**

```html
<meta http-equiv="refresh" content="5;url=https://example.com">
```

**Passing example:**

```html
<!-- Use server-side redirects (301/302) instead of meta refresh -->
<a href="https://example.com">Click here to continue</a>
```

---

### 9.5 MetaViewportPresent

| Property | Value |
|----------|-------|
| **WCAG** | Best Practice |
| **Impacted Users** | Vision Impaired |

**Requirement:** Providing a meta viewport to control layout and scaling on mobile devices.

**Failing example:**

```html
<head>
  <!-- No viewport meta tag -->
</head>
```

**Passing example:**

```html
<meta name="viewport" content="width=device-width, initial-scale=1.0">
```

---

### 9.6 MetaViewportScalable

| Property | Value |
|----------|-------|
| **WCAG** | 2.0 — Level A |
| **Impacted Users** | Vision Impaired |

**Requirement:** The meta viewport should allow scalability, typically with `width=device-width, initial-scale=1`, so text can be resized up to 200% without loss of functionality. Using `user-scalable=no` or `maximum-scale=1` prevents users from enlarging content, making it difficult for people with low vision to read or interact.

**Failing example:**

```html
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=5.0, user-scalable=no">
```

**Passing example:**

```html
<meta name="viewport" content="width=device-width, initial-scale=1.0">
```

---

### 9.7 PageTitle

| Property | Value |
|----------|-------|
| **WCAG** | 2.0 — Level A |
| **Impacted Users** | Blind |

**Requirement:** A missing page title makes it difficult for screen reader users and sighted users with multiple tabs open to identify the page, reducing orientation and usability.

**Failing example:**

```html
<head>
  <!-- No <title> element -->
</head>
```

**Passing example:**

```html
<title>Careers at Hardee's | Boddie-Noell Enterprises</title>
```

---

### 9.8 PageTitleDescriptive

| Property | Value |
|----------|-------|
| **WCAG** | 2.0 — Level A |
| **Impacted Users** | Blind |

**Requirement:** Screen readers rely heavily on page titles to announce the purpose of a page. If titles aren't descriptive, users with low or no vision may not understand the context until they start navigating the page.

**Failing example:**

```html
<title></title>
```

**Passing example:**

```html
<title>Careers at Hardee's — Crew, Management & Technician Jobs</title>
```

---

## 10. Tabs (9 rules)

WCAG version: 2.0

---

### 10.1 TablistRole

| Property | Value |
|----------|-------|
| **WCAG** | 2.0 — Level A |
| **Impacted Users** | Blind |

> *Internal scanner rule — not present in commercial accessScan docs.*

**Requirement:** A container of tabs must have `role="tablist"` so assistive technology can identify it as a group of tabs and announce the number of tabs present.

**Failing example:**

```html
<div class="tabs">
  <button role="tab">Tab 1</button>
  <button role="tab">Tab 2</button>
</div>
```

**Passing example:**

```html
<div class="tabs" role="tablist" aria-label="Job categories">
  <button role="tab" aria-selected="true">Tab 1</button>
  <button role="tab">Tab 2</button>
</div>
```

---

### 10.2 TabAriaControls

| Property | Value |
|----------|-------|
| **WCAG** | 2.0 — Level A |
| **Impacted Users** | Blind |

> *Internal scanner rule — not present in commercial accessScan docs.*

**Requirement:** Each tab must have an `aria-controls` attribute that references the id of its corresponding tab panel, so screen readers can link the tab to its content.

**Failing example:**

```html
<button role="tab">Details</button>
<div role="tabpanel" id="panel-details">...</div>
```

**Passing example:**

```html
<button role="tab" aria-controls="panel-details">Details</button>
<div role="tabpanel" id="panel-details">...</div>
```

---

### 10.3 TabAriaSelected

| Property | Value |
|----------|-------|
| **WCAG** | 2.0 — Level A |
| **Impacted Users** | Blind |

> *Internal scanner rule — not present in commercial accessScan docs.*

**Requirement:** The active tab must have `aria-selected="true"` and inactive tabs must have `aria-selected="false"` so screen readers can announce which tab is currently selected.

**Failing example:**

```html
<button role="tab" class="active">Tab 1</button>
<button role="tab">Tab 2</button>
```

**Passing example:**

```html
<button role="tab" aria-selected="true">Tab 1</button>
<button role="tab" aria-selected="false">Tab 2</button>
```

---

### 10.4 TabListMisuse

| Property | Value |
|----------|-------|
| **WCAG** | 2.0 — Level A |
| **Impacted Users** | Blind |

> Commercial alias: `TabListMisMatch`

**Requirement:** Applying `role="tablist"` to an element without tabs misleads screen reader users by suggesting a group of tabs that does not exist. A tablist without `role="tablist"` is not announced as a group of related tabs.

**Failing example:**

```html
<div role="tablist">
  <a href="/page1">Link 1</a>
  <a href="/page2">Link 2</a>
</div>
```

**Passing example:**

```html
<div role="tablist" aria-label="Sections">
  <button role="tab" aria-selected="true">Overview</button>
  <button role="tab" aria-selected="false">Details</button>
</div>
```

---

### 10.5 TabMismatch

| Property | Value |
|----------|-------|
| **WCAG** | 2.0 — Level A |
| **Impacted Users** | Blind |

**Requirement:** Custom tabs must be explicitly defined for screen readers since there are no native HTML tab elements. Without assigning `role="tab"` to the interactive elements, assistive technology will not identify them as tabs, preventing users from understanding their function or navigating them as part of a tab interface.

**Failing example:**

```html
<div role="tablist">
  <button>Tab 1</button>
  <button>Tab 2</button>
</div>
```

**Passing example:**

```html
<div role="tablist">
  <button role="tab" aria-selected="true">Tab 1</button>
  <button role="tab" aria-selected="false">Tab 2</button>
</div>
```

---

### 10.6 TabMisuse

| Property | Value |
|----------|-------|
| **WCAG** | 2.0 — Level A |
| **Impacted Users** | Blind |

**Requirement:** Applying `role="tab"` to an element that is not part of a functioning tab interface misleads screen reader users by presenting it as a tab without a corresponding panel.

**Failing example:**

```html
<a href="/page1" role="tab">Page 1</a>
```

**Passing example:**

```html
<div role="tablist">
  <button role="tab" aria-controls="panel-1">Tab 1</button>
</div>
<div role="tabpanel" id="panel-1">Content for Tab 1</div>
```

---

### 10.7 TabPanelMismatch

| Property | Value |
|----------|-------|
| **WCAG** | 2.0 — Level A |
| **Impacted Users** | Blind |

**Requirement:** The `role="tabpanel"` identifies an element as the content region of a tab interface. Without this role, panels are exposed only by their native role (such as a generic div or a named section) and screen reader users may not perceive them as part of the tab structure.

**Failing example:**

```html
<button role="tab" aria-controls="content-1">Tab 1</button>
<div id="content-1">Tab content here</div>
```

**Passing example:**

```html
<button role="tab" aria-controls="content-1">Tab 1</button>
<div role="tabpanel" id="content-1">Tab content here</div>
```

---

### 10.8 TabPanelMisuse

| Property | Value |
|----------|-------|
| **WCAG** | 2.0 — Level A |
| **Impacted Users** | Blind |

**Requirement:** Applying `role="tabpanel"` to an element without a corresponding tab misleads screen reader users by announcing it as tab content, even though no controlling tab exists.

**Failing example:**

```html
<div role="tabpanel">
  <p>Standalone content not part of any tabs</p>
</div>
```

**Passing example:**

```html
<button role="tab" aria-controls="panel-1" aria-selected="true">Overview</button>
<div role="tabpanel" id="panel-1" aria-labelledby="tab-1">
  <p>Overview content</p>
</div>
```

---

### 10.9 TabpanelLabelledBy

| Property | Value |
|----------|-------|
| **WCAG** | 2.0 — Level A |
| **Impacted Users** | Blind |

> *Internal scanner rule — not present in commercial accessScan docs.*

**Requirement:** Each tab panel must have an `aria-labelledby` attribute that references the id of its controlling tab, so screen readers can announce the panel's label when focus enters it.

**Failing example:**

```html
<button role="tab" id="tab-1">Overview</button>
<div role="tabpanel">Overview content</div>
```

**Passing example:**

```html
<button role="tab" id="tab-1" aria-controls="panel-1">Overview</button>
<div role="tabpanel" id="panel-1" aria-labelledby="tab-1">Overview content</div>
```

---

## 11. Tables (7 rules)

WCAG version: 2.0

---

### 11.1 TableCaption

| Property | Value |
|----------|-------|
| **WCAG** | 2.0 — Level A |
| **Impacted Users** | Blind |

> *Internal scanner rule — not present in commercial accessScan docs.*

**Requirement:** Data tables should include a `<caption>` element or `aria-label`/`aria-labelledby` to give screen reader users a summary of the table's purpose before they begin navigating rows and columns.

**Failing example:**

```html
<table>
  <tr><th>Location</th><th>Positions</th></tr>
  <tr><td>Springfield</td><td>5</td></tr>
</table>
```

**Passing example:**

```html
<table>
  <caption>Open positions by location</caption>
  <tr><th>Location</th><th>Positions</th></tr>
  <tr><td>Springfield</td><td>5</td></tr>
</table>
```

---

### 11.2 TableHeaderEmpty

| Property | Value |
|----------|-------|
| **WCAG** | 2.0 — Level A |
| **Impacted Users** | Blind |

**Requirement:** If a table header cell is empty, screen reader users may only hear a generic label such as "column 3" or nothing at all. This makes it harder to understand what each column or row represents.

**Failing example:**

```html
<table>
  <tr><th>Name</th><th></th><th>Location</th></tr>
</table>
```

**Passing example:**

```html
<table>
  <tr><th>Name</th><th>Actions</th><th>Location</th></tr>
</table>
```

---

### 11.3 TableHeaders

| Property | Value |
|----------|-------|
| **WCAG** | 2.0 — Level A |
| **Impacted Users** | Blind |

> *Internal scanner rule — not present in commercial accessScan docs.* Commercial alias: `TableColumnHeaderMismatch`

**Requirement:** Data tables must use `<th>` elements (with appropriate `scope` attributes for complex tables) so screen readers can announce column and row headers while navigating cells.

**Failing example:**

```html
<table>
  <tr><td class="bold">Name</td><td class="bold">Location</td></tr>
  <tr><td>John</td><td>Springfield</td></tr>
</table>
```

**Passing example:**

```html
<table>
  <tr><th scope="col">Name</th><th scope="col">Location</th></tr>
  <tr><td>John</td><td>Springfield</td></tr>
</table>
```

---

### 11.4 TableMisuse

| Property | Value |
|----------|-------|
| **WCAG** | 2.0 — Level A |
| **Impacted Users** | Blind |

**Requirement:** When a layout table is marked up with HTML elements like `<table>` or `<tr>`, or assigned table ARIA roles, screen readers announce a data table structure with rows, columns, and headers, even though the table is only used for page layout.

**Failing example:**

```html
<table>
  <tr>
    <td><nav>...</nav></td>
    <td><main>...</main></td>
  </tr>
</table>
```

**Passing example:**

```html
<div class="flex">
  <nav>...</nav>
  <main>...</main>
</div>
```

---

### 11.5 TableNesting

| Property | Value |
|----------|-------|
| **WCAG** | 2.0 — Level A |
| **Impacted Users** | Blind |

> Commercial alias: `TableNested`

**Requirement:** Nested tables are often misinterpreted by screen readers, making it hard for users to follow the intended structure and meaning of the data.

**Failing example:**

```html
<table>
  <tr><td>
    <table>
      <tr><td>Nested data</td></tr>
    </table>
  </td></tr>
</table>
```

**Passing example:**

```html
<table>
  <tr><td>Data in a flat table structure</td></tr>
</table>
```

---

### 11.6 TableRoles

| Property | Value |
|----------|-------|
| **WCAG** | 2.0 — Level A |
| **Impacted Users** | Blind |

> *Internal scanner rule — not present in commercial accessScan docs.*

**Requirement:** Elements with ARIA table roles (`role="table"`, `role="row"`, `role="cell"`, etc.) must follow the correct nesting hierarchy. Incorrect role usage causes screen readers to misrepresent the table structure.

**Failing example:**

```html
<div role="table">
  <div role="cell">Data without row wrapper</div>
</div>
```

**Passing example:**

```html
<div role="table" aria-label="Job listings">
  <div role="row">
    <div role="columnheader">Title</div>
    <div role="columnheader">Location</div>
  </div>
  <div role="row">
    <div role="cell">Crew Member</div>
    <div role="cell">Springfield</div>
  </div>
</div>
```

---

### 11.7 TableRowHeaderMismatch

| Property | Value |
|----------|-------|
| **WCAG** | 2.0 — Level A |
| **Impacted Users** | Blind |

**Requirement:** If a table row header is not marked up with the correct role or scope, screen reader users cannot determine which header applies to each cell.

**Failing example:**

```html
<table>
  <tr><td>Springfield</td><td>5 positions</td></tr>
</table>
```

**Passing example:**

```html
<table>
  <tr><th scope="row">Springfield</th><td>5 positions</td></tr>
</table>
```

---

## Rule Summary by Category

| # | Category | Rules | WCAG Versions |
|---|----------|-------|---------------|
| 1 | General | 14 | 2.1, 2.0, Best Practices |
| 2 | Interactive Content | 18 | 2.2, 2.0, Best Practices |
| 3 | Forms | 6 | 2.0 |
| 4 | Landmarks | 10 | 2.0, Best Practices |
| 5 | Graphics | 6 | 2.0 |
| 6 | Dragging Alternative | 1 | 2.2 |
| 7 | ARIA | 2 | 2.1 |
| 8 | Lists | 2 | 2.2, 2.0 |
| 9 | Metadata | 8 | 2.0, Best Practices |
| 10 | Tabs | 9 | 2.0 |
| 11 | Tables | 7 | 2.0 |
| | **Total** | **83** | |

---

## Internal-Only Rules (Not in Commercial accessScan)

These 10 rules are implemented in our internal scanner (`schema.js`) but are not part of the commercial accessScan tool's 73-rule set:

| Rule | Category | WCAG |
|------|----------|------|
| `LinkOpensNewWindow` | Interactive Content | 2.0 — A |
| `TargetSize` | Interactive Content | 2.2 — AA |
| `DecorativeGraphicExposed` | Graphics | 2.0 — A |
| `AriaLabelledbyContentMismatch` | ARIA | 2.1 — A |
| `MetaDescription` | Metadata | Best Practice |
| `TablistRole` | Tabs | 2.0 — A |
| `TabAriaControls` | Tabs | 2.0 — A |
| `TabAriaSelected` | Tabs | 2.0 — A |
| `TabpanelLabelledBy` | Tabs | 2.0 — A |
| `TableCaption` | Tables | 2.0 — A |
| `TableHeaders` | Tables | 2.0 — A |
| `TableRoles` | Tables | 2.0 — A |

---

## Name Mapping: Commercial vs Internal Scanner

Where the commercial accessScan tool uses a different rule name than our internal scanner:

| Commercial Name | Internal Name | Category |
|-----------------|---------------|----------|
| `NoUiSliderSinglePointer` | `DraggingAlternative` | Dragging |
| `FocusNotObscuredHeader` | `StickyHeaderObscuresFocus` | Lists |
| `ListNotEmpty` | `ListEmpty` | Lists |
| `TabListMisMatch` | `TabListMisuse` | Tabs |
| `TableColumnHeaderMismatch` | `TableHeaders` | Tables |
| `TableNested` | `TableNesting` | Tables |
