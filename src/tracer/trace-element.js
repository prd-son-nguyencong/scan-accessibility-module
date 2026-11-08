import { existsSync } from 'node:fs';
import path from 'node:path';
import { getProjectRoot } from '../utils/paths.js';
import {
  buildTagIndex,
  collectRenderTree,
  findLineForRenderedHtml,
  findPageLevelAnchor,
  findSkipLinkHome,
  isDocumentTag,
  isPageStructureRule,
  isPageTargetRule,
  parseRenderedTag,
} from './liquid-tag-index.js';
import {
  DEFAULT_SOURCE_ROOTS,
  extractHtmlHints,
  searchLiquidHintMatches,
} from './remote-hint-trace.js';
import { computeSourcePreimage } from './preimage.js';
import { findStructuralSource } from './structural-source.js';
import { classifyOwnership, untraceableOwnerReason } from './ownership.js';
import { loadLocalPageHtml, traceByFingerprint } from './fingerprint-map.js';
import { resolveAdapter } from './adapters/index.js';
import './adapters/paradox-liquid.js';

export { TRACE_REASONS } from './trace-reasons.js';

const SCOPE_REASONS = new Set(['DEPLOYMENT_URL_MISMATCH', 'DEPLOYMENT_URL_INCONSISTENT']);
const norm = (value) => String(value).replace(/\s+/g, ' ').trim();

/**
 * Snippet names whose `<!-- snippets/x.html -->` ... `<!-- /snippets/x.html -->` region contains
 * the element, innermost first. `markers` is false when the page carries no marker at all;
 * `outside` counts occurrences of the element that no owning region accounts for (page-level
 * markup with the same text), which makes every owner unproven.
 */
function markerOwners(pageHtml, outerHTML) {
  const page = norm(pageHtml);
  const key = norm(outerHTML).slice(0, 160);
  const count = (text) => (key.length >= 10 ? text.split(key).length - 1 : 0);
  const owners = [];
  let markers = false;
  const open = /<!--\s*snippets\/([^\s>]+?)\.html\s*-->/g;
  let m;
  while ((m = open.exec(page)) !== null) {
    markers = true;
    const close = new RegExp(`<!--\\s*/snippets/${m[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.html\\s*-->`, 'g');
    close.lastIndex = open.lastIndex;
    const end = close.exec(page);
    if (!end) continue;
    const n = count(page.slice(open.lastIndex, end.index));
    if (n > 0) owners.push({ name: m[1], n, start: open.lastIndex, end: end.index });
  }
  owners.sort((a, b) => (a.end - a.start) - (b.end - b.start));
  // Occurrences inside regions that nest in no other owning region; the rest of the page is "outside".
  const covered = owners
    .filter((o) => !owners.some((p) => p !== o && p.start <= o.start && o.end <= p.end && (p.end - p.start) > (o.end - o.start)))
    .reduce((sum, o) => sum + o.n, 0);
  return { markers, outside: Math.max(0, count(page) - covered), names: [...new Set(owners.map((o) => o.name))] };
}

function snippetFile(name, root) {
  return [`src/partials/${name}.liquid`, `src/components/${name}.liquid`]
    .find((rel) => existsSync(path.join(root, rel))) || null;
}

function hitCandidates(file, hit, owned, evidence) {
  const strong = hit.confidence === 'high' && !hit.ambiguous;
  return (hit.lines || [hit.line]).map((line) => ({
    file,
    line,
    method: hit.method,
    score: hit.score ?? null,
    evidence: [...evidence, ...(strong ? ['decisive-match'] : [])],
    strong,
    owned,
  }));
}

/**
 * Tied candidates told apart by the element's own leading text. Sound only when every tie has authored
 * text of its own (a Liquid-filled or text-less tag could have rendered anything): then exactly one
 * matching tie is the element and the rest cannot have produced it. Anything less keeps the tie.
 */
function breakTieByText(list, rendered, root, twin) {
  // A twin whose text the preview element does not share (bound text) is itself a guess: its text proves nothing.
  if (!rendered.text || (twin && !twin.textAgrees)) return list;
  const texts = list.map((c) => {
    const tags = buildTagIndex(c.file, root).filter((t) => t.line === c.line && t.tagName === rendered.tagName);
    return tags.length === 1 ? tags[0].text : null;
  });
  const hits = list.filter((_, i) => texts[i] === rendered.text);
  if (texts.some((t) => t === null) || hits.length !== 1) return list;
  // Text is a weaker proof than a marker region, so the winner is never `high`.
  return [{ ...hits[0], strong: true, owned: false, evidence: [...hits[0].evidence, 'text-match'] }];
}

/** True when the candidate's tag writes exactly the element's class list (no Liquid in it, none cut off) and no other tag of `files` writes that same tag and list. */
function uniqueExactClassList(candidate, rendered, files, root) {
  if (!rendered.classes.length || rendered.classes.some((c) => /\u2026|\.\.\./.test(c))) return false;
  const sameList = (t) => t.tagName === rendered.tagName && t.dynamicClasses.length === 0 && t.classTokens.length === rendered.classSet.size && t.classTokens.every((c) => rendered.classSet.has(c));
  const own = buildTagIndex(candidate.file, root).find((t) => t.line === candidate.line && t.tagName === rendered.tagName);
  if (!own || !sameList(own)) return false;
  return files.every((f) => buildTagIndex(f, root).every((t) => !sameList(t) || (f === candidate.file && t.line === candidate.line)));
}

function distinct(candidates) {
  return [...new Map(candidates.map((c) => [`${c.file}|${c.line}`, c])).values()];
}

const publicCandidate = ({ strong, owned, ...rest }) => rest;

/**
 * The one entry point that turns a rendered element into local source candidates: asks the source
 * adapter of the detected framework (or `el.adapter` / `tracer.adapter` in .scan-config.json).
 * No adapter for the project means `untraceable` with `unknown-framework` / `unsupported-framework`.
 * Element fields are documented on `traceLiquid`, the `paradox-liquid` adapter's locate.
 */
export function traceElement(el = {}) {
  const untraceable = (reason) => ({ confidence: 'untraceable', candidates: [], reason });
  if (classifyOwnership(el) !== 'source') return untraceable(untraceableOwnerReason(el));
  if (el.mode === 'preview') {
    if (!el.attestation?.ok) {
      return untraceable(SCOPE_REASONS.has(el.attestation?.reason) ? 'scope-mismatch' : 'preview-without-reference');
    }
    if (!el.root) return untraceable('preview-without-reference');
  }
  const { adapter, reason } = resolveAdapter(el.root || getProjectRoot(), el.adapter);
  if (!adapter) return untraceable(reason);
  return adapter.locate(el);
}

/**
 * Paradox Liquid pipeline (the `paradox-liquid` adapter's locate).
 *
 * @param {object} el
 *   outerHTML, selector, text, pageFile (src/pages/x.liquid), mode ('local' | 'preview'),
 *   attestation ({ ok, reason }), pageHtml (local render with snippet markers; in preview mode the
 *   reference the preview element is matched against by fingerprint), ownerFile
 *   (owner already proven by a marker or the build manifest), ruleId, platformOwned, hasManifest,
 *   root (source root; required for preview), searchRoots, devHost (hostname of the scanned page).
 * @returns {{ confidence: 'high'|'medium'|'low'|'ambiguous'|'untraceable', candidates: object[], reason: string|null }}
 *   `high` only for exactly one candidate backed by a marker/manifest owner and a
 *   decisive match; several equal candidates are `ambiguous`; nothing is `untraceable` with a reason.
 */
export function traceLiquid(el = {}) {
  const mode = el.mode === 'preview' ? 'preview' : 'local';
  const outerHTML = String(el.outerHTML || '').trim();
  const untraceable = (reason) => ({ confidence: 'untraceable', candidates: [], reason });
  const rendered = outerHTML ? parseRenderedTag(outerHTML) : null;

  if (classifyOwnership(el) !== 'source') return untraceable(untraceableOwnerReason(el));

  if (mode === 'local' && el.hasManifest === false && !el.pageHtml && !el.ownerFile) {
    return untraceable('no-manifest');
  }
  const root = el.root || getProjectRoot();
  const pageFile = el.pageFile && existsSync(path.join(root, el.pageFile)) ? el.pageFile : null;

  // Structural findings (nested <main>, unlabelled <nav>, <img> without alt, modal without trap) go to the template that writes the element.
  const structural = pageFile ? findStructuralSource(pageFile, el.ruleId, rendered, el.selector, root) : null;
  if (structural) return structural;

  // A structural finding reported on <html>/<body> is about the page, not about the layout that writes those tags.
  const documentLevel = rendered && pageFile
    && ((isDocumentTag(rendered.tagName) && isPageStructureRule(el.ruleId)) || isPageTargetRule(el.ruleId));
  if (!rendered || documentLevel) {
    // Absence findings ("no h1") have no element: anchor where the markup would go, never claim more.
    const anchor = pageFile && el.ruleId ? findPageLevelAnchor(pageFile, el.ruleId, root) : null;
    if (!anchor && !documentLevel) return untraceable('no-element');
    // No skip link at all: the fix is in the header every page shares; the page <main> (the target) stays listed behind it.
    const home = anchor && pageFile && /^(skip-link-missing|bypass)$/i.test(el.ruleId || '') ? findSkipLinkHome(pageFile, root) : null;
    if (anchor) return {
      confidence: 'low',
      candidates: [
        ...(home ? [{ file: home.file, line: home.line, method: home.method, score: null, evidence: ['page-level-anchor', home.shared] }] : []),
        { file: anchor.file, line: anchor.line, method: anchor.method, score: null, evidence: ['page-level-anchor'] },
      ],
      reason: null,
    };
  }

  // Preview with the local instrumented build as reference: match by fingerprint, trace the local twin.
  if (mode === 'preview' && el.pageHtml) {
    const viaLocal = traceByFingerprint(
      { pageHtml: el.pageHtml, outerHTML, selector: el.selector },
      (html, owners, refTagCount, textAgrees) => traceLiquid({
        ...el,
        mode: 'local',
        twin: { refTagCount, textAgrees },
        outerHTML: html,
        selector: undefined,
        platformOwned: false,
        // Only the matched element's own marker regions, so identical markup elsewhere cannot blur its owner.
        pageHtml: owners.reduceRight((inner, name) => `<!-- snippets/${name}.html -->${inner}<!-- /snippets/${name}.html -->`, html),
      }),
    );
    if (viaLocal) return viaLocal;
    // The reference page is the truth for this route: no twin there means no source, not a source-side guess.
    if (/<!--\s*snippets\//.test(el.pageHtml)) return untraceable('no-match');
  }

  // Owner files: a marker region (or a manifest-proven file) is the strong evidence for `high`.
  let markers = false;
  let outside = 0;
  const ownerFiles = [];
  if (el.ownerFile && existsSync(path.join(root, el.ownerFile))) ownerFiles.push({ file: el.ownerFile, evidence: ['manifest-owner'] });
  if (mode === 'local' && el.pageHtml) {
    const found = markerOwners(el.pageHtml, outerHTML);
    markers = found.markers;
    outside = found.outside;
    for (const name of found.names) {
      const file = snippetFile(name, root);
      if (file && !ownerFiles.some((o) => o.file === file)) ownerFiles.push({ file, evidence: [`marker:snippets/${name}.html`] });
    }
  }

  let pool = [];
  for (const { file, evidence } of ownerFiles) {
    const hit = findLineForRenderedHtml(file, outerHTML, root, { local: mode === 'local' && (el.devHost || true) });
    // The innermost owner may legitimately be a wrapper; only the first owner file counts as owned.
    if (hit) pool.push(...hitCandidates(file, hit, outside === 0 && file === ownerFiles[0].file, evidence));
  }
  const searched = [];
  // Not inside a marker region (page-level markup, layout head, or a stripped Studio render) or also
  // present outside every region (so the marker alone does not prove the owner): search the tree.
  if ((pool.length === 0 || outside > 0) && pageFile) {
    for (const file of collectRenderTree(pageFile, undefined, root)) {
      searched.push(file);
      const hit = findLineForRenderedHtml(file, outerHTML, root, { local: mode === 'local' && (el.devHost || true) });
      if (hit) pool.push(...hitCandidates(file, hit, false, [markers ? 'outside-marker' : 'tree-search']));
    }
  }

  if (pool.length > 0) {
    if (pool.some((c) => c.strong)) pool = pool.filter((c) => c.strong);
    let list = distinct(pool);
    if (list.length > 1) list = breakTieByText(list, rendered, root, el.twin);
    if (list.length > 1) {
      return { confidence: 'ambiguous', candidates: list.map(publicCandidate), reason: 'multiple-candidates' };
    }
    const [only] = list;
    let confidence = 'low';
    if (only.strong) confidence = only.owned ? 'high' : 'medium';
    else {
      // A bare tag-name match is only worth `medium` when no other file could own that tag either.
      const files = searched.length > 0 ? searched : ownerFiles.map((o) => o.file);
      const sameTag = files.reduce((n, f) => n + buildTagIndex(f, root).filter((t) => t.tagName === rendered.tagName).length, 0);
      // A twin also needs its tag to be unique in the reference page, else the lone source tag may be another element.
      if (sameTag === 1 && mode !== 'preview' && (!el.twin || el.twin.refTagCount === 1)) confidence = 'medium';
      // Utility-only classes (`group`) carry no identity score, but a complete literal class list that equals the element's own, written by exactly one tag of the page's render tree, does.
      else if (mode !== 'preview' && !el.twin && uniqueExactClassList(only, rendered, files, root)) confidence = 'medium';
    }
    // A preview element with no reference twin and only a weak source match is not worth a guessed path.
    if (mode === 'preview' && confidence === 'low') return untraceable('no-match');
    return { confidence, candidates: [publicCandidate(only)], reason: null };
  }

  // A twin on a page whose source is missing has no source; identical markup on another page is not its owner.
  if ((mode === 'preview' || !pageFile) && !el.ownerFile && !(el.twin && el.pageFile && !pageFile)) {
    const matches = new Map();
    for (const hint of extractHtmlHints(outerHTML)) {
      for (const match of searchLiquidHintMatches(root, hint, el.searchRoots || DEFAULT_SOURCE_ROOTS)) {
        matches.set(`${match.file}|${match.line}`, match);
      }
    }
    const list = [...matches.values()].map((m) => ({
      file: m.file,
      line: m.line,
      method: matches.size === 1 ? 'hybrid-verified-unique-hint' : 'hybrid-ambiguous-hint',
      score: null,
      evidence: ['hint-search'],
      preimageSha256: m.preimageSha256,
    }));
    if (list.length === 1) return { confidence: 'medium', candidates: list, reason: null };
    if (list.length > 1) return { confidence: 'ambiguous', candidates: list, reason: 'multiple-candidates' };
  }

  if (el.pageFile && !pageFile) return untraceable('page-source-missing');
  return untraceable(mode === 'local' && el.pageHtml && !markers ? 'no-marker' : 'no-match');
}

/**
 * Report-compatible `source` fields from a traceElement result (old fields stay: file, line,
 * confidence, method, preimage*). `ambiguous`/`untraceable` map to confidence `none` plus
 * additive `traceConfidence`/`traceReason`; ambiguous also yields `sourceCandidates`.
 */
export function traceToSourceFields(result, root = getProjectRoot()) {
  const [top] = result.candidates;
  const base = { traceConfidence: result.confidence, traceReason: result.reason };
  if (!top || result.confidence === 'ambiguous' || result.confidence === 'untraceable') {
    return {
      source: { file: null, line: null, confidence: 'none', method: result.confidence === 'ambiguous' ? top.method : 'unresolved', preimageSha256: null, preimageRange: null, ...base },
      sourceCandidates: result.candidates.map((c) => ({
        file: c.file,
        line: c.line,
        confidence: 'low',
        method: c.method,
        preimageSha256: c.preimageSha256 || computeSourcePreimage(c.file, c.line, root)?.preimageSha256 || null,
      })),
    };
  }
  const preimage = computeSourcePreimage(top.file, top.line, root);
  return {
    source: {
      file: top.file,
      line: top.line,
      confidence: result.confidence,
      method: top.method,
      preimageSha256: preimage?.preimageSha256 || top.preimageSha256 || null,
      preimageRange: preimage?.range || null,
      ...base,
    },
    // A unique answer may still carry the other places that write the same defect (two unlabelled navs).
    sourceCandidates: result.candidates.slice(1).map((c) => ({ file: c.file, line: c.line, confidence: 'low', method: c.method })),
  };
}

/**
 * Preview findings: attach a source only when traceElement can stand behind it (unique file+line),
 * otherwise list the candidates. Replaces the old hint-only attribution.
 */
export function applyRemoteHintAttribution(violation, localRoot, { searchRoots = DEFAULT_SOURCE_ROOTS, pageHtml } = {}) {
  if (!violation || !localRoot) return violation;
  if (violation.source?.file && violation.source.file !== 'unknown' && violation.source?.line) return violation;

  const result = traceElement({
    outerHTML: violation.element?.outerHTML || '',
    selector: violation.element?.selector,
    mode: 'preview',
    attestation: { ok: true },
    root: localRoot,
    searchRoots,
    pageHtml,
    pageFile: violation.source?.page || null,
    ruleId: violation.rule || violation.ruleId,
  });
  if (result.confidence === 'untraceable') return violation;

  const { source, sourceCandidates } = traceToSourceFields(result, localRoot);
  violation.source = {
    ...(violation.source || {}),
    mode: violation.source?.mode || 'url',
    ...source,
    ...(source.file ? { partial: source.file } : {}),
  };
  if (sourceCandidates.length > 0) violation.sourceCandidates = sourceCandidates;
  return violation;
}

export function applyAttestedRemoteTracing(pageResults, localRoot, { searchRoots = DEFAULT_SOURCE_ROOTS, outDir } = {}) {
  if (!localRoot || !Array.isArray(pageResults)) return pageResults;
  return pageResults.map((pageResult) => {
    // The local build of this route is the fingerprint reference; without it the old hint search runs.
    const pageHtml = loadLocalPageHtml(localRoot, pageResult.url, outDir) || undefined;
    return {
      ...pageResult,
      violations: (pageResult.violations || []).map((violation) =>
        applyRemoteHintAttribution(structuredClone(violation), localRoot, { searchRoots, pageHtml }),
      ),
    };
  });
}

/**
 * Marks traces stale when the local file they point at no longer matches the hash recorded at build
 * time: the line number and preimage describe the built source, not what is on disk now. A stale
 * trace keeps file/line as a lead but is `low`, `traceConfidence: 'stale'`, reason
 * `source-changed-since-build`, with no preimage, so nothing can be applied against it.
 * @param {object[]} pageResults scan page results (violations carry `source`, `sourceCandidates`)
 * @param {string[]} changedSources project-relative files that changed since the build
 */
export function markStaleTraces(pageResults, changedSources = []) {
  const changed = new Set(changedSources);
  if (changed.size === 0 || !Array.isArray(pageResults)) return pageResults;
  return pageResults.map((pageResult) => ({
    ...pageResult,
    violations: (pageResult.violations || []).map((violation) => {
      const source = violation.source;
      const candidates = (violation.sourceCandidates || []).map((c) => (
        changed.has(c.file) ? { ...c, preimageSha256: null } : c));
      if (!source?.file || !changed.has(source.file)) return { ...violation, sourceCandidates: candidates };
      return {
        ...violation,
        sourceCandidates: candidates,
        source: {
          ...source,
          confidence: source.confidence === 'none' ? 'none' : 'low',
          preimageSha256: null,
          preimageRange: null,
          traceConfidence: 'stale',
          traceReason: 'source-changed-since-build',
        },
      };
    }),
  }));
}
