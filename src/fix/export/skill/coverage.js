// Static instruction coverage: every rule family the export can emit (recipes.js) must map to a pattern file that exists
// and is listed in SKILL.md, and every pattern file must be reachable from a rule or listed explicitly.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { RECIPE_RULES } from '../recipes.js';
import { SKILL_SOURCE, bundleFiles } from './install.js';

const P = (n) => `patterns/${n}.md`;
export const RULE_PATTERN = {
  'button-name': P('button-name'), 'link-name': P('link-name'), 'link-new-tab-notice-without-target': P('link-new-tab'), 'image-alt': P('image-alt'),
  label: P('form-labels'),
  'multiple-navs-missing-labels': P('landmarks-navs'), 'landmark-unique': P('landmarks-navs'), region: P('landmarks-navs'), 'missing-main-landmark': P('landmarks-navs'),
  'skip-link-missing': P('skip-link'), 'skip-link-target-missing': P('skip-link'),
  'page-has-heading-one': P('headings'), 'missing-h1': P('headings'), 'heading-order': P('headings'), 'heading-level-skipped': P('headings'),
  'disclosure-missing-aria-expanded': P('disclosure'), 'menu-trigger-missing-aria-expanded': P('disclosure'),
  'tabpanel-labelledby': P('tabs'), tabpanellabelledby: P('tabs'),
  'target-size': P('target-size'), targetsize: P('target-size'),
  'focus-visible': P('focus-visible'), 'focus-not-visible': P('focus-visible'), 'focus-indicator-removed': P('focus-visible'), 'focus-invisible-stop': P('focus-visible'),
  'label-content-name-mismatch': P('label-in-name'), visibletextpartofaccessiblename: P('label-in-name'),
  'document-title': P('language'), 'html-has-lang': P('language'),
  'meta-viewport': P('reflow'),
  'duplicate-id': P('duplicate-ids'), 'duplicate-id-aria': P('duplicate-ids'), 'duplicate-id-referenced': P('duplicate-ids'),
  'aria-allowed-role': P('aria-misuse'), 'aria-hidden-focus': P('aria-misuse'),
  'color-contrast': 'design-locked.md', 'color-contrast-enhanced': 'design-locked.md', 'focus-indicator-low-contrast': 'design-locked.md', 'non-text-contrast': 'design-locked.md',
};
// Topic patterns with no export rule today (reached from SKILL.md by their topic).
export const TOPIC_PATTERNS = [P('dialogs-focus'), P('carousels'), P('role-button-keyboard')];

/** @returns {{unmapped:string[], missingFiles:string[], unlisted:string[], orphans:string[]}} empty arrays mean full coverage. */
export function checkCoverage(dir = SKILL_SOURCE) {
  const skill = readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
  const targets = new Set([...Object.values(RULE_PATTERN), ...TOPIC_PATTERNS]);
  const files = bundleFiles(dir);
  return {
    unmapped: RECIPE_RULES.filter((r) => !RULE_PATTERN[r]),
    missingFiles: [...targets].filter((f) => !existsSync(path.join(dir, f))),
    unlisted: [...targets].filter((f) => !skill.includes(`\`${f}\``)),
    orphans: files.filter((f) => f.startsWith('patterns/') && !targets.has(f)),
  };
}
