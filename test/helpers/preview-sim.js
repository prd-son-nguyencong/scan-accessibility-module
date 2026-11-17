import { indexHtml } from '../../src/tracer/fingerprint-map.js';
import { parseRenderedTag } from '../../src/tracer/liquid-tag-index.js';
import { traceElement } from '../../src/tracer/trace-element.js';

/**
 * Simulates what Paradox Site Studio does to a local instrumented page (markers dropped, markup
 * rewritten) and measures how traceElement copes. Elements inserted by the simulation carry
 * `data-sim-new` (stripped from probes) so they have no local twin.
 */
export const PROFILES = {
  light: { collapse: true },
  attrs: { collapse: true, reorder: true, noise: 3 },
  bound: { collapse: true, reorder: true, noise: 3, bind: 4 },
  heavy: { collapse: true, reorder: true, noise: 3, bind: 4, wrap: true, inject: true, head: true },
  // Cadences and whitespace the thresholds were not tuned on.
  holdout: { reorder: true, noise: 2, bind: 3, wrap: true, inject: true, head: true },
};

const TOKEN = /<!--[\s\S]*?-->|<\/?[A-Za-z](?:"[^"]*"|'[^']*'|[^'">])*>|[^<]+|</g;

export function simulatePreview(localHtml, o = {}) {
  let tagN = 0;
  let textN = 0;
  const out = (localHtml.match(TOKEN) || []).map((tok) => {
    if (tok.startsWith('<!--')) {
      const open = /^<!--\s*snippets\/\S+?\.html\s*-->$/.test(tok);
      const close = /^<!--\s*\/snippets\/\S+?\.html\s*-->$/.test(tok);
      if (o.wrap && open) return '<div class="ps-snippet-wrap" data-sim-new>';
      if (o.wrap && close) return '</div>';
      return '';
    }
    if (tok.startsWith('</')) return tok;
    if (tok.startsWith('<') && tok.length > 1) {
      const rendered = parseRenderedTag(tok);
      if (!rendered) return tok;
      let { attrs } = rendered;
      tagN += 1;
      if (o.noise && attrs.class && tagN % o.noise === 0) attrs = { ...attrs, class: `${attrs.class} css-1a9f3c` };
      let entries = Object.entries(attrs);
      if (o.reorder) entries = entries.reverse();
      if (o.head && rendered.tagName === 'meta' && attrs.name === 'viewport') entries = entries.map(([k, v]) => [k, k === 'content' ? 'width=device-width, initial-scale=1' : v]);
      const body = entries.map(([k, v]) => ` ${k}="${v}"`).join('');
      return `<${rendered.tagName}${body}${tok.endsWith('/>') ? ' /' : ''}>`;
    }
    if (/^\s*$/.test(tok)) return o.collapse ? '' : tok;
    textN += 1;
    if (o.bind && textN % o.bind === 0) return `Value ${textN}`;
    return o.collapse ? tok.replace(/\s+/g, ' ') : tok;
  });
  let html = out.join('');
  if (o.head) html = html.replace(/<title>[\s\S]*?<\/title>/, '<title>Careers</title>').replace('</head>', '<meta name="robots" content="noindex" data-sim-new></head>');
  if (o.inject) {
    html = html.replace('<main', '<div data-react-component="JobSearch" data-sim-new><a href="/jobs" class="job-link" data-sim-new>Search jobs</a></div><main')
      .replace('</body>', '<script src="/platform.js" data-sim-new></script></body>');
  }
  return html;
}

function selectorOf(el) {
  const seg = (e) => `${e.tag}${e.attrs.id ? `#${e.attrs.id}` : ''}${e.classes[0] ? `.${e.classes[0]}` : ''}:nth-child(${e.childIndex})`;
  const path = [];
  for (let e = el; e && path.length < 3; e = e.parent) path.unshift(seg(e));
  return path.join(' > ');
}

/** Probes for every body/head leaf of interest: { local, outerHTML, selector, isNew }. */
export function probesFor(localHtml, previewHtml) {
  const local = indexHtml(localHtml);
  const preview = indexHtml(previewHtml);
  const skip = new Set(['html', 'head', 'body']);
  const localList = local.filter((e) => !skip.has(e.tag));
  let next = 0;
  return preview.filter((e) => !skip.has(e.tag)).map((e) => {
    const outerHTML = previewHtml.slice(e.start, e.end).replace(/ data-sim-new(="")?/g, '');
    const isNew = e.attrs['data-sim-new'] !== undefined;
    const twin = isNew ? null : localList[next++];
    return { local: twin ? localHtml.slice(twin.start, twin.end) : null, outerHTML, selector: selectorOf(e), isNew };
  });
}

const key = (c) => `${c.file}:${c.line}`;

/** Classify one preview probe against the local reference trace. */
export function classify(ref, got) {
  const refOne = ref && (ref.confidence === 'high' || ref.confidence === 'medium') ? key(ref.candidates[0]) : null;
  const gotKeys = got.candidates.map(key);
  if (refOne) {
    if (got.confidence === 'untraceable') return 'miss-untraceable';
    if (got.confidence === 'ambiguous') return gotKeys.includes(refOne) ? 'ambiguous-with-truth' : 'ambiguous-without-truth';
    return `${gotKeys[0] === refOne ? 'correct' : 'WRONG'}-${got.confidence}`;
  }
  if (got.confidence === 'untraceable' || got.confidence === 'ambiguous') return 'safe-no-path';
  return got.confidence === 'high' ? 'WRONG-high-unverifiable' : `unverified-${got.confidence}`;
}

/** Run one profile over one local page. Returns { rows, counts }. */
export function measure({ root, pageFile, localHtml, profile, useReference = true, trace = traceElement }) {
  const previewHtml = simulatePreview(localHtml, profile);
  const rows = probesFor(localHtml, previewHtml).map((p) => {
    let ref = p.local ? traceElement({ root, pageFile, pageHtml: localHtml, mode: 'local', outerHTML: p.local }) : null;
    // A local line fixed only by the element's text is not fixable from a preview whose text was rewritten (bound): the preview
    // cannot see what told the sources apart, so the right preview answer is still "several candidates", not that line.
    if (ref?.candidates[0]?.evidence.includes('text-match') && parseRenderedTag(p.outerHTML)?.text !== parseRenderedTag(p.local)?.text) {
      ref = { ...ref, confidence: 'ambiguous' };
    }
    const got = trace({
      root, pageFile, mode: 'preview', attestation: { ok: true }, outerHTML: p.outerHTML, selector: p.selector,
      ...(useReference ? { pageHtml: localHtml } : {}),
    });
    // Hand-checked truth: a page-level hit in another page's source is the E4.1 reference guessing (this page has no source), so no path is right.
    const noSource = ref?.candidates[0]?.file.startsWith('src/pages/') && ref.candidates[0].file !== pageFile;
    return { ...p, ref, got, verdict: p.isNew || noSource ? (got.candidates.length > 0 && got.confidence !== 'ambiguous' ? `WRONG-${got.confidence}-new` : 'safe-new') : classify(ref, got) };
  });
  const counts = {};
  for (const r of rows) counts[r.verdict] = (counts[r.verdict] || 0) + 1;
  return { rows, counts };
}

/** Headline numbers: of the elements with a single reference source, how many were traced right. */
export function summarize(rows) {
  const n = { traceable: 0, correct: 0, ambiguous: 0, untraceable: 0, wrongHigh: 0, wrongOther: 0, newTraced: 0 };
  for (const { verdict } of rows) {
    if (verdict.startsWith('WRONG-high')) n.wrongHigh += 1;
    else if (verdict.startsWith('WRONG') && verdict.endsWith('-new')) n.newTraced += 1;
    else if (verdict.startsWith('WRONG')) n.wrongOther += 1;
    if (/^(correct|WRONG-(?!.*(new|unverifiable))|ambiguous|miss)/.test(verdict)) n.traceable += 1;
    if (verdict.startsWith('correct')) n.correct += 1;
    if (verdict.startsWith('ambiguous')) n.ambiguous += 1;
    if (verdict.startsWith('miss')) n.untraceable += 1;
  }
  return n;
}
