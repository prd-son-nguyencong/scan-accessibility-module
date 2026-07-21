import { existsSync, lstatSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
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

const DEFAULT_DIST_MAP = [
  { dist: 'dist/partials/', src: 'src/partials/', ext: '.liquid' },
  { dist: 'dist/pages/', src: 'src/pages/', ext: '.liquid' },
  { dist: 'dist/layouts/', src: 'src/layouts/', ext: '.liquid' },
  { dist: 'dist/components/', src: 'src/components/', ext: '.liquid' },
];

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
  if (raw == null) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
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

export function sanitizeDistMap(projectRoot, distMap = DEFAULT_DIST_MAP) {
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
  return safe.length ? safe : DEFAULT_DIST_MAP;
}

export function injectScanAttestation(html, attestation = {}) {
  return injectAttestationMetaTags(html, attestation);
}

export function scanInstrumentationPlugin() {
  return {
    name: 'scan-instrumentation',
    apply: 'build',

    async closeBundle() {
      if (process.env.SCAN_MODE !== 'true') return;

      const projectRoot = process.cwd();
      const config = loadHostScanConfig(projectRoot);
      const outDir = resolveSafeOutDir(projectRoot, config.outDir || 'dist');
      const distMap = sanitizeDistMap(
        projectRoot,
        Array.isArray(config.distMap) && config.distMap.length ? config.distMap : DEFAULT_DIST_MAP,
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
      if (!existsSync(outDirAbs)) mkdirSync(outDirAbs, { recursive: true });
      assertPathContainedInRoot(projectRoot, outDirAbs);

      const sortedManifest = normalizeInstrumentationManifest(manifest);
      const instrumentationDigest = instrumentationManifestDigest(sortedManifest);
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

      const manifestPath = join(outDirAbs, 'scan-manifest.json');
      const sidecarPath = join(outDirAbs, 'scan-attestation.json');
      writeFileSync(manifestPath, JSON.stringify(sortedManifest, null, 2));
      writeFileSync(sidecarPath, JSON.stringify(attestation, null, 2));

      console.log(`[scan-instrumentation] ${outDir}/scan-manifest.json — ${Object.keys(sortedManifest).length} entries`);
    },
  };
}
