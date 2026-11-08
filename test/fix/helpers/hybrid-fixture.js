import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { computeInstrumentationDigest } from '../../../src/tracer/build-instrumented.js';
import { buildSourcePreimage } from '../../../src/tracer/preimage.js';

export const REVISION = 'git:abc123def4567890123456789012345678901234';
export const DEPLOYMENT_URL = 'https://example.test';
export const DIGEST = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

export function writeVerifiedFixtureSources(root) {
  const sortDir = join(root, 'src', 'partials', 'jobs');
  mkdirSync(sortDir, { recursive: true });
  const sortLines = [];
  for (let line = 1; line <= 11; line += 1) {
    sortLines.push(`<!-- sort line ${line} -->`);
  }
  sortLines.push('<select id="sort-select"></select>');
  const sortContent = `${sortLines.join('\n')}\n`;
  writeFileSync(join(sortDir, 'sort.liquid'), sortContent);

  const indexDir = join(root, 'src', 'pages');
  mkdirSync(indexDir, { recursive: true });
  const indexLines = [];
  for (let line = 1; line <= 29; line += 1) {
    indexLines.push(`<!-- index line ${line} -->`);
  }
  indexLines.push('<div id="duplicate"></div>');
  const indexContent = `${indexLines.join('\n')}\n`;
  writeFileSync(join(indexDir, 'index.liquid'), indexContent);

  return {
    'src/partials/jobs/sort.liquid': {
      line: 12,
      preimageSha256: buildSourcePreimage(sortContent, 12).preimageSha256,
    },
    'src/pages/index.liquid': {
      line: 30,
      preimageSha256: buildSourcePreimage(indexContent, 30).preimageSha256,
    },
  };
}

export function patchScanResultsSources(scanResults, sourceMap) {
  const cloned = structuredClone(scanResults);
  for (const page of cloned) {
    for (const violation of page.violations || []) {
      const mapped = sourceMap[violation.source?.file];
      if (!mapped) continue;
      violation.source.line = mapped.line;
      violation.source.preimageSha256 = mapped.preimageSha256;
    }
  }
  return cloned;
}

export function writeHybridAttestationProject(root, {
  revision = REVISION,
  manifest = { 'dist/pages/index.html': 'src/pages/index.liquid' },
  deploymentUrl = DEPLOYMENT_URL,
  persistDigest = null,
} = {}) {
  writeFileSync(join(root, '.scan-config.json'), JSON.stringify({
    outDir: 'dist',
    deploymentUrl,
  }));
  mkdirSync(join(root, 'dist'), { recursive: true });
  writeFileSync(join(root, 'dist', 'scan-manifest.json'), JSON.stringify(manifest));
  const digest = persistDigest || computeInstrumentationDigest(manifest);
  writeFileSync(join(root, 'dist', 'scan-attestation.json'), JSON.stringify({
    schemaVersion: '1.1.0',
    buildRevision: revision,
    instrumentationDigest: digest,
    deploymentUrl,
    entryCount: Object.keys(manifest).length,
  }));
  writeVerifiedFixtureSources(root);
  return { digest, revision, deploymentUrl };
}

export function hybridTarget(overrides = {}) {
  return {
    mode: 'hybrid',
    url: `${DEPLOYMENT_URL}/`,
    buildRevision: REVISION,
    instrumentationDigest: DIGEST,
    deploymentUrl: DEPLOYMENT_URL,
    attestationStatus: 'complete',
    attestationReason: null,
    ...overrides,
  };
}

export function attestationMetaHtml(attestation) {
  return `<!doctype html><html><head>
    <meta name="ada-scan-build-revision" content="${attestation.buildRevision}">
    <meta name="ada-scan-instrumentation-digest" content="${attestation.instrumentationDigest}">
    <meta name="ada-scan-deployment-url" content="${attestation.deploymentUrl}">
  </head><body></body></html>`;
}
