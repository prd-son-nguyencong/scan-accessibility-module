import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TLS_DIR = fileURLToPath(new URL('../../fixtures/cis/tls/', import.meta.url));

/**
 * @param {{
 *   cert: string,
 *   key: string,
 *   responseBody: unknown,
 *   modelsBody?: unknown,
 *   secureOptions?: import('node:tls').SecureContextOptions,
 * }} options
 */
function listenHttpsServer({ cert, key, responseBody, modelsBody, secureOptions = {} }) {
  const predictionBody = JSON.stringify(responseBody);
  const inventoryBody = JSON.stringify(modelsBody ?? {
    models: [{ model: 'test-model' }],
  });
  const server = https.createServer({ cert, key, ...secureOptions }, (req, res) => {
    if (req.method === 'POST' && req.url?.includes('/v1alpha1/predictions')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(predictionBody);
      return;
    }
    if (req.method === 'GET' && req.url?.includes('/v1alpha1/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(inventoryBody);
      return;
    }
    res.writeHead(404);
    res.end();
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({
        port,
        async close() {
          await new Promise((closeResolve, closeReject) => {
            server.close((error) => (error ? closeReject(error) : closeResolve()));
          });
        },
      });
    });
  });
}

/**
 * @param {unknown} responseBody
 * @param {{ modelsBody?: unknown }} [options]
 */
export function startCisTlsTestServer(responseBody, options = {}) {
  const cert = readFileSync(`${TLS_DIR}server.pem`, 'utf8');
  const key = readFileSync(`${TLS_DIR}server-key.pem`, 'utf8');
  return listenHttpsServer({ cert, key, responseBody, modelsBody: options.modelsBody }).then((listener) => ({
    ...listener,
    baseUrl: `https://localhost:${listener.port}/ml/inference/cis`,
    baseUrlIp: `https://127.0.0.1:${listener.port}/ml/inference/cis`,
  }));
}

/**
 * Serves a cert with DNS:localhost only so connecting via 127.0.0.1 fails hostname verification.
 * @param {unknown} responseBody
 */
export function startCisTlsHostnameMismatchServer(responseBody) {
  const tmp = mkdtempSync(join(tmpdir(), 'ada-cis-tls-mismatch-'));
  const keyPath = join(tmp, 'key.pem');
  const csrPath = join(tmp, 'req.csr');
  const certPath = join(tmp, 'cert.pem');
  try {
    execFileSync('openssl', [
      'req', '-newkey', 'rsa:2048', '-sha256', '-nodes',
      '-keyout', keyPath,
      '-out', csrPath,
      '-subj', '/C=US/O=ada-scan tests/CN=localhost',
      '-addext', 'subjectAltName=DNS:localhost',
    ], { stdio: 'pipe' });
    execFileSync('openssl', [
      'x509', '-req',
      '-in', csrPath,
      '-CA', `${TLS_DIR}ca.pem`,
      '-CAkey', `${TLS_DIR}ca-key.pem`,
      '-set_serial', '2',
      '-out', certPath,
      '-days', '3650',
      '-sha256',
      '-copy_extensions', 'copy',
    ], { stdio: 'pipe' });
    const cert = readFileSync(certPath, 'utf8');
    const key = readFileSync(keyPath, 'utf8');
    return listenHttpsServer({ cert, key, responseBody }).then((listener) => ({
      ...listener,
      baseUrlIp: `https://127.0.0.1:${listener.port}/ml/inference/cis`,
      cleanup() {
        rmSync(tmp, { recursive: true, force: true });
      },
    }));
  } catch (error) {
    rmSync(tmp, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Ephemeral self-signed cert for insecure-dev integration tests; TLS 1.2 only.
 * @param {unknown} responseBody
 * @param {{ modelsBody?: unknown, hostname?: string }} [options]
 */
export function startCisTls12SelfSignedServer(responseBody, options = {}) {
  const hostname = options.hostname ?? 'cis.example.test';
  const tmp = mkdtempSync(join(tmpdir(), 'ada-cis-tls12-selfsigned-'));
  const keyPath = join(tmp, 'key.pem');
  const certPath = join(tmp, 'cert.pem');
  try {
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes',
      '-keyout', keyPath,
      '-out', certPath,
      '-days', '3650',
      '-subj', `/C=US/O=ada-scan tests/CN=${hostname}`,
      '-addext', `subjectAltName=DNS:${hostname}`,
    ], { stdio: 'pipe' });
    const cert = readFileSync(certPath, 'utf8');
    const key = readFileSync(keyPath, 'utf8');
    return listenHttpsServer({
      cert,
      key,
      responseBody,
      modelsBody: options.modelsBody,
      secureOptions: {
        minVersion: 'TLSv1.2',
        maxVersion: 'TLSv1.2',
      },
    }).then((listener) => ({
      ...listener,
      baseUrl: `https://${hostname}:${listener.port}/ml/inference/cis`,
      cleanup() {
        rmSync(tmp, { recursive: true, force: true });
      },
    }));
  } catch (error) {
    rmSync(tmp, { recursive: true, force: true });
    throw error;
  }
}

export const TEST_CA_PEM = readFileSync(`${TLS_DIR}ca.pem`, 'utf8');
