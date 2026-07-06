import { execFileSync } from 'child_process';

/**
 * Returns true if the current working directory (or any parent) is a git repository.
 */
export function hasGitRepo() {
  try {
    execFileSync('git', ['rev-parse', '--git-dir'], { stdio: 'pipe', encoding: 'utf8' });
    return true;
  } catch {
    return false;
  }
}

export function gitStash(message = 'scan-fix backup') {
  try {
    const output = execFileSync('git', ['stash', 'push', '-m', message], {
      encoding: 'utf8',
      stdio: 'pipe',
    });
    return !output.includes('No local changes to save');
  } catch {
    return false;
  }
}

export function gitStashPop() {
  try {
    execFileSync('git', ['stash', 'pop'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

export function gitDiffFiles() {
  try {
    const output = execFileSync('git', ['diff', '--name-only'], { encoding: 'utf8', stdio: 'pipe' });
    return output.trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

export function gitChangedSinceLastCommit() {
  try {
    const output = execFileSync('git', ['diff', '--name-only', 'HEAD'], { encoding: 'utf8', stdio: 'pipe' });
    return output.trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

export function hasUncommittedChanges() {
  try {
    const output = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8', stdio: 'pipe' });
    return output.trim().length > 0;
  } catch {
    return false;
  }
}
