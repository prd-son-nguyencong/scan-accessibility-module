import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PARADOX_SITE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/paradox-site/pages');

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
// "local" keeps the snippet marker comments; "studio" is the Site Studio export without them.
const MARKER = /^[ \t]*<!--\s*\/?snippets\/[^>]*-->\r?\n/gm;

/**
 * Serves the fixture site on an ephemeral port. Extensionless routes map to
 * `<route>.html`, `/` to index.html, unknown routes to 404.html with status 404.
 * `routes` maps a pathname to a (req, res) handler that wins over the files (flaky/slow test routes).
 * Returns { url, port, close() }.
 */
export async function startParadoxSite({ variant = 'local', host = '127.0.0.1', dir = PARADOX_SITE_DIR, routes = {} } = {}) {
  const server = http.createServer(async (req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/\/+$/, '') || '/';
    if (routes[pathname]) return routes[pathname](req, res);
    const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
    const candidates = path.extname(rel) ? [rel] : [`${rel}.html`];
    for (const [i, name] of [...candidates, '404.html'].entries()) {
      const file = path.resolve(dir, name);
      if (path.relative(dir, file).startsWith('..')) break;
      try {
        let body = await readFile(file);
        const type = TYPES[path.extname(file)] || 'application/octet-stream';
        if (variant === 'studio' && type.startsWith('text/html')) body = body.toString('utf8').replace(MARKER, '');
        res.writeHead(i < candidates.length ? 200 : 404, { 'content-type': type });
        return res.end(body);
      } catch { /* try next candidate */ }
    }
    res.writeHead(404).end('not found');
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, host, resolve); });
  const { port } = server.address();
  const urlHost = host.includes(':') ? `[${host}]` : host;
  return {
    port,
    url: `http://${urlHost}:${port}`,
    close: () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections?.(); }),
  };
}
