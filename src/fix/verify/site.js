import { createServer } from 'node:http';
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { join, normalize, relative, resolve } from 'node:path';
import { randomInt } from 'node:crypto';
import { assertLoopbackSiteUrl, ShadowVerificationError } from './shadow.js';

const LOOPBACK_HOST = '127.0.0.1';
const MAX_FILE_BYTES = 8 * 1024 * 1024;

function resolveContainedFile(rootReal, requestPath) {
  const decoded = decodeURIComponent(String(requestPath || '/').split('?')[0]);
  let pathname = decoded;
  if (pathname.endsWith('/')) pathname += 'index.html';
  if (pathname.startsWith('/')) pathname = pathname.slice(1);
  pathname = normalize(pathname).replace(/^(\.\.(\/|\\|$))+/, '');
  if (!pathname || pathname.includes('..')) {
    throw new ShadowVerificationError('SITE_PATH_DENIED', 'Requested path is not allowed.');
  }
  const candidate = resolve(rootReal, pathname);
  const rel = relative(rootReal, candidate);
  if (rel.startsWith('..') || rel.includes('..')) {
    throw new ShadowVerificationError('SITE_PATH_DENIED', 'Requested path escapes site root.');
  }
  return candidate;
}

function contentTypeFor(filePath) {
  if (filePath.endsWith('.html')) return 'text/html; charset=utf-8';
  if (filePath.endsWith('.css')) return 'text/css; charset=utf-8';
  if (filePath.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (filePath.endsWith('.json')) return 'application/json; charset=utf-8';
  if (filePath.endsWith('.svg')) return 'image/svg+xml';
  if (filePath.endsWith('.png')) return 'image/png';
  if (filePath.endsWith('.jpg') || filePath.endsWith('.jpeg')) return 'image/jpeg';
  if (filePath.endsWith('.webp')) return 'image/webp';
  return 'application/octet-stream';
}

function readRegularFile(filePath) {
  if (!existsSync(filePath)) return null;
  const lst = lstatSync(filePath);
  if (lst.isSymbolicLink() || !lst.isFile()) return null;
  if (lst.size > MAX_FILE_BYTES) {
    throw new ShadowVerificationError('SITE_FILE_TOO_LARGE', 'Static file exceeds size limit.');
  }
  const resolved = realpathSync(filePath);
  return readFileSync(resolved);
}

/**
 * Built-in containment-safe static site adapter for shadow verification.
 * Serves configured outDir from the shadow workspace on a random loopback port.
 */
export function createStaticSiteAdapter({ outDir = 'dist' } = {}) {
  return {
    async start(shadowRoot, { signal } = {}) {
      const siteRoot = resolve(shadowRoot, outDir);
      if (!existsSync(siteRoot)) {
        throw new ShadowVerificationError('SITE_ROOT_MISSING', 'Built site output directory is missing.');
      }
      const siteRootReal = realpathSync(siteRoot);
      const rel = relative(realpathSync(shadowRoot), siteRootReal);
      if (rel.startsWith('..') || rel.includes('..')) {
        throw new ShadowVerificationError('SITE_ROOT_ESCAPE', 'Site root escapes shadow workspace.');
      }

      const port = randomInt(49152, 65535);
      let closing = false;

      const server = createServer((req, res) => {
        if (closing) {
          res.writeHead(503, { 'Cache-Control': 'no-store' });
          res.end('Site shutting down');
          return;
        }
        try {
          const filePath = resolveContainedFile(siteRootReal, req.url || '/');
          const bytes = readRegularFile(filePath);
          if (!bytes) {
            res.writeHead(404, { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
            res.end('Not found');
            return;
          }
          res.writeHead(200, {
            'Content-Type': contentTypeFor(filePath),
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
          });
          res.end(bytes);
        } catch (error) {
          const code = error instanceof ShadowVerificationError ? 403 : 500;
          res.writeHead(code, { 'Cache-Control': 'no-store' });
          res.end('Forbidden');
        }
      });

      await new Promise((resolvePromise, reject) => {
        server.once('error', reject);
        server.listen(port, LOOPBACK_HOST, resolvePromise);
      });

      const abortListener = () => {
        closing = true;
        server.close(() => {});
      };
      if (signal) {
        if (signal.aborted) abortListener();
        else signal.addEventListener('abort', abortListener, { once: true });
      }

      const url = assertLoopbackSiteUrl(`http://${LOOPBACK_HOST}:${port}/`);
      return {
        url,
        context: { siteRoot: siteRootReal, port },
        async stop() {
          closing = true;
          if (signal) signal.removeEventListener('abort', abortListener);
          await new Promise((resolvePromise) => {
            if (typeof server.closeAllConnections === 'function') {
              server.closeAllConnections();
            }
            server.close(() => resolvePromise());
          });
        },
      };
    },
  };
}

/**
 * Trusted Vite site adapter for projects whose build output contains deployable
 * fragments rather than the fully composed document served in development.
 */
export function createViteSiteAdapter() {
  return {
    async start(shadowRoot, { signal } = {}) {
      if (signal?.aborted) {
        throw new ShadowVerificationError('CANCELLED', 'Vite site start was cancelled.');
      }

      const shadowRootReal = realpathSync(shadowRoot);
      let createViteServer;
      try {
        ({ createServer: createViteServer } = await import('vite'));
      } catch {
        throw new ShadowVerificationError(
          'VITE_UNAVAILABLE',
          'Vite is required to serve this shadow project.',
        );
      }

      const port = randomInt(49152, 65535);
      let viteServer;
      try {
        viteServer = await createViteServer({
          root: shadowRootReal,
          clearScreen: false,
          logLevel: 'silent',
          server: {
            host: LOOPBACK_HOST,
            port,
            strictPort: true,
            open: false,
            fs: {
              strict: true,
              allow: [shadowRootReal],
            },
          },
        });

        // Inline config has precedence, but enforce containment again after the
        // host config is resolved so a broad `server.fs.allow` cannot escape.
        viteServer.config.server.fs.strict = true;
        viteServer.config.server.fs.allow = [shadowRootReal];
        await viteServer.listen();
      } catch (error) {
        try {
          await viteServer?.close();
        } catch {
          // ignore cleanup failure while reporting startup failure
        }
        throw new ShadowVerificationError(
          'VITE_SITE_START_FAILED',
          `Vite shadow site failed to start: ${error.message}`,
        );
      }

      const url = assertLoopbackSiteUrl(`http://${LOOPBACK_HOST}:${port}/`);
      let stopped = false;
      const stop = async () => {
        if (stopped) return;
        stopped = true;
        if (signal) signal.removeEventListener('abort', abortListener);
        await viteServer.close();
      };
      const abortListener = () => {
        void stop();
      };

      if (signal) signal.addEventListener('abort', abortListener, { once: true });

      return {
        url,
        context: { mode: 'vite', root: shadowRootReal, port },
        stop,
      };
    },
  };
}

export function assertSiteRootContained(shadowRoot, outDir = 'dist') {
  const siteRoot = resolve(shadowRoot, outDir);
  if (!existsSync(siteRoot)) return false;
  const shadowReal = realpathSync(shadowRoot);
  const siteReal = realpathSync(siteRoot);
  const rel = relative(shadowReal, siteReal);
  return !rel.startsWith('..') && !rel.includes('..');
}
