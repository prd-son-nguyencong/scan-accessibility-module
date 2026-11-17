// Lighthouse perfRunner for captureSnapshot (docs/fix-harness.md section 3). Reuses the scanner's Lighthouse integration and its
// per-device throttling profile (DEVICE_CONFIGS in src/scanner/lighthouse.js); no second Lighthouse setup.
import { runLocalLighthouse, isUnscorable } from '../../scanner/lighthouse.js';

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const audit = (lhr, id) => num(lhr?.audits?.[id]?.numericValue);

/** One lhr -> the snapshot perf run shape { score, lcp, cls, tbt, fcp, si, transfer } (plus transferBytes, the same number). */
export function perfFromLhr(lhr) {
  if (isUnscorable(lhr)) throw Object.assign(new Error('Lighthouse could not score the page'), { code: 'UNSCORABLE' });
  const score = num(lhr.categories?.performance?.score);
  const transfer = audit(lhr, 'total-byte-weight');
  return {
    score: score == null ? null : Math.round(score * 100),
    lcp: audit(lhr, 'largest-contentful-paint'),
    cls: audit(lhr, 'cumulative-layout-shift'),
    tbt: audit(lhr, 'total-blocking-time'),
    fcp: audit(lhr, 'first-contentful-paint'),
    si: audit(lhr, 'speed-index'),
    transfer,
    transferBytes: transfer,
  };
}

const median = (xs) => {
  const v = xs.filter((x) => x != null).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};

/** Per-metric median of several runs. */
export function medianPerf(runs) {
  const out = {};
  for (const k of ['score', 'lcp', 'cls', 'tbt', 'fcp', 'si', 'transfer']) out[k] = median(runs.map((r) => r[k]));
  out.transferBytes = out.transfer;
  return out;
}

/**
 * perfRunner(browser, url) for captureSnapshot. Each call does `runs` Lighthouse runs (default 1: captureSnapshot's perfRuns repeats the
 * call, and the gate needs the per-run values for its noise margin) and returns their median. `runner(url, device, {signal})` returns an lhr
 * and is injectable for tests. A failed or unscorable run is absent; all failed throws.
 */
export function createLighthousePerfRunner({ device = 'desktop', runs = 1, timeoutMs = 120000, runner = runLocalLighthouse } = {}) {
  return async function lighthousePerfRunner(_browser, url) {
    const done = [];
    let last = null;
    for (let i = 0; i < runs; i++) {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), timeoutMs);
      try {
        done.push(perfFromLhr(await Promise.race([
          runner(url, device, { signal: ctl.signal }),
          new Promise((_, rej) => ctl.signal.addEventListener('abort', () => rej(new Error(`Lighthouse run timed out after ${timeoutMs} ms`)))),
        ])));
      } catch (err) { last = err; } finally { clearTimeout(timer); }
    }
    if (!done.length) throw last || new Error('no Lighthouse run');
    return done.length === 1 ? done[0] : medianPerf(done);
  };
}
