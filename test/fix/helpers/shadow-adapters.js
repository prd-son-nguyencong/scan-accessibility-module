export function createLoopbackSiteAdapter(url = 'http://127.0.0.1:8765') {
  const state = { started: 0, stopped: 0 };
  return {
    get started() { return state.started; },
    get stopped() { return state.stopped; },
    async start() {
      state.started += 1;
      return {
        url,
        async stop() {
          state.stopped += 1;
        },
      };
    },
  };
}

export function createScannerWithOwnedSiteLifecycle(handler) {
  const scanner = async (context) => handler(context);
  scanner.ownsSiteLifecycle = true;
  return scanner;
}

export function createPassingScanner() {
  return async () => ({
    findings: [],
    sourceTraceResolved: true,
    sourceTraceByTarget: [],
    executedLayers: ['axe', 'accessScan'],
  });
}
