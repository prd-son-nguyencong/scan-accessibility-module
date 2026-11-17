import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { spawnGroup, killGroup } from './process-group.js';
import { getProjectRoot } from './paths.js';
import { CliError } from './cli-args.js';
import { isLoopbackUrl } from './host-classify.js';

const CHECK_TIMEOUT_MS = 5000;
const START_TIMEOUT_MS = 30000;
const timeoutOf = (config) => config.devServerTimeoutMs ?? START_TIMEOUT_MS;
const READY_DELAY_MS = 1000;
const IS_WINDOWS = process.platform === 'win32';

export async function isServerRunning(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
    return response.ok || response.status < 500;
  } catch {
    return false;
  }
}

function readyHostPort(baseUrl) {
  try {
    const u = new URL(baseUrl);
    return { host: u.hostname, port: u.port || (u.protocol === 'https:' ? '443' : '80') };
  } catch {
    return { host: 'localhost', port: '' };
  }
}

/**
 * Starts the host dev server using the configured `devCommand`, in the host
 * root. Readiness is detected from Vite-style output and the port parsed from
 * `config.baseUrl` (not a hardcoded 1234).
 */
export async function startDevServer(config = {}) {
  const devCommand = config.devCommand || 'pnpm dev';
  const [cmd, ...args] = devCommand.split(/\s+/);
  const { host, port } = readyHostPort(config.baseUrl || 'http://localhost:1234');

  console.log(`Starting dev server (${devCommand})...`);

  const proc = spawnGroup(cmd, args, {
    cwd: getProjectRoot(),
    stdio: ['ignore', 'pipe', 'pipe'],
    // Windows package-manager binaries are .cmd shims — require a shell.
    shell: IS_WINDOWS,
  });

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      killGroup(proc, 'SIGKILL');
      reject(new Error(`Dev server not ready within ${timeoutOf(config)}ms via "${devCommand}" (set devServerTimeoutMs to change)`));
    }, timeoutOf(config));

    const onData = async (data) => {
      const text = data.toString();
      const ready =
        text.includes('Local:') ||
        text.includes('ready in') ||
        (port && text.includes(`:${port}`)) ||
        (host && port && text.includes(`${host}:${port}`));
      if (ready) {
        await new Promise((r) => setTimeout(r, READY_DELAY_MS));
        clearTimeout(timeout);
        resolve(proc);
      }
    };

    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    proc.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        clearTimeout(timeout);
        reject(new Error(`Dev server exited with code ${code}`));
      }
    });
  });
}

const lsof = (...a) => execFileSync('lsof', a, { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
const real = (p) => { try { return realpathSync.native(p); } catch { return path.resolve(p); } };

/** [{ pid, cwd }] of every process LISTENing on `port`, or null when any of them cannot be read (Windows, no lsof, another user's process, a tunnel). */
export function listenerCwds(port, run = lsof) {
  try {
    const pids = [...new Set(run('-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp').split('\n').map((l) => /^p(\d+)$/.exec(l)?.[1]).filter(Boolean))];
    if (!pids.length) return null;
    const out = pids.map((pid) => ({ pid, cwd: /^n(.+)$/m.exec(run('-a', '-p', pid, '-d', 'cwd', '-Fn'))?.[1] }));
    return out.every((l) => l.cwd) ? out : null;
  } catch {
    return null;
  }
}

/** 'own' when a listener runs inside `root`, 'foreign' when every listener's cwd is known and none does, else 'unknown'. Containment is path based: a sibling that shares a name prefix is outside. */
export function serverOwner(root, listeners) {
  if (!listeners) return 'unknown';
  const base = real(root);
  const inside = ({ cwd }) => { const rel = path.relative(base, real(cwd)); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); };
  return listeners.some(inside) ? 'own' : 'foreign';
}

export async function ensureServer(args, config, { listeners = listenerCwds, root = getProjectRoot() } = {}) {
  if (args.has('--no-server')) return null;

  const running = await isServerRunning(config.baseUrl);
  if (running) {
    if (isLoopbackUrl(config.baseUrl)) {
      const url = new URL(config.baseUrl);
      const found = listeners(url.port || (url.protocol === 'https:' ? '443' : '80'));
      const owner = serverOwner(root, found);
      if (owner === 'foreign') {
        const who = found.map((l) => `pid ${l.pid} in ${l.cwd}`).join(', ');
        throw new CliError(
          `${config.baseUrl} is already served by another project (${who}), not by ${root}; the scan would test the wrong site. ` +
          `Stop it, change baseUrl in .scan-config.json, or pass --no-server to scan it on purpose.`,
        );
      }
      if (owner === 'unknown') console.warn(`Warning: could not tell which project serves ${config.baseUrl}; assuming it is ${root}.`);
    }
    console.log(`Server running at ${config.baseUrl}`);
    return null;
  }

  const proc = await startDevServer(config);
  console.log('Dev server started.');
  return proc;
}
