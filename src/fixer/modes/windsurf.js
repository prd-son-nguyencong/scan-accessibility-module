import { writeFileSync, mkdirSync } from 'fs';
import path from 'path';
import { getProjectRoot } from '../../utils/paths.js';
import { groupViolations } from '../../schema.js';

const ROOT = getProjectRoot();

/**
 * Windsurf (Codeium/Cascade) integration mode.
 *
 * Writes:
 * - .windsurf/scan-task.md as a Cascade task prompt
 * - .windsurf/applied.json after fixes are applied
 */
export async function writeFixContext(violations, _config = {}) {
  const windsurfDir = path.join(ROOT, '.windsurf');
  mkdirSync(windsurfDir, { recursive: true });

  const byFile = groupViolations(violations, (v) => v.source?.file || 'unknown');
  const taskContent = buildCascadeTask(violations, byFile);
  writeFileSync(path.join(windsurfDir, 'scan-task.md'), taskContent, 'utf8');

  console.log(`  Windsurf task: .windsurf/scan-task.md (${violations.length} violations)`);
}

function buildCascadeTask(violations, byFile) {
  const lines = [
    '# Cascade Task: Accessibility Fixes',
    '',
    `Fix ${violations.length} accessibility violations in the following files.`,
    'Each fix includes the file path, line range, WCAG reference, and expected outcome.',
    '',
    '## Instructions',
    '',
    '1. Fix each violation in the specified file and line',
    '2. Follow the WCAG reference for compliance requirements',
    '3. Run `pnpm scan --page <name>` after fixing to verify',
    '',
    '## Violations',
    '',
  ];

  for (const [file, fileViolations] of byFile) {
    if (file === 'unknown') continue;
    lines.push(`### ${file}`);
    lines.push('');
    for (const v of fileViolations) {
      lines.push(`#### ${v.ruleId} (P${v.priority}, ${v.impact})`);
      if (v.source?.line) lines.push(`- **Line:** ${v.source.line}`);
      if (v.wcagRef) lines.push(`- **WCAG:** ${v.wcagRef}`);
      lines.push(`- **Fix:** ${v.fix?.hint || 'Manual review needed'}`);
      if (v.source?.snippet) {
        lines.push('- **Context:**');
        lines.push('```liquid');
        lines.push(v.source.snippet);
        lines.push('```');
      }
      if (v.fix?.patch) {
        lines.push('- **Patch:**');
        lines.push('```diff');
        lines.push(v.fix.patch);
        lines.push('```');
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}
