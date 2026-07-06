import http from 'http';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRollbackPoint } from '../rollback.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PORT = 3847;

/**
 * Start the fix dashboard HTTP server.
 *
 * Plain Node.js http.createServer — no Express dependency.
 * Serves the SPA + JSON API for the browser-based fix workflow.
 */
export async function startFixServer(state, options = {}) {
  const { fixMode = 'claude', dryRun = false, onApply } = options;
  const port = options.port || DEFAULT_PORT;

  let modeModules = {};
  async function getModeModule(mode) {
    if (!modeModules[mode]) {
      modeModules[mode] = await import(`../modes/${mode}.js`);
    }
    return modeModules[mode];
  }

  async function parseBody(req) {
    return new Promise((resolve) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        try { resolve(JSON.parse(body)); } catch { resolve({}); }
      });
    });
  }

  function json(res, data, status = 200) {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(data));
  }

  function cors(res) {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    const pathname = url.pathname;

    if (req.method === 'OPTIONS') return cors(res);

    try {
      // Serve SPA
      if (pathname === '/' || pathname === '/index.html') {
        const html = readFileSync(path.join(__dirname, 'fix-dashboard.html'), 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html' });
        return res.end(html);
      }

      // API: all violations
      if (pathname === '/api/violations' && req.method === 'GET') {
        return json(res, { violations: state.getAll(), fixMode });
      }

      // API: generate fix (must be before single-violation GET)
      if (pathname.match(/^\/api\/fix\/([^/]+)\/generate$/) && req.method === 'POST') {
        const id = pathname.match(/^\/api\/fix\/([^/]+)\/generate$/)[1];
        const mod = await getModeModule(fixMode);
        const result = await state.generate(id, mod);
        return json(res, result);
      }

      // API: re-fix with comment
      if (pathname.match(/^\/api\/fix\/([^/]+)\/refix$/) && req.method === 'POST') {
        const id = pathname.match(/^\/api\/fix\/([^/]+)\/refix$/)[1];
        const body = await parseBody(req);
        const mod = await getModeModule(fixMode);
        const result = await state.refix(id, mod, body.comment || '');
        return json(res, result);
      }

      // API: accept fix
      if (pathname.match(/^\/api\/fix\/([^/]+)\/accept$/) && req.method === 'POST') {
        const id = pathname.match(/^\/api\/fix\/([^/]+)\/accept$/)[1];
        state.accept(id);
        return json(res, { ok: true });
      }

      // API: reject fix
      if (pathname.match(/^\/api\/fix\/([^/]+)\/reject$/) && req.method === 'POST') {
        const id = pathname.match(/^\/api\/fix\/([^/]+)\/reject$/)[1];
        const body = await parseBody(req);
        state.reject(id, body.reason || null);
        return json(res, { ok: true });
      }

      // API: switch mode for a fix
      if (pathname.match(/^\/api\/fix\/([^/]+)\/switch-mode$/) && req.method === 'POST') {
        const id = pathname.match(/^\/api\/fix\/([^/]+)\/switch-mode$/)[1];
        const body = await parseBody(req);
        const newMode = body.mode;
        if (!['cis', 'claude', 'codex'].includes(newMode)) {
          return json(res, { error: `Invalid mode: ${newMode}` }, 400);
        }
        const mod = await getModeModule(newMode);
        const result = await state.switchMode(id, newMode, mod);
        return json(res, result);
      }

      // API: single violation detail (must be after action routes)
      const fixMatch = pathname.match(/^\/api\/fix\/([^/]+)$/);
      if (fixMatch && req.method === 'GET') {
        const detail = state.getOne(fixMatch[1]);
        if (!detail) return json(res, { error: 'Not found' }, 404);
        return json(res, detail);
      }

      // API: apply all accepted
      if (pathname === '/api/apply-all' && req.method === 'POST') {
        if (dryRun) return json(res, { error: 'Dry run — no files modified', dryRun: true }, 400);

        const rollback = createRollbackPoint('browser-ui-fix');
        rollback.save();

        const results = state.applyAll();
        return json(res, { ...results, rollbackId: rollback.id || 'stash' });
      }

      // API: rollback
      if (pathname === '/api/rollback' && req.method === 'POST') {
        try {
          const rollback = createRollbackPoint('browser-ui-rollback');
          rollback.restore();
          return json(res, { ok: true });
        } catch (err) {
          return json(res, { error: err.message }, 500);
        }
      }

      // API: session state
      if (pathname === '/api/session' && req.method === 'GET') {
        return json(res, state.getSession());
      }

      json(res, { error: 'Not found' }, 404);
    } catch (err) {
      json(res, { error: err.message }, 500);
    }
  });

  return new Promise((resolve) => {
    server.listen(port, () => {
      const actualPort = server.address().port;
      resolve({
        port: actualPort,
        server,
        waitForClose: () => new Promise((r) => {
          process.on('SIGINT', () => { server.close(); r(); });
          process.on('SIGTERM', () => { server.close(); r(); });
        }),
      });
    });
  });
}
