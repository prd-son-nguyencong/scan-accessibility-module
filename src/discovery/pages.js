import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { classifyHost } from '../utils/host-classify.js';
import { normalizeRoute } from '../utils/route.js';
import { parseCliArgs, CliError } from '../utils/cli-args.js';
import { resolveProject } from '../utils/project.js';

const FETCH_TIMEOUT_MS = 8000;
const DEFAULT_MAX_PAGES = 50;
const MAX_SITEMAPS = 20;
const MAX_SITEMAP_DEPTH = 2;
const CRAWL_DEPTH = 2;
const DEFAULT_PER_TEMPLATE = 2;
const NON_PAGE_EXT = /\.(?:css|js|mjs|json|xml|gz|pdf|zip|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|mp4|webm)$/i;
// Build output folders that hold fragments, not pages; the project's own pages dir name is added at call time.
const FRAGMENT_DIRS = new Set(['partials', 'layouts', 'components']);
// Conventional error templates: the route answers with its own status, so that status is expected.
const ERROR_PAGE = /^\/(404|500)$/;
const errorStatus = (route) => (ERROR_PAGE.test(route) ? Number(route.slice(1)) : null);

const nameFor = (route) => route.replace(/^\/+|\/+$/g, '').replace(/[/?&=]+/g, '-') || 'homepage';
const decodeXml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/**
 * Resolves the pages to scan. Priority: explicit --page/config pages, sitemap,
 * local build output, Liquid pages, bounded crawl. `args` is already parsed:
 * { page, sitemap, crawl, maxPages, url }. `args.url` marks URL mode.
 * @returns {Promise<{pages: {name: string, route: string, url: string|null, source: string}[], warnings: string[]}>}
 */
export async function resolvePages({ config = {}, args = {}, baseUrl, projectRoot, fetchImpl = globalThis.fetch } = {}) {
  const warnings = [];
  const base = baseUrl || args.url || config.baseUrl || null;
  const origin = base ? new URL(base).origin : null;
  const maxPages = Number.isInteger(args.maxPages) && args.maxPages > 0 ? args.maxPages : DEFAULT_MAX_PAGES;
  const ctx = { fetchImpl, origin, baseKind: origin ? classifyHost(origin).kind : 'public', warnings };
  const toPage = (route, source) => ({ name: nameFor(route), route, url: origin ? new URL(route, origin).href : null, source });

  const explicit = args.page
    ? String(args.page).split(',').map((s) => s.trim()).filter(Boolean).map((p) => ({ route: normalizeRoute(p), source: 'page-flag' }))
    : (config.pages || []).map((p) => ({ route: normalizeRoute(p.path ?? p.name ?? '/'), name: p.name, source: 'config' }));
  if (explicit.length) {
    return { pages: explicit.filter((e, i) => explicit.findIndex((o) => o.route === e.route) === i).map((e) => ({ ...toPage(e.route, e.source), ...(e.name ? { name: e.name } : {}) })), warnings };
  }

  const urlMode = Boolean(args.url);
  const sources = { sitemap: () => fromSitemap(args.sitemap, ctx, maxPages), crawl: () => fromCrawl(ctx, maxPages, args.crawlPerTemplate ?? DEFAULT_PER_TEMPLATE),
    dist: () => fromDist(projectRoot, config), liquid: () => fromLiquid(projectRoot, config) };
  const order = [args.sitemap && 'sitemap', args.crawl && 'crawl', ...(urlMode ? ['sitemap', 'crawl'] : ['dist', 'liquid'])]
    .filter(Boolean).filter((s, i, a) => a.indexOf(s) === i);

  const found = {};
  let primary = null;
  for (const source of order) {
    if ((source === 'sitemap' || source === 'crawl') && !origin) { warnings.push(`${source}: no base URL`); continue; }
    // A crawl is not a claim of completeness, so it is never diffed and never runs once a source won.
    if (source === 'crawl' && primary) continue;
    const routes = [...new Set((await sources[source]()).map((r) => normalizeRoute(r)))];
    if (!routes.length) continue;
    found[source] = routes;
    primary ??= source;
  }
  if (primary) {
    warnings.push(...discrepancies(found, config));
    // Against a local dev server the templates are the truth; dist-only routes must prove themselves with a probe.
    const distOnly = (found.dist || []).filter((r) => !(found.liquid || []).includes(r));
    let fromDistOnly = new Set(primary === 'dist' ? found.dist : []);
    if (found.dist && found.liquid && ctx.baseKind !== 'public') {
      primary = 'liquid';
      const excluded = new Set((config.excludedPages || []).map((e) => nameFor(normalizeRoute(String(e)))));
      fromDistOnly = new Set(distOnly.filter((r) => !excluded.has(nameFor(r))));
      found.liquid = [...found.liquid, ...fromDistOnly];
    }
    const dropped = [];
    let routes = found[primary];
    if (origin && fromDistOnly.size) {
      const kept = [];
      for (const r of routes) {
        const status = fromDistOnly.has(r) && errorStatus(r) === null ? await probeStatus(r, ctx) : null;
        if (status === 404 || status === 410) dropped.push({ route: r, source: 'dist', status });
        else kept.push(r);
      }
      routes = kept;
      if (dropped.length) warnings.push(`dist: dropped ${dropped.length} route(s) that answer 404 (build output the server does not serve): ${dropped.slice(0, 5).map((d) => d.route).join(', ')}`);
    }
    const capped = routes.slice(0, maxPages);
    const truncated = capped.length < routes.length;
    if (truncated) warnings.push(`${primary}: ${routes.length} pages found, capped at ${maxPages} (--max-pages)`);
    const crawl = primary === 'crawl' ? ctx.crawl : null;
    const pages = capped.map((r) => ({ ...toPage(r, primary), ...(fromDistOnly.has(r) ? { source: 'dist' } : {}), ...(errorStatus(r) ? { errorPage: true, allowStatus: [errorStatus(r)] } : {}),
      ...(crawl ? { template: crawl.templateOf.get(r) } : {}) }));
    const templates = crawl ? [...crawl.templates].map(([template, samples]) => ({ template, samples })) : undefined;
    // A removed 404 page is not in `found`, so a later level never re-adds it (found.has is checked first).
    return { pages, warnings, truncated, ...(dropped.length ? { droppedRoutes: dropped } : {}), ...(crawl ? { templates, skippedDuplicates: crawl.skipped, brokenLinks: crawl.broken } : {}) };
  }
  warnings.push('no pages discovered, defaulting to the home page');
  return { pages: [toPage('/', 'default')], warnings };
}

/** Pages one source lists that another (sitemap, dist, liquid) lacks; compared on path, never dropped silently. */
function discrepancies(found, config) {
  const excluded = new Set((config.excludedPages || []).map((p) => nameFor(normalizeRoute(String(p), { keepQuery: false }))));
  const paths = (list) => new Set(list.map((r) => normalizeRoute(r, { keepQuery: false })).filter((r) => !excluded.has(nameFor(r))));
  const names = Object.keys(found).filter((n) => n !== 'crawl');
  const out = [];
  for (const a of names) for (const b of names) {
    if (a === b) continue;
    const other = paths(found[b]);
    const missing = [...paths(found[a])].filter((r) => !other.has(r));
    if (missing.length) out.push(`${missing.length} page(s) in ${a} but not in ${b}: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ', ...' : ''}`);
  }
  return out;
}

/** HTTP status of a route, or null when the probe itself fails (a dead server is not evidence of a missing page). */
async function probeStatus(route, ctx) {
  try { await get(new URL(route, ctx.origin).href, ctx); return 200; } catch (err) { return err.status ?? null; }
}

async function get(url, ctx, hops = 3) {
  // Private hosts are only reachable when the base itself is private.
  if (ctx.baseKind === 'public' && classifyHost(url).kind !== 'public') throw new Error('refused: private host from a public base');
  const res = await ctx.fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: 'manual' });
  const location = res.headers?.get?.('location');
  if (res.status >= 300 && res.status < 400 && location && hops > 0) {
    const next = new URL(location, url);
    if (next.origin !== ctx.origin) throw new Error(`redirect to other origin ${next.origin}`);
    return get(next.href, ctx, hops - 1);
  }
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
  return res;
}

async function getBuffer(url, ctx) {
  const buf = Buffer.from(await (await get(url, ctx)).arrayBuffer());
  return buf[0] === 0x1f && buf[1] === 0x8b ? gunzipSync(buf) : buf;
}

function sameOriginRoute(loc, ctx) {
  try {
    const u = new URL(decodeXml(loc.trim()));
    return u.origin === ctx.origin && !NON_PAGE_EXT.test(u.pathname) ? normalizeRoute(u.href) : null;
  } catch { return null; }
}

async function fromSitemap(location, ctx, maxPages) {
  const start = location || `${ctx.origin}/sitemap.xml`;
  const routes = new Set();
  const seen = new Set();
  async function visit(ref, depth) {
    if (seen.size >= MAX_SITEMAPS || seen.has(ref) || routes.size >= maxPages) return;
    seen.add(ref);
    let xml;
    try {
      const isRemote = /^https?:\/\//i.test(ref);
      if (isRemote && new URL(ref).origin !== ctx.origin) { ctx.warnings.push(`sitemap: ignored cross-origin ${ref}`); return; }
      const buf = isRemote ? await getBuffer(ref, ctx) : await readFile(ref);
      xml = (buf[0] === 0x1f && buf[1] === 0x8b ? gunzipSync(buf) : buf).toString('utf8');
    } catch (err) {
      ctx.warnings.push(`sitemap ${ref}: ${err.message}`);
      return;
    }
    const locs = [...xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)].map((m) => m[1]);
    if (/<sitemapindex[\s>]/i.test(xml)) {
      if (depth >= MAX_SITEMAP_DEPTH) { ctx.warnings.push(`sitemap: index nesting deeper than ${MAX_SITEMAP_DEPTH} ignored`); return; }
      for (const loc of locs) await visit(decodeXml(loc), depth + 1);
      return;
    }
    for (const loc of locs) {
      const route = ctx.origin ? sameOriginRoute(loc, ctx) : null;
      if (route) routes.add(route); else ctx.warnings.push(`sitemap: ignored ${loc}`);
    }
  }
  await visit(start, 0);
  return [...routes];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const idLike = (seg) => UUID.test(seg) || /^\d+$/.test(seg) || (/^[a-z0-9_-]{6,}$/i.test(seg) && (seg.match(/\d/g) || []).length >= 3);

/** Route template: ID-like segments become :id, a slug before /job(s)/ or ending in digits becomes :slug, query values are dropped. */
export function routeTemplate(route) {
  const u = new URL(route, 'http://x');
  const segs = u.pathname.split('/').filter(Boolean);
  const out = segs.map((seg, i) => {
    if (idLike(seg)) return ':id';
    if (/^job(s)?$/i.test(segs[i + 1] || '') && i === segs.length - 3) return ':slug';
    return /^[^/]+-\d{3,}$/.test(seg) ? ':slug' : seg;
  });
  const keys = [...new Set(u.searchParams.keys())].sort();
  return `/${out.join('/')}${keys.length ? `?${keys.map((k) => `${k}=*`).join('&')}` : ''}`;
}

// shortcut: regex region match (nested header/nav/footer fine, same-tag nesting is not), upgrade to a parser if sites need it.
function linksOf(html) {
  const regions = [...html.matchAll(/<(header|nav|footer)[\s>][\s\S]*?<\/\1>/gi)].map((m) => [m.index, m.index + m[0].length]);
  return [...html.matchAll(/<a\s[^>]*?href\s*=\s*["']([^"'#]+)[^"']*["']/gi)]
    .map((m) => ({ href: m[1], nav: regions.some(([from, to]) => m.index >= from && m.index < to) }));
}

async function fromCrawl(ctx, maxPages, perTemplate = DEFAULT_PER_TEMPLATE) {
  const found = new Set(['/']);
  const counts = new Map([[routeTemplate('/'), 1]]);
  const templateOf = new Map([['/', routeTemplate('/')]]);
  const rejected = new Set();
  const referrers = new Map();
  const hrefOf = new Map(); // route -> href as authored on its first referrer (a source lookup needs the raw value)
  const broken = [];
  const dead = new Set();
  let frontier = ['/'];
  for (let depth = 0; depth <= CRAWL_DEPTH && frontier.length && found.size < maxPages; depth++) {
    const candidates = [];
    for (const route of frontier) {
      let html;
      try {
        const res = await get(new URL(route, ctx.origin).href, ctx);
        if (!/html/i.test(res.headers?.get?.('content-type') || 'text/html')) continue;
        html = await res.text();
      } catch (err) {
        // A linked page that is gone is a broken link on its referrers, not a failed page; the home page stays.
        if ([404, 410].includes(err.status) && route !== '/') {
          found.delete(route);
          dead.add(route);
          counts.set(templateOf.get(route), counts.get(templateOf.get(route)) - 1);
          broken.push({ route, status: err.status });
        }
        ctx.warnings.push(`crawl ${route}: ${err.message}`);
        continue;
      }
      if (depth === CRAWL_DEPTH) continue;
      for (const { href, nav } of linksOf(html)) {
        let u;
        try { u = new URL(decodeXml(href), new URL(route, ctx.origin)); } catch { continue; }
        const r = normalizeRoute(u.href);
        if (u.origin === ctx.origin && !NON_PAGE_EXT.test(u.pathname)) { (referrers.get(r) ?? referrers.set(r, new Set()).get(r)).add(route); if (!hrefOf.has(r)) hrefOf.set(r, decodeXml(href)); }
        if (u.origin !== ctx.origin || NON_PAGE_EXT.test(u.pathname) || found.has(r) || dead.has(r) || candidates.some((c) => c.route === r)) continue;
        candidates.push({ route: r, nav, template: routeTemplate(r) });
      }
    }
    // Every template's first sample is tried before any second sample; navigation links before body links; document order breaks ties.
    const seenInLevel = new Map();
    const ranked = candidates.map((c, order) => ({ ...c, order, rank: seenInLevel.set(c.template, (seenInLevel.get(c.template) ?? -1) + 1).get(c.template) }))
      .sort((a, b) => a.rank - b.rank || Number(b.nav) - Number(a.nav) || a.order - b.order);
    const next = [];
    for (const c of ranked) {
      if (found.size >= maxPages) break;
      if ((counts.get(c.template) ?? 0) >= perTemplate) { rejected.add(c.route); continue; }
      found.add(c.route);
      counts.set(c.template, (counts.get(c.template) ?? 0) + 1);
      templateOf.set(c.route, c.template);
      next.push(c.route);
    }
    frontier = next;
  }
  ctx.crawl = { templates: counts, templateOf, skipped: rejected.size,
    // Referrers are read after the crawl: pages fetched after the 404 may link to it too.
    broken: broken.map((b) => ({ ...b, href: hrefOf.get(b.route), referrers: [...(referrers.get(b.route) ?? [])] })) };
  return [...found];
}

async function fromDist(projectRoot, config) {
  const project = resolveProject(config, projectRoot);
  const dist = project.distDir;
  if (!existsSync(dist)) return [];
  const fragments = new Set([...FRAGMENT_DIRS, path.posix.basename(project.pagesRoot)]);
  const routes = [];
  async function walk(dir, rel) {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (!(rel === '' && fragments.has(e.name))) await walk(path.join(dir, e.name), `${rel}${e.name}/`);
      } else if (e.name.endsWith('.html')) {
        const r = `/${rel}${e.name.slice(0, -5)}`.replace(/\/index$/, '') || '/';
        routes.push(r);
      }
    }
  }
  await walk(dist, '');
  return routes.sort();
}

async function fromLiquid(projectRoot, config) {
  const root = resolveProject(config, projectRoot).pagesDir;
  if (!existsSync(root)) return [];
  const excluded = new Set((config.excludedPages || []).map((p) => nameFor(normalizeRoute(String(p)))));
  const routes = [];
  async function walk(dir, rel) {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      if (e.isDirectory()) await walk(path.join(dir, e.name), `${rel}${e.name}/`);
      else if (e.name.endsWith('.liquid')) routes.push(`/${rel}${e.name.slice(0, -7)}`.replace(/\/index$/, '') || '/');
    }
  }
  await walk(root, '');
  return routes.filter((r) => !excluded.has(nameFor(r))).sort();
}

/** Reads --sitemap <url|file>, --crawl and --max-pages <n> from raw argv through the strict CLI parser. */
export function parseDiscoveryArgs(rawArgs) {
  const v = parseCliArgs(rawArgs);
  const maxPages = v['max-pages'] === undefined ? undefined : Number(v['max-pages']);
  if (maxPages !== undefined && !(Number.isInteger(maxPages) && maxPages > 0)) throw new CliError('--max-pages needs a positive integer.');
  const perTemplate = v['crawl-per-template'] === undefined ? undefined : Number(v['crawl-per-template']);
  if (perTemplate !== undefined && !(Number.isInteger(perTemplate) && perTemplate > 0)) throw new CliError('--crawl-per-template needs a positive integer.');
  return { sitemap: v.sitemap, crawl: Boolean(v.crawl), maxPages, ...(perTemplate === undefined ? {} : { crawlPerTemplate: perTemplate }) };
}

/** Runs discovery for the CLI and returns scan page entries; logs warnings and sources. */
export async function discoverScanPages({ rawArgs, config, baseUrl, projectRoot, urlMode, onWarnings }) {
  const flags = parseDiscoveryArgs(rawArgs);
  // --url stays a single-page scan unless discovery is requested with --sitemap or --crawl.
  if (urlMode && !flags.sitemap && !flags.crawl) return [{ url: baseUrl, name: 'remote', path: '/', source: 'page-flag' }];
  const { pages, warnings, truncated, templates, skippedDuplicates, brokenLinks, droppedRoutes } = await resolvePages({
    config: { ...config, pages: [] }, baseUrl, projectRoot,
    args: { ...flags, ...(urlMode ? { url: baseUrl } : {}) },
  });
  for (const w of warnings) console.warn(`  discovery: ${w}`);
  onWarnings?.(warnings, templates || droppedRoutes
    ? { ...(templates ? { templates, skippedDuplicates, ...(brokenLinks?.length ? { brokenLinks } : {}) } : {}), ...(droppedRoutes ? { droppedRoutes } : {}) } : undefined);
  console.log(`Discovered ${pages.length} page(s) via ${[...new Set(pages.map((p) => p.source))].join(', ')}`);
  if (templates) console.log(`${pages.length} pages in ${new Set(pages.map((p) => p.template)).size} templates (${skippedDuplicates} URLs skipped as duplicates of templates)`);
  const brokenFor = (route) => (brokenLinks || []).filter((b) => b.referrers.includes(route)).map((b) => ({ route: b.route, url: new URL(b.route, baseUrl).href, status: b.status, ...(b.href ? { href: b.href } : {}) }));
  return pages.map((p) => (p.source === 'default' && urlMode ? { url: baseUrl, name: 'remote', path: '/', source: 'default' }
    : { name: p.name, path: p.route, url: p.url, source: p.source, ...(p.errorPage ? { errorPage: true, allowStatus: p.allowStatus } : {}), ...(p.template ? { template: p.template } : {}),
        ...(brokenFor(p.route).length ? { brokenLinks: brokenFor(p.route) } : {}),
        // A sitemap or crawl cannot prove full coverage; a cap certainly cuts it.
        ...(truncated || p.source === 'sitemap' || p.source === 'crawl' ? { partial: true } : {}) }));
}
