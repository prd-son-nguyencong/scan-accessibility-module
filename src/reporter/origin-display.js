// One place for how a finding's `origin` is worded in the reports (scan-visual.html, qa-report.html, console), so the labels never drift.
import { escapeHtml as esc } from '../utils/escape-html.js';
import { suggestedAction } from '../tracer/ownership.js';
import { proseWbr } from './ui/theme.js';

/** Filter keys, in display order. */
export const OWNER_KEYS = ['site', 'platform', 'third-party', 'injected', 'iframe'];

/** { key, text } for an origin; a finding without one (older report) is the site's. */
export function ownerBadge(origin) {
  if (!origin) return { key: 'site', text: 'Site' };
  if (origin.kind === 'iframe') return { key: 'iframe', text: 'iframe' };
  if (origin.owner === 'third-party') return { key: 'third-party', text: `Third-party: ${origin.vendor || origin.label}` };
  if (origin.owner === 'platform') return { key: 'platform', text: origin.kind === 'react-widget' ? 'Platform React widget' : 'Platform component' };
  if (origin.kind === 'injected-runtime') return { key: 'injected', text: 'Injected at runtime' };
  if (origin.kind === 'unknown-probe-failed') return { key: 'injected', text: 'Origin unknown (probe failed)' };
  return { key: 'site', text: 'Site' };
}

/** Badge span plus an expandable label and evidence list (safe HTML). */
export function ownerHtml(origin) {
  const b = ownerBadge(origin);
  const detail = origin
    ? `<details class="origin-detail"><summary>Origin</summary><p>${esc(origin.label)}</p>${origin.evidence?.length ? `<ul>${origin.evidence.map((e) => `<li>${proseWbr(e)}</li>`).join('')}</ul>` : ''}${origin.owner !== 'site' ? `<p>${esc(suggestedAction(origin))}</p>` : ''}</details>`
    : '';
  return `<span class="owner-badge owner-${esc(b.key)}">Owner: ${esc(b.text)}</span>${detail}`;
}

/**
 * Findings outside the site's own code, grouped by owner + vendor/label (one row per vendor or component) with the pages and rules they appear on.
 * items: [{ origin, rule, page, count, impact }].
 */
export function groupNotYourCode(items) {
  const groups = new Map();
  for (const { origin, rule, page, count = 1, impact } of items) {
    if (!origin || origin.owner === 'site' || impact === 'info') continue;
    // A vendor is named by its id, a platform widget by its label (which carries the component name).
    const name = origin.owner === 'platform' ? origin.label : ownerBadge(origin).text;
    const key = `${origin.owner}|${name}`;
    const g = groups.get(key) || { name, origin, occurrences: 0, pages: new Set(), rules: new Set() };
    g.occurrences += count;
    g.pages.add(page);
    g.rules.add(rule);
    groups.set(key, g);
  }
  return [...groups.values()]
    .map((g) => ({ name: g.name, owner: g.origin.owner, label: g.origin.label, occurrences: g.occurrences, pages: [...g.pages].sort(), rules: [...g.rules].sort(), action: suggestedAction(g.origin) }))
    .sort((a, b) => b.occurrences - a.occurrences || a.name.localeCompare(b.name));
}

/** "Not your code (N)" section; '' when there is nothing. N is occurrences. */
export function notYourCodeHtml(groups, note = '') {
  if (!groups.length) return '';
  const total = groups.reduce((n, g) => n + g.occurrences, 0);
  const rows = groups.map((g) => `<tr><th scope="row">${esc(g.name)}<br><small>${esc(g.label)}</small></th><td>${g.occurrences}</td><td>${g.pages.map((p) => `<code>${esc(p)}</code>`).join(', ')}</td><td>${g.rules.map((r) => `<code>${esc(r)}</code>`).join(', ')}</td><td>${esc(g.action)}</td></tr>`);
  return `<section class="platform-owned" aria-labelledby="not-your-code">
  <h2 id="not-your-code">Not your code (${total})</h2>
  <p>Third-party scripts and Paradox platform widgets render this markup; it cannot be fixed in the site source. ${esc(note)}</p>
  <table><caption>Findings in code the site does not own, by vendor or component</caption><thead><tr><th scope="col">Owner</th><th scope="col">Occurrences</th><th scope="col">Pages</th><th scope="col">Rules</th><th scope="col">Suggested action</th></tr></thead><tbody>${rows.join('')}</tbody></table>
</section>`;
}
