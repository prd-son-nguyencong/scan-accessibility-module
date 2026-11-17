import { spawn } from 'child_process';

const IS_WINDOWS = process.platform === 'win32';
const live = new Set();
let installed = false;
let signalled = false;

/** Kills the child's whole process group (POSIX) or just the child (Windows). */
export function killGroup(child, signal = 'SIGTERM') {
  if (!child?.pid) return;
  try {
    if (IS_WINDOWS) child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {
    // already gone
  }
}

function killAll(signal) {
  for (const c of live) killGroup(c, signal);
}

async function onSignal(signal) {
  // Second signal: stop being graceful.
  if (signalled) {
    killAll('SIGKILL');
    process.exit(128 + (signal === 'SIGINT' ? 2 : 15));
  }
  signalled = true;
  killAll('SIGTERM');
  const force = setTimeout(() => { killAll('SIGKILL'); process.exit(1); }, 5000);
  force.unref();
  try {
    const { closeBrowser } = await import('../scanner/browser.js');
    await closeBrowser();
  } catch {
    // best effort
  }
  killAll('SIGKILL');
  process.exit(128 + (signal === 'SIGINT' ? 2 : 15));
}

const onSigint = () => onSignal('SIGINT');
const onSigterm = () => onSignal('SIGTERM');
const onExit = () => killAll('SIGKILL');

function install() {
  if (installed) return;
  installed = true;
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);
  process.on('exit', onExit);
}

function uninstall() {
  if (!installed || live.size) return;
  installed = false;
  signalled = false;
  process.off('SIGINT', onSigint);
  process.off('SIGTERM', onSigterm);
  process.off('exit', onExit);
}

/**
 * spawn() in its own process group, tracked so signals, timeouts and exit take
 * the grandchildren down too. When the leader exits the leftover group is killed.
 */
export function spawnGroup(cmd, args, options = {}) {
  install();
  const child = spawn(cmd, args, { ...options, detached: !IS_WINDOWS });
  live.add(child);
  child.once('exit', () => {
    killGroup(child, 'SIGKILL');
    live.delete(child);
    uninstall();
  });
  child.once('error', () => { live.delete(child); uninstall(); });
  return child;
}

/** SIGTERM the group, SIGKILL after graceMs. */
export function terminateGroup(child, graceMs = 2000) {
  killGroup(child, 'SIGTERM');
  const t = setTimeout(() => killGroup(child, 'SIGKILL'), graceMs);
  t.unref();
}
