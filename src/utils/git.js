import { execFileSync } from 'child_process';

/** Files changed vs HEAD plus untracked ones, relative to `cwd`. */
export function gitChangedSinceLastCommit(cwd = process.cwd()) {
  try {
    const run = (args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim().split('\n').filter(Boolean);
    return [...run(['diff', '--name-only', '--relative', 'HEAD']), ...run(['ls-files', '--others', '--exclude-standard'])];
  } catch {
    return [];
  }
}
