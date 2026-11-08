import { existsSync, lstatSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import fg from 'fast-glob';
import {
  instrumentationManifestDigest,
  normalizeInstrumentationManifest,
} from '../src/reporter/fingerprint.js';
import { injectAttestationMetaTags } from '../src/tracer/page-attestation.js';
import {
  resolveDeploymentUrlForBuild,
  resolveDeploymentUrlFromEnv,
} from '../src/tracer/trusted-deployment-url.js';
import { readBoundedFile } from '../src/fix/review/secure-io.js';
import { hashSourceFiles } from '../src/tracer/preimage.js';

const defaultDistMap = (outDir) => ['partials', 'pages', 'layouts', 'components']
  .map((d) => ({ dist: `${outDir}/${d}/`, src: `src/${d}/`, ext: '.liquid' }));

// Write-then-rename so a crashed build never leaves a half-written manifest.
function writeFileAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, file);
}

const SIDECAR_SCHEMA_VERSION = '1.1.0';
const MAX_CONFIG_BYTES = 256 * 1024;

function resolveProjectRoot(projectRoot) {
  return realpathSync(projectRoot);
}

function assertPathContainedInRoot(root, candidatePath) {
  const resolvedRoot = resolveProjectRoot(root);
  if (!existsSync(candidatePath)) {
    throw new Error('PATH_TRAVERSAL');
  }
  const resolvedCandidate = realpathSync(candidatePath);
  const rel = relative(resolvedRoot, resolvedCandidate);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error('PATH_TRAVERSAL');
  }
  return { resolvedRoot, resolvedCandidate };
}

function isRegularFile(filePath) {
  try {
    return lstatSync(filePath).isFile();
  } catch {
    return false;
  }
}

export function loadHostScanConfig(projectRoot) {
  const resolvedRoot = resolveProjectRoot(projectRoot);
  const configPath = join(resolvedRoot, '.scan-config.json');
  if (!existsSync(configPath) || !isRegularFile(configPath)) return {};
  const contained = assertPathContainedInRoot(resolvedRoot, configPath);
  const raw = readBoundedFile(contained.resolvedCandidate, MAX_CONFIG_BYTES);
  if (raw == null) {
    throw new Error(`[scan-instrumentation] .scan-config.json is unreadable or larger than ${MAX_CONFIG_BYTES} bytes.`);
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('config must be a JSON object');
    return parsed;
  } catch (err) {
    const msg = `[scan-instrumentation] invalid .scan-config.json: ${err.message}`;
    console.warn(msg);
    throw new Error(msg);
  }
}

export function resolveSafeOutDir(projectRoot, outDir = 'dist') {
  const resolvedRoot = resolveProjectRoot(projectRoot);
  if (typeof outDir !== 'string' || !outDir || outDir.includes('..') || isAbsolute(outDir)) {
    throw new Error('PATH_TRAVERSAL');
  }
  const outPath = resolve(resolvedRoot, outDir);
  const rel = relative(resolvedRoot, outPath);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error('PATH_TRAVERSAL');
  }
  if (existsSync(outPath)) {
    assertPathContainedInRoot(resolvedRoot, outPath);
  }
  return outDir;
}

function assertRelativePathContained(root, relPath) {
  if (typeof relPath !== 'string' || !relPath || relPath.includes('..') || isAbsolute(relPath)) {
    throw new Error('PATH_TRAVERSAL');
  }
  const candidate = resolve(root, relPath);
  const rel = relative(root, candidate);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error('PATH_TRAVERSAL');
  }
  return candidate;
}

export function sanitizeDistMap(projectRoot, distMap = defaultDistMap('dist')) {
  const resolvedRoot = resolveProjectRoot(projectRoot);
  const safe = [];
  for (const entry of distMap) {
    if (!entry || typeof entry.dist !== 'string' || typeof entry.src !== 'string') continue;
    assertRelativePathContained(resolvedRoot, entry.dist);
    assertRelativePathContained(resolvedRoot, entry.src);
    safe.push({
      dist: entry.dist,
      src: entry.src,
      ext: entry.ext || '.liquid',
    });
  }
  return safe.length ? safe : defaultDistMap('dist');
}

export function injectScanAttestation(html, attestation = {}) {
  return injectAttestationMetaTags(html, attestation);
}

export function scanInstrumentationPlugin() {
  let resolved = null;
  let buildFailed = false;
  return {
    name: 'scan-instrumentation',
    apply: 'build',

    configResolved(cfg) {
      resolved = cfg;
    },

    buildEnd(error) {
      if (error) buildFailed = true;
    },

    closeBundle: {
      order: 'post',
      async handler() {
      if (process.env.SCAN_MODE !== 'true' || buildFailed) return;

      const projectRoot = resolved?.root || process.cwd();
      const config = loadHostScanConfig(projectRoot);
      // The resolved Vite outDir wins over .scan-config.json so both always agree.
      const outDir = resolveSafeOutDir(
        projectRoot,
        resolved ? relative(resolveProjectRoot(projectRoot), resolve(projectRoot, resolved.build.outDir)) || '.' : config.outDir || 'dist',
      );
      const distMap = sanitizeDistMap(
        projectRoot,
        // An untouched template distMap (rooted at dist/) follows the real outDir.
        Array.isArray(config.distMap) && config.distMap.length
          && JSON.stringify(config.distMap) !== JSON.stringify(defaultDistMap('dist'))
          ? config.distMap
          : defaultDistMap(outDir),
      );

      const manifest = {};
      for (const { dist, src, ext } of distMap) {
        const files = await fg(`${dist}**/*.html`, { cwd: projectRoot });
        for (const file of files) {
          const relativePath = file.slice(dist.length).replace(/\.html$/, '');
          manifest[file] = `${src}${relativePath}${ext || '.liquid'}`;
        }
      }

      const outDirAbs = join(projectRoot, outDir);
      if (!existsSync(outDirAbs)) return; // nothing was emitted (failed or empty build)
      assertPathContainedInRoot(projectRoot, outDirAbs);

      const sortedManifest = normalizeInstrumentationManifest(manifest);
      // Build-time content hashes of every traced source: the digest commits to them and the report re-checks them.
      const sourceHashes = hashSourceFiles(projectRoot, Object.values(sortedManifest));
      const instrumentationDigest = instrumentationManifestDigest(sortedManifest, sourceHashes);
      const deploymentResolved = resolveDeploymentUrlForBuild(projectRoot);
      const deploymentUrl = deploymentResolved.ok
        ? deploymentResolved.deploymentUrl
        : resolveDeploymentUrlFromEnv();

      const attestation = {
        schemaVersion: SIDECAR_SCHEMA_VERSION,
        buildRevision: process.env.ADA_SCAN_BUILD_REVISION || null,
        instrumentationDigest,
        deploymentUrl: deploymentUrl || null,
        entryCount: Object.keys(sortedManifest).length,
        sourceHashes,
      };

      if (attestation.buildRevision && attestation.deploymentUrl) {
        const htmlFiles = await fg('**/*.html', {
          cwd: outDirAbs,
          absolute: true,
        });
        for (const htmlFile of htmlFiles) {
          assertPathContainedInRoot(projectRoot, htmlFile);
          const html = readBoundedFile(htmlFile, 8 * 1024 * 1024);
          if (html == null) continue;
          writeFileSync(htmlFile, injectScanAttestation(html, attestation), 'utf8');
        }
      } else if (attestation.buildRevision && !attestation.deploymentUrl) {
        console.warn('[scan-instrumentation] deploymentUrl missing; HTML attestation markers omitted (hybrid fix unavailable).');
      }

      // The instrumented (marker-carrying) pages as emitted, after the attestation meta tags.
      attestation.renderedHashes = hashSourceFiles(projectRoot, Object.keys(sortedManifest));

      const manifestPath = join(outDirAbs, 'scan-manifest.json');
      const sidecarPath = join(outDirAbs, 'scan-attestation.json');
      writeFileAtomic(manifestPath, JSON.stringify(sortedManifest, null, 2));
      writeFileAtomic(sidecarPath, JSON.stringify(attestation, null, 2));

      console.log(`[scan-instrumentation] ${outDir}/scan-manifest.json — ${Object.keys(sortedManifest).length} entries`);
      },
    },
  };
}
