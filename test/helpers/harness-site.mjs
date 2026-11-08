import http from 'node:http';
import { cpSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const HARNESS_SITE_SRC = new URL('../fixtures/harness-site/src', import.meta.url).pathname;
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' };

/** Renders src/pages/*.liquid (only `{% render "x" %}` is expanded; backend tags stay literal) and copies styles, scripts and assets into outDir. */
export function renderHarnessSite(srcDir, outDir) {
  mkdirSync(outDir, { recursive: true });
  const partial = (n) => readFileSync(join(srcDir, 'partials', `${n}.liquid`), 'utf8');
  for (const f of readdirSync(join(srcDir, 'pages'))) {
    const html = readFileSync(join(srcDir, 'pages', f), 'utf8').replace(/\{%\s*render\s+"([\w-]+)"\s*%\}/g, (_, n) => partial(n).trimEnd());
    writeFileSync(join(outDir, f.replace('.liquid', '.html')), html);
  }
  for (const d of ['styles', 'scripts', 'assets']) for (const f of readdirSync(join(srcDir, d))) cpSync(join(srcDir, d, f), join(outDir, f));
}

export async function serveDir(dir) {
  const server = http.createServer((req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    const rel = p === '/' ? 'index.html' : p.slice(1);
    const name = /\.\w+$/.test(rel) ? rel : `${rel}.html`;
    try {
      const body = readFileSync(join(dir, name));
      res.writeHead(200, { 'content-type': TYPES[name.slice(name.lastIndexOf('.'))] || 'application/octet-stream' });
      res.end(body);
    } catch { res.writeHead(404); res.end('not found'); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}
