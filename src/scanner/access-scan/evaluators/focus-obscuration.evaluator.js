import {
  elementFinding,
  getEvaluatorCache,
  getSession,
  getSnapshot,
} from './lib/runtime-context.js';

const CACHE_KEY = 'focusObscurationAudit';

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
        findings.push(elementFinding(entry.element, { obscuringOverlay: entry.overlaySelector }));
      }
      return { status: 'complete', candidatesScanned: audit.focusablesScanned, findings };
    }

    if (mode === 'focus-not-obscured-footer') {
      for (const entry of audit.footerObscured) {
        findings.push(elementFinding(entry.element, { obscuringOverlay: entry.overlaySelector }));
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

      const frameSiblingIndex = (iframe) => {
        const parent = iframe.parentElement;
        if (!parent) return 0;
        let index = 0;
        for (const child of parent.children) {
          if (child.tagName === 'IFRAME') {
            if (child === iframe) return index;
            index += 1;
          }
        }
        return index;
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

      const pointCoveredByOverlay = (overlay, focusable, x, y) => {
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
            const containedByOverlay = contextOverlays.some((overlay) => (
              overlay.element !== node && overlay.element.contains(node)
            ));
            if (!containedByOverlay) {
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
            const frameIndex = frameSiblingIndex(node);
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

      /** @type {Array<{ element: ReturnType<typeof describeElement>, overlaySelector: string, kind: 'header' | 'footer' }>} */
      const obscured = [];

      for (const focusable of focusables) {
        focusable.element.focus({ preventScroll: true });
        await waitForPaint();
        if (!elementHasFocus(focusable.element)) continue;

        const rect = focusable.element.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;

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
          obscured.push({
            element: {
              selector: focusable.selector,
              reportSelector: focusable.reportSelector,
              framePath: focusable.framePath,
              shadowPath: focusable.shadowPath,
              outerHTML: focusable.outerHTML,
            },
            overlaySelector: overlay.selector,
            kind: overlay.kind,
          });
          break;
        }
      }

      window.scrollTo(previousScroll.x, previousScroll.y);
      if (previousActive instanceof HTMLElement) {
        previousActive.focus({ preventScroll: true });
      }

      return {
        focusablesScanned: focusables.length,
        headerObscured: obscured.filter((entry) => entry.kind === 'header'),
        footerObscured: obscured.filter((entry) => entry.kind === 'footer'),
        skippedFrames,
      };
    });

    const snapshot = getSnapshot(context);
    return {
      focusablesScanned: result.focusablesScanned,
      headerObscured: result.headerObscured.map((entry) => ({
        element: matchSnapshotElement(snapshot, entry.element),
        overlaySelector: entry.overlaySelector,
      })),
      footerObscured: result.footerObscured.map((entry) => ({
        element: matchSnapshotElement(snapshot, entry.element),
        overlaySelector: entry.overlaySelector,
      })),
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
