import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';

const TELEMETRY_FILE = 'cis-telemetry.ndjson';
const MAX_RECORD_BYTES = 4096;
const MAX_FILE_BYTES = 256 * 1024;

const REDACTED_KEYS = new Set([
  'messages',
  'content',
  'output',
  'source',
  'path',
  'file',
  'oldText',
  'newText',
  'prompt',
  'completion',
  'modelOutput',
  'credentials',
  'token',
  'featureKey',
  'baseUrl',
]);

export function sanitizeCisTelemetryRecord(record = {}) {
  const sanitized = {
    at: record.at || new Date().toISOString(),
    fixUnitId: typeof record.fixUnitId === 'string' ? record.fixUnitId : null,
    sessionCalls: Number.isFinite(record.sessionCalls) ? record.sessionCalls : 0,
    outcome: typeof record.outcome === 'string' ? record.outcome : 'unknown',
    reasonCode: typeof record.reasonCode === 'string' ? record.reasonCode.slice(0, 128) : null,
    promptVersion: typeof record.promptVersion === 'string' ? record.promptVersion : '',
    modelId: typeof record.modelId === 'string' ? record.modelId : '',
    latencyMs: {
      total: Number.isFinite(record.latencyMs?.total) ? record.latencyMs.total : null,
      calls: Array.isArray(record.latencyMs?.calls)
        ? record.latencyMs.calls.filter((value) => Number.isFinite(value)).slice(0, 8)
        : [],
    },
    tokens: {
      prompt: Number.isFinite(record.tokens?.prompt) ? record.tokens.prompt : null,
      completion: Number.isFinite(record.tokens?.completion) ? record.tokens.completion : null,
      total: Number.isFinite(record.tokens?.total) ? record.tokens.total : null,
    },
  };

  for (const key of Object.keys(record)) {
    if (REDACTED_KEYS.has(key)) {
      throw new Error(`CIS telemetry record attempted to persist forbidden field: ${key}`);
    }
  }

  const serialized = JSON.stringify(sanitized);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_RECORD_BYTES) {
    throw new Error('CIS telemetry record exceeds size limit.');
  }
  return sanitized;
}

export function appendCisTelemetryRecord(sessionDir, record) {
  if (!sessionDir) throw new Error('sessionDir is required for CIS telemetry.');
  mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  chmodSync(sessionDir, 0o700);
  const filePath = join(sessionDir, TELEMETRY_FILE);
  const sanitized = sanitizeCisTelemetryRecord(record);
  const line = `${JSON.stringify(sanitized)}\n`;
  let fd;
  try {
    fd = openSync(filePath, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND, 0o600);
    writeSync(fd, line);
    fsyncSync(fd);
  } finally {
    if (fd != null) closeSync(fd);
  }
  if (existsSync(filePath)) chmodSync(filePath, 0o600);
  return sanitized;
}

export function aggregateCisTelemetryRecords(records = []) {
  const calls = records.map((record) => record.sessionCalls).filter((value) => Number.isFinite(value));
  const latencies = records.flatMap((record) => {
    const values = [];
    if (Number.isFinite(record.latencyMs?.total)) values.push(record.latencyMs.total);
    if (Array.isArray(record.latencyMs?.calls)) {
      values.push(...record.latencyMs.calls.filter((value) => Number.isFinite(value)));
    }
    return values;
  });
  const promptTokens = records.map((record) => record.tokens?.prompt).filter(Number.isFinite);
  const completionTokens = records.map((record) => record.tokens?.completion).filter(Number.isFinite);
  const totalTokens = records.map((record) => record.tokens?.total).filter(Number.isFinite);

  return {
    recordCount: records.length,
    sessionCalls: {
      min: calls.length ? Math.min(...calls) : null,
      max: calls.length ? Math.max(...calls) : null,
      total: calls.reduce((sum, value) => sum + value, 0),
    },
    latencyMs: {
      p95: nearestRankP95(latencies),
      max: latencies.length ? Math.max(...latencies) : null,
    },
    tokens: {
      prompt: promptTokens.reduce((sum, value) => sum + value, 0) || null,
      completion: completionTokens.reduce((sum, value) => sum + value, 0) || null,
      total: totalTokens.reduce((sum, value) => sum + value, 0) || null,
    },
  };
}

export function nearestRankP95(values = []) {
  const sorted = [...values].filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const rank = Math.ceil(0.95 * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

export function evaluateCisCallBudget(records = [], maxCalls = 2) {
  if (!Array.isArray(records) || records.length === 0) {
    return { ok: false, reason: 'EMPTY_TELEMETRY_CORPUS' };
  }
  const overBudget = records.filter((record) => (record.sessionCalls || 0) > maxCalls);
  if (overBudget.length > 0) {
    return { ok: false, reason: 'CIS_CALL_BUDGET_EXCEEDED', count: overBudget.length };
  }
  const p95 = nearestRankP95(records.map((record) => record.sessionCalls));
  if (p95 == null || p95 > maxCalls) {
    return { ok: false, reason: 'CIS_P95_EXCEEDED', p95 };
  }
  return { ok: true, p95, recordCount: records.length };
}

/**
 * Load persisted CIS telemetry records from a fix session directory.
 * @param {string} sessionDir
 */
export function readCisTelemetryRecords(sessionDir) {
  if (!sessionDir) return [];
  const filePath = join(sessionDir, TELEMETRY_FILE);
  if (!existsSync(filePath)) return [];
  const raw = readFileSync(filePath, 'utf8');
  const records = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      throw new Error('CIS telemetry NDJSON contains invalid JSON.');
    }
  }
  return records;
}

export { TELEMETRY_FILE, MAX_FILE_BYTES };
