// Fix recipes for `ada-scan fix --export`: per rule, an intent sentence, a before/after pattern filled from the finding,
// cautions and a verification step. Pure text, no AI, no network. A recipe returns:
//   { intent, before, after, cautions[], verify, change? }
// where `change` ({ before, after }, whole source lines) is set only when the fix is certain from the source line.
// Everything is a suggestion for a person or an AI tool to adapt; none of it is applied by ada-scan.

// ---------------------------------------------------------------- helpers

/** Opening tag of an html string: { tag, attrs, open } (attrs is a name to value map, valueless attributes are ''). */
export function parseElement(html) {
  const m = /^\s*<([a-z][\w-]*)((?:"[^"]*"|'[^']*'|[^<>"'])*)>/i.exec(html || '');
  // A snippet cut inside its opening tag (a task keeps only the first characters of a long element) still names the tag and the attributes it has.
  const cut = m ? null : /^\s*<([a-z][\w-]*)([\s\S]*)$/i.exec(html || '');
  if (!m && !cut) return { tag: '', attrs: {}, open: '' };
  const attrs = {};
  for (const a of (m || cut)[2].matchAll(/([^\s=/"'<>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) attrs[a[1].toLowerCase()] = a[2] ?? a[3] ?? a[4] ?? '';
  return { tag: (m || cut)[1].toLowerCase(), attrs, open: m ? m[0].trim() : '' };
}

const textOf = (html) => String(html || '').replace(/<(script|style)[\s\S]*?<\/\1>/gi, '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

/** Adds `attr` to the single `<tag` on a source line, before its closing bracket; null when the tag is absent, repeated or not closed on the line. */
export function addAttrToLine(line, tag, attr) {
  const re = new RegExp(`<${tag}(?=[\\s>/])`, 'gi');
  const hits = [...line.matchAll(re)];
  if (hits.length !== 1) return null;
  let q = null;
  for (let j = hits[0].index; j < line.length; j += 1) {
    const ch = line[j];
    if (q) { if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'") q = ch;
    else if (line.startsWith('{{', j)) j = line.indexOf('}}', j) < 0 ? line.length : line.indexOf('}}', j) + 1;
    else if (line.startsWith('{%', j)) j = line.indexOf('%}', j) < 0 ? line.length : line.indexOf('%}', j) + 1;
    else if (ch === '>') {
      const at = line[j - 1] === '/' ? j - 1 : j;
      const head = line.slice(0, at);
      return `${head.replace(/\s+$/, '')} ${attr}${at < j && /\s$/.test(head) ? ' ' : ''}${line.slice(at)}`;
    }
  }
  return null;
}

const withAttr = (html, attr) => {
  const el = parseElement(html);
  if (!el.tag) return null;
  const out = addAttrToLine(el.open, el.tag, attr);
  return out;
};
const addClass = (open, k) => (/\sclass="/.test(open) ? open.replace(/(\sclass=")([^"]*)"/, `$1$2 ${k}"`) : open.replace(/^(<[a-z][\w-]*)/i, `$1 class="${k}"`));
const clip = (s, n = 220) => (s.length > n ? `${s.slice(0, n)} ...` : s);
const openOf = (c) => clip(parseElement(c.html).open || c.html || `<${c.tag || 'element'}>`);
const lineHas = (c, tag) => Boolean(c.line) && new RegExp(`<${tag}(?=[\\s>/])`, 'i').test(c.line);
const attrChange = (c, tag, attr, probe) => {
  if (!c.line || !lineHas(c, tag) || (probe && probe.test(c.line))) return null;
  const after = addAttrToLine(c.line, tag, attr);
  return after ? { before: c.line, after } : null;
};

// Colour maths (WCAG relative luminance, HSL for same-hue search).
const hexRgb = (h) => [1, 3, 5].map((i) => parseInt(h.replace('#', '').slice(i - 1, i + 1), 16));
const lum = (rgb) => { const [r, g, b] = rgb.map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
export const ratioOf = (a, b) => { const [x, y] = [lum(hexRgb(a)), lum(hexRgb(b))]; return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
function toHsl([r, g, b]) {
  const [x, y, z] = [r, g, b].map((v) => v / 255); const mx = Math.max(x, y, z); const mn = Math.min(x, y, z); const l = (mx + mn) / 2; const d = mx - mn;
  if (!d) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = mx === x ? ((y - z) / d + (y < z ? 6 : 0)) : mx === y ? (z - x) / d + 2 : (x - y) / d + 4;
  return [h * 60, s, l];
}
function fromHsl([h, s, l]) {
  const k = (n) => (n + h / 30) % 12; const a = s * Math.min(l, 1 - l);
  const f = (n) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))));
  return `#${[f(0), f(8), f(4)].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}
/** Nearest colour in the same hue and saturation (1% lightness steps, darker first on a light background) that reaches `threshold` on `bg`; null when none does. */
export function accessibleColor(fg, bg, threshold) {
  const [h, s, l] = toHsl(hexRgb(fg));
  const first = lum(hexRgb(bg)) > 0.18 ? -1 : 1;
  for (const dir of [first, -first]) {
    for (let i = 1; i <= 100; i += 1) {
      const l2 = l + (dir * i) / 100;
      if (l2 < 0 || l2 > 1) break;
      const c = fromHsl([h, s, l2]);
      if (ratioOf(c, bg) >= threshold) return c;
    }
  }
  return null;
}

const LABEL_GUESS = [
  [/hamburger|burger|nav-?toggle|menu-?toggle|menu-?btn|toggle-?menu|\bmenu\b/i, 'Menu'],
  [/close|dismiss|\bx\b|times/i, 'Close'], [/search|magnif/i, 'Search'], [/chevron-?(left)|arrow-?(left)|prev(ious)?/i, 'Previous'],
  [/chevron-?(right)|arrow-?(right)|next/i, 'Next'], [/play/i, 'Play'], [/pause/i, 'Pause'], [/share/i, 'Share'], [/filter/i, 'Filters'],
];
const SOCIAL = [[/linkedin/i, 'LinkedIn'], [/facebook/i, 'Facebook'], [/instagram/i, 'Instagram'], [/youtube/i, 'YouTube'], [/(twitter|\bx\.com)/i, 'X'], [/tiktok/i, 'TikTok']];
const guessLabel = (c, extra = []) => {
  const hay = `${c.attrs.class || ''} ${c.attrs.id || ''} ${c.html.match(/href="#i-([\w-]+)"/)?.[1] || ''} ${c.html.match(/<(?:use|i)[^>]*(?:href|class)="([^"]*)"/)?.[1] || ''}`;
  return [...LABEL_GUESS, ...extra].find(([re]) => re.test(hay))?.[1] || null;
};

const SIDECAR = (c) => (c.file ? `\`${c.file}.json\`` : 'the `.liquid.json` file next to the template');

// ---------------------------------------------------------------- recipes

const R = {};

R['button-name'] = (c) => {
  const label = guessLabel(c);
  const text = label || '<what the button does, e.g. "Menu">';
  const after = withAttr(c.html, `aria-label="${text}"`) || `<button aria-label="${text}">...</button>`;
  return {
    intent: `Give this ${c.tag || 'button'} a short accessible name that states its action${label ? ` ("${label}" fits its class or icon)` : ''}; it has only icons or empty spans, so a screen reader announces just "button".`,
    before: openOf(c), after,
    cautions: ['Keep decorative icons and bars `aria-hidden="true"` (or `role="presentation"`); do not move the name into `title` alone.', 'The name states the action (Menu, Close, Search), never "button" or "icon".', 'If the site is translated, put the label where the other UI strings live instead of hard-coding English.'],
    verify: `\`button-name\` must stop firing for \`${c.pattern}\`; the button's accessible name must be "${label || 'the label you chose'}".`,
    change: label ? attrChange(c, c.tag || 'button', `aria-label="${label}"`, /aria-label|aria-labelledby/) : null,
  };
};

R['link-name'] = (c) => {
  const social = SOCIAL.find(([re]) => re.test(c.attrs.href || ''))?.[1] || null;
  const label = social || guessLabel(c);
  const text = label || '<where the link goes>';
  return {
    intent: `Give this link text a screen reader can announce: visible text, or an \`aria-label\` that says where it goes${c.attrs.href ? ` (href \`${c.attrs.href}\`)` : ''}.`,
    before: openOf(c), after: withAttr(c.html, `aria-label="${text}"`) || `<a href="..." aria-label="${text}">...</a>`,
    cautions: ['An image inside the link needs a meaningful `alt` instead when the image is the only content.', 'Do not use "click here" or the raw URL as the name.', 'Keep the icon `aria-hidden="true"`.'],
    verify: `\`link-name\` must stop firing for \`${c.pattern}\`.`,
    change: label ? attrChange(c, c.tag || 'a', `aria-label="${label}"`, /aria-label|aria-labelledby/) : null,
  };
};

R['image-alt'] = (c) => {
  const src = c.attrs.src ? ` src="${clip(c.attrs.src, 80)}"` : '';
  return {
    intent: 'Decide whether the image carries information: describe it in `alt`, or mark it decorative with an empty `alt`.',
    before: `<img${src}>`, after: `<img${src} alt="<what the image shows, in one short sentence>">\n<!-- decorative image: alt="" -->`,
    cautions: ['Never use the file name or "image of" as alt text.', 'A decorative image still needs the attribute: `alt=""`, not a missing `alt`.', 'When the alt text comes from data, bind it in the `.liquid.json` sidecar rather than hard-coding it in a loop.'],
    verify: `\`image-alt\` must stop firing for \`${c.pattern}\`.`,
  };
};

R['meta-viewport'] = (c) => {
  const fix = (s) => s.replace(/\s*,?\s*user-scalable\s*=\s*(?:no|0)/gi, '').replace(/\s*,?\s*maximum-scale\s*=\s*([\d.]+)/gi, (m, v) => (Number(v) < 5 ? '' : m)).replace(/content=(["'])\s*,\s*/i, 'content=$1').replace(/,\s*(["'])/g, '$1');
  const bad = c.line && /<meta[^>]*name=["']viewport/i.test(c.line) ? c.line : (c.html && /viewport/i.test(c.html) ? c.html : null);
  const before = bad ? bad.trim() : '<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">';
  const after = fix(before);
  return {
    intent: 'Let users zoom: remove `user-scalable=no` and any `maximum-scale` below 5 from the viewport meta tag (WCAG 1.4.4).',
    before, after,
    cautions: ['Keep `width=device-width, initial-scale=1`.', 'Edit the layout or head partial once: every page shares it.', 'Do not re-add zoom locks in CSS (`touch-action: none`) or script.'],
    verify: '`meta-viewport` must stop firing; the rendered `<meta name="viewport">` has no `user-scalable=no` and no `maximum-scale` below 5.',
    change: bad && bad === c.line && after !== before ? { before: c.line, after: c.line.replace(before, after) } : null,
  };
};

const NAV_NAMES = [[/footer/i, 'Footer'], [/mobile|offcanvas|drawer/i, 'Mobile'], [/desktop|primary|main/i, 'Main'], [/breadcrumb/i, 'Breadcrumb'], [/social/i, 'Social media'], [/pagination|pager/i, 'Pagination'], [/language|locale/i, 'Language'], [/sub-?menu|secondary/i, 'Secondary']];
R['multiple-navs-missing-labels'] = (c) => {
  const label = NAV_NAMES.find(([re]) => re.test(`${c.attrs.id || ''} ${c.attrs.class || ''}`))?.[1] || null;
  const links = [...String(c.html).matchAll(/<a[^>]*>([^<]{2,40})</g)].map((m) => m[1].trim()).slice(0, 3);
  return {
    intent: 'Give every `<nav>` a distinct accessible name so screen reader users can tell the landmarks apart; name each by purpose.',
    before: openOf(c), after: withAttr(c.html, `aria-label="${label || '<purpose, e.g. Footer>'}"`) || `<nav aria-label="${label || '<purpose>'}">`,
    cautions: ['Names must be unique across the page and must not include the word "navigation" (the role is announced already).', 'Label the navs of the shared header/footer partial once; do not label per page.', `Purpose hint from the links${links.length ? `: ${links.map((l) => `"${l}"`).join(', ')}` : ''}${c.attrs.id ? `, id \`${c.attrs.id}\`` : ''}.`],
    verify: `\`multiple-navs-missing-labels\` must stop firing for \`${c.pattern}\`; every \`<nav>\` has a different aria-label.`,
    change: label ? attrChange(c, c.tag || 'nav', `aria-label="${label}"`, /aria-label|aria-labelledby/) : null,
  };
};

R['landmark-unique'] = (c) => ({
  intent: 'Make each landmark of one type distinguishable: give the repeated landmarks distinct `aria-label` text (or remove the extra landmark role).',
  before: openOf(c), after: withAttr(c.html, 'aria-label="<distinct purpose>"') || '<aside aria-label="<distinct purpose>">',
  cautions: ['Do not label two landmarks with the same text.', 'Prefer a native element (`<nav>`, `<aside>`) over `role=` on a div.'],
  verify: `\`landmark-unique\` must stop firing for \`${c.pattern}\`.`,
});

R.region = (c) => ({
  intent: 'Put all page content inside landmarks: shared header in `<header>`, page body in one `<main>`, footer in `<footer>` (or the matching `role`).',
  before: '<body>\n  {% render "layout/header" %}\n  {% block content %}{% endblock %}\n  {% render "layout/footer" %}\n</body>',
  after: '<body>\n  <header>{% render "layout/header" %}</header>\n  <main id="main-content" tabindex="-1">{% block content %}{% endblock %}</main>\n  <footer>{% render "layout/footer" %}</footer>\n</body>',
  cautions: ['Exactly one `<main>` per page; skip `<header>`/`<footer>` wrapping when the partial already contains them.', 'Content injected by vendor or platform widgets outside your markup cannot be fixed here.', 'Keep `{{data:..}}`, `{{component:..}}`, `{{snippet:..}}` tags and `data-pdk-*` attributes where they are.'],
  verify: `\`${c.rule}\` must stop firing on the listed pages; the DOM has one \`main\` and no content outside a landmark.`,
});
R['missing-main-landmark'] = R.region;

R['skip-link-missing'] = (c) => ({
  intent: 'Add a skip link as the first focusable element in `<body>`, hidden until focused, that jumps to the `<main>` landmark (WCAG 2.4.1). Edit the shared layout once.',
  before: '<body>\n  {% render "layout/header" %}\n  <main>...</main>',
  after: '<body>\n  <a href="#main-content" class="sr-only focus:not-sr-only focus:fixed focus:left-[1rem] focus:top-[1rem] focus:z-50 focus:bg-white focus:px-[1rem] focus:py-[0.5rem] focus:text-black focus:underline">Skip to main content</a>\n  {% render "layout/header" %}\n  <main id="main-content" tabindex="-1">...</main>',
  cautions: ['The link must come before the header and navigation in DOM order, and be visible with a focus ring when focused.', 'The `href` fragment must equal the `id` on `<main>`; keep exactly one `<main>` and one `id="main-content"`.', 'Arbitrary values (`left-[1rem]`) are used because the project may override the Tailwind spacing scale; swap for classes the project already uses.', 'Check the page does not define its own skip link or sr-only class under another name; reuse it instead.', ...(c.verifyExtra || [])],
  verify: '`skip-link-missing` must stop firing on the listed pages; pressing Tab once focuses a visible "Skip to main content" link and Enter moves focus into `<main>`.',
});

R['skip-link-target-missing'] = (c) => {
  const id = /#([\w-]+)/.exec(c.evidence.join(' '))?.[1] || 'main-content';
  return {
    intent: `Make the skip link land somewhere: the fragment \`#${id}\` must match an element id (normally \`<main>\`); fix the id or the href.`,
    before: `<a href="#${id}" ...>Skip to main content</a>\n<main>`, after: `<a href="#${id}" ...>Skip to main content</a>\n<main id="${id}" tabindex="-1">`,
    cautions: ['Change the `id` on the target or the `href`, not both; keep them identical.', 'The id must be unique on the page, and not rendered conditionally away.'],
    verify: '`skip-link-target-missing` must stop firing; `document.getElementById` finds the fragment target on every listed page.',
  };
};

R['page-has-heading-one'] = (c) => ({
  intent: 'Give each page exactly one `<h1>` that names the page: promote the existing hero or page title heading rather than adding a second visible title.',
  before: '<h2 class="<existing hero title classes>">{{data:...}}</h2>', after: '<h1 class="<existing hero title classes>">{{data:...}}</h1>',
  cautions: ['Keep the classes: heading level is semantics, size and colour stay in the Tailwind utilities.', 'One h1 per page; when the page template has several heroes, only the first is the h1.', `Edit the page template${c.pages?.length ? ` for ${c.pages.slice(0, 3).join(', ')}` : ''} (\`src/pages/<route>.liquid\`) or the partial that renders the hero; if the design has no visible title, use \`class="sr-only"\`.`],
  verify: `\`${c.rule}\` must stop firing on the listed pages; each has exactly one h1.`,
});
R['missing-h1'] = R['page-has-heading-one'];

R['heading-order'] = (c) => {
  const lvl = Number(/^h([1-6])$/.exec(c.tag)?.[1]) || null;
  return {
    intent: `Fix the heading level so it increases by one from the previous heading${lvl ? ` (this one is \`${c.tag}\`)` : ''}; keep the look with the existing Tailwind text classes.`,
    before: openOf(c), after: lvl && lvl > 2 ? `<h${lvl - 1}${c.attrs.class ? ` class="${c.attrs.class}"` : ''}>...</h${lvl - 1}>` : '<h{previous level + 1} class="<same classes>">...</h{previous level + 1}>',
    cautions: ['Change the tag, not the classes; check the heading that follows still nests correctly.', 'Do not pick a level for its size; use `text-*` utilities for size.', 'If the heading is only decoration, use a `<p>` or `<div>` with the same classes.'],
    verify: `\`${c.rule}\` must stop firing for \`${c.pattern}\`; the page outline has no skipped level.`,
  };
};
R['heading-level-skipped'] = R['heading-order'];

// Design-locked decisions: colours follow the design, so these are never auto-fixed. Add rule ids, patterns or token patterns here
// when another decision belongs to the design owner. A locked task gets a "For the design owner" section, no diff and no edit steps.
export const DESIGN_LOCKED = {
  rules: new Set(['color-contrast', 'color-contrast-enhanced', 'focus-indicator-low-contrast', 'non-text-contrast']),
  patterns: [/contrast/i],
  brandTokens: /brand|primary|secondary|accent/i,
};
export const isDesignLocked = (rule, c = {}) => {
  const k = String(rule || '').toLowerCase();
  return DESIGN_LOCKED.rules.has(k) || DESIGN_LOCKED.patterns.some((re) => re.test(k)) || Boolean(c.tokens?.fg && DESIGN_LOCKED.brandTokens.test(c.tokens.fg.token));
};
export const NEVER_CHANGE_COLOURS = 'Never change colour values, tokens, utility colour classes, opacity or background images to fix a contrast finding. If a task needs a colour change, stop and leave it for the design owner.';

R['color-contrast'] = (c) => {
  const text = c.evidence.join(' ');
  const fg = /foreground color:\s*(#[0-9a-f]{6})/i.exec(text)?.[1]?.toLowerCase();
  const bg = /background color:\s*(#[0-9a-f]{6})/i.exec(text)?.[1]?.toLowerCase();
  const got = /(?<!expected\s)contrast(?: ratio)? of\s*([\d.]+):1/i.exec(text)?.[1] || (c.measured?.ratio != null ? String(c.measured.ratio) : null);
  const need = Number(/expected contrast ratio of\s*([\d.]+):1/i.exec(text)?.[1]) || Number(c.measured?.threshold) || 4.5;
  const best = fg && bg ? accessibleColor(fg, bg, need) : null;
  const tok = c.tokens?.fg;
  const bgTok = c.tokens?.bg?.[0];
  const cls = (c.attrs.class || '').split(/\s+/).find((x) => /^text-/.test(x));
  const producedBy = [tok ? `foreground token \`--color-${tok.token}\` (${tok.hex}) declared at ${tok.file}:${tok.line}` : (cls ? `utility class \`${cls}\`` : null), bgTok ? `background token \`--color-${bgTok.token}\` (${bgTok.hex}) declared at ${bgTok.file}:${bgTok.line}` : null].filter(Boolean);
  return {
    designLocked: true,
    intent: 'Design decision: do not edit colours. Hand this task to the design owner (see "For the design owner").',
    cautions: [NEVER_CHANGE_COLOURS],
    verify: `After the design owner decides, rescan: \`${c.rule}\` no longer reported for \`${c.pattern}\`. ada-scan makes no edit for this task.`,
    designOwner: {
      currentRatio: got ? `${got}:1` : null, requiredRatio: `${need}:1`, foreground: fg || null, background: bg || null,
      producedBy: producedBy.length ? producedBy : ['not resolved to a token or class; see the Evidence lines'],
      nearestPassing: best && bg ? `${best} (${ratioOf(best, bg).toFixed(2)}:1 on ${bg}); not applied, design decision` : null,
      questions: ['Could this text be set as large text in the design (24px or more, or 18.66px or more and bold), which needs only 3:1?', 'Could a scrim or solid backing be added behind text that sits over an image?', 'Is this text purely decorative or inactive, so the requirement does not apply?'],
    },
  };
};
R['color-contrast-enhanced'] = R['color-contrast'];
R['focus-indicator-low-contrast'] = R['color-contrast'];
R['non-text-contrast'] = R['focus-indicator-low-contrast'];

R['target-size'] = (c) => {
  const m = /(\d+(?:\.\d+)?)\s*x\s*(\d+(?:\.\d+)?)/.exec(c.evidence.join(' '));
  const [w, h] = m ? [Number(m[1]), Number(m[2])] : [null, null];
  const vp = /\bat viewport (\d+x\d+)/i.exec(c.evidence.join(' '))?.[1];
  const size = `${m ? `${w} x ${h} CSS px` : 'under 24 x 24 CSS px'}${vp ? ` at viewport ${vp}` : ''}`;
  return {
    intent: `Make the target at least 24 x 24 CSS px (now ${size}${vp ? `; measure it at ${vp}, other widths may pass` : ''}) or keep a 24px circle around it clear of other targets (WCAG 2.5.8). Grow the hit area with padding or min size on the element itself.`,
    before: openOf(c), after: addClass(openOf(c), 'inline-flex min-h-[24px] min-w-[24px] items-center justify-center'),
    cautions: ['Use arbitrary px values (`min-h-[24px]`): numeric utilities such as `p-6` depend on the project `--spacing` and may be far bigger.', 'Prefer growing the clickable area (padding) over scaling the icon; do not change the visual layout of neighbours.', 'Alternative: add spacing (`gap-[0.5rem]`) so each target keeps 24px clear around it.', 'Check mobile widths: the finding may fail only on some viewports.'],
    verify: `\`${c.rule}\` must stop firing for \`${c.pattern}\` at every scanned viewport (target at least 24 x 24 or spaced).`,
  };
};
R.targetsize = R['target-size'];

R['disclosure-missing-aria-expanded'] = (c) => {
  const script = (c.evidence.join(' ').match(/src\/scripts\/[\w./-]+\.(?:js|mjs|ts)/) || [])[0] || c.script || null;
  const ctl = c.attrs['aria-controls'];
  const attr = `aria-expanded="false"${ctl ? '' : ' aria-controls="<panel id>"'}`;
  return {
    intent: `Expose the open state: add \`aria-expanded="false"\`${ctl ? '' : ' and `aria-controls` naming the panel it opens'} to the control and make the script that toggles the panel flip \`aria-expanded\` between "true" and "false".`,
    before: openOf(c), after: withAttr(c.html, attr) || `<button type="button" ${attr}>`,
    cautions: [`Update the toggle handler, not only the markup: ${script ? `edit \`${script}\`` : 'find the script under `src/scripts/` that handles this control (search its class name)'} so it calls \`setAttribute('aria-expanded', open)\`.`, 'The initial value must match the initial panel state; keep `aria-controls` pointing at the real panel id, which must be unique (use `forloop.index` in loops).', 'Do not add `aria-expanded` to links that navigate.', 'Do not duplicate the toggle logic: extend the existing handler.'],
    verify: `\`${c.rule}\` must stop firing for \`${c.pattern}\`; activating the control flips \`aria-expanded\` and the panel state together.`,
    change: attrChange(c, c.tag || 'button', attr, /aria-expanded/),
  };
};
R['menu-trigger-missing-aria-expanded'] = R['disclosure-missing-aria-expanded'];

R['duplicate-id-referenced'] = (c) => {
  const id = c.attrs.id || c.evidence.join(' ').match(/id[= "']+([\w-]+)/)?.[1] || '<id>';
  return {
    intent: `Make the id unique: where the element is rendered in a loop, suffix it with \`forloop.index\` and use the same expression in every reference (\`aria-controls\`, \`aria-labelledby\`, \`for\`, \`href="#.."\`).`,
    before: `<div id="${id}">...</div>\n<button aria-controls="${id}">`, after: `<div id="${id}-{{ forloop.index }}">...</div>\n<button aria-controls="${id}-{{ forloop.index }}">`,
    cautions: ['Never hard-code an id inside a loop; use `forloop.index` (`forloop.parentloop.index` for the outer loop of nested loops). Avoid assign/capture.', 'Update every reference to the id in the markup and in scripts that read it.', 'A sprite `<use href="#id">` or a partial rendered twice also repeats ids: define it once.'],
    verify: `\`${c.rule}\` must stop firing for \`${c.pattern}\`; ids are unique on every listed page.`,
    change: c.inLoop && c.line && new RegExp(`\\bid="${id}"`).test(c.line) ? { before: c.line, after: c.line.replace(`id="${id}"`, `id="${id}-{{ forloop.index }}"`) } : null,
  };
};
R['duplicate-id'] = R['duplicate-id-aria'] = R['duplicate-id-referenced'];

R['aria-hidden-focus'] = (c) => ({
  intent: 'Stop focus landing in hidden content: either remove `aria-hidden="true"` from the container, or make everything focusable inside it unreachable (`inert`, `hidden`, or `tabindex="-1"`).',
  before: openOf(c), after: `${openOf(c).replace(/ aria-hidden="true"/, '')}  <!-- visible content: no aria-hidden -->\n${withAttr(openOf(c), 'inert') || '<div aria-hidden="true" inert>'}  <!-- closed or off-screen content -->`,
  cautions: ['A closed menu or off-canvas panel should be `inert` (or `hidden`) while closed; toggle it in the existing script when it opens.', 'Never hide a container that holds the only way to a feature.', 'Do not set `tabindex="-1"` on controls that stay visible.'],
  verify: `\`aria-hidden-focus\` must stop firing for \`${c.pattern}\`; Tab never lands inside a hidden region.`,
});

R['aria-allowed-role'] = (c) => {
  const role = c.attrs.role;
  const script = (c.evidence.join(' ').match(/src\/scripts\/[\w./-]+\.(?:js|mjs|ts)/) || [])[0];
  return {
    intent: `Remove the \`role\`${role ? ` "${role}"` : ''} this ${c.tag || 'element'} may not carry, or use the element that has that role natively.${script ? ` The role is set by \`${script}\`.` : ''}`,
    before: openOf(c), after: role ? openOf(c).replace(/\s+role="[^"]*"/, '') : `<${c.tag || 'div'}>`,
    cautions: ['Prefer the native element (`<button>`, `<nav>`, `<ul>`) over adding a role.', 'If a script writes the role (setAttribute), edit the script as well as the markup.', 'Keep the attributes the role required (aria-controls, aria-selected) only if the new role supports them.'],
    verify: `\`aria-allowed-role\` must stop firing for \`${c.pattern}\`.`,
    change: role && c.line && c.line.includes(`role="${role}"`) ? { before: c.line, after: c.line.replace(new RegExp(`\\s+role="${role}"`), '') } : null,
  };
};

R['label-content-name-mismatch'] = (c) => {
  const vis = c.visibleText || c.text || '<visible text>';
  const name = c.accessibleName || c.attrs['aria-label'] || '<current name>';
  const fixed = `${vis}: ${name}`;
  return {
    intent: `Make the accessible name start with the visible text "${vis}" (WCAG 2.5.3): either drop the \`aria-label\` so the text is the name, or begin the label with it.`,
    before: `aria-label="${name}"  <!-- visible text: ${vis} -->`, after: `aria-label="${fixed}"\n<!-- or remove aria-label and let the visible text be the name -->`,
    cautions: ['The visible text must appear in the name in the same order, spelling and language.', 'Context after the visible text is fine; context before it is not.', 'When the text comes from data, change the label in the `.liquid.json` sidecar or build it from the same field.'],
    verify: `\`${c.rule}\` must stop firing for \`${c.pattern}\`; the name starts with "${vis}".`,
    change: c.accessibleName && c.line && c.line.includes(`aria-label="${name}"`) && !name.toLowerCase().includes(vis.toLowerCase()) ? { before: c.line, after: c.line.replace(`aria-label="${name}"`, `aria-label="${fixed}"`) } : null,
  };
};
R.visibletextpartofaccessiblename = R['label-content-name-mismatch'];

R['link-new-tab-notice-without-target'] = (c) => ({
  intent: 'Make the link and its name agree: if it should open a new tab, add `target="_blank" rel="noopener noreferrer"` and keep the notice; if not, remove the "opens in a new tab" wording.',
  before: openOf(c), after: `${withAttr(c.html, 'target="_blank" rel="noopener noreferrer"') || '<a target="_blank" rel="noopener noreferrer">'}\n  ...link text<span class="sr-only"> (opens in a new tab)</span></a>`,
  cautions: ['Every `target="_blank"` link needs a notice for screen readers (visible icon plus sr-only text, or the name).', 'A script may open the window already; check `window.open` in `src/scripts/` before adding `target`.', 'Do not announce a new tab on links that stay in the tab.'],
  verify: `\`${c.rule}\` must stop firing for \`${c.pattern}\`.`,
});

R['focus-visible'] = (c) => ({
  intent: 'Restore a visible focus indicator: keep the default outline, or replace it with a `focus-visible:` ring of at least 3:1 contrast against its surroundings.',
  before: openOf(c), after: addClass(openOf(c).replace(/ (?:focus:)?outline-none/g, ''), 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current'),
  cautions: ['Never ship `outline-none` or `outline: 0` without a replacement style on `:focus-visible`.', 'Check ring contrast on every background; use `focus-visible:` (keyboard only), not `focus:`.', 'Prefer a shared utility or a rule in the existing stylesheet over per-element classes when many controls fail.', 'Make sure `overflow-hidden` ancestors do not clip the ring (use `outline-offset-0` or `ring-inset`).'],
  verify: `\`${c.rule}\` must stop firing for \`${c.pattern}\`; Tab to the control and a visible ring appears.`,
});
R['focus-indicator-removed'] = R['focus-not-visible'] = R['focus-visible'];

R['focus-invisible-stop'] = (c) => ({
  intent: 'Fix a tab stop that cannot be seen when focused: show it on focus (visually hidden until focused) or take it out of the tab order while hidden.',
  before: openOf(c), after: `${addClass(openOf(c), 'sr-only focus:not-sr-only')}  <!-- reveal on focus -->\n${withAttr(openOf(c), 'tabindex="-1" aria-hidden="true"') || '<div tabindex="-1" aria-hidden="true">'}  <!-- or: not reachable while hidden -->`,
  cautions: ['Do not use `opacity-0`, `invisible` tricks that leave the element focusable; `display:none`, `hidden` or `inert` remove it from the tab order.', 'A closed menu or carousel slide should be `inert` while closed; toggle it in the existing script.', 'A custom checkbox keeps focus on a hidden input: style the visible box with `peer-focus-visible:`.'],
  verify: `\`focus-invisible-stop\` must stop firing for \`${c.pattern}\`; every Tab stop is visible when focused.`,
});

R['tabpanel-labelledby'] = (c) => {
  const id = c.attrs.id || 'panel';
  return {
    intent: 'Label the tab panel with its tab: add `aria-labelledby` pointing at the `id` of the tab that controls it, and give that tab the matching `aria-controls`.',
    before: openOf(c), after: withAttr(c.html, `aria-labelledby="tab-${id}"`) || `<div role="tabpanel" id="${id}" aria-labelledby="tab-${id}">`,
    cautions: ['Both ids must exist exactly once; in loops build them with `forloop.index`.', 'Keep `role="tab"`, `aria-controls` and `aria-selected` on the tab in sync with the script.'],
    verify: `\`${c.rule}\` must stop firing for \`${c.pattern}\`.`,
  };
};
R.tabpanellabelledby = R['tabpanel-labelledby'];

R.label = (c) => ({
  intent: 'Give the field a visible label bound to it with matching `for` and `id`.',
  before: openOf(c), after: `<label for="${c.attrs.id || 'email'}">Email</label>\n${openOf(c)}`,
  cautions: ['Placeholder text is not a label.', 'In a loop, build the id with `forloop.index` and use it in `for` too.'],
  verify: `\`label\` must stop firing for \`${c.pattern}\`.`,
});
R['document-title'] = () => ({ intent: 'Give every page a unique, descriptive `<title>`.', before: '<title></title>', after: '<title>Open jobs | Company</title>', cautions: ['Set it once in the layout from the page data, not per page markup.'], verify: '`document-title` must stop firing on the listed pages.' });
R['html-has-lang'] = () => ({ intent: 'Declare the page language on `<html>` in the layout.', before: '<html>', after: '<html lang="en">', cautions: ['Use the site language code; a translated site needs the code per locale.'], verify: '`html-has-lang` must stop firing on the listed pages.' });

const ALIAS = { 'link-new-tab-without-notice': 'link-new-tab-notice-without-target' };
export const recipeFor = (rule) => { const k = String(rule || '').toLowerCase(); return R[ALIAS[k] || k] || R[k.replace(/_/g, '-')] || null; };
export const RECIPE_RULES = Object.keys(R);

/** Page-wide, source-less rules: likely locations are found by role, not by line. */
export const PAGE_WIDE_RULES = new Set(['skip-link-missing', 'skip-link-target-missing', 'page-has-heading-one', 'missing-h1', 'region', 'missing-main-landmark', 'document-title', 'html-has-lang']);

const LIQUID_RULES = [
  'Liquid and Paradox: edit a shared partial or layout once; every page that renders it changes (do not copy the fix per page).',
  'When the element is rendered in a `{% for %}` loop or its text comes from data, put per-item values in the `.liquid.json` sidecar next to the template; never hard-code an id or label inside a loop (use `forloop.index`).',
  'Leave `{{data:..}}`, `{{component:..}}`, `{{snippet:..}}`, `{{attribute:..}}` tags and `data-pdk-*` attributes untouched; do not edit platform-owned widgets (`data-react-component`).',
  'Prefer Tailwind utility classes already used in the project over new CSS; do not edit generated `+.css` files or `dist/`.',
];

/**
 * Filled recipe for a task context. Without a recipe the axe help text is kept, marked, and the problem sentence is never repeated as the fix.
 * Returns { recipe: bool, intent, before, after, cautions, verify, change, noRecipe }.
 */
export function fillRecipe(c) {
  const make = isDesignLocked(c.rule, c) ? R['color-contrast'] : recipeFor(c.rule);
  const loop = c.inLoop ? [`The element sits inside \`{% for ${c.loopVar || 'item'} in ... %}\`: values that differ per item belong in ${SIDECAR(c)}, ids need \`forloop.index\`.`] : [];
  if (!make) {
    const help = c.hint && c.hint !== c.problem ? c.hint : '';
    return {
      recipe: false, noRecipe: true,
      intent: `No recipe: use judgement.${help ? ` Rule help: ${help}` : ' Read the Evidence lines, apply the smallest markup change that makes them untrue, and check the WCAG criterion named above.'}`,
      before: null, after: null, cautions: [...loop, ...LIQUID_RULES], verify: `Rule \`${c.rule}\` must no longer be reported for \`${c.pattern}\`.`, change: null,
    };
  }
  const r = make(c);
  if (r.designLocked) return { recipe: false, noRecipe: false, change: null, before: null, after: null, ...r, cautions: [NEVER_CHANGE_COLOURS, ...LIQUID_RULES.slice(2, 3)] };
  return { recipe: true, noRecipe: false, change: null, ...r, cautions: [...(r.cautions || []), ...loop, ...LIQUID_RULES] };
}

/** Unified-diff style text for a whole-line change at `line` of `file`. */
export function renderDiff(file, line, change) {
  const old = change.before.split('\n'); const neu = change.after.split('\n');
  return `--- a/${file}\n+++ b/${file}\n@@ -${line},${old.length} +${line},${neu.length} @@\n${old.map((l) => `-${l}`).join('\n')}\n${neu.map((l) => `+${l}`).join('\n')}`;
}
export { textOf };
