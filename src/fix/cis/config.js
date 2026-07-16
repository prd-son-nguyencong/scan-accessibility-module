import { CisCaError, loadTrustedCaBundle } from './ca.js';
import { isLoopbackHost } from './transport.js';

const DEFAULT_ALLOWED_HOSTS = Object.freeze(['127.0.0.1', 'localhost']);

/**
 * Resolve CIS configuration from trusted env/local process only.
 * Missing config disables proposal generation with a safe reason.
 */
export function resolveTrustedCisConfig(env = process.env, options = {}) {
  const { requireModel = true } = options;
  const loadCa = options.loadTrustedCaBundle ?? loadTrustedCaBundle;
  const proxyUrl = String(env.CIS_PROXY_URL || '').trim();
  const featureKey = String(env.CIS_AUTH_TOKEN || env.CIS_FEATURE_KEY || '').trim();
  const model = String(env.CIS_MODEL || '').trim();
  const provider = String(env.CIS_PROVIDER || 'aws').trim();
  const allowedHostsRaw = String(env.CIS_ALLOWED_HOSTS || '').trim();
  const allowedHosts = allowedHostsRaw
    ? allowedHostsRaw.split(',').map((item) => item.trim()).filter(Boolean)
    : DEFAULT_ALLOWED_HOSTS.slice();
  const caBundlePath = String(env.CIS_CA_BUNDLE_PATH || '').trim();
  const caSha256 = String(env.CIS_CA_SHA256 || '').trim().toLowerCase();

  if (!proxyUrl || !featureKey || (requireModel && !model) || !caBundlePath || !caSha256) {
    return {
      ok: false,
      reason: 'CIS_CONFIG_MISSING',
      message: requireModel
        ? 'CIS proposal generation is disabled until CIS_PROXY_URL, CIS auth token, CIS_MODEL, and pinned CA settings are configured.'
        : 'CIS model discovery is disabled until CIS_PROXY_URL, CIS auth token, and pinned CA settings are configured.',
    };
  }

  let parsed;
  try {
    parsed = new URL(proxyUrl);
  } catch {
    return { ok: false, reason: 'CIS_CONFIG_INVALID', message: 'CIS_PROXY_URL is invalid.' };
  }

  if (!allowedHosts.map((host) => host.toLowerCase()).includes(parsed.hostname.toLowerCase())) {
    return { ok: false, reason: 'CIS_HOST_DENIED', message: 'CIS host is not allowlisted.' };
  }

  if (parsed.protocol !== 'https:' && !isLoopbackHost(parsed.hostname)) {
    return { ok: false, reason: 'CIS_CONFIG_INSECURE', message: 'CIS proxy must use HTTPS unless loopback.' };
  }

  let caBundle;
  try {
    caBundle = loadCa(caBundlePath, caSha256);
  } catch (error) {
    if (error instanceof CisCaError) {
      return {
        ok: false,
        reason: error.code,
        message: error.message,
      };
    }
    return {
      ok: false,
      reason: 'CIS_CA_INVALID',
      message: 'CIS CA configuration is invalid.',
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
    caPem: caBundle.pem,
    caSha256: caBundle.sha256,
    caBundlePath,
  };
}

export function createCisTransportFromTrustedConfig(config, fetchImpl = globalThis.fetch) {
  if (!config?.ok) return null;
  return {
    async importTransport() {
      const [{ createCisTransport }, { Agent, fetch: undiciFetch }] = await Promise.all([
        import('./transport.js'),
        import('undici'),
      ]);
      const dispatcher = new Agent({
        connect: {
          ca: config.caPem,
          rejectUnauthorized: true,
        },
      });
      return createCisTransport({
        baseUrl: config.baseUrl,
        featureKey: config.featureKey,
        provider: config.provider,
        allowedHosts: config.allowedHosts,
        allowInsecureLoopback: config.allowInsecureLoopback,
        dispatcher,
        ownsDispatcher: true,
        fetch: undiciFetch,
      });
    },
    model: config.model,
    provider: config.provider,
  };
}
