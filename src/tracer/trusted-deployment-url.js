import { join, resolve, isAbsolute, relative } from 'node:path';
import { existsSync, realpathSync } from 'node:fs';
import { readBoundedFile } from '../fix/review/secure-io.js';
import { canonicalizeDeploymentUrl } from './deployment-url.js';

const MAX_CONFIG_BYTES = 256 * 1024;

export function resolveDeploymentUrlFromEnv() {
  const raw = process.env.ADA_SCAN_DEPLOYMENT_URL;
  if (!raw || typeof raw !== 'string') return null;
  return canonicalizeDeploymentUrl(raw.trim());
}

export function resolveDeploymentUrlFromConfigObject(config = {}) {
  const raw = config?.deploymentUrl;
  if (!raw || typeof raw !== 'string') return null;
  return canonicalizeDeploymentUrl(raw.trim());
}

/**
 * Resolve trusted deployment URL from env or host `.scan-config.json`.
 * Never accepts model/remote data.
 */
export function resolveTrustedDeploymentUrl(localRoot) {
  const fromEnv = resolveDeploymentUrlFromEnv();
  if (fromEnv) {
    return { ok: true, deploymentUrl: fromEnv, source: 'env' };
  }

  if (!localRoot || typeof localRoot !== 'string' || !existsSync(localRoot)) {
    return { ok: false, reason: 'MISSING_DEPLOYMENT_URL' };
  }

  let resolvedRoot;
  try {
    resolvedRoot = realpathSync(localRoot);
  } catch {
    return { ok: false, reason: 'MISSING_DEPLOYMENT_URL' };
  }

  const configPath = resolve(resolvedRoot, '.scan-config.json');
  let resolvedConfigPath;
  try {
    resolvedConfigPath = realpathSync(configPath);
  } catch {
    return { ok: false, reason: 'MISSING_DEPLOYMENT_URL' };
  }

  const rel = relative(resolvedRoot, resolvedConfigPath);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    return { ok: false, reason: 'MISSING_DEPLOYMENT_URL' };
  }

  let rawConfig;
  try {
    rawConfig = readBoundedFile(resolvedConfigPath, MAX_CONFIG_BYTES);
  } catch {
    return { ok: false, reason: 'MISSING_DEPLOYMENT_URL' };
  }
  if (rawConfig == null) {
    return { ok: false, reason: 'MISSING_DEPLOYMENT_URL' };
  }

  let config;
  try {
    config = JSON.parse(rawConfig);
  } catch {
    return { ok: false, reason: 'MISSING_DEPLOYMENT_URL' };
  }

  const fromConfig = resolveDeploymentUrlFromConfigObject(config);
  if (!fromConfig) {
    return { ok: false, reason: 'MISSING_DEPLOYMENT_URL' };
  }

  return { ok: true, deploymentUrl: fromConfig, source: 'config' };
}

export function resolveDeploymentUrlForBuild(projectRoot) {
  return resolveTrustedDeploymentUrl(projectRoot);
}
