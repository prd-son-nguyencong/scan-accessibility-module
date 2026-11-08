import { isLoopbackHost } from './transport.js';

export const INSECURE_DEV_ACK = 'ALLOW_UNVERIFIED_CIS_TLS';

function isNonEmptyEnv(value) {
  return String(value ?? '').length > 0;
}

function isProductionNodeEnv(env) {
  return String(env.NODE_ENV || '').trim().toLowerCase() === 'production';
}

/**
 * Resolve CIS configuration for guarded local development without pinned CA.
 */
export function resolveInsecureDevCisConfig(env = process.env, { requireModel = true } = {}) {
  if (isNonEmptyEnv(env.CI) || isProductionNodeEnv(env)) {
    return {
      ok: false,
      reason: 'CIS_INSECURE_ENV_DENIED',
      message: 'Insecure development mode is unavailable in CI or production environments.',
    };
  }

  const ack = String(env.CIS_INSECURE_DEV_ACK ?? '');
  if (ack !== INSECURE_DEV_ACK) {
    return {
      ok: false,
      reason: 'CIS_INSECURE_DEV_ACK_REQUIRED',
      message: 'Insecure development mode requires an explicit TLS acknowledgment.',
    };
  }

  const tlsMaxVersion = String(env.CIS_TLS_MAX_VERSION ?? '');
  if (tlsMaxVersion !== 'TLSv1.2') {
    return {
      ok: false,
      reason: 'CIS_TLS_VERSION_INVALID',
      message: 'Insecure development mode requires TLS maximum version TLSv1.2.',
    };
  }

  const devBypassAuth = String(env.CIS_DEV_BYPASS_AUTH ?? '');
  if (devBypassAuth !== 'true') {
    return {
      ok: false,
      reason: 'CIS_DEV_AUTH_BYPASS_DENIED',
      message: 'Insecure development mode requires explicit development auth bypass.',
    };
  }

  const proxyUrl = String(env.CIS_PROXY_URL || '').trim();
  const featureKey = String(env.CIS_AUTH_TOKEN || env.CIS_FEATURE_KEY || '').trim();
  const model = String(env.CIS_MODEL || '').trim();
  const provider = String(env.CIS_PROVIDER || 'aws').trim();

  if (!proxyUrl || !featureKey || (requireModel && !model)) {
    return {
      ok: false,
      reason: 'CIS_CONFIG_MISSING',
      message: requireModel
        ? 'CIS proposal generation is disabled until CIS_PROXY_URL, CIS auth token, and CIS_MODEL are configured.'
        : 'CIS model discovery is disabled until CIS_PROXY_URL and CIS auth token are configured.',
    };
  }

  let parsed;
  try {
    parsed = new URL(proxyUrl);
  } catch {
    return { ok: false, reason: 'CIS_CONFIG_INVALID', message: 'CIS_PROXY_URL is invalid.' };
  }

  if (parsed.protocol !== 'https:') {
    return {
      ok: false,
      reason: 'CIS_INSECURE_DEV_DENIED',
      message: 'Insecure development mode requires an HTTPS CIS endpoint.',
    };
  }

  const allowedHostsRaw = String(env.CIS_ALLOWED_HOSTS || '').trim();
  const allowedHosts = allowedHostsRaw
    ? allowedHostsRaw.split(',').map((item) => item.trim()).filter(Boolean)
    : [];

  if (allowedHosts.length !== 1 || allowedHosts[0].toLowerCase() !== parsed.hostname.toLowerCase()) {
    return {
      ok: false,
      reason: 'CIS_INSECURE_DEV_DENIED',
      message: 'Insecure development mode requires an exact single-host allowlist match.',
    };
  }

  return {
    ok: true,
    baseUrl: proxyUrl,
    featureKey,
    model,
    provider,
    allowedHosts,
    allowInsecureLoopback: isLoopbackHost(parsed.hostname),
    transportSecurity: 'insecure-dev',
    devBypassAuth: true,
    tlsMinVersion: 'TLSv1.2',
    tlsMaxVersion: 'TLSv1.2',
  };
}
