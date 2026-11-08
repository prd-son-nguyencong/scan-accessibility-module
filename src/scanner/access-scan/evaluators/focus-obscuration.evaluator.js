import {
  elementFinding,
  getEvaluatorCache,
  getSession,
  getSnapshot,
} from './lib/runtime-context.js';

const CACHE_KEY = 'focusObscurationAudit';
const TAB_STOPS = 60; // real Tab presses per page at the scan viewport

// focus()-only: Tab did not reach the control within the limit, so what a keyboard user sees is not measured: a question, not a confirmed failure.
function obscuredFinding(entry) {
  const base = elementFinding(entry.element, { obscuringOverlay: entry.overlaySelector, obscuringChain: entry.overlayChain, proof: entry.proof, focusMethod: entry.method });
  // A semi-opaque bar (rgba background, backdrop-filter, opacity below 1) leaves the content readable through it: 2.4.11 only fails when the control is entirely hidden.
  return entry.method === 'focus-only' || entry.translucent ? { ...base, violationType: 'manual-review', ...(entry.translucent ? { reviewReason: 'the overlay is translucent: the focused control may still be visible through it' } : {}) } : base;
}

/** @type {import('../engine/loader.js').EvaluatorModule} */
export default {
  id: 'focus-obscuration',
  async evaluate(context, check) {
    const mode = /** @type {string} */ (check.options?.mode);
    const cache = getEvaluatorCache(context);
    if (!cache[CACHE_KEY]) {
      cache[CACHE_KEY] = await runFocusObscurationAudit(context);
    }
    const audit = /** @type {Awaited<ReturnType<typeof runFocusObscurationAudit>>} */ (cache[CACHE_KEY]);
    /** @type {import('../engine/loader.js').EvaluatorResult['findings']} */
    const findings = [];

    if (mode === 'sticky-header-obscures-focus') {
      for (const entry of audit.headerObscured) {
        findings.push(obscuredFinding(entry));
      }
      return { status: 'complete', candidatesScanned: audit.focusablesScanned, findings };
    }

    if (mode === 'focus-not-obscured-footer') {
      for (const entry of audit.footerObscured) {
        findings.push(obscuredFinding(entry));
      }
      return { status: 'complete', candidatesScanned: audit.focusablesScanned, findings };
    }

    throw Object.assign(new Error(`unsupported focus-obscuration mode "${mode}"`), {
      errorCode: 'evaluator_failure',
    });
  },
};

/**
 * @param {unknown} context
 */
async function runFocusObscurationAudit(context) {
  const session = getSession(context);
  const fork = await session.forkBehavioralPage();
  try {
    const result = await fork.page.evaluate(async () => {
      const ELEMENT_NODE = 1;
      const DOCUMENT_FRAGMENT_NODE = 11;

      const semantics = globalThis.__adaScanRuntime?.semantics;

      const isElement = (node) => Boolean(node && node.nodeType === ELEMENT_NODE);
      const isShadowRoot = (node) => Boolean(
        node
        && node.nodeType === DOCUMENT_FRAGMENT_NODE
        && node.host,
      );
      const isIframeElement = (element) => isElement(element) && element.tagName === 'IFRAME';

      const getOwnerWindow = (node) => node?.ownerDocument?.defaultView ?? null;
      const getNodeFilter = (doc) => doc?.defaultView?.NodeFilter ?? { SHOW_ELEMENT: 1 };

      const getComputedStyleFor = (element) => {
        const win = getOwnerWindow(element);
        if (!win || typeof win.getComputedStyle !== 'function') {
          return {
            display: '',
            visibility: '',
            contentVisibility: '',
            position: '',
            top: '',
            bottom: '',
          };
        }
        return win.getComputedStyle(element);
      };

      const getViewportSize = (element) => {
        const win = getOwnerWindow(element);
        const doc = element.ownerDocument;
        return {
          width: win?.innerWidth || doc?.documentElement?.clientWidth || 0,
          height: win?.innerHeight || doc?.documentElement?.clientHeight || 0,
        };
      };

      const escapeIdentifier = (value) => {
        const css = globalThis.CSS;
        if (css && typeof css.escape === 'function') {
          return css.escape(value);
        }
        return String(value).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
      };

      const buildIdCountMap = (scopeRoot, doc) => {
        /** @type {Map<string, number>} */
        const counts = new Map();
        const nodeFilter = getNodeFilter(doc);
        const walker = doc.createTreeWalker(scopeRoot, nodeFilter.SHOW_ELEMENT);
        let node = walker.nextNode();
        while (node) {
          if (node.id) {
            counts.set(node.id, (counts.get(node.id) || 0) + 1);
          }
          node = walker.nextNode();
        }
        return counts;
      };

      const structuralSelector = (element, idCountMap) => {
        const segments = [];
        let current = element;
        while (isElement(current)) {
          const tag = current.tagName.toLowerCase();
          let segment = tag;
          if (current.id) {
            const idTotal = idCountMap.get(current.id) || 0;
            if (idTotal === 1) {
              segment = `${tag}#${escapeIdentifier(current.id)}`;
              segments.unshift(segment);
              break;
            }
          }

          const parent = current.parentElement;
          if (parent) {
            const siblings = [...parent.children].filter(
              (child) => child.tagName === current.tagName,
            );
            const index = siblings.indexOf(current) + 1;
            segment = `${tag}:nth-of-type(${index})`;
          }
          segments.unshift(segment);
          current = current.parentElement;
        }
        return segments.join(' > ');
      };

      const buildReportSelector = (localSelector, framePath, shadowPath) => {
        const prefixes = ['document'];
        for (const index of framePath) {
          prefixes.push(`frame[${index}]`);
        }
        for (const index of shadowPath) {
          prefixes.push(`shadow[${index}]`);
        }
        return `${prefixes.join('>')}>${localSelector}`;
      };

      const nextCounter = (counters, scopeKey) => {
        const current = counters.get(scopeKey) || 0;
        counters.set(scopeKey, current + 1);
        return current;
      };

      const getFrameAccess = (iframe) => {
        if (!isIframeElement(iframe)) {
          return { accessible: false, reason: 'not-frame', document: null };
        }

        const parentWin = getOwnerWindow(iframe);
        const sandbox = iframe.getAttribute('sandbox');
        if (sandbox !== null && !/\ballow-same-origin\b/i.test(sandbox)) {
          return { accessible: false, reason: 'sandbox', document: null };
        }

        const srcAttr = iframe.getAttribute('src');
        if (srcAttr && parentWin) {
          try {
            const resolved = new parentWin.URL(srcAttr, iframe.ownerDocument.baseURI);
            if (
              (resolved.protocol === 'http:' || resolved.protocol === 'https:')
              && resolved.origin !== parentWin.location.origin
            ) {
              return { accessible: false, reason: 'cross-origin', document: null };
            }
          } catch {
            return { accessible: false, reason: 'cross-origin', document: null };
          }
        }

        try {
          const doc = iframe.contentDocument;
          const childWin = doc?.defaultView;
          if (!doc || !childWin) {
            return { accessible: false, reason: 'cross-origin', document: null };
          }
          try {
            const frameOrigin = childWin.location.origin;
            if (
              frameOrigin
              && frameOrigin !== 'null'
              && parentWin
              && frameOrigin !== parentWin.location.origin
            ) {
              return { accessible: false, reason: 'cross-origin', document: null };
            }
          } catch {
            return { accessible: false, reason: 'cross-origin', document: null };
          }
          return { accessible: true, reason: null, document: doc };
        } catch {
          return { accessible: false, reason: 'cross-origin', document: null };
        }
      };

      const fallbackIsRendered = (element) => {
        for (let current = element; current; current = current.parentElement) {
          if (
            current.hidden
            || current.hasAttribute('inert')
            || current.getAttribute('aria-hidden') === 'true'
          ) {
            return false;
          }
          const style = getComputedStyleFor(current);
          if (
            style.display === 'none'
            || style.visibility === 'hidden'
            || style.contentVisibility === 'hidden'
          ) {
            return false;
          }
        }
        const rect = element.getBoundingClientRect();
        return element.getClientRects().length > 0 && rect.width > 0 && rect.height > 0;
      };

      const fallbackIsFocusable = (element) => {
        if (!fallbackIsRendered(element)) return false;
        if (element.disabled) return false;
        const tag = element.tagName;
        if (tag === 'A') return Boolean(element.getAttribute('href'));
        if (tag === 'BUTTON' || tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'SUMMARY') {
          return true;
        }
        if (tag === 'INPUT' && element.getAttribute('type') !== 'hidden') return true;
        if (element.isContentEditable) return true;
        const tabIndex = element.getAttribute('tabindex');
        return tabIndex !== null && tabIndex !== '-1';
      };

      const isRendered = semantics?.isRendered ?? fallbackIsRendered;
      const isFocusable = semantics?.isFocusable ?? fallbackIsFocusable;

      const classifyOverlay = (element) => {
        const style = getComputedStyleFor(element);
        if (style.position !== 'fixed' && style.position !== 'sticky') return null;
        const rect = element.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return null;
        const viewport = getViewportSize(element);
        const isSemanticChrome = (
          element.tagName === 'HEADER'
          || element.tagName === 'FOOTER'
          || element.getAttribute('role') === 'banner'
          || element.getAttribute('role') === 'contentinfo'
        );
        const spansChrome = rect.width >= viewport.width * 0.25 && rect.height >= 24;
        if (!isSemanticChrome && !spansChrome) return null;

        const topOffset = Number.parseFloat(style.top);
        const bottomOffset = Number.parseFloat(style.bottom);
        const isTopAnchored = (
          Number.isFinite(topOffset) && Math.abs(topOffset) <= 1
        ) || (
          isSemanticChrome
          && (element.tagName === 'HEADER' || element.getAttribute('role') === 'banner')
          && (style.position === 'fixed' || style.position === 'sticky')
        );
        const isBottomAnchored = (
          Number.isFinite(bottomOffset) && Math.abs(bottomOffset) <= 1
        ) || (
          Number.isFinite(topOffset) && rect.top >= viewport.height * 0.7
        ) || (
          isSemanticChrome
          && (element.tagName === 'FOOTER' || element.getAttribute('role') === 'contentinfo')
          && (style.position === 'fixed' || style.position === 'sticky')
        );
        if (isTopAnchored) return 'header';
        if (isBottomAnchored) return 'footer';
        return null;
      };

      const elementHasFocus = (element) => {
        const doc = element.ownerDocument;
        if (!doc) return false;
        const active = doc.activeElement;
        if (!active) return false;
        if (active === element) return true;
        const root = element.getRootNode();
        if (isShadowRoot(root)) {
          if (active === root.host) return true;
          if (root.activeElement === element) return true;
        }
        return false;
      };

      const pointInsideRect = (x, y, rect) => (
        x >= rect.left
        && x <= rect.right
        && y >= rect.top
        && y <= rect.bottom
      );

      const parseZIndex = (element) => {
        const value = Number.parseInt(getComputedStyleFor(element).zIndex, 10);
        return Number.isFinite(value) ? value : 0;
      };

      const pathsEqual = (left, right) => (
        left.length === right.length && left.every((value, index) => value === right[index])
      );

      // An overlay painted at opacity 0 (itself or an ancestor) still wins elementFromPoint but hides nothing.
      const effectiveOpacity = (element) => {
        let product = 1;
        for (let current = element; isElement(current); current = current.parentElement) {
          const value = Number.parseFloat(getComputedStyleFor(current).opacity);
          if (Number.isFinite(value)) product *= value;
        }
        return product;
      };

      // Translucent: no fully opaque paint at the sampled points. A point is opaque when the element on top (or an ancestor up to the overlay) has an opaque
      // background and nothing between is below full opacity; a bar that only wraps opaque children is still solid there.
      const opaqueBackground = (element) => {
        const cs = getComputedStyleFor(element);
        if (cs.backdropFilter && cs.backdropFilter !== 'none') return false;
        // rgb(), hsl(), oklch(), lab(), color(...) and friends: opaque unless an alpha (after "/" or the 4th legacy slot) is below 1.
        const bg = (cs.backgroundColor || '').trim();
        const m = /^(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(([^)]*)\)$/.exec(bg);
        if (!m) return false;
        const alpha = m[1].includes('/') ? m[1].split('/')[1].trim() : (/^(?:rgba?|hsla?)\(/.test(bg) ? m[1].split(/[\s,]+/).filter(Boolean)[3] : undefined);
        if (alpha === undefined) return true;
        const a = alpha.endsWith('%') ? Number.parseFloat(alpha) / 100 : Number.parseFloat(alpha);
        return a >= 0.999; // a non-numeric alpha ("none") is not proof of an opaque bar
      };
      const opaqueAt = (overlay, focusable, x, y) => {
        if (effectiveOpacity(overlay.element) < 0.999) return false;
        let el = focusable.element.ownerDocument.elementFromPoint(x, y);
        for (; isElement(el); el = el.parentElement) {
          if (opaqueBackground(el)) return true;
          if (el === overlay.element) break;
        }
        return false;
      };

      const pointCoveredByOverlay = (overlay, focusable, x, y) => {
        if (effectiveOpacity(overlay.element) < 0.05) return false;
        const overlayRect = overlay.element.getBoundingClientRect();
        if (!pointInsideRect(x, y, overlayRect)) return false;

        const doc = focusable.element.ownerDocument;
        const topElement = doc.elementFromPoint(x, y);
        if (topElement && (
          topElement === overlay.element || overlay.element.contains(topElement)
        )) {
          return true;
        }

        const focusRoot = focusable.element.getRootNode();
        const overlayRoot = overlay.element.getRootNode();
        if (
          focusRoot === overlayRoot
          && isShadowRoot(focusRoot)
          && topElement === focusRoot.host
        ) {
          return parseZIndex(overlay.element) >= parseZIndex(focusable.element);
        }

        return false;
      };

      // Tag and identifying attributes of the overlay and its nearest ancestors: lets the caller name the vendor that owns the obscuring element.
      const chainOf = (element) => {
        const chain = [];
        for (let el = element; isElement(el) && chain.length < 4; el = el.parentElement) {
          const attrs = {};
          for (const name of ['id', 'class', 'src', 'href', 'data-src']) {
            const value = el.getAttribute(name);
            if (value) attrs[name] = value.slice(0, 200);
          }
          chain.push({ tag: el.tagName.toLowerCase(), attrs });
        }
        return chain;
      };

      const describeElement = (element, framePath, shadowPath, idCountMap) => {
        const selector = structuralSelector(element, idCountMap);
        const attributes = Object.fromEntries(
          [...element.attributes].map((attr) => [attr.name, attr.value]),
        );
        const tag = element.tagName.toLowerCase();
        const attrParts = Object.entries(attributes).map(
          ([name, value]) => `${name}="${String(value).replace(/"/g, '&quot;')}"`,
        );
        const outerHTML = `<${tag}${attrParts.length ? ` ${attrParts.join(' ')}` : ''} />`.slice(0, 500);
        return {
          selector,
          reportSelector: buildReportSelector(selector, framePath, shadowPath),
          framePath: [...framePath],
          shadowPath: [...shadowPath],
          outerHTML,
        };
      };

      /** @type {Array<{ element: Element, kind: 'header' | 'footer', selector: string, reportSelector: string, framePath: number[], shadowPath: number[] }>} */
      const overlays = [];
      /** @type {Array<{ element: Element, selector: string, reportSelector: string, framePath: number[], shadowPath: number[] }>} */
      const focusables = [];
      /** @type {Array<{ reason: string | null, framePath: number[] }>} */
      const skippedFrames = [];
      /** @type {Map<string, number>} */
      const shadowCounters = new Map();

      const inspectContext = ({
        root,
        doc,
        framePath,
        shadowPath,
      }) => {
        const scopeKey = `f:${framePath.join('.')}|s:${shadowPath.join('.')}`;
        const idCountMap = buildIdCountMap(root, doc);
        const nodeFilter = getNodeFilter(doc);
        const walker = doc.createTreeWalker(root, nodeFilter.SHOW_ELEMENT);
        let node = walker.nextNode();
        /** @type {Array<{ element: Element, kind: 'header' | 'footer' }>} */
        const contextOverlays = [];

        while (node) {
          const overlayKind = classifyOverlay(node);
          if (overlayKind && isRendered(node)) {
            const described = describeElement(node, framePath, shadowPath, idCountMap);
            const entry = { element: node, kind: overlayKind, ...described };
            contextOverlays.push(entry);
            overlays.push(entry);
          }

          if (isFocusable(node) && isRendered(node)) {
            // The overlay itself (a consent banner that takes focus) and anything inside it is the obscurer, not a victim.
            // A fixed/sticky focusable does not move when focus scrolls the page, so scrolling cannot be what fails for it.
            const containedByOverlay = contextOverlays.some((overlay) => overlay.element.contains(node));
            // Neither does anything inside a fixed/sticky container (a consent banner's own buttons, whatever the banner's size or anchoring).
            let positionedItself = false;
            for (let up = node; isElement(up) && !positionedItself; up = up.parentElement) positionedItself = ['fixed', 'sticky'].includes(getComputedStyleFor(up).position);
            if (!containedByOverlay && !positionedItself) {
              focusables.push({
                element: node,
                ...describeElement(node, framePath, shadowPath, idCountMap),
              });
            }
          }

          if (node.shadowRoot) {
            const shadowIndex = nextCounter(shadowCounters, scopeKey);
            inspectContext({
              root: node.shadowRoot,
              doc,
              framePath,
              shadowPath: [...shadowPath, shadowIndex],
            });
          }

          if (isIframeElement(node)) {
            // Document order within the owning frame: unique per iframe, unlike the index among siblings of one parent.
            const frameIndex = nextCounter(shadowCounters, `frames:${framePath.join('.')}`);
            const childFramePath = [...framePath, frameIndex];
            const access = getFrameAccess(node);
            if (!access.accessible || !access.document) {
              skippedFrames.push({ reason: access.reason, framePath: childFramePath });
            } else {
              const frameRoot = access.document.body || access.document.documentElement;
              if (frameRoot) {
                inspectContext({
                  root: frameRoot,
                  doc: access.document,
                  framePath: childFramePath,
                  shadowPath: [],
                });
              }
            }
          }

          node = walker.nextNode();
        }
      };

      inspectContext({
        root: document.documentElement,
        doc: document,
        framePath: [],
        shadowPath: [],
      });

      const previousActive = document.activeElement;
      const previousScroll = { x: window.scrollX, y: window.scrollY };
      const waitForPaint = () => new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      });

      // Where is the focused element now, and does a fixed/sticky bar cover all five sampled points of it?
      const measureFocused = (focusable, method) => {
        const rect = focusable.element.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return null;

        const inset = Math.min(1, rect.width / 4, rect.height / 4);
        const points = [
          [rect.left + inset, rect.top + inset],
          [rect.right - inset, rect.top + inset],
          [rect.left + inset, rect.bottom - inset],
          [rect.right - inset, rect.bottom - inset],
          [rect.left + rect.width / 2, rect.top + rect.height / 2],
        ];

        const contextOverlays = overlays.filter((overlay) => (
          pathsEqual(overlay.framePath, focusable.framePath)
          && pathsEqual(overlay.shadowPath, focusable.shadowPath)
        ));

        for (const overlay of contextOverlays) {
          const fullyCovered = points.every(([x, y]) => (
            pointCoveredByOverlay(overlay, focusable, x, y)
          ));
          if (!fullyCovered) continue;
          const box = (r) => `${Math.round(r.top)}-${Math.round(r.bottom)}px`;
          const viewport = getViewportSize(focusable.element);
          return {
            proof: {
              type: 'element-from-point',
              fact: `after focus, elementFromPoint returned the fixed/sticky ${overlay.kind} (${overlay.selector}) at ${points.length} of ${points.length} sampled points of the focused element: element y ${box(rect)}, ${overlay.kind} y ${box(overlay.element.getBoundingClientRect())}, viewport ${viewport.width}x${viewport.height}px (measured after ${method === 'tab' ? 'real Tab navigation reached it' : 'focus() scrolled the element into view'})`,
            },
            element: {
              selector: focusable.selector,
              reportSelector: focusable.reportSelector,
              framePath: focusable.framePath,
              shadowPath: focusable.shadowPath,
              outerHTML: focusable.outerHTML,
            },
            overlaySelector: overlay.selector,
            overlayChain: chainOf(overlay.element),
            translucent: !points.every(([x, y]) => opaqueAt(overlay, focusable, x, y)),
            kind: overlay.kind,
            method,
          };
        }
        return null;
      };

      /** @type {Array<{ idx: number, entry: ReturnType<typeof measureFocused> }>} */
      const focusObscured = [];

      for (const [idx, focusable] of focusables.entries()) {
        // A document that cannot scroll still obscures a control the bar covers (it cannot be scrolled clear); empty error shells are downgraded by scan.errorPages / bareShell, not skipped here.
        // focus() scrolls the element into view; measure where it ends up, not where it sat before. The Tab pass below repeats this with real keyboard navigation.
        focusable.element.focus();
        await waitForPaint();
        if (!elementHasFocus(focusable.element)) continue;
        const entry = measureFocused(focusable, 'focus');
        if (entry) focusObscured.push({ idx, entry });
      }

      // The Tab pass (driven from Node, one key press at a time) asks this for the element that now holds real focus.
      globalThis.__adaObscureTab = async () => {
        await waitForPaint();
        let active = document.activeElement;
        while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
        const atBody = !active || active === document.body || active === document.documentElement;
        const idx = atBody ? -1 : focusables.findIndex((f) => f.element === active);
        return { atBody, idx, entry: idx >= 0 ? measureFocused(focusables[idx], 'tab') : null };
      };

      window.scrollTo(previousScroll.x, previousScroll.y);
      if (previousActive instanceof HTMLElement) {
        previousActive.focus({ preventScroll: true });
      }

      // Tab starts from the top of the document: blur and move the sequential-navigation starting point (Chromium keeps the last focused element as the start otherwise).
      document.activeElement?.blur?.();
      window.scrollTo(0, 0);
      document.getSelection()?.collapse(document.body, 0);
      return { focusablesScanned: focusables.length, focusObscured, skippedFrames };
    });

    // Real Tab navigation over the first stops at the scan viewport: what a keyboard user sees. A control focus() left obscured but Tab leaves clear is no finding;
    // one Tab leaves obscured is confirmed; one Tab never reached within the limit stays a question (focus()-only measurement).
    const tabbed = new Map();
    try {
      for (let n = 0; n < TAB_STOPS; n++) {
        await fork.page.keyboard.press('Tab');
        const stop = await fork.page.evaluate(() => globalThis.__adaObscureTab());
        if (stop.atBody) { if (tabbed.size || n > 1) break; continue; } // the first Tab after the reset may land on the document itself
        if (stop.idx >= 0 && !tabbed.has(stop.idx)) tabbed.set(stop.idx, stop.entry);
      }
    } catch { /* a focus handler navigated or closed the page: the focus() measurements stand as questions */ }
    await fork.page.evaluate(() => { document.activeElement?.blur?.(); }).catch(() => {});
    const final = [];
    for (const { idx, entry } of result.focusObscured) {
      if (!tabbed.has(idx)) final.push({ ...entry, method: 'focus-only' });
      else if (tabbed.get(idx)) final.push(tabbed.get(idx));
      else final.push({ ...entry, method: 'focus-only' }); // Tab (forward only) left it clear: a question, not a confirmed failure
    }
    for (const [idx, entry] of tabbed) if (entry && !result.focusObscured.some((f) => f.idx === idx)) final.push(entry);

    const snapshot = getSnapshot(context);
    const lift = (entry) => ({
      element: matchSnapshotElement(snapshot, entry.element),
      overlaySelector: entry.overlaySelector,
      overlayChain: entry.overlayChain,
      proof: entry.proof,
      method: entry.method,
      translucent: entry.translucent === true,
    });
    return {
      focusablesScanned: result.focusablesScanned,
      headerObscured: final.filter((entry) => entry.kind === 'header').map(lift),
      footerObscured: final.filter((entry) => entry.kind === 'footer').map(lift),
      skippedFrames: result.skippedFrames,
    };
  } finally {
    await fork.cleanup();
  }
}

/**
 * @param {import('../runtime/types.js').Snapshot} snapshot
 * @param {{
 *   selector: string,
 *   reportSelector?: string,
 *   framePath: number[],
 *   shadowPath: number[],
 *   outerHTML: string,
 * }} entry
 */
function matchSnapshotElement(snapshot, entry) {
  const pathsEqual = (left, right) => (
    left.length === right.length && left.every((value, index) => value === right[index])
  );

  return snapshot.elements.find((element) => (
    element.selector === entry.selector
    && pathsEqual(element.framePath, entry.framePath)
    && pathsEqual(element.shadowPath, entry.shadowPath)
  ))
    || (entry.reportSelector
      ? snapshot.elements.find((element) => element.reportSelector === entry.reportSelector)
      : undefined)
    || snapshot.elements.find((element) => (
      element.outerHTML.slice(0, 120) === entry.outerHTML.slice(0, 120)
      && pathsEqual(element.framePath, entry.framePath)
      && pathsEqual(element.shadowPath, entry.shadowPath)
    ))
    || {
      outerHTML: entry.outerHTML,
      selector: entry.selector,
      framePath: [...entry.framePath],
      shadowPath: [...entry.shadowPath],
      reportSelector: entry.reportSelector,
    };
}
