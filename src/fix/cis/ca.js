import { createHash, timingSafeEqual, X509Certificate } from 'node:crypto';
import { readBoundedFile, SecureIoError } from '../review/secure-io.js';

const MAX_CA_BUNDLE_BYTES = 256 * 1024;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const PEM_PATTERN = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;

export class CisCaError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CisCaError';
    this.code = code;
  }
}

function hashesEqual(left, right) {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

export function loadTrustedCaBundle(filePath, expectedSha256, options = {}) {
  const readBoundedFileImpl = options.readBoundedFile ?? readBoundedFile;

  if (!filePath) {
    throw new CisCaError('CIS_CA_MISSING', 'CIS CA bundle path is required.');
  }
  if (!SHA256_PATTERN.test(expectedSha256 || '')) {
    throw new CisCaError('CIS_CA_FINGERPRINT_MISMATCH', 'CIS CA fingerprint is invalid.');
  }

  let pem;
  try {
    pem = readBoundedFileImpl(filePath, MAX_CA_BUNDLE_BYTES);
  } catch (error) {
    if (error instanceof SecureIoError && error.code === 'SYMLINK_FILE') {
      throw new CisCaError('CIS_CA_UNTRUSTED_PATH', 'CIS CA bundle must not be a symlink.');
    }
    if (error instanceof SecureIoError) {
      throw new CisCaError('CIS_CA_INVALID', 'CIS CA bundle is not a bounded regular file.');
    }
    throw new CisCaError('CIS_CA_INVALID', 'CIS CA bundle could not be read securely.');
  }
  if (pem == null) {
    throw new CisCaError('CIS_CA_MISSING', 'CIS CA bundle was not found.');
  }
  if (pem === '') {
    throw new CisCaError('CIS_CA_INVALID', 'CIS CA bundle is not valid PEM.');
  }

  const certificates = pem.match(PEM_PATTERN) || [];
  try {
    if (certificates.length === 0) throw new Error('missing certificate');
    const parsed = certificates.map((certificate) => new X509Certificate(certificate));
    if (!parsed.some((certificate) => certificate.ca)) throw new Error('missing CA certificate');
  } catch {
    throw new CisCaError('CIS_CA_INVALID', 'CIS CA bundle is not valid PEM.');
  }

  const actualSha256 = `sha256:${createHash('sha256').update(Buffer.from(pem, 'utf8')).digest('hex')}`;
  if (!hashesEqual(actualSha256, expectedSha256)) {
    throw new CisCaError('CIS_CA_FINGERPRINT_MISMATCH', 'CIS CA fingerprint does not match.');
  }

  return Object.freeze({
    pem,
    sha256: actualSha256,
    certificateCount: certificates.length,
  });
}

export { MAX_CA_BUNDLE_BYTES };
