// Re-verification against flaky findings (T-E11.5): findings from timing/state-sensitive layers, and critical/serious/moderate
// axe / accessScan findings, are re-checked once in a fresh context. One that does not reproduce is flaky (stability 1/2).

export const REVERIFY_LAYERS = Object.freeze(['keyboard', 'focusTrap', 'dynamicContent', 'ariaLive', 'links']);
const STRICT_LAYERS = ['axe', 'accessScan'];
export const DEFAULT_VERIFY = Object.freeze({ maxPerPage: 100, timeoutMs: 60000 });

export const needsReverify = (v) =>
  REVERIFY_LAYERS.includes(v.layer) || (STRICT_LAYERS.includes(v.layer) && ['critical', 'serious', 'moderate'].includes(v.impact));

/**
 * violations: the page's first-pass findings. rerun(layer, findings) -> Promise<findings[]> from a fresh context (it may limit the work to what `findings`, the targets of that layer, need) (throws when the
 * layer could not run again). key(v) -> identity string. Returns { kept, flaky, summary }; findings over the cap, from a
 * layer that could not be re-run or past the time budget stay in `kept` unverified. The cost is one re-run per layer, not per
 * finding, so the time budget (timeoutMs) is the real limit and maxPerPage only a ceiling. laneOf(layer) names the lane
 * a layer runs in: layers of one lane run in order, lanes run together.
 */
export async function reverifyFindings(violations, { rerun, key, maxPerPage = DEFAULT_VERIFY.maxPerPage, timeoutMs = DEFAULT_VERIFY.timeoutMs, laneOf = () => 0 }) {
  const targets = violations.filter(needsReverify).slice(0, maxPerPage);
  const summary = { checked: 0, stable: 0, flaky: 0, unverified: 0, overCap: violations.filter(needsReverify).length - targets.length, byRule: {} };
  const flaky = new Set();
  const deadline = Date.now() + timeoutMs;
  const layers = [...new Set(targets.map((v) => v.layer))];
  const seenBy = new Map();
  const reRun = async (layer) => {
    const left = deadline - Date.now();
    if (left <= 0) return;
    let timer;
    try {
      const fresh = await Promise.race([rerun(layer, targets.filter((v) => v.layer === layer)), new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timeout')), left); })]);
      seenBy.set(layer, new Set(fresh.map(key)));
    } catch { /* layer could not be re-run: leave its findings unverified */ } finally { clearTimeout(timer); }
  };
  // Layers that share a page run one after another (a lane); independent lanes run together.
  const lanes = new Map();
  for (const layer of layers) lanes.set(laneOf(layer), [...(lanes.get(laneOf(layer)) || []), layer]);
  await Promise.all([...lanes.values()].map(async (lane) => { for (const layer of lane) await reRun(layer); }));
  for (const layer of layers) {
    const mine = targets.filter((v) => v.layer === layer);
    const seen = seenBy.get(layer);
    if (!seen) { summary.unverified += mine.length; continue; }
    for (const v of mine) {
      const rule = (summary.byRule[v.ruleId] ||= { checked: 0, flaky: 0 });
      rule.checked++;
      summary.checked++;
      if (seen.has(key(v))) summary.stable++;
      else { flaky.add(v); rule.flaky++; summary.flaky++; }
    }
  }
  return {
    kept: violations.filter((v) => !flaky.has(v)),
    flaky: [...flaky].map((v) => ({ ruleId: v.ruleId, layer: v.layer, impact: v.impact, selector: v.element?.selector || '', stability: '1/2' })),
    summary,
  };
}

/** Folds per-page summaries into the run-level metadata: totals plus the flake rate per rule. */
export function summarizeReverify(pages, { maxPerPage, timeoutMs }) {
  const total = { enabled: true, maxPerPage, timeoutMs, checked: 0, stable: 0, flaky: 0, unverified: 0, overCap: 0, flakeRate: {}, flakyFindings: [] };
  for (const { route, reverify: r } of pages) {
    if (!r) continue;
    for (const k of ['checked', 'stable', 'flaky', 'unverified', 'overCap']) total[k] += r.summary[k];
    for (const [rule, c] of Object.entries(r.summary.byRule)) {
      const t = (total.flakeRate[rule] ||= { checked: 0, flaky: 0, rate: 0 });
      t.checked += c.checked;
      t.flaky += c.flaky;
      t.rate = Number((t.flaky / t.checked).toFixed(3));
    }
    total.flakyFindings.push(...r.flaky.map((f) => ({ route, ...f })));
  }
  return total;
}
