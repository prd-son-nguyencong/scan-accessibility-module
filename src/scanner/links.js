import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createViolation } from '../schema.js';
import { classifyHost } from '../utils/host-classify.js';

const CONCURRENCY = 8;
const PER_HOST_CONCURRENCY = 2; // politeness: never hammer one origin
const TIMEOUT = 8000;
const MAX_REDIRECTS = 5;
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

// An href that is still a backend/Liquid tag ({{data:..}}, {{ x }}, {% .. %}) has no value to probe; the browser percent-encodes it.
const UNBOUND_HREF = /\{\{|\{%|%7B%7B|%7B%25/i;
const splitFragment = (u) => { const x = new URL(u); const fragment = x.hash.length > 1 ? x.hash : null; x.hash = ''; return { url: x.href, fragment }; };

const normalise = (u) => { const x = new URL(u); x.hash = ''; return x.href; };

// Statuses that mean "the server refused this client", not "the link is dead".
const BLOCKED_STATUS = new Set([401, 403, 429, 999]);
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
// Short pauses before the browser-UA retries of a link that still answers 404/410/5xx: a bot defence or a restarting origin answers 502 in a burst and 200 a moment later.
const RETRY_BACKOFF_MS = [300, 900];
const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());
const TLS_CODE = /^(CERT_|ERR_TLS_|ERR_SSL_|UNABLE_TO_|DEPTH_ZERO|SELF_SIGNED|HOSTNAME_MISMATCH|EPROTO)/;

/** timeout | dns | tls | connection, from a fetch rejection (undici puts the real reason in `cause`). */
export function classifyFetchError(err) {
  const code = err?.cause?.code || err?.code || '';
  if (err?.name === 'AbortError' || err?.name === 'TimeoutError' || /TIMEOUT|ETIMEDOUT/.test(code)) return 'timeout';
  if (/^(ENOTFOUND|EAI_AGAIN|EAI_NODATA)$/.test(code)) return 'dns';
  if (TLS_CODE.test(code)) return 'tls';
  return 'connection';
}

const errorText = (err) => [err?.message, err?.cause?.code || err?.cause?.message].filter(Boolean).join(': ');

export const globToRegExp = (g) => new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*')}$`);
const normPath = (p) => (p.replace(/\.html$/, '').replace(/\/index$/, '').replace(/\/+$/, '') || '/');

/**
 * Routes the project itself defines: src/pages/**.liquid (or .html) and the page elements of the Paradox export.
 * Returns null when no page is found (not a project scan): then no same-origin 404 can be called unverifiable.
 */
export function loadProjectRoutes(root, { pagesRoot = 'src/pages', outDir = 'dist' } = {}) {
  const routes = new Set();
  const walk = (dir, rel) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(dir, e.name), `${rel}${e.name}/`);
      else if (/\.(liquid|html)$/.test(e.name)) routes.add(normPath(`/${rel}${e.name.replace(/\.\w+$/, '')}`));
    }
  };
  try {
    if (existsSync(path.join(root, pagesRoot))) walk(path.join(root, pagesRoot), '');
    for (const dir of new Set([outDir, 'dist'])) {
      const file = path.join(root, dir, 'paradox-export.json');
      if (!existsSync(file)) continue;
      for (const e of JSON.parse(readFileSync(file, 'utf8')).elements_data || []) {
        if (e?.type === 'page' && typeof e.path === 'string') routes.add(normPath(`/${e.path.replace(/^pages\//, '')}`));
      }
      break;
    }
  } catch { /* unreadable export or pages dir: use what was found */ }
  return routes.size ? routes : null;
}

/** A same-origin page route the project does not define: a local 404 there is a platform route, not proof (a path with a file extension is a static asset, so it stays real). */
export const routeNotServedLocally = (target, pageUrl, knownRoutes) => {
  if (!knownRoutes) return false;
  const t = new URL(target);
  return t.origin === new URL(pageUrl).origin && !/\.(?!html?$)[a-z0-9]{1,8}$/i.test(t.pathname) && !knownRoutes.has(normPath(t.pathname));
};

/**
 * Probes each distinct URL once for a whole scan (shared header/footer links are not re-checked per page; concurrent
 * requests for one URL share the answer) with at most `concurrency` requests in flight and `perHost` per origin.
 * check() resolves to { url, status, ... } or null when the target is not probed (private address from a public page).
 */
export function createLinkChecker({ concurrency = CONCURRENCY, perHost = PER_HOST_CONCURRENCY, timeoutMs = TIMEOUT, retryBackoffMs = RETRY_BACKOFF_MS } = {}) {
  const cache = new Map();
  const hostActive = new Map();
  let active = 0;
  let waiters = [];
  const acquire = async (host) => {
    while (active >= concurrency || (hostActive.get(host) || 0) >= perHost) await new Promise((r) => waiters.push(r));
    active++;
    hostActive.set(host, (hostActive.get(host) || 0) + 1);
  };
  const release = (host) => {
    active--;
    hostActive.set(host, hostActive.get(host) - 1);
    const w = waiters;
    waiters = [];
    w.forEach((r) => r());
  };

  const probe = async (method, startUrl, pageIsPublic, userAgent = 'ADA-Scanner/1.0 Link-Checker') => {
    let current = startUrl;
    const chain = [];
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (pageIsPublic && classifyHost(current).kind !== 'public') return { skipped: true };
      const host = new URL(current).host;
      await acquire(host);
      let res;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        res = await fetch(current, {
          method,
          redirect: 'manual',
          signal: controller.signal,
          headers: { 'User-Agent': userAgent, ...(method === 'GET' ? { Range: 'bytes=0-0' } : {}) },
        });
      } finally {
        clearTimeout(timeout);
        release(host);
      }
      chain.push({ url: current, status: res.status });
      const location = REDIRECT_STATUS.has(res.status) && res.headers.get('location');
      if (!location) {
        const challenge = /challenge/i.test(res.headers.get('cf-mitigated') || '');
        return { status: res.status, redirected: hop > 0, finalUrl: current, chain, ...(challenge ? { challenge: true } : {}) };
      }
      current = new URL(location, current).href;
    }
    return { status: 0, errorClass: 'redirect', error: `more than ${MAX_REDIRECTS} redirects`, chain };
  };

  // A rejected fetch becomes a result carrying its error class instead of throwing.
  const tryProbe = async (...args) => {
    try {
      return await probe(...args);
    } catch (err) {
      return { status: 0, errorClass: classifyFetchError(err), error: errorText(err) };
    }
  };

  const run = async (checkUrl, pageIsPublic) => {
    let res = await tryProbe('HEAD', checkUrl, pageIsPublic);
    const attempts = [res];
    // Anything but a clean answer (HEAD rejected, blocked, 404, network error or timeout) is retried once as a
    // browser-like GET: servers and bot walls treat HEAD and the tool UA differently from a real visit.
    if ((res.status === 0 && res.errorClass !== 'redirect') || res.status >= 400) {
      const get = await tryProbe('GET', checkUrl, pageIsPublic, BROWSER_UA);
      attempts.push(get);
      if (!(get.status === 0 && res.status > 0)) res = get;
      // A dead-looking answer (404/410/5xx) is asked again, with a browser UA and a short backoff: it stands only when the final status after the retries is still an error.
      // The decisive answer replaces the GET attempt, so a first-hit 502 that recovers is never judged dead from an earlier attempt.
      for (const wait of retryBackoffMs) {
        if (!(res.status === 404 || res.status === 410 || res.status >= 500)) break;
        await sleep(wait);
        const again = await tryProbe('GET', checkUrl, pageIsPublic, BROWSER_UA);
        if (again.status === 0) continue; // a transport error says nothing about the status: keep the last answer
        res = again;
        attempts[attempts.length - 1] = again;
      }
      // An http link whose chain never reached https: ask the https variant too; a different answer is a disagreement.
      if (res.status >= 400 && !BLOCKED_STATUS.has(res.status) && res.finalUrl?.startsWith('http:')) {
        const https = await tryProbe('GET', res.finalUrl.replace(/^http:/, 'https:'), pageIsPublic, BROWSER_UA);
        if (https.status > 0) attempts.push({ ...https, variant: 'https' });
      }
    }
    return res.skipped ? null : { url: checkUrl, ...res, attempts: attempts.map(({ status, finalUrl, chain, errorClass, challenge, variant }) => ({ status, finalUrl, chain, errorClass, challenge, variant })) };
  };

  return {
    check(checkUrl, { pageIsPublic, fresh = false }) {
      const key = `${pageIsPublic}|${normalise(checkUrl)}`;
      if (!fresh && cache.has(key)) return cache.get(key).then((r) => r && { ...r, url: checkUrl });
      const p = run(checkUrl, pageIsPublic);
      if (!fresh) cache.set(key, p);
      return p;
    },
  };
}

const chainText = (chain = []) => chain.map((h) => `${h.url} (${h.status})`).join(' -> ');
const isDeadStatus = (n) => n === 404 || n === 410 || n >= 500;

/**
 * Judgement for a link on another origin: confirmed dead only when two independent attempts (HEAD with the tool UA, GET with a
 * browser UA) end at the same final URL with 404/410 or persistent 5xx. A block status anywhere is blocked-unverifiable; any
 * other disagreement (between attempts, or between the http and https variants) is inconsistent-status. Null = no finding.
 */
export function judgeExternal(result) {
  const at = result.attempts || [];
  const answered = at.filter((a) => a.status > 0 && !a.variant);
  const all = at.filter((a) => a.status > 0);
  if (all.some((a) => BLOCKED_STATUS.has(a.status) || a.challenge)) return { reason: 'blocked-unverifiable', status: all.find((a) => BLOCKED_STATUS.has(a.status))?.status ?? result.status };
  const dead = (a) => a.status === 404 || a.status === 410 || a.status >= 500;
  if (answered.length < 2) return result.status === 0 ? { reason: undefined, status: 0 } : dead(result) ? { reason: 'inconsistent-status', status: result.status } : null; // one answer is not two independent attempts
  const [head, get] = answered;
  if (!dead(head) && !dead(get)) return get.status >= 400 ? { reason: 'unverified-status', status: get.status } : null;
  const variantDiffers = all.some((a) => a.variant && (!dead(a) || a.status !== get.status));
  const agree = dead(head) && dead(get) && head.finalUrl === get.finalUrl && (head.status >= 500) === (get.status >= 500);
  if (!agree || variantDiffers) return { reason: 'inconsistent-status', status: get.status };
  return { reason: undefined, status: get.status };
}

/**
 * Dead Link Crawler
 *
 * Crawls all links on a page and checks for:
 * - 404 / 5xx responses and unreachable targets (http/https only; mailto:, tel:,
 *   javascript:, data: and bare # are never fetched)
 * - Empty href / bare #
 *
 * On a local page (dev server) a same-origin link to a path no project page defines (knownRoutes) that the server
 * answers 404 is a platform route the dev server cannot serve: needs-review, never a confirmed 404. `platformRoutes`
 * (globs of paths) silences such routes entirely. External blocks (401/403/429/999, bot challenge) and non-HTTP
 * errors are needs-review too; only 404/410/5xx that survive the browser-UA GET and two backed-off retries are confirmed (the final status decides).
 *
 * A public page cannot make the scanner fetch private or loopback addresses
 * (directly or through a redirect); at most 5 redirects are followed.
 */
export async function scanDeadLinks(page, url, { selectors = null, checker = createLinkChecker(), platformRoutes = [], knownRoutes = null } = {}) {
  const violations = [];

  // selectors: a re-run only probes the links it reported before.
  const allLinks = await page.$$eval('a[href], link[href], img[src], script[src]', (els) => {
    function cssPath(el) {
      if (el.id) return '#' + el.id;
      const parts = [];
      let cur = el;
      while (cur && cur !== document.body) {
        let seg = cur.nodeName.toLowerCase();
        const siblings = Array.from(cur.parentElement?.children || []).filter(s => s.nodeName === cur.nodeName);
        if (siblings.length > 1) seg += ':nth-of-type(' + (siblings.indexOf(cur) + 1) + ')';
        parts.unshift(seg);
        cur = cur.parentElement;
      }
      return parts.join(' > ').slice(0, 200);
    }
    // Non-navigational <link> rels that should not be checked for dead links
    const SKIP_LINK_RELS = new Set(['preconnect', 'preload', 'dns-prefetch', 'prefetch', 'manifest', 'icon', 'apple-touch-icon', 'canonical', 'alternate']);
    return els
      .map((e) => ({
        tag: e.tagName.toLowerCase(),
        url: e.href || e.src || '',
        rawHref: e.tagName === 'A' ? e.getAttribute('href') || '' : '',
        text: e.textContent?.trim().slice(0, 80) || '',
        html: (e.outerHTML || '').slice(0, 300),
        selector: cssPath(e),
        linkRel: e.tagName === 'LINK' ? (e.getAttribute('rel') || '') : '',
      }))
      .filter((l) => {
        if (!l.url || l.url.startsWith('data:') || l.url.startsWith('blob:')) return false;
        if (l.rawHref.trim().startsWith('#')) return false; // same-page anchor, nothing to fetch
        if (/\{\{|\{%/.test(l.rawHref)) return false; // unbound backend tag: no value to probe
        if (l.tag === 'link' && l.linkRel.split(/\s+/).some(r => SKIP_LINK_RELS.has(r))) return false;
        // Skip Vite dev server internal URLs (module sources, HMR client)
        const p = new URL(l.url, window.location.href).pathname;
        if (p.startsWith('/src/') || p.startsWith('/@') || p.startsWith('/node_modules/')) return false;
        return true;
      });
  });
  const links = (selectors ? allLinks.filter((l) => selectors.has(l.selector)) : allLinks).filter((l) => !UNBOUND_HREF.test(l.url));

  // Detect empty hrefs that are genuine bugs vs template-rendered placeholders.
  // A template-rendered link has structural indicators: styled with CSS classes,
  // contains child elements, or has ARIA attributes — signs that a template
  // intended to produce a real link but the data was missing at scan time.
  const emptyHrefs = await page.$$eval('a', (anchors) => {
    return anchors
      .filter((a) => {
        const href = (a.getAttribute('href') || '').trim();
        if (href && href !== '#' && !href.startsWith('javascript:')) return false;

        // A truly broken link: bare <a href=""> or <a href="#">
        // with no classes, no children, no attributes beyond href — flag it.
        // A template-rendered link: has styling classes, ARIA attrs, child elements — skip it.
        const hasClasses = a.classList.length > 0;
        const hasAria = a.hasAttribute('aria-label') || a.hasAttribute('aria-labelledby') || a.hasAttribute('role');
        const hasChildren = a.querySelector('img, svg, span, i, strong, em') !== null;
        const isHidden = a.hasAttribute('tabindex') && a.getAttribute('tabindex') === '-1';

        // If the element has ANY styling/structure, it's a designed component
        // whose data source is empty at scan time — not a broken link.
        if (hasClasses || hasAria || hasChildren || isHidden) return false;

        return true;
      })
      .map((a) => ({
        tag: 'a',
        text: (a.textContent || '').trim().slice(0, 80),
        html: a.outerHTML.slice(0, 300),
        rawHref: a.getAttribute('href') || '',
      }));
  });
  for (const el of emptyHrefs.slice(0, 10)) {
    violations.push(
      createViolation({
        ruleId: 'dead-link-empty-href',
        layer: 'links',
        category: 'reliability',
        impact: 'moderate',
        priority: 4,
        element: { outerHTML: el.html, selector: el.selector },
        source: { mode: 'url', url },
        fix: {
          deterministic: false,
          hint: `Link "${el.text || '(no text)'}" has empty or # href.`,
        },
      })
    );
    violations[violations.length - 1].evidence = { proof: { type: 'attribute-value', fact: `href="${el.rawHref}"` } };
  }

  // Dedupe URLs for HTTP checks; the checker (shared by every page of a scan) also dedupes across pages.
  const pageIsPublic = classifyHost(url).kind === 'public';
  const silenced = platformRoutes.map(globToRegExp);
  const sameOrigin = (u) => new URL(u).origin === new URL(url).origin;
  const isSilenced = (u) => sameOrigin(u) && silenced.some((r) => r.test(new URL(u).pathname) || r.test(normPath(new URL(u).pathname)));
  const uniqueUrls = [...new Set(links.filter((l) => l.url.startsWith('http') && !isSilenced(l.url)).map((l) => l.url))];
  // A re-run (selectors) exists to probe again, so it bypasses the cache.
  const results = await Promise.all(uniqueUrls.map((u) => checker.check(u, { pageIsPublic, fresh: !!selectors })));
  const checked = new Map();
  uniqueUrls.forEach((u, i) => { if (results[i]) checked.set(u, results[i]); });

  // A path with a file extension is a static asset (pdf, css, png...) that public/ should serve: a 404 there is real.
  const notServedLocally = (u) => !pageIsPublic && routeNotServedLocally(u, url, knownRoutes);
  // On a local page, another origin's path that repeats the local page's own path was most likely built from it by a script (window.location.pathname appended
  // to a host): the live site may redirect that page elsewhere, so the visitor's URL is not the one probed. Not proof the link is dead.
  const pagePath = normPath(new URL(url).pathname);
  const echoesLocalPage = (u) => !pageIsPublic && pagePath !== '/' && !sameOrigin(u) && normPath(new URL(u).pathname) === pagePath;

  for (const [checkUrl, rawResult] of checked) {
    // External links need two agreeing attempts to be dead; same-origin links keep the single-result policy.
    const judged = sameOrigin(checkUrl) ? undefined : judgeExternal(rawResult);
    if (judged === null || (judged === undefined && !(rawResult.status >= 400 || rawResult.status === 0))) continue;
    const result = judged ? { ...rawResult, status: judged.status } : rawResult;
    const gone = result.status === 404 || result.status === 410;
    let reason = null;
    if (judged?.reason) reason = judged.reason;
    else if (result.status === 404 && notServedLocally(checkUrl)) reason = 'route-not-served-locally';
    else if (gone && echoesLocalPage(checkUrl)) reason = 'route-echoes-local-page';
    else if (result.status === 0) reason = result.errorClass === 'redirect' ? null : result.errorClass || 'connection'; // a redirect loop is deterministic
    else if (BLOCKED_STATUS.has(result.status) || result.challenge) reason = 'blocked-unverifiable';
    else if (result.status < 500 && !gone) reason = 'unverified-status';
    const detail = reason === 'route-not-served-locally'
      ? 'returned HTTP 404 on the local server, but no page in the project defines this path (a platform route is not served locally)'
      : reason === 'route-echoes-local-page'
        ? `returned HTTP ${result.status}, but its path repeats the path of the local page it was found on (a script may append the page path to this host; the live page can redirect elsewhere, so a visitor may get another URL)`
      : result.status === 0
        ? `could not be reached (${result.errorClass}: ${result.error})`
        : `returned HTTP ${result.status}${reason === 'blocked-unverifiable' ? ' (blocked-unverifiable: the site refuses automated requests)' : ''}${reason === 'inconsistent-status' ? ' (inconsistent-status: the attempts disagree, so it is not proven dead)' : ''}`;
    const chains = (rawResult.attempts || []).map((a, i) => (a.chain?.length ? `${a.variant === 'https' ? 'https variant' : i === 0 ? 'HEAD' : 'GET'}: ${chainText(a.chain)}` : null)).filter(Boolean);
    const chainNote = chains.length ? ` Redirect chain: ${chains.join('; ')}.` : '';
    const matchingLinks = links.filter((l) => l.url === checkUrl);
    for (const el of matchingLinks.slice(0, 10)) {
      const { url: target, fragment } = splitFragment(checkUrl);
      const violation = createViolation({
        ruleId: gone ? 'dead-link-404' : result.status >= 500 && !reason ? 'dead-link-server-error' : 'dead-link-unreachable',
        layer: 'links',
        category: 'reliability',
        impact: gone && !reason ? 'serious' : 'moderate',
        priority: gone && !reason ? 3 : 4,
        element: { outerHTML: el.html, selector: el.selector },
        source: { mode: 'url', url },
        fix: {
          deterministic: false,
          hint: `${el.tag} "${el.text}" → ${checkUrl} ${detail}.${chainNote}`,
        },
      });
      // Structured target for the report: one finding per target URL + kind across pages; the fragment is kept, never probed.
      violation.linkTarget = { url: target, fragment, status: result.status, reason };
      if (chains.length) violation.evidence = { ...violation.evidence, proof: { type: 'http-status', fact: `HTTP ${result.status}.${chainNote}`.trim() } };
      if (reason) { violation.verdict = 'needs-review'; violation.kind = 'heuristic'; violation.reason = reason; }
      violations.push(violation);
    }
  }

  return violations;
}
