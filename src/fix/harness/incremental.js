// Which routes a candidate can have changed (docs/fix-harness.md section 3, "Incremental rescan"). The gates, the scan and the perf runs then cover only
// those routes; every other route keeps the cells, rows and perf runs of the accepted state it already had. When there is any doubt, every route is covered.
const TEMPLATE = /\.(?:liquid|html)$/i;
const trim = (r) => (String(r ?? '/').split('?')[0].replace(/\/+$/, '') || '/');

/** file -> routes it is known to reach, from the report's own `source.routeDependencies` plus the page each finding sits on. Empty for a null report. */
export function routeIndexFromReport(report) {
  const index = new Map();
  for (const pg of report?.pages || []) {
    for (const f of pg.findings || []) {
      const file = f.source?.file;
      if (!file) continue;
      const set = index.get(file) || index.set(file, new Set()).get(file);
      for (const r of [pg.route ?? f.route, ...(f.source.routeDependencies || [])]) if (r != null) set.add(trim(r));
    }
  }
  return index;
}

const routesOfFile = (index, file) => [...index].filter(([k]) => k === file || k.endsWith(`/${file}`)).flatMap(([, set]) => [...set]);

/**
 * Routes to re-measure for a candidate that touched `touched` (project-relative paths).
 *  - Only templates (.liquid, .html) narrow the set: a stylesheet, a script or a data file can change a route whose HTML is byte-identical, so any
 *    other touched file means every route.
 *  - A template change reaches a route when that route's served HTML changed (before/after hashes by route; a route missing a hash counts as changed),
 *    when it is a route of the task, or when the report's routeDependencies list it for a touched file.
 * Returns { routes (sorted, a subset of `routes`), all: boolean, reason }.
 */
export function affectedRoutes({ routes, touched, taskRoutes = [], before = null, after = null, routeIndex = null, enabled = true }) {
  const every = (reason) => ({ routes: [...routes].sort(), all: true, reason });
  if (!enabled) return every('incremental rescan is off');
  if (!before || !after) return every('no served-HTML hashes to compare');
  const other = touched.find((f) => !TEMPLATE.test(f));
  if (other) return every(`${other} is not a template: a style, script or data file can change a route whose HTML did not`);
  const hit = new Set(taskRoutes.map(trim));
  for (const r of routes) if (before[r] == null || after[r] == null || before[r] !== after[r]) hit.add(trim(r));
  if (routeIndex) for (const f of touched) for (const r of routesOfFile(routeIndex, f)) hit.add(trim(r));
  const picked = [...routes].filter((r) => hit.has(trim(r))).sort();
  return picked.length ? { routes: picked, all: picked.length === routes.length, reason: 'served HTML changed, task routes, report routeDependencies' } : every('no route matched');
}
