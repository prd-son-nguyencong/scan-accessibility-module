// Shared report wording (visual report, QA report, console) so one number or engine is never described two ways.

export const GATE_NOTE = 'Only confirmed findings fail the gate; likely and needs-review findings are listed for review.';

export const totalsLabel = (occurrences, findings) => `${occurrences} occurrence${occurrences === 1 ? '' : 's'} in ${findings} distinct finding${findings === 1 ? '' : 's'}`;

const W3C_LAYERS = ['w3c', 'htmlValidate'];
const inLayer = (f, layer) => f.layer === layer || (f.layers || []).includes(layer);

/**
 * Which engine fed the w3c.* gate rows. runs: scanner runs ({layer,status,engine}); findings: any finding/violation list.
 * Nu counts as run only when its run completed or fell back; html-validate has no run record, so its findings are the evidence.
 */
export function w3cEngineNote(runs = [], findings = []) {
  const w3cRuns = runs.filter((r) => r.layer === 'w3c');
  const nuRan = w3cRuns.some((r) => r.status === 'complete');
  const fallback = w3cRuns.some((r) => r.status === 'fallback');
  const offline = findings.some((f) => inLayer(f, 'htmlValidate'));
  const parts = [];
  if (offline) parts.push('HTML validity (html-validate, offline)');
  if (nuRan) parts.push('W3C Nu');
  else if (fallback) parts.push('Nu validator unreachable (ada-scan local HTML checks)');
  else if (w3cRuns.length && w3cRuns.every((r) => r.status === 'skipped')) parts.push('Nu validator not run (external disabled)');
  return parts.join('; ');
}

/** Scanner-run status word; Lighthouse that finished with unevaluated audits says so. */
export function runStatusLabel(run = {}) {
  const n = run.evidence?.accessibility?.incomplete;
  return run.layer === 'lighthouse' && run.status === 'complete' && n > 0 ? `complete (${n} audits not evaluated)` : run.status;
}

export { W3C_LAYERS };
