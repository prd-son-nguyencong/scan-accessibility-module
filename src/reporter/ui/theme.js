// Pieces shared by the three generated reports (scan-visual, qa-report, roi pages): the stylesheet, the pre-paint theme script, the toggle button.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { cspMeta, escapeHtml as esc } from '../../utils/escape-html.js';

export const THEME_CSS = readFileSync(new URL('./theme.css', import.meta.url), 'utf8');
export const THEME_KEY = 'ada-report-theme';
/** Runs before the first paint: the saved choice, else the system preference, else light. Storage may be blocked, so every access is guarded. */
export const THEME_INIT = `(function(){var t;try{t=localStorage.getItem('${THEME_KEY}')}catch(e){}if(t!=='light'&&t!=='dark'){try{t=matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'}catch(e){t='light'}}document.documentElement.setAttribute('data-theme',t)})();`;
/** Toggle handler for the pages that have no other script. */
export const THEME_TOGGLE_JS = `(function(){var b=document.getElementById('theme-toggle');if(!b)return;document.documentElement.classList.add('js');function cur(){return document.documentElement.getAttribute('data-theme')==='dark'?'dark':'light'}function label(){var t=cur();b.setAttribute('aria-label','Theme: '+t+', switch to '+(t==='dark'?'light':'dark'))}label();b.addEventListener('click',function(){var n=cur()==='dark'?'light':'dark';document.documentElement.setAttribute('data-theme',n);try{localStorage.setItem('${THEME_KEY}',n)}catch(e){}label()})})();`;
export const sha = (text) => createHash('sha256').update(text).digest('base64');

const svg = (cls, d) => `<svg class="${cls} ico" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${d}</svg>`;
export const THEME_TOGGLE_HTML = `<button type="button" class="theme-toggle" id="theme-toggle" aria-label="Theme: light, switch to dark">${svg('i-moon', '<path d="M21 13A9 9 0 1 1 11 3a7 7 0 0 0 10 10z"/>')}${svg('i-sun', '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>')}<span class="t-d">Theme: Dark</span><span class="t-l">Theme: Light</span></button>`;

/** <head> content and the two script tags of a document page that has no explorer (qa-report, roi pages). */
export function docParts({ title, css = '' }) {
  return {
    head: `<meta charset="UTF-8">\n${cspMeta({ scriptSha256: [sha(THEME_INIT), sha(THEME_TOGGLE_JS)] })}\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<meta name="color-scheme" content="light dark">\n<title>${title}</title>\n<style>${THEME_CSS}${css}</style>`,
    bodyStart: `<script>${THEME_INIT}</script>`,
    bodyEnd: `<script>${THEME_TOGGLE_JS}</script>`,
  };
}

/** Code-like strings get a line-break opportunity after path and URL punctuation. */
export function wbr(s) {
  const t = String(s ?? ''); const sep = /[/._\-:?&=#%>+~,[\]()*"]/;
  let out = '';
  for (let i = 0; i < t.length; i++) {
    out += esc(t[i]);
    if ((sep.test(t[i]) && !sep.test(t[i + 1] || '')) || (/[a-z0-9]/.test(t[i]) && /[A-Z]/.test(t[i + 1] || '') && /[a-z]/.test(t[i + 2] || ''))) out += '<wbr>';
  }
  return out;
}

/** Prose with a long token in it (a URL quoted in a scanner message): only that token gets break opportunities, words are never split. */
export const proseWbr = (text) => String(text ?? '').split(/(\s+)/).map((t) => (t.length >= 28 ? wbr(t) : esc(t))).join('');
