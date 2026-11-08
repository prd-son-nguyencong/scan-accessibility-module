// `ada-scan fix --export --target cursor|claude`: ONE agent rules file that this tool owns (marker line), teaching the fix loop.
// Never touches an existing file without the marker, and never CLAUDE.md.
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { MARKER, ownership, writeOwned } from './tasks.js';
import { NEVER_CHANGE_COLOURS } from './recipes.js';
import { SKILL_ENTRY } from './skill/install.js';

export const TARGETS = ['generic', 'cursor', 'claude'];
const RULES_FILE = { cursor: '.cursor/rules/ada-scan.mdc', claude: '.claude/ada-scan.md' };
const NOTICE = `<!-- ${MARKER}: managed by ada-scan, regenerated; edits will be overwritten -->`;

export function renderRules(target, { tasksDir, url, verifyFlags = '' }) {
  const outside = path.isAbsolute(tasksDir);
  const body = `${NOTICE}
# ada-scan accessibility fixes

Work through the exported accessibility tasks, one source file at a time.

1. Read \`${tasksDir}/INDEX.md\`${outside ? ' (an absolute path on purpose: the export folder is outside this project; regenerate this file on another machine)' : ''}. Use "By file": open each source file once and apply every fix listed for it, highest line first so line numbers stay valid.
2. Each task's markdown file has Where, Evidence, Fix, Do not and Verify. "Proposed change" is a suggestion to adapt, not a patch to paste. If it says "locate manually", use the likely location by role it names.
3. Edit only the Liquid templates or stylesheets under src/. Edit a shared partial or layout once: every page that renders it changes. Never edit dist/, exported JSON, or platform-owned widgets (\`data-react-component\`); those are listed as not actionable.
4. Per-item values (text, labels, ids that differ per item) go in the \`.liquid.json\` sidecar next to the template when the element is rendered in a \`{% for %}\` loop or its text comes from data. Never hard-code an id inside a loop; use \`forloop.index\`.
5. Keep \`{{data:..}}\`, \`{{component:..}}\`, \`{{snippet:..}}\`, \`{{attribute:..}}\` tags and \`data-pdk-*\` attributes untouched. Prefer Tailwind utility classes already used in the project over new CSS.
6. Colour contrast tasks ("Design decisions (do not change colours)" in INDEX.md) are not yours to fix. ${NEVER_CHANGE_COLOURS}
7. Read the ada-scan fix skill before the first edit: \`${SKILL_ENTRY[target] || 'the fix skill'}\` (installed by \`fix --export --target ${target}\`). It holds the per-task workflow, the Paradox and Liquid rules, the no-break guardrails and one pattern file per rule family.
8. Follow this project's own CLAUDE.md or contributing guide for Liquid and Paradox conventions.
9. Verify: run \`ada-scan fix --verify${verifyFlags}\` (checks your diff against the export: files, data tags, colour declarations, dist/), then \`ada-scan --url ${url || '<site url>'}\` (it compares with the baseline saved by \`ada-scan --baseline\`). Mark a task done only if its rule no longer fires for the listed selector pattern and its ids (in the task's .json sidecar) are reported as fixed. Otherwise revert and report why.
10. Then take the next file.
11. Leave every edit uncommitted in the working tree (no git commit, stash or reset): the maintainer runs \`ada-scan fix --harness --from-working-tree\` to check each change against layout, style, behaviour, performance and build gates.
`;
  return target === 'cursor'
    ? `---\ndescription: Fix accessibility findings exported by ada-scan, one task at a time\nalwaysApply: false\n---\n${body}`
    : body;
}

/**
 * Plans (and unless dryRun, performs) the rules-file write. Returns { file, action: 'create'|'update'|'refused', hint }.
 * `refused` means an unmarked file is in the way: nothing is written there and the content goes to fallback instead.
 */
export function exportRules(target, root, { tasksDir, url, dryRun = false, fallback, verifyFlags = '' }) {
  const rel = RULES_FILE[target];
  if (!rel) return null;
  const file = path.join(root, rel);
  const content = renderRules(target, { tasksDir, url, verifyFlags });
  const own = ownership(file);
  if (own === 'foreign') {
    if (!dryRun) {
      mkdirSync(path.dirname(fallback), { recursive: true });
      writeOwned(fallback, content);
    }
    return { file, action: 'refused', fallback };
  }
  if (!dryRun) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeOwned(file, content);
  }
  return { file, action: own === 'owned' ? 'update' : 'create' };
}
