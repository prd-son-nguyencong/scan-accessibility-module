import { gitStash, gitStashPop, hasGitRepo } from '../utils/git.js';

/**
 * Fix Safety: Git-based rollback.
 *
 * Usage:
 *   const rollback = createRollbackPoint('my-fix-description');
 *   rollback.save();          // git stash before fixes
 *   applyFixes();
 *   rollback.restore();       // git stash pop on failure
 *
 * If the project is not a git repository, save() returns false and logs a
 * clear warning. All methods are no-ops (safe to call but do nothing).
 */
export function createRollbackPoint(description = 'scan-fix') {
  let stashed = false;
  const gitAvailable = hasGitRepo();

  if (!gitAvailable) {
    console.log('  Warning: Project is not a git repository — rollback protection is disabled.');
    console.log('           Fixes are applied directly. Use --dry-run to preview changes first.');
  }

  return {
    /** Stash current changes before applying fixes. Returns true if stash was created. */
    save() {
      if (!gitAvailable) return false;
      stashed = gitStash(`${description} pre-fix backup`);
      if (stashed) {
        console.log('  Rollback point created (git stash)');
      }
      return stashed;
    },

    /** Verify fixes worked; if verifyFn returns falsy, restore. */
    async verify(verifyFn) {
      if (!gitAvailable) return true; // can't rollback but can't verify either
      try {
        const ok = await verifyFn();
        if (!ok) {
          this.restore();
          return false;
        }
        return true;
      } catch {
        this.restore();
        return false;
      }
    },

    /** Restore to pre-fix state via git stash pop. */
    restore() {
      if (!gitAvailable || !stashed) return false;
      const restored = gitStashPop();
      if (restored) {
        console.log('  Rolled back to pre-fix state (git stash pop)');
      } else {
        console.error('  Rollback FAILED — git stash pop failed, manual intervention needed');
        console.error('  Run: git stash list  to see available stashes');
      }
      stashed = false;
      return restored;
    },

    get isProtected() {
      return gitAvailable && stashed;
    },
  };
}
