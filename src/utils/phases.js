// Per-page wall-clock phase timings (ms). Read-only layers run concurrently, so layer phases overlap and do not sum to the page total.

/** Runs fn and adds its wall time to phases[name] (also when it throws). */
export async function timed(phases, name, fn) {
  const started = Date.now();
  try {
    return await fn();
  } finally {
    phases[name] = (phases[name] || 0) + Date.now() - started;
  }
}

/** "navigate 2.1s, axe 20.4s, ..." for the console line. */
export const formatPhases = (phases) => Object.entries(phases).map(([name, ms]) => `${name} ${(ms / 1000).toFixed(1)}s`).join(', ');
