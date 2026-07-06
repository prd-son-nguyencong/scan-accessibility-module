import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'fs';
import path from 'path';
import { getProjectRoot } from '../../utils/paths.js';
import { groupViolations } from '../../schema.js';

const ROOT = getProjectRoot();

/**
 * VS Code + Copilot integration mode.
 *
 * Writes:
 * - .vscode/scan-fixes/<file>.json for each affected file
 * - .vscode/tasks.json entries for Command Palette
 * - .github/copilot-instructions.md with fix context for Copilot Chat
 */
export async function writeFixContext(violations, _config = {}) {
  const fixDir = path.join(ROOT, '.vscode', 'scan-fixes');
  mkdirSync(fixDir, { recursive: true });

  const byFile = groupViolations(violations, (v) => v.source?.file || 'unknown');

  // Write per-file fix JSON
  for (const [file, fileViolations] of byFile) {
    if (file === 'unknown') continue;
    const fixName = file.replace(/[/\\]/g, '__') + '.json';
    writeFileSync(
      path.join(fixDir, fixName),
      JSON.stringify(
        fileViolations.map((v) => ({
          ruleId: v.ruleId,
          line: v.source?.line,
          impact: v.impact,
          priority: v.priority,
          wcagRef: v.wcagRef,
          hint: v.fix?.hint,
          patch: v.fix?.patch,
          element: v.element?.outerHTML?.slice(0, 200),
        })),
        null,
        2
      ),
      'utf8'
    );
  }

  // Write tasks.json
  const tasksPath = path.join(ROOT, '.vscode', 'tasks.json');
  let tasks = { version: '2.0.0', tasks: [] };
  if (existsSync(tasksPath)) {
    try {
      tasks = JSON.parse(readFileSync(tasksPath, 'utf8'));
    } catch {
      /* use default */
    }
  }
  tasks.tasks = tasks.tasks.filter((t) => !t.label?.startsWith('Scan Fix:'));
  tasks.tasks.push({
    label: 'Scan Fix: Review All',
    type: 'shell',
    command: 'pnpm scan:fix --fix-mode vscode',
    problemMatcher: [],
    group: 'test',
  });
  writeFileSync(tasksPath, JSON.stringify(tasks, null, 2), 'utf8');

  // Write Copilot instructions
  const githubDir = path.join(ROOT, '.github');
  mkdirSync(githubDir, { recursive: true });
  const instructions = buildCopilotInstructions(violations, byFile);
  writeFileSync(path.join(githubDir, 'copilot-instructions.md'), instructions, 'utf8');

  console.log(`  VS Code fixes: ${fixDir} (${byFile.size} file(s))`);
  console.log(`  Copilot instructions: .github/copilot-instructions.md`);
}

function buildCopilotInstructions(violations, byFile) {
  const lines = [
    '# Accessibility Fix Instructions for Copilot',
    '',
    `> ${violations.length} violations detected — fix in priority order.`,
    '',
  ];

  for (const [file, fileViolations] of byFile) {
    lines.push(`## ${file}`);
    for (const v of fileViolations) {
      lines.push(`- **${v.ruleId}** (${v.wcagRef || 'N/A'}) line ${v.source?.line || '?'}: ${v.fix?.hint || 'Fix needed'}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
