// The dev server composes layout and fragment into the document the visitor gets.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
export default {
  plugins: [{
    name: 'compose',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const name = new URL(req.url, 'http://x').pathname.replace(/^\/|\/$/g, '') || 'index';
        const root = server.config.root;
        const page = join(root, `src/pages/${name}.html`);
        if (!/^[\w-]+$/.test(name) || !existsSync(page)) return next();
        res.setHeader('content-type', 'text/html; charset=utf-8');
        res.end(readFileSync(join(root, 'src/layout.html'), 'utf8').replace('<!--content-->', readFileSync(page, 'utf8')));
      });
    },
  }],
};
