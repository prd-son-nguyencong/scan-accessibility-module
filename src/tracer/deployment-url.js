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

/**
 * Scope is origin + base path only: the deployment URL must be canonical (no query/hash), but a
 * scanned URL's query and hash never matter, so they are dropped before the length/shape check.
 */
export function isUrlWithinDeploymentScope(scannedUrl, deploymentUrl) {
  const canonicalDeployment = canonicalizeDeploymentUrl(deploymentUrl);
  if (!canonicalDeployment || typeof scannedUrl !== 'string' || CONTROL_CHARS.test(scannedUrl)) return false;

  let scanned;
  try {
    scanned = new URL(scannedUrl);
  } catch {
    return false;
  }
  scanned.search = '';
  scanned.hash = '';
  if (!isBoundedHttpUrl(scanned.href)) return false;
  const deployment = new URL(`${canonicalDeployment}/`);

  if (scanned.origin !== deployment.origin) return false;

  const basePath = deployment.pathname === '/' ? '' : deployment.pathname.replace(/\/+$/, '');
  const scanPath = scanned.pathname || '/';

  if (!basePath) return true;
  return scanPath === basePath || scanPath.startsWith(`${basePath}/`);
}
