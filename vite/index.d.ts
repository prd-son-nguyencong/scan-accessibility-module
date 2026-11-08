import type { Plugin } from 'vite';

/**
 * Vite plugin that emits `<outDir>/scan-manifest.json` (source-tracing map)
 * when built with `SCAN_MODE=true`. Register it in your host `vite.config`.
 */
export function scanInstrumentationPlugin(): Plugin;

export function injectScanAttestation(
  html: string,
  attestation: {
    buildRevision?: string | null;
    instrumentationDigest?: string | null;
    deploymentUrl?: string | null;
  },
): string;

/**
 * Scan-build plugin (`SCAN_MODE=true`): adds `data-ada-src="file:line"` to host elements in .jsx/.tsx and emits
 * `ada-react-src.json` for the `react` source adapter.
 */
export function reactSourceAttrPlugin(): Plugin;
