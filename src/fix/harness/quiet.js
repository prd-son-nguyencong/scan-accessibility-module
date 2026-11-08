// The harness serves the project in-process (vite), and the project's own plugins print per-request lines (file watcher, HMR, export) that bury the progress lines.
// Run `fn` with console.log/info/debug/warn sent to a log file instead; `emit` (the harness's own progress) is handed the real console.log. Errors stay visible.
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export async function withQuietConsole(logFile, fn, { verbose = false } = {}) {
  if (verbose) return fn(console.log.bind(console));
  const saved = {}; const real = console.log.bind(console);
  let bytes = 0; const CAP = 20 * 1024 * 1024;
  try { mkdirSync(dirname(logFile), { recursive: true }); } catch { /* the lines are then dropped */ }
  const sink = (level) => (...args) => {
    if (bytes > CAP) return;
    const line = `${level} ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}\n`;
    bytes += line.length;
    try { appendFileSync(logFile, line); } catch { /* best effort */ }
  };
  for (const k of ['log', 'info', 'debug', 'warn']) { saved[k] = console[k]; console[k] = sink(k); }
  try { return await fn(real); } finally { for (const k of Object.keys(saved)) console[k] = saved[k]; }
}
