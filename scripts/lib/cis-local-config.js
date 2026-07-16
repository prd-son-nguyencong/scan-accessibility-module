import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { writeAtomicFile } from '../../src/fix/apply/transaction.js';

export const CIS_KEYS = Object.freeze([
  'CIS_PROXY_URL',
  'CIS_AUTH_TOKEN',
  'CIS_ALLOWED_HOSTS',
  'CIS_PROVIDER',
  'CIS_MODEL',
  'CIS_CA_BUNDLE_PATH',
  'CIS_CA_SHA256',
]);

const MODELS_PATH_SUFFIX = '/v1alpha1/models';
const FEATURE_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,512}$/;
const MODEL_ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,199}$/i;
const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9._:-]{0,63}$/i;
const MANAGED_ENV_LINE = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*/;
const BODY_JSON_MARKER = 'body:json';

function oneMatch(source, pattern, label) {
  const matches = [...source.matchAll(pattern)];
  if (matches.length !== 1 || !matches[0][1]) {
    throw new Error(`${label} must appear exactly once.`);
  }
  return matches[0][1].trim();
}

function isWhitespace(char) {
  return char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === '\f' || char === '\v';
}

function skipWhitespace(source, start) {
  let cursor = start;
  while (cursor < source.length && isWhitespace(source[cursor])) {
    cursor += 1;
  }
  return cursor;
}

function assertWhitespaceOnly(source, start, end = source.length) {
  for (let index = start; index < end; index += 1) {
    if (!isWhitespace(source[index])) {
      throw new Error('Bruno JSON body is ambiguous.');
    }
  }
}

function extractBalancedObject(source, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return {
          text: source.slice(start, index + 1),
          end: index + 1,
        };
      }
    }
  }
  throw new Error('Bruno JSON body is incomplete.');
}

function extractBrunoJsonBody(source) {
  const markerMatches = [...source.matchAll(/body:json/g)];
  if (markerMatches.length !== 1) {
    throw new Error('Bruno JSON body must appear exactly once.');
  }

  const markerIndex = markerMatches[0].index;
  let cursor = skipWhitespace(source, markerIndex + BODY_JSON_MARKER.length);
  if (source[cursor] !== '{') {
    throw new Error('Bruno JSON body is missing.');
  }

  const wrapper = extractBalancedObject(source, cursor);
  const innerStart = cursor + 1;
  const innerEnd = wrapper.end - 1;
  const inner = source.slice(innerStart, innerEnd);

  let jsonCursor = skipWhitespace(inner, 0);
  if (inner[jsonCursor] !== '{') {
    throw new Error('Bruno JSON body is missing.');
  }

  const jsonObject = extractBalancedObject(inner, jsonCursor);
  assertWhitespaceOnly(inner, jsonObject.end);

  assertWhitespaceOnly(source, wrapper.end);
  return jsonObject.text;
}

function assertSafeProviderModel(provider, model) {
  if (typeof provider !== 'string' || !PROVIDER_ID_PATTERN.test(provider)) {
    throw new Error('Bruno prediction target is invalid.');
  }
  if (typeof model !== 'string' || !MODEL_ID_PATTERN.test(model)) {
    throw new Error('Bruno prediction target is invalid.');
  }
}

function assertEnvValue(value, key) {
  if (value === undefined) {
    throw new Error(`${key} is undefined.`);
  }
  const serialized = String(value);
  if (serialized.includes('\n') || serialized.includes('\0')) {
    throw new Error('CIS env value is invalid.');
  }
}

export function resolveCanonicalCaBundlePath(inputPath, realpathSyncImpl = realpathSync) {
  const parentDir = dirname(inputPath);
  const leafName = basename(inputPath);
  const canonicalParent = realpathSyncImpl(parentDir);
  return join(canonicalParent, leafName);
}

export function extractBrunoCisSettings({ modelsSource, predictionsSource }) {
  const rawUrl = oneMatch(modelsSource, /^\s*url:\s*(\S+)\s*$/gim, 'models URL');
  const featureKey = oneMatch(
    modelsSource,
    /^\s*Wd-PCA-Feature-Key:\s*(\S+)\s*$/gim,
    'feature key',
  );

  if (featureKey.includes('{{') || featureKey.includes('}}') || !FEATURE_KEY_PATTERN.test(featureKey)) {
    throw new Error('Bruno feature key must appear exactly once.');
  }

  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('Bruno models URL must be HTTPS and end in /v1alpha1/models.');
  }

  if (url.username || url.password) {
    throw new Error('Bruno models URL must not include user credentials.');
  }

  if (url.protocol !== 'https:' || !url.pathname.endsWith(MODELS_PATH_SUFFIX)) {
    throw new Error('Bruno models URL must be HTTPS and end in /v1alpha1/models.');
  }

  url.pathname = url.pathname.slice(0, -MODELS_PATH_SUFFIX.length);
  url.search = '';
  url.hash = '';

  let body;
  try {
    body = JSON.parse(extractBrunoJsonBody(predictionsSource));
  } catch (error) {
    if (error instanceof Error && /ambiguous|exactly once|missing|incomplete/i.test(error.message)) {
      throw error;
    }
    throw new Error('Bruno JSON body is incomplete.');
  }

  const provider = body?.target?.provider;
  const model = body?.target?.model;
  if (typeof provider !== 'string' || typeof model !== 'string') {
    throw new Error('Bruno prediction target is invalid.');
  }
  assertSafeProviderModel(provider, model);

  return {
    baseUrl: url.toString().replace(/\/$/, ''),
    allowedHost: url.hostname,
    featureKey,
    provider,
    model,
  };
}

export function mergeEnvSettings(existing, settings) {
  for (const key of CIS_KEYS) {
    assertEnvValue(settings[key], key);
  }

  const lines = String(existing || '').split('\n');
  const seen = new Set();
  const replacements = new Map(
    CIS_KEYS.map((key) => [key, `${key}=${JSON.stringify(String(settings[key]))}`]),
  );

  const merged = lines.map((line) => {
    const match = line.match(MANAGED_ENV_LINE);
    const key = match?.[1];
    if (!replacements.has(key)) {
      return line;
    }
    if (seen.has(key)) {
      throw new Error(`Duplicate ${key} entry in .env.`);
    }
    seen.add(key);
    return replacements.get(key);
  });

  for (const key of CIS_KEYS) {
    if (!seen.has(key)) {
      merged.push(replacements.get(key));
    }
  }

  return `${merged.filter((line, index, all) => !(index === all.length - 1 && line === '')).join('\n')}\n`;
}

export function writeEnvAtomic(envPath, contents) {
  if (existsSync(envPath)) {
    const stat = lstatSync(envPath);
    if (stat.isSymbolicLink()) {
      throw new Error('.env must not be a symlink.');
    }
    if (!stat.isFile()) {
      throw new Error('.env must be a regular file.');
    }
  }
  writeAtomicFile(envPath, Buffer.from(contents, 'utf8'), 0o600);
}
