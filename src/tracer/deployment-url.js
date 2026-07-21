const DEPLOYMENT_URL_MAX_LENGTH = 2048;
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

export function isBoundedHttpUrl(raw) {
  if (typeof raw !== 'string' || !raw || raw.length > DEPLOYMENT_URL_MAX_LENGTH) {
    return false;
  }
  if (CONTROL_CHARS.test(raw)) return false;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  if (parsed.username || parsed.password) return false;
  if (parsed.hash) return false;
  if (parsed.search) return false;
  return true;
}

/**
 * Canonical deployment URL: origin plus normalized base path (no query/hash/credentials).
 */
export function canonicalizeDeploymentUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > DEPLOYMENT_URL_MAX_LENGTH) {
    return null;
  }
  if (CONTROL_CHARS.test(raw)) return null;

  let parsed;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (parsed.username || parsed.password) return null;
  if (parsed.search || parsed.hash) return null;

  let pathname = parsed.pathname || '/';
  if (pathname !== '/') {
    pathname = pathname.replace(/\/+$/, '') || '/';
  }
  if (pathname === '/') {
    return parsed.origin;
  }
  return `${parsed.origin}${pathname}`;
}

export function isUrlWithinDeploymentScope(scannedUrl, deploymentUrl) {
  const canonicalDeployment = canonicalizeDeploymentUrl(deploymentUrl);
  if (!canonicalDeployment || !isBoundedHttpUrl(scannedUrl)) return false;

  const scanned = new URL(scannedUrl);
  const deployment = new URL(`${canonicalDeployment}/`);

  if (scanned.origin !== deployment.origin) return false;

  const basePath = deployment.pathname === '/' ? '' : deployment.pathname.replace(/\/+$/, '');
  const scanPath = scanned.pathname || '/';

  if (!basePath) return true;
  return scanPath === basePath || scanPath.startsWith(`${basePath}/`);
}
