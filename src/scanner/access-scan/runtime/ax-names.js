const TAG = 'data-ada-scan-nid';

/**
 * Accessible names from Chromium's own accessibility tree (accname 1.2),
 * keyed by snapshot element id. Only main-frame, non-ignored nodes are
 * returned; callers keep the in-page name for everything else.
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<Map<number, string>>}
 */
export async function readAxNames(page) {
  const cdp = await page.context().newCDPSession(page);
  try {
    await page.evaluate(() => globalThis.__adaScanRuntime.tagElementsForAx());
    try {
      const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
      /** @type {Map<number, number>} */
      const nidByBackend = new Map();
      const stack = [root];
      while (stack.length) {
        const node = stack.pop();
        const attrs = node.attributes || [];
        const at = attrs.indexOf(TAG);
        if (at >= 0 && at % 2 === 0) nidByBackend.set(node.backendNodeId, Number(attrs[at + 1]));
        // Child frames' documents are not in the main-frame AX tree below.
        stack.push(...(node.children || []), ...(node.shadowRoots || []));
      }
      const { nodes } = await cdp.send('Accessibility.getFullAXTree');
      /** @type {Map<number, string>} */
      const names = new Map();
      for (const ax of nodes) {
        const nid = nidByBackend.get(ax.backendDOMNodeId);
        if (nid === undefined || ax.ignored) continue;
        names.set(nid, String(ax.name?.value ?? '').replace(/\s+/g, ' ').trim());
      }
      return names;
    } finally {
      await page.evaluate(() => globalThis.__adaScanRuntime.untagElementsForAx()).catch(() => {});
    }
  } finally {
    await cdp.detach().catch(() => {});
  }
}
