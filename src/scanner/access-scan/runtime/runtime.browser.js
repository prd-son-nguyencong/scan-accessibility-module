(() => {
  const ELEMENT_NODE = 1;
  const DOCUMENT_FRAGMENT_NODE = 11;
  const TEXT_NODE = 3;

  const SENSITIVE_ATTRIBUTE_PATTERN = /(?:^|[_-])(?:token|secret|csrf|password|api[_-]?key|auth|authorization|session|bearer|credential)(?:$|[_-])/i;
  const SENSITIVE_QUERY_PARAM_PATTERN = /^(?:token|key|api[_-]?key|auth|authorization|session|secret|password|csrf)$/i;
  const URL_ATTRS = new Set(['href', 'src', 'action', 'formaction']);
  const NON_VISUAL_TEXT_CONTAINERS = new Set([
    'NOSCRIPT', 'SCRIPT', 'STYLE', 'TEMPLATE', 'TITLE',
  ]);

  const FOCUSABLE_SELECTOR = [
    'a[href]',
    'area[href]',
    'button:not([disabled])',
    'input:not([disabled]):not([type="hidden"])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    'summary',
    'iframe',
    'object',
    'embed',
    'video[controls]',
    'audio[controls]',
    '[contenteditable]:not([contenteditable="false"])',
    '[tabindex]:not([tabindex="-1"])',
  ].join(',');

  /** @type {{ hostTag: string, hostId: string | null }[]} */
  const closedShadowHosts = [];
  let observationFromDocumentStart = (
    !globalThis.document?.documentElement
    || globalThis.document.readyState === 'loading'
  );

  const originalAttachShadow = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function attachShadow(init) {
    const root = originalAttachShadow.call(this, init);
    if (init && init.mode === 'closed') {
      closedShadowHosts.push({
        hostTag: this.tagName.toLowerCase(),
        hostId: this.id || null,
      });
    }
    return root;
  };

  const normalizeText = (value) =>
    String(value || '').replace(/\s+/g, ' ').trim();

  const escapeIdentifier = (value) => {
    const css = globalThis.CSS;
    if (css && typeof css.escape === 'function') {
      return css.escape(value);
    }
    return String(value).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
  };

  const escapeSnippetAttribute = (value) =>
    String(value)
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;');

  const isElement = (node) => Boolean(node && node.nodeType === ELEMENT_NODE);

  const isShadowRoot = (node) => Boolean(
    node
    && node.nodeType === DOCUMENT_FRAGMENT_NODE
    && node.host,
  );

  const isIframeElement = (element) => isElement(element) && element.tagName === 'IFRAME';

  const getOwnerWindow = (node) => node?.ownerDocument?.defaultView ?? null;

  const getNodeFilter = (doc) => doc?.defaultView?.NodeFilter ?? {
    SHOW_ELEMENT: 1,
  };

  const getComputedStyleFor = (element) => {
    const win = getOwnerWindow(element);
    if (!win || typeof win.getComputedStyle !== 'function') {
      return {
        display: '',
        visibility: '',
        opacity: '1',
        contentVisibility: '',
        position: '',
        pointerEvents: '',
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

  const composedParent = (node) => {
    if (!isElement(node)) return null;
    if (node.parentElement) return node.parentElement;
    const root = node.getRootNode();
    if (isShadowRoot(root)) return root.host;
    return null;
  };

  const walkComposedAncestors = (element, visitor) => {
    let current = element;
    while (isElement(current)) {
      if (visitor(current) === false) return;
      current = composedParent(current);
    }
  };

  const isSensitiveAttributeName = (name) => SENSITIVE_ATTRIBUTE_PATTERN.test(name);

  const isSensitiveMetaElement = (element) => {
    if (element.tagName !== 'META') return false;
    const marker = (
      element.getAttribute('name')
      || element.getAttribute('property')
      || element.getAttribute('http-equiv')
      || ''
    ).toLowerCase();
    return isSensitiveAttributeName(marker);
  };

  const redactUrlValue = (value, element) => {
    if (!value) return value;
    const trimmed = String(value).trim();
    if (trimmed.startsWith('#')) return trimmed;
    const win = getOwnerWindow(element);
    let base = element.ownerDocument?.baseURI || 'http://127.0.0.1/';
    if (base.startsWith('about:')) {
      base = 'http://127.0.0.1/';
    }
    try {
      const URLCtor = win?.URL || globalThis.URL;
      const parsed = new URLCtor(value, base);
      for (const key of [...parsed.searchParams.keys()]) {
        if (SENSITIVE_QUERY_PARAM_PATTERN.test(key)) {
          parsed.searchParams.set(key, '[redacted]');
        }
      }
      return parsed.toString();
    } catch {
      return '[redacted]';
    }
  };

  const redactAttributeValue = (element, name, value) => {
    const lowerName = name.toLowerCase();
    if (
      isSensitiveAttributeName(lowerName)
      || (lowerName === 'content' && isSensitiveMetaElement(element))
      || (lowerName === 'value' && (
        element.getAttribute('type') === 'password'
        || element.getAttribute('type') === 'hidden'
      ))
    ) {
      return '[redacted]';
    }
    if (URL_ATTRS.has(lowerName)) {
      return redactUrlValue(value, element);
    }
    return value;
  };

  const redactAttributes = (element) => {
    /** @type {Record<string, string>} */
    const attributes = {};
    for (const attr of element.attributes) {
      attributes[attr.name] = redactAttributeValue(element, attr.name, attr.value);
    }
    return attributes;
  };

  const buildStructuralSnippet = (element, attributes) => {
    const tag = element.tagName.toLowerCase();
    const attrParts = Object.entries(attributes).map(
      ([name, value]) => `${name}="${escapeSnippetAttribute(value)}"`,
    );
    const attrString = attrParts.length ? ` ${attrParts.join(' ')}` : '';

    const directText = normalizeText(
      [...element.childNodes]
        .filter((node) => node.nodeType === TEXT_NODE)
        .map((node) => node.textContent || '')
        .join(' '),
    ).slice(0, 120);

    const childMarkers = [...element.children].slice(0, 8).map((child) => {
      const childTag = child.tagName.toLowerCase();
      if (childTag === 'script' || childTag === 'style') {
        return `<${childTag}>[omitted]</${childTag}>`;
      }
      const inlineTextTags = new Set([
        'span', 'a', 'label', 'button', 'strong', 'em', 'small', 'abbr', 'b', 'i',
      ]);
      const childText = normalizeText(
        [...child.childNodes]
          .filter((node) => node.nodeType === TEXT_NODE)
          .map((node) => node.textContent || '')
          .join(' '),
      ).slice(0, 80);
      if (inlineTextTags.has(childTag) && childText) {
        return `<${childTag}>${childText}</${childTag}>`;
      }
      return `<${childTag}>…</${childTag}>`;
    });

    if (!directText && childMarkers.length === 0) {
      return `<${tag}${attrString} />`.slice(0, 500);
    }

    return `<${tag}${attrString}>${directText}${childMarkers.join('')}</${tag}>`.slice(0, 500);
  };

  const getRelevantComputedStyle = (element) => {
    const style = getComputedStyleFor(element);
    return {
      display: style.display,
      visibility: style.visibility,
      opacity: style.opacity,
      contentVisibility: style.contentVisibility,
      position: style.position,
      pointerEvents: style.pointerEvents,
      fontWeight: style.fontWeight,
      fontStyle: style.fontStyle,
      fontSize: style.fontSize,
      lineHeight: style.lineHeight,
      textDecoration: style.textDecorationLine || style.textDecoration || '',
      backgroundImage: style.backgroundImage,
      backgroundColor: style.backgroundColor,
      zIndex: style.zIndex,
      top: style.top,
      right: style.right,
      bottom: style.bottom,
      left: style.left,
      clip: style.clip,
      clipPath: style.clipPath,
      whiteSpace: style.whiteSpace,
      overflow: style.overflow,
      cursor: style.cursor,
      paddingTop: style.paddingTop,
      paddingRight: style.paddingRight,
      paddingBottom: style.paddingBottom,
      paddingLeft: style.paddingLeft,
    };
  };

  const getIntrinsicDimensions = (element) => {
    if (element.tagName !== 'IMG') return undefined;
    const width = element.naturalWidth || element.width || 0;
    const height = element.naturalHeight || element.height || 0;
    if (!width && !height) return undefined;
    return { width, height };
  };

  const isCssHidden = (element) => {
    const style = getComputedStyleFor(element);
    return (
      style.display === 'none'
      || style.visibility === 'hidden'
      || style.contentVisibility === 'hidden'
    );
  };

  const isRendered = (element) => {
    let rendered = true;
    walkComposedAncestors(element, (current) => {
      if (current.hidden || isCssHidden(current)) {
        rendered = false;
        return false;
      }
      return true;
    });
    return rendered;
  };

  const effectiveOpacity = (element) => {
    let opacity = 1;
    walkComposedAncestors(element, (current) => {
      const value = Number.parseFloat(getComputedStyleFor(current).opacity);
      if (Number.isFinite(value)) {
        opacity *= value;
      }
      return true;
    });
    return opacity;
  };

  const isVisuallyVisible = (element) => {
    if (!isRendered(element)) return false;
    if (effectiveOpacity(element) <= 0) return false;
    const rect = element.getBoundingClientRect();
    if (
      element.getClientRects().length === 0
      || rect.width <= 0
      || rect.height <= 0
    ) {
      return false;
    }

    const { width: viewportWidth, height: viewportHeight } = getViewportSize(element);
    return !(
      rect.bottom < 0
      || rect.right < 0
      || rect.top > viewportHeight
      || rect.left > viewportWidth
    );
  };

  const isHiddenFromAT = (element) => {
    let hidden = false;
    walkComposedAncestors(element, (current) => {
      if (
        current.hidden
        || current.hasAttribute('inert')
        || current.getAttribute('aria-hidden') === 'true'
        || isCssHidden(current)
      ) {
        hidden = true;
        return false;
      }
      return true;
    });
    return hidden;
  };

  const isSubtreeExcludedFromAT = (element) => (
    element.hidden
    || element.hasAttribute('inert')
    || element.getAttribute('aria-hidden') === 'true'
  );

  const isNativelyFocusable = (element) => {
    if (!isElement(element) || typeof element.matches !== 'function') return false;
    if (element.hasAttribute('disabled') || element.getAttribute('aria-disabled') === 'true') {
      return false;
    }
    if (element.matches(FOCUSABLE_SELECTOR)) {
      if (element.matches('[tabindex]')) {
        const tabindex = Number.parseInt(element.getAttribute('tabindex') || '', 10);
        return Number.isFinite(tabindex) && tabindex >= 0;
      }
      return true;
    }
    const tabindex = Number.parseInt(element.getAttribute('tabindex') || '', 10);
    return Number.isFinite(tabindex) && tabindex >= 0;
  };

  const isFocusable = (element) => {
    if (isHiddenFromAT(element)) return false;
    if (!isRendered(element)) return false;
    if (element.hasAttribute('inert')) return false;
    return isNativelyFocusable(element);
  };

  const getElementByIdInRoot = (element, id) => {
    const root = element.getRootNode();
    if (root && typeof root.getElementById === 'function') {
      return root.getElementById(id);
    }
    return null;
  };

  const getATExposedDescendantText = (element) => {
    /** @type {string[]} */
    const parts = [];

    const collect = (node) => {
      if (node.nodeType === TEXT_NODE) {
        parts.push(node.textContent || '');
        return;
      }
      if (!isElement(node)) return;
      if (node !== element && isSubtreeExcludedFromAT(node)) return;
      for (const child of node.childNodes) {
        collect(child);
      }
    };

    for (const child of element.childNodes) {
      collect(child);
    }

    return normalizeText(parts.join(' '));
  };

  const getVisibleDescendantText = (element) => {
    /** @type {string[]} */
    const parts = [];

    const collect = (node) => {
      if (node.nodeType === TEXT_NODE) {
        const text = node.textContent || '';
        const parent = node.parentElement;
        if (!text.trim() || !parent || NON_VISUAL_TEXT_CONTAINERS.has(parent.tagName)) {
          return;
        }
        const style = getComputedStyleFor(parent);
        const fontSize = Number.parseFloat(style.fontSize || '');
        if (Number.isFinite(fontSize) && fontSize <= 0) return;
        if (!isRendered(parent) || effectiveOpacity(parent) <= 0) return;
        try {
          const range = parent.ownerDocument.createRange();
          range.selectNodeContents(node);
          const hasRenderedRect = [...range.getClientRects()]
            .some((rect) => rect.width > 0 && rect.height > 0);
          range.detach?.();
          if (!hasRenderedRect) return;
        } catch {
          // Style and composed-tree checks remain a safe fallback when a
          // detached or cross-realm text range cannot be measured.
        }
        parts.push(text);
        return;
      }
      if (!isElement(node)) return;
      if (node !== element) {
        if (
          isSubtreeExcludedFromAT(node)
          || !isRendered(node)
          || effectiveOpacity(node) <= 0
        ) {
          return;
        }
      }
      for (const child of node.childNodes) {
        collect(child);
      }
    };

    for (const child of element.childNodes) {
      collect(child);
    }

    return normalizeText(parts.join(' '));
  };

  const getAccessibleName = (element, visitedIds = new Set()) => {
    const labelledBy = element.getAttribute('aria-labelledby');
    if (labelledBy) {
      const parts = [];
      for (const id of labelledBy.split(/\s+/).filter(Boolean)) {
        if (visitedIds.has(id)) continue;
        visitedIds.add(id);
        const ref = getElementByIdInRoot(element, id);
        if (!ref) continue;
        const refName = getAccessibleName(ref, visitedIds);
        if (refName) parts.push(refName);
      }
      const joined = normalizeText(parts.join(' '));
      if (joined) return joined;
    }

    const ariaLabel = normalizeText(element.getAttribute('aria-label'));
    if (ariaLabel) return ariaLabel;

    if (element.labels && element.labels.length > 0) {
      const labelText = normalizeText(
        [...element.labels].map((label) => label.textContent || '').join(' '),
      );
      if (labelText) return labelText;
    }

    if (element.tagName === 'IMG' && element.hasAttribute('alt')) {
      return normalizeText(element.getAttribute('alt'));
    }

    if (element.tagName === 'INPUT' || element.tagName === 'BUTTON') {
      const value = normalizeText(element.getAttribute('value'));
      if (value && element.getAttribute('type') !== 'password') {
        return value;
      }
    }

    const descendantText = getATExposedDescendantText(element);
    if (descendantText) return descendantText;

    return normalizeText(element.getAttribute('title'));
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

  const makeScopeKey = (framePath, shadowPath) => (
    `f:${framePath.join('.')}|s:${shadowPath.join('.')}`
  );

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

  const collectObserveRoots = (doc, roots, visitedDocs) => {
    if (!doc || visitedDocs.has(doc)) return;
    visitedDocs.add(doc);
    if (doc.documentElement) {
      roots.add(doc.documentElement);
    }

    const nodeFilter = getNodeFilter(doc);
    const walkSubtree = (subtreeRoot) => {
      const walker = doc.createTreeWalker(subtreeRoot, nodeFilter.SHOW_ELEMENT);
      let node = walker.nextNode();
      while (node) {
        if (node.shadowRoot) {
          roots.add(node.shadowRoot);
          walkSubtree(node.shadowRoot);
        }
        if (isIframeElement(node)) {
          const access = getFrameAccess(node);
          if (access.accessible && access.document) {
            collectObserveRoots(access.document, roots, visitedDocs);
          }
        }
        node = walker.nextNode();
      }
    };

    walkSubtree(doc.documentElement || doc);
  };

  const waitForDomStability = async ({
    quietMs = 50,
    timeoutMs = 3000,
    minObserveMs = 0,
  } = {}) => {
    await new Promise((resolve) => {
      if (document.readyState === 'complete') {
        resolve();
        return;
      }
      globalThis.addEventListener('load', () => resolve(), { once: true });
    });

    /** @type {MutationObserver[]} */
    const observers = [];
    const observedRoots = new Set();
    let lastMutationAt = performance.now();
    const startedAt = performance.now();
    let needsRootDiscovery = true;
    let pollCount = 0;

    const markMutation = () => {
      lastMutationAt = performance.now();
      needsRootDiscovery = true;
    };

    const ensureObservers = () => {
      const observeTargets = new Set();
      const visitedDocs = new Set();
      collectObserveRoots(document, observeTargets, visitedDocs);

      for (const root of observeTargets) {
        if (observedRoots.has(root)) continue;
        observedRoots.add(root);
        const observer = new MutationObserver(markMutation);
        observer.observe(root, {
          childList: true,
          subtree: true,
          attributes: true,
          characterData: true,
        });
        observers.push(observer);
      }
    };

    try {
      ensureObservers();

      while (true) {
        const now = performance.now();
        const elapsed = now - startedAt;
        const sinceMutation = now - lastMutationAt;

        if (needsRootDiscovery) {
          ensureObservers();
          needsRootDiscovery = false;
        } else if (pollCount % 4 === 0) {
          ensureObservers();
        }
        pollCount += 1;

        if (elapsed >= minObserveMs && sinceMutation >= quietMs) {
          break;
        }
        if (elapsed >= timeoutMs) {
          break;
        }

        await new Promise((resolve) => {
          setTimeout(resolve, 10);
        });
      }
    } finally {
      for (const observer of observers) {
        observer.disconnect();
      }
    }
  };

  const traverseRoot = ({
    root,
    doc,
    elements,
    diagnostics,
    nextIdRef,
    parentId,
    framePath,
    shadowPath,
    counts,
    elementToId,
    shadowCounters,
    scopeKey,
    idCountMap,
  }) => {
    const assignId = () => {
      const id = nextIdRef.value;
      nextIdRef.value += 1;
      return id;
    };

  const needsVisibleText = (element) => {
    const tag = element.tagName.toLowerCase();
    if (['button', 'a', 'label', 'legend', 'figcaption', 'summary', 'option'].includes(tag)) {
      return true;
    }
    if (['input', 'select', 'textarea'].includes(tag)) return true;
    return Boolean(element.getAttribute('role'));
  };

    const visitElement = (element, currentParentId) => {
      const id = assignId();
      elementToId.set(element, id);
      const attributes = redactAttributes(element);
      const localSelector = structuralSelector(element, idCountMap);
      const record = {
        id,
        parentId: currentParentId,
        tag: element.tagName.toLowerCase(),
        attributes,
        text: normalizeText(
          [...element.childNodes]
            .filter((node) => node.nodeType === TEXT_NODE)
            .map((node) => node.textContent || '')
            .join(' '),
        ),
        visibleText: needsVisibleText(element) ? getVisibleDescendantText(element) : '',
        selector: localSelector,
        reportSelector: buildReportSelector(localSelector, framePath, shadowPath),
        framePath: [...framePath],
        shadowPath: [...shadowPath],
        outerHTML: buildStructuralSnippet(element, attributes),
        rect: (() => {
          const rect = element.getBoundingClientRect();
          return {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
          };
        })(),
        computedStyle: getRelevantComputedStyle(element),
        intrinsicDimensions: getIntrinsicDimensions(element),
        accessibleName: getAccessibleName(element),
        effectiveOpacity: effectiveOpacity(element),
        rendered: isRendered(element),
        visuallyVisible: isVisuallyVisible(element),
        hiddenFromAT: isHiddenFromAT(element),
        focusable: isFocusable(element),
      };
      elements.push(record);

      if (element.shadowRoot) {
        counts.shadowRootCount += 1;
        const shadowIndex = nextCounter(shadowCounters, scopeKey);
        const childShadowPath = [...shadowPath, shadowIndex];
        const childIdCountMap = buildIdCountMap(element.shadowRoot, doc);
        traverseRoot({
          root: element.shadowRoot,
          doc,
          elements,
          diagnostics,
          nextIdRef,
          parentId: id,
          framePath,
          shadowPath: childShadowPath,
          counts,
          elementToId,
          shadowCounters,
          scopeKey: makeScopeKey(framePath, childShadowPath),
          idCountMap: childIdCountMap,
        });
      }

      if (isIframeElement(element)) {
        const frameIndex = frameSiblingIndex(element);
        const childFramePath = [...framePath, frameIndex];
        const access = getFrameAccess(element);
        if (!access.accessible) {
          diagnostics.push({
            code: 'frame-inaccessible',
            reason: access.reason || 'unknown',
            inspected: false,
            message: 'Frame document could not be inspected.',
            details: {
              framePath: [...childFramePath],
              selector: localSelector,
            },
          });
          counts.frameCount += 1;
          return id;
        }

        counts.frameCount += 1;
        const frameDoc = access.document;
        const body = frameDoc.body || frameDoc.documentElement;
        if (body) {
          const frameIdCountMap = buildIdCountMap(
            frameDoc.documentElement || body,
            frameDoc,
          );
          traverseRoot({
            root: body,
            doc: frameDoc,
            elements,
            diagnostics,
            nextIdRef,
            parentId: id,
            framePath: childFramePath,
            shadowPath: [],
            counts,
            elementToId,
            shadowCounters,
            scopeKey: makeScopeKey(childFramePath, []),
            idCountMap: frameIdCountMap,
          });
        }
      }

      return id;
    };

    const nodeFilter = getNodeFilter(doc);
    const walker = doc.createTreeWalker(
      root,
      nodeFilter.SHOW_ELEMENT,
      null,
    );

    let next = root.nodeType === ELEMENT_NODE
      ? root
      : walker.nextNode();

    while (next) {
      const parentElement = next.parentElement;
      const resolvedParentId = parentElement && elementToId.has(parentElement)
        ? elementToId.get(parentElement)
        : parentId;
      visitElement(next, resolvedParentId);
      next = walker.nextNode();
    }
  };

  const buildSnapshot = () => {
    /** @type {import('./types.js').SnapshotElement[]} */
    const elements = [];
    /** @type {import('./types.js').RuntimeDiagnostic[]} */
    const diagnostics = [];
    const counts = {
      frameCount: 0,
      shadowRootCount: 0,
      closedShadowCount: closedShadowHosts.length,
    };

    if (!observationFromDocumentStart) {
      diagnostics.push({
        code: 'shadow-root-observation-incomplete',
        inspected: false,
        message: 'Closed shadow root observation began after document scripts executed; coverage may be incomplete.',
      });
    }

    for (const host of closedShadowHosts) {
      diagnostics.push({
        code: 'shadow-root-closed',
        inspected: false,
        message: 'Closed shadow root detected; internal content was not inspected.',
        details: host,
      });
    }

    const nextIdRef = { value: 1 };
    const elementToId = new WeakMap();
    /** @type {Map<string, number>} */
    const shadowCounters = new Map();
    const root = document.documentElement;
    if (root) {
      const idCountMap = buildIdCountMap(root, document);
      traverseRoot({
        root,
        doc: document,
        elements,
        diagnostics,
        nextIdRef,
        parentId: null,
        framePath: [],
        shadowPath: [],
        counts,
        elementToId,
        shadowCounters,
        scopeKey: makeScopeKey([], []),
        idCountMap,
      });
    }

    return {
      elements,
      diagnostics,
      counts,
    };
  };

  const resetForNavigation = () => {
    closedShadowHosts.length = 0;
    observationFromDocumentStart = true;
  };

  const markLateObservation = () => {
    observationFromDocumentStart = false;
  };

  if (globalThis.__adaScanRuntime) {
    globalThis.__adaScanRuntime.resetForNavigation = resetForNavigation;
    globalThis.__adaScanRuntime.markLateObservation = markLateObservation;
    return;
  }

  globalThis.__adaScanRuntime = {
    closedShadowHosts,
    waitForDomStability,
    buildSnapshot,
    resetForNavigation,
    markLateObservation,
    semantics: {
      isRendered,
      isVisuallyVisible,
      isHiddenFromAT,
      isFocusable,
      getAccessibleName,
    },
  };
})();
