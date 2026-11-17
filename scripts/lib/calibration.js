// Pure scoring for scripts/calibrate.js: labels (expected verdict/owner per known finding class) against the findings of a scan.
// The confirmed tier is what the gate and fix tasks act on: verdict "confirmed" AND owner "site". Everything else is not a promise.

export const isConfirmedSite = (f) => f.verdict === 'confirmed' && (f.origin?.owner || 'site') === 'site';

const ruleIdsOf = (f) => [f.nativeRuleId, f.canonicalRuleId, ...(f.nativeRuleIds || [])].filter(Boolean);

/** A finding matches a label when route, rule (regex over every rule id of the finding) and optional selector/markup regex all match. */
export function matches(label, f) {
  if (label.route && f.route !== label.route) return false;
  if (label.rule && label.rule !== '*' && !ruleIdsOf(f).some((r) => new RegExp(label.rule).test(r))) return false;
  if (label.match) {
    const hay = `${f.element?.selector || ''}\n${f.element?.html || f.element?.outerHTML || ''}\n${f.evidence?.message || ''}`;
    if (!new RegExp(label.match, 'i').test(hay)) return false;
  }
  return true;
}

/**
 * label.kind "fp": every matching finding must satisfy expect (default: not confirmed-site); none matching is a pass.
 * label.kind "tp": at least one matching finding must satisfy expect.verdict (list) and expect.owner; none is a miss.
 * label.max: at most that many matching findings across the site (grouping checks).
 */
export function scoreCalibration(labels, findings) {
  const results = [];
  const labelled = new Set();
  for (const label of labels) {
    const hits = findings.filter((f) => matches(label, f));
    hits.forEach((f) => labelled.add(f));
    const expect = label.expect || {};
    const okOne = (f) => (expect.verdict ? expect.verdict.includes(f.verdict) : true)
      && (expect.owner ? (f.origin?.owner || 'site') === expect.owner : true)
      && (expect.confirmedSite === false ? !isConfirmedSite(f) : true);
    let pass;
    let why = '';
    if (label.kind === 'fp') {
      const bad = hits.filter((f) => !okOne(f));
      pass = bad.length === 0;
      if (!pass) why = bad.map((f) => `${f.verdict}/${f.origin?.owner || 'site'} ${f.nativeRuleId} ${f.element?.selector || ''}`).join('; ');
    } else {
      pass = hits.some(okOne);
      if (!pass) why = hits.length ? `found but ${hits.map((f) => `${f.verdict}/${f.origin?.owner || 'site'}`).join(', ')}` : 'not found';
    }
    if (pass && label.max != null && hits.length > label.max) { pass = false; why = `${hits.length} findings, at most ${label.max}`; }
    results.push({ id: label.id, class: label.class, kind: label.kind, pass, why, hits: hits.length });
  }
  const confirmed = findings.filter(isConfirmedSite);
  // A confirmed finding is right only when a tp label expecting "confirmed" claims it; anything else confirmed is a false positive.
  const tpConfirmed = new Set(labels.filter((l) => l.kind === 'tp' && l.expect?.verdict?.includes('confirmed') && (l.expect.owner || 'site') === 'site')
    .flatMap((l) => findings.filter((f) => matches(l, f) && isConfirmedSite(f))));
  const unexplained = confirmed.filter((f) => !tpConfirmed.has(f));
  const wantConfirmed = labels.filter((l) => l.kind === 'tp' && l.expect?.verdict?.length === 1 && l.expect.verdict[0] === 'confirmed');
  const foundConfirmed = wantConfirmed.filter((l) => results.find((r) => r.id === l.id)?.pass);
  const precision = confirmed.length ? tpConfirmed.size / confirmed.length : 1;
  const byVerdict = {};
  for (const f of findings) byVerdict[f.verdict] = (byVerdict[f.verdict] || 0) + 1;
  return {
    results,
    confirmedTier: { total: confirmed.length, correct: tpConfirmed.size, precision, recall: wantConfirmed.length ? foundConfirmed.length / wantConfirmed.length : 1, unexplained },
    tiers: byVerdict,
    fpConfirmed: results.filter((r) => r.kind === 'fp' && !r.pass),
    missed: results.filter((r) => r.kind === 'tp' && !r.pass),
  };
}
