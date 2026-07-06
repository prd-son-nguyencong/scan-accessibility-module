import { spawn } from 'child_process';
import { getProjectRoot } from './paths.js';

const CHECK_TIMEOUT_MS = 5000;
const START_TIMEOUT_MS = 30000;
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

  const proc = spawn(cmd, args, {
    cwd: getProjectRoot(),
    stdio: ['ignore', 'pipe', 'pipe'],
    // Windows package-manager binaries are .cmd shims — require a shell.
    shell: IS_WINDOWS,
  });

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      proc.kill();
      reject(new Error('Dev server failed to start within 30s'));
    }, START_TIMEOUT_MS);

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

export async function ensureServer(args, config) {
  if (args.has('--no-server')) return null;

  const running = await isServerRunning(config.baseUrl);
  if (running) {
    console.log(`Server running at ${config.baseUrl}`);
    return null;
  }

  const proc = await startDevServer(config);
  console.log('Dev server started.');
  return proc;
}
