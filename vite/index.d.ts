import type { Plugin } from 'vite';

/**
 * Vite plugin that emits `<outDir>/scan-manifest.json` (source-tracing map)
 * when built with `SCAN_MODE=true`. Register it in your host `vite.config`.
 */
export function scanInstrumentationPlugin(): Plugin;
