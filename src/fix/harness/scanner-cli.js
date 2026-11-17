// Harness scanner that runs the real ada-scan CLI per route (axe, accessScan, keyboard, html-validate, measured checks), so findings carry the same
// canonical rule ids, verdicts and selectors as the report the tasks came from. Async spawn: the candidate site is served by this process.
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../../../bin/ada-scan.js', import.meta.url));
export const HARNESS_LAYERS = 'axe,accessScan,htmlValidate,keyboard,dynamicContent';

function runOnce(args, cwd, signal, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, args, { cwd, ...(signal ? { signal } : {}), timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (err) => {
      // exit 1 (violations) and 2 (incomplete) still write a report; only a missing report is an error
      if (err && err.name === 'AbortError') return reject(Object.assign(new Error('CANCELLED'), { code: 'CANCELLED' }));
      resolve();
    });
  });
}

/** concurrency: routes scanned at the same time (each is its own ada-scan process and browser). Findings come back in route order whatever the concurrency. */
export function createCliScanner({ layers = HARNESS_LAYERS, timeoutMs = 240000, concurrency = 1 } = {}) {
  const scanRoute = async ({ route, workspaceRoot, siteUrl, signal }) => {
    for (let attempt = 1; ; attempt += 1) {
      const out = mkdtempSync(join(tmpdir(), 'ada-harness-scan-'));
      try {
        await runOnce([BIN, '--url', new URL(route, siteUrl).href, '--out-dir', out, '--no-fail', '--no-reverify', '--layers', layers], workspaceRoot, signal, timeoutMs);
        let report;
        try { report = JSON.parse(readFileSync(join(out, 'latest.json'), 'utf8')); } catch { report = null; }
        const failed = !report ? 'wrote no report' : (report.pages || []).map((p) => (p.status === 'failed' ? `failed: ${p.failure?.message || p.failure?.reason || 'unknown'}` : null)).find(Boolean);
        // A browser that died under load (Protocol error, Target closed, timeout) gets one more try; anything else is a real failure.
        if (failed && attempt < 2 && /wrote no report|Protocol error|Target (?:page|closed)|timeout/i.test(failed)) continue;
        if (failed) throw new Error(`scan of ${route} ${failed}`);
        return (report.pages || []).flatMap((page) => (page.findings || []).map((f) => ({ ...f, route })));
      } finally { rmSync(out, { recursive: true, force: true }); }
    }
  };
  return async ({ workspaceRoot, siteUrl, routes = ['/'], signal = null }) => {
    const perRoute = new Array(routes.length);
    let next = 0, failure = null;
    const worker = async () => {
      for (let i = next++; i < routes.length && !failure; i = next++) {
        try { perRoute[i] = await scanRoute({ route: routes[i], workspaceRoot, siteUrl, signal }); } catch (err) { failure = failure || err; }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(Number.isInteger(concurrency) && concurrency >= 1 ? concurrency : 1, routes.length)) }, worker));
    if (failure) throw failure;
    return { findings: perRoute.flat() };
  };
}
