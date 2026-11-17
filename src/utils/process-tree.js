import { execFileSync } from 'node:child_process';

const BROWSER_CMD = /headless|chrom|ms-playwright/i;

/** Headless browser processes among the descendants of rootPid ({ pid, ppid, command }). */
export function liveBrowserChildren(rootPid = process.pid) {
  let table;
  try {
    table = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8', timeout: 10_000 });
  } catch {
    return []; // shortcut: no ps (Windows) or ps hung past 10 s (the sync call would freeze every timer); callers treat this as "nothing to kill"
  }
  const rows = table.split('\n').map((l) => l.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean)
    .map(([, pid, ppid, command]) => ({ pid: +pid, ppid: +ppid, command }));
  const seen = new Set([rootPid]);
  const found = [];
  for (let grew = true; grew;) {
    grew = false;
    for (const r of rows) if (!seen.has(r.pid) && seen.has(r.ppid)) { seen.add(r.pid); grew = true; if (BROWSER_CMD.test(r.command)) found.push(r); }
  }
  return found;
}

export function killBrowserChildren() {
  for (const r of liveBrowserChildren()) { try { process.kill(r.pid, 'SIGKILL'); } catch { /* already gone */ } }
}
